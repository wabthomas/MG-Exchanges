import { type AddressInfo, createServer, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { toProblem } from '../../src/common/http/problem-details.filter.js';
import { loadAppConfig } from '../../src/config/app-config.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { isDatabaseSaturated } from '../../src/infrastructure/database/database-errors.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  UnitOfWork,
} from '../../src/infrastructure/database/unit-of-work.js';
import { occupyConnections } from '../support/saturation.js';
import { TEST_CODE_HMAC_SECRET, TEST_SECRETS_ENCRYPTION_KEY } from '../support/test-app.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';
import { redisUrl } from '../support/test-environment.js';

/** Ce que l'API répond lorsque la base est saturée. */
const OVERLOADED = {
  status: 503,
  code: 'SERVICE_UNAVAILABLE',
  detail: 'The service is temporarily overloaded. Please retry in a few seconds.',
  retryAfterSeconds: 5,
};
const SERVER_ERROR = {
  status: 500,
  code: 'INTERNAL_ERROR',
  detail: 'An unexpected error occurred. Please try again later.',
};

/** L'erreur que lève `action`, ou `null` si elle aboutit — et le temps qu'elle a pris. */
async function outcomeOf(
  action: () => Promise<unknown>,
): Promise<{ error: unknown; elapsedMs: number }> {
  const startedAt = Date.now();
  const error = await action().then(
    () => null,
    (reason: unknown) => reason,
  );
  return { error, elapsedMs: Date.now() - startedAt };
}

/**
 * Les erreurs sont ici celles que Prisma et le pool `pg` lèvent réellement lorsque toutes les
 * connexions sont prises — et non des erreurs reconstituées : elles ne portent aucun code
 * propre, l'API les reconnaît à leur message. Ce fichier échoue si une montée de version en
 * change les termes.
 */
describe('Base saturée — aucune connexion ne se libère à temps (PostgreSQL réel)', () => {
  let database: TestDatabase;
  const clients: PrismaService[] = [];

  /** Le client de l'application, réduit à une seule connexion ; il n'est pas encore connecté. */
  function clientFor(env: Record<string, string> = {}): PrismaService {
    const config = loadAppConfig({
      NODE_ENV: 'test',
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: '1',
      REDIS_URL: redisUrl(),
      AUTH_CODE_HMAC_SECRET: TEST_CODE_HMAC_SECRET,
      AUTH_SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
      ...env,
    });
    const prisma = new PrismaService(config);
    clients.push(prisma);
    return prisma;
  }

  /** Le même, connecté à la base de test. */
  async function clientWith(env: Record<string, string> = {}): Promise<PrismaService> {
    const prisma = clientFor(env);
    await prisma.onModuleInit();
    return prisma;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await Promise.all(clients.map((prisma) => prisma.onModuleDestroy()));
    await database.drop();
  });

  it('une transaction qui attend deux secondes une connexion est abandonnée sans avoir commencé : 503', async () => {
    // Réglages par défaut : le pool patienterait cinq secondes, Prisma renonce avant lui.
    const prisma = await clientWith();
    const unitOfWork = new UnitOfWork(prisma);
    const release = await occupyConnections(prisma, 1);
    try {
      let ran = 0;
      const { error, elapsedMs } = await outcomeOf(() =>
        unitOfWork.run(
          async () => {
            ran += 1;
          },
          // Une saturation n'est pas un conflit : elle n'est pas relancée.
          { retry: DEFAULT_CONFLICT_RETRY },
        ),
      );

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
      expect(isDatabaseSaturated(error)).toBe(true);
      expect(toProblem(error)).toEqual(OVERLOADED);
      // Rien n'a été exécuté : la transaction n'a jamais commencé.
      expect(ran).toBe(0);
      // Deux secondes d'attente, et non les cinq du pool.
      expect(elapsedMs).toBeGreaterThanOrEqual(1_900);
      expect(elapsedMs).toBeLessThan(4_000);
    } finally {
      await release();
    }

    // La connexion rendue, la même transaction passe.
    await expect(unitOfWork.run(async (tx) => tx.user.count())).resolves.toBe(0);
  });

  it('toute requête qui attend plus que le délai du pool est abandonnée par lui : 503', async () => {
    // Le délai du pool (`DATABASE_CONNECTION_TIMEOUT_MS`) ramené sous celui de Prisma.
    const prisma = await clientWith({ DATABASE_CONNECTION_TIMEOUT_MS: '300' });
    const unitOfWork = new UnitOfWork(prisma);
    const release = await occupyConnections(prisma, 1);
    try {
      const requests: [string, () => Promise<unknown>][] = [
        ['requête d’un modèle', () => prisma.user.count()],
        ['requête SQL', () => prisma.$queryRaw`SELECT 1 AS one`],
        ['transaction', () => unitOfWork.run(async (tx) => tx.user.count())],
        ['transaction par lot', () => prisma.$transaction([prisma.user.count()])],
      ];
      for (const [label, request] of requests) {
        const { error, elapsedMs } = await outcomeOf(request);
        expect({ label, saturated: isDatabaseSaturated(error), problem: toProblem(error) }).toEqual(
          { label, saturated: true, problem: OVERLOADED },
        );
        // L'erreur du pool, telle quelle : ni code, ni cause.
        expect({ label, message: (error as Error).message }).toEqual({
          label,
          message: 'timeout exceeded when trying to connect',
        });
        // Le délai configuré, et non les deux secondes de Prisma.
        expect(elapsedMs).toBeGreaterThanOrEqual(250);
        expect(elapsedMs).toBeLessThan(1_500);
      }
    } finally {
      await release();
    }

    await expect(prisma.user.count()).resolves.toBe(0);
  });

  it('une transaction trop longue n’est pas une saturation : elle avait commencé — 500', async () => {
    const prisma = await clientWith();
    const unitOfWork = new UnitOfWork(prisma);

    const { error } = await outcomeOf(() =>
      unitOfWork.run(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(0.5)`;
          // Le délai accordé à la transaction est passé : Prisma l'a annulée.
          await tx.user.count();
        },
        { timeoutMs: 200 },
      ),
    );

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // Le même code que pour une transaction qui n'a pas pu commencer : seul le message diffère.
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
    expect((error as Error).message).toContain('expired transaction');
    expect(isDatabaseSaturated(error)).toBe(false);
    expect(toProblem(error)).toEqual(SERVER_ERROR);
  });

  it('une base qui refuse les connexions n’est pas une saturation : c’est une panne — 500', async () => {
    // Personne n'écoute sur ce port.
    const prisma = clientFor({
      DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/nowhere',
      DATABASE_CONNECTION_TIMEOUT_MS: '300',
    });

    for (const request of [
      () => prisma.user.count(),
      () => prisma.$transaction(async (tx) => tx.user.count()),
    ]) {
      const { error } = await outcomeOf(request);
      expect(error).toBeInstanceOf(Error);
      expect(isDatabaseSaturated(error)).toBe(false);
      expect(toProblem(error)).toEqual(SERVER_ERROR);
    }
  });

  it('une base qui ne répond plus : la requête qui tentait la connexion échoue — 500 ; celles qui attendaient derrière elle sont refusées — 503', async () => {
    // Un serveur qui accepte la connexion et ne dit jamais rien.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, '127.0.0.1', resolve);
    });
    const { port } = silent.address() as AddressInfo;
    try {
      const prisma = clientFor({
        DATABASE_URL: `postgresql://nobody:nothing@127.0.0.1:${String(port)}/nowhere`,
        DATABASE_CONNECTION_TIMEOUT_MS: '300',
      });

      const outcomes = await Promise.all([
        outcomeOf(() => prisma.user.count()),
        outcomeOf(() => prisma.user.count()),
      ]);
      const errors = new Map(outcomes.map(({ error }) => [(error as Error).message, error]));
      expect([...errors.keys()].sort()).toEqual([
        'Connection terminated due to connection timeout',
        'timeout exceeded when trying to connect',
      ]);

      // L'une a ouvert la seule connexion du pool, restée sans réponse : une panne.
      const opened = errors.get('Connection terminated due to connection timeout');
      expect(isDatabaseSaturated(opened)).toBe(false);
      expect(toProblem(opened)).toEqual(SERVER_ERROR);
      // L'autre attendait cette connexion : elle n'a pas commencé.
      const waited = errors.get('timeout exceeded when trying to connect');
      expect(isDatabaseSaturated(waited)).toBe(true);
      expect(toProblem(waited)).toEqual(OVERLOADED);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});
