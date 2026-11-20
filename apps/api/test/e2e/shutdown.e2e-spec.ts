import { EventEmitter } from 'node:events';
import http from 'node:http';
import { type AddressInfo, createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { problemDetailsSchema } from '@mgx/contracts';
import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type pg from 'pg';
import request from 'supertest';

import { shutdown, SHUTDOWN_SIGNALS, type ShutdownOptions } from '../../src/bootstrap/shutdown.js';
import { startApp } from '../../src/bootstrap/start.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { OUTBOX_RELAY_QUEUE } from '../../src/infrastructure/queue/queue.constants.js';
import { OutboxService } from '../../src/modules/outbox/application/outbox.service.js';
import {
  from,
  newClientIp,
  openFeature,
  registerVerifiedUser,
  TEST_DEVICE_ID,
} from '../support/identity.js';
import {
  createTestApp,
  eventually,
  TEST_CODE_HMAC_SECRET,
  TEST_SECRETS_ENCRYPTION_KEY,
  type TestApp,
} from '../support/test-app.js';
import { createTestDatabase, withConnection } from '../support/test-database.js';
import { redisUrl, TEST_APP_ROLE } from '../support/test-environment.js';

interface Line {
  readonly level: 'info' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** Fermeture que le test retient : celle d'un exécutant de file quand Redis ne répond plus. */
let release: () => void = () => undefined;
let blocked = new Promise<void>(() => undefined);

@Injectable()
class StuckClosing implements OnModuleDestroy {
  onModuleDestroy(): Promise<void> {
    return blocked;
  }
}

@Module({ providers: [StuckClosing] })
class StuckClosingModule {}

/**
 * L'arrêt borné, sur l'application réelle à l'écoute d'un port. Le processus n'est pas
 * arrêté : la fonction qui y met fin est remplacée, et ce fichier relève le code demandé.
 */
describe('Arrêt borné — bout en bout (HTTP)', () => {
  let testApp: TestApp | undefined;
  let lines: Line[];
  let exits: number[];
  const agents: http.Agent[] = [];
  /** Requêtes qu'un test a laissées en cours. */
  const pending: http.ClientRequest[] = [];

  const options = (timeoutMs: number): ShutdownOptions => ({
    timeoutMs,
    log: {
      info: (fields, message) => lines.push({ level: 'info', fields, message }),
      error: (fields, message) => lines.push({ level: 'error', fields, message }),
    },
    exit: (code) => exits.push(code),
  });

  /** Démarre l'application à l'écoute d'un port libre. */
  async function listening(
    imports: [] | [typeof StuckClosingModule] = [],
  ): Promise<{ started: TestApp; app: TestApp['app']; server: http.Server; port: number }> {
    lines = [];
    exits = [];
    const started = await createTestApp({ imports });
    testApp = started;
    const { app } = started;
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer();
    return { started, app, server, port: (server.address() as AddressInfo).port };
  }

  const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  const connectionsOf = (server: http.Server): Promise<number> =>
    new Promise((resolve, reject) => {
      server.getConnections((error, count) => {
        if (error === null) {
          resolve(count);
        } else {
          reject(error);
        }
      });
    });

  /** Attend qu'une session de la base attende un verrou de table : le travail est en cours. */
  async function untilWaitingForTable(observer: pg.Client): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await observer.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_locks
           WHERE NOT granted AND locktype = 'relation'
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        return (rows[0]?.waiting ?? 0) > 0;
      },
      { intervalMs: 20 },
    );
  }

  /** Nombre de connexions que le rôle de l'API tient sur la base de cette application. */
  function applicationSessions({ database }: TestApp): Promise<number> {
    return withConnection(database.ownerUrl, async (owner) => {
      const { rows } = await owner.query<{ sessions: number }>(
        `SELECT count(*)::int AS sessions FROM pg_stat_activity
         WHERE datname = current_database() AND usename = $1`,
        [TEST_APP_ROLE],
      );
      return rows[0]?.sessions ?? -1;
    });
  }

  function get(port: number, path: string, agent: http.Agent | false): Promise<Answer> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, agent }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        })
        .on('error', reject);
    });
  }

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      agent.destroy();
    }
    release();
    // Un test qui échoue en route laisse des connexions ouvertes : elles retiendraient la
    // fermeture ci-dessous, et son échec entraînerait celui des tests suivants.
    for (const left of pending.splice(0)) {
      left.destroy();
    }
    testApp?.app.getHttpServer().closeAllConnections();
    // L'application est déjà fermée par l'arrêt ; il reste à rendre sa base.
    await testApp?.close();
    testApp = undefined;
  });

  it('cesse d’accepter aussitôt, mène la requête en cours à son terme, puis se termine par 0', async () => {
    const { app, server, port } = await listening();
    // Une connexion qu'un client garde ouverte, sans requête en cours.
    const keepAlive = new http.Agent({ keepAlive: true });
    agents.push(keepAlive);
    expect((await get(port, '/health/live', keepAlive)).status).toBe(200);
    // Une requête en cours : ses en-têtes sont arrivés, son corps pas encore.
    const body = JSON.stringify({ email: 'nobody@example.com', password: 'not-a-real-password' });
    const inFlight = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    pending.push(inFlight);
    const answered = new Promise<Answer>((resolve, reject) => {
      inFlight.on('error', reject);
      inFlight.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      });
    });
    inFlight.write(body.slice(0, 10));
    // Le serveur tient ses deux connexions : l'inactive, et celle de la requête en cours.
    await eventually(async () => (await connectionsOf(server)) === 2, { intervalMs: 10 });
    await pause(100);

    const startedAt = Date.now();
    const done = shutdown(app, 'SIGTERM', options(10_000));

    // Plus aucune connexion nouvelle, dès l'instant de la demande.
    await expect(get(port, '/health/live', false)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // La requête en cours retient l'arrêt, qui l'attend.
    await pause(600);
    expect(exits).toEqual([]);

    inFlight.end(body.slice(10));
    const answer = await answered;
    await done;

    // Elle a reçu une vraie réponse de l'API, non une coupure.
    expect(answer.status).toBe(401);
    expect(problemDetailsSchema.parse(JSON.parse(answer.body)).code).toBe('INVALID_CREDENTIALS');
    expect(exits).toEqual([0]);
    expect(lines).toEqual([
      {
        level: 'info',
        fields: { signal: 'SIGTERM', timeoutMs: 10_000 },
        message: 'Shutdown requested',
      },
      { level: 'info', fields: { signal: 'SIGTERM' }, message: 'Shutdown complete' },
    ]);
    // La connexion gardée ouverte par le client n'a pas retenu l'arrêt jusqu'à son délai
    // d'inactivité (cinq secondes) : il s'achève peu après la dernière réponse.
    expect(server.keepAliveTimeout).toBe(5000);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('la requête qui écrit en base à l’instant de l’arrêt aboutit : la base se ferme après elle', async () => {
    const { started, app, server } = await listening();
    const http = request(server);
    await openFeature(started, 'registration');
    const user = await registerVerifiedUser(http, started);

    const signedIn = await withConnection(started.database.ownerUrl, async (owner) => {
      // Tant que ce verrou est tenu, la connexion ne peut pas écrire sa session : elle attend,
      // au milieu de son travail en base.
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE "user_sessions" IN ACCESS EXCLUSIVE MODE');
      const answered = http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: user.email, password: user.password, deviceId: TEST_DEVICE_ID })
        .then((response) => response);
      await untilWaitingForTable(owner);
      expect(await applicationSessions(started)).toBeGreaterThan(0);

      const done = shutdown(app, 'SIGTERM', options(10_000));
      // L'arrêt attend la requête : rien n'est fermé sous elle.
      await pause(600);
      expect(exits).toEqual([]);

      await owner.query('COMMIT');
      const response = await answered;
      await done;
      return response;
    });

    // Une vraie réponse — et non l'erreur d'une base fermée sous la requête.
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ status: 'AUTHENTICATED' });
    expect(exits).toEqual([0]);
    // L'arrêt achevé, l'API ne tient plus aucune connexion à sa base.
    expect(await applicationSessions(started)).toBe(0);
    expect(lines.map(({ message }) => message)).toEqual([
      'Shutdown requested',
      'Shutdown complete',
    ]);
  });

  it('la tâche de fond en cours à l’instant de l’arrêt s’achève avant la fin du processus', async () => {
    const { started, app } = await listening();
    const relayQueue = app.get<Queue>(getQueueToken(OUTBOX_RELAY_QUEUE));
    const written = jest.spyOn(PinoLogger.prototype, 'error');
    // Un événement attend dans la boîte d'envoi, le relais étant suspendu le temps de l'écrire.
    await relayQueue.pause();
    await eventually(async () => (await relayQueue.getActiveCount()) === 0, { intervalMs: 20 });
    const eventId = await app.get(UnitOfWork).run((tx) =>
      app.get(OutboxService).append(tx, {
        aggregateType: 'probe',
        aggregateId: '00000000-0000-4000-8000-000000000001',
        eventType: 'probe.shutdown_checked',
        payload: {},
      }),
    );

    await withConnection(started.database.ownerUrl, async (owner) => {
      // Tant que ce verrou est tenu, le relais ne peut pas réserver l'événement : son passage
      // attend, au milieu de son travail en base.
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE "outbox_events" IN EXCLUSIVE MODE');
      await relayQueue.resume();
      await untilWaitingForTable(owner);

      const done = shutdown(app, 'SIGTERM', options(10_000));
      // L'arrêt attend le passage en cours.
      await pause(600);
      expect(exits).toEqual([]);

      await owner.query('COMMIT');
      await done;

      // Le passage a fini son travail : l'événement est parti, et rien n'a échoué.
      const { rows } = await owner.query<{ status: string }>(
        'SELECT "status"::text AS status FROM "outbox_events" WHERE "id" = $1',
        [eventId],
      );
      expect(rows).toEqual([{ status: 'PUBLISHED' }]);
    });
    expect(exits).toEqual([0]);
    expect(written.mock.calls.map(([, message]) => message)).toEqual([]);
  });

  it('se termine par 1 à l’échéance si la fermeture n’aboutit pas — sans plus rien accepter d’ici là', async () => {
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, port } = await listening([StuckClosingModule]);
    expect((await get(port, '/health/live', false)).status).toBe(200);

    const startedAt = Date.now();
    const done = shutdown(app, 'SIGTERM', options(700));

    await expect(get(port, '/health/live', false)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await pause(400);
    expect(exits).toEqual([]);

    await eventually(async () => exits.length > 0, { timeoutMs: 5000, intervalMs: 20 });
    const elapsed = Date.now() - startedAt;

    expect(exits).toEqual([1]);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(2500);
    expect(lines.at(-1)).toEqual({
      level: 'error',
      fields: { signal: 'SIGTERM', timeoutMs: 700 },
      message: 'Shutdown did not complete in time: exiting',
    });

    // La fermeture, libérée après coup, ne change plus l'issue.
    release();
    await done;
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(2);
  });

  describe('lancement réel', () => {
    type Launched = Awaited<ReturnType<typeof startApp>>;
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    let previous: (readonly [string, string | undefined])[];
    let port: number;
    let signals: EventEmitter;
    let launched: Launched | undefined;
    let starting: Promise<Launched> | undefined;
    let notices: string[];

    /** Lance l'API comme en service, à ceci près : ses signaux et sa fin sont ceux du test. */
    const launch = (): Promise<Launched> => {
      starting = startApp({
        signals,
        exit: (code) => exits.push(code),
        notice: (message) => notices.push(message),
      });
      return starting;
    };

    beforeEach(async () => {
      // Le lancement lit sa configuration dans l'environnement du processus, comme en service.
      database = await createTestDatabase();
      port = await freePort();
      const environment: Record<string, string> = {
        NODE_ENV: 'test',
        APP_ENV: 'test',
        LOG_LEVEL: 'silent',
        HOST: '127.0.0.1',
        PORT: String(port),
        SHUTDOWN_TIMEOUT_MS: '6000',
        DATABASE_URL: database.appUrl,
        REDIS_URL: redisUrl(),
        AUTH_CODE_HMAC_SECRET: TEST_CODE_HMAC_SECRET,
        AUTH_SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
        AUTH_PASSWORD_HASH_MEMORY_KIB: '64',
        AUTH_PASSWORD_HASH_PASSES: '1',
      };
      previous = Object.keys(environment).map((name) => [name, process.env[name]] as const);
      Object.assign(process.env, environment);
      // Comme toute application de test : l'instance Redis de test, vidée.
      const flush = new Redis(redisUrl());
      await flush.flushdb();
      await flush.quit();
      signals = new EventEmitter();
      exits = [];
      notices = [];
      launched = undefined;
      starting = undefined;
    });

    afterEach(async () => {
      // Que l'arrêt ait eu lieu ou non, l'application ne reste pas ouverte derrière le test.
      launched ??= await starting?.catch(() => undefined);
      await launched?.close();
      for (const [name, value] of previous) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
      await database.drop();
    });

    it('installe l’arrêt borné : SIGTERM ferme l’API et la termine par 0', async () => {
      const written = jest.spyOn(PinoLogger.prototype, 'info');
      const listenersBefore = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

      launched = await launch();

      expect((await get(port, '/health/ready', false)).status).toBe(200);
      // Un écouteur par signal, et un seul : celui de l'arrêt borné.
      expect(signals.eventNames()).toEqual(['SIGTERM', 'SIGINT']);
      expect(SHUTDOWN_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual([1, 1]);
      // Rien d'autre n'écoute les signaux du processus : un second écouteur — celui de NestJS,
      // s'il était activé — fermerait l'application de son côté, puis renverrait le signal.
      expect(SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
        listenersBefore,
      );

      signals.emit('SIGTERM');
      await eventually(async () => exits.length > 0, { intervalMs: 20 });

      expect(exits).toEqual([0]);
      await expect(get(port, '/health/live', false)).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      // L'échéance est celle de la configuration.
      expect(written.mock.calls.filter(([, message]) => message === 'Shutdown requested')).toEqual([
        [{ signal: 'SIGTERM', timeoutMs: 6000 }, 'Shutdown requested'],
      ]);
      expect(notices).toEqual([]);
    });

    it.each(SHUTDOWN_SIGNALS)(
      '%s reçu avant que l’API soit prête : le processus se termine aussitôt, par 0',
      async (signal) => {
        const written = jest.spyOn(PinoLogger.prototype, 'info');

        // Le lancement n'est pas attendu : l'application s'initialise encore.
        void launch();
        // Les signaux sont écoutés dès cet instant, avant toute initialisation.
        expect(signals.eventNames()).toEqual(['SIGTERM', 'SIGINT']);
        signals.emit(signal);

        // Rien n'était à fermer : la fin est immédiate, et ce n'est pas l'arrêt borné.
        expect(exits).toEqual([0]);
        expect(notices).toEqual([
          `Shutdown requested (${signal}) before the application was ready: exiting.`,
        ]);
        launched = await starting;
        expect(
          written.mock.calls.filter(([, message]) => message === 'Shutdown requested'),
        ).toEqual([]);
      },
    );
  });
});

/** Un port que rien n'écoute : celui que le système vient d'attribuer, aussitôt rendu. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}
