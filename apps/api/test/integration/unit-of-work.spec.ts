import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  isTransactionConflict,
  sqlStateOf,
} from '../../src/infrastructure/database/database-errors.js';
import { type DbClient, PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  UnitOfWork,
} from '../../src/infrastructure/database/unit-of-work.js';
import { toProblem } from '../../src/common/http/problem-details.filter.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/** Rendez-vous : chaque participant attend que `count` participants l'aient atteint. */
function meetingOf(count: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const all = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= count) {
      open();
    }
    return all;
  };
}

describe('Transactions — conflits et nouvelles tentatives (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = testApp.app.get(PrismaService);
    unitOfWork = testApp.app.get(UnitOfWork);
  });

  afterAll(async () => {
    await testApp.close();
  });

  /**
   * Deux transactions qui lisent chacune ce que l'autre va écrire : exécutées l'une après
   * l'autre, la seconde verrait la ligne de la première. Sérialisables, elles ne peuvent pas
   * être validées toutes les deux telles quelles : PostgreSQL annule la seconde à sa validation.
   */
  function crossing(action: string) {
    const read = meetingOf(2);
    const written = meetingOf(2);
    const seen: number[] = [];
    const work = async (tx: DbClient): Promise<number> => {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}`;
      const found = rows[0]?.n ?? -1;
      seen.push(found);
      // Les deux ont lu avant qu'aucune n'écrive, et écrit avant qu'aucune ne valide. À la
      // nouvelle tentative, le rendez-vous a déjà eu lieu : elle passe sans attendre.
      await read();
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action,
          resourceType: 'test',
          outcome: 'SUCCESS',
          metadata: { found },
        },
      });
      await written();
      return found;
    };
    return { work, seen };
  }

  const rowsOf = (action: string): Promise<number> => prisma.auditLog.count({ where: { action } });

  it('deux transactions sérialisables qui se croisent : sans nouvelle tentative, la seconde échoue à sa validation', async () => {
    const action = `test.crossing_${randomUUID().replaceAll('-', '')}`;
    const { work, seen } = crossing(action);
    const outcomes = await Promise.allSettled([
      unitOfWork.run(work, { isolationLevel: 'Serializable' }),
      unitOfWork.run(work, { isolationLevel: 'Serializable' }),
    ]);

    const refused = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    expect(refused).toHaveLength(1);
    // L'erreur vient de la validation elle-même, et porte tout de même son SQLSTATE.
    expect(sqlStateOf(refused[0])).toBe('40001');
    expect(isTransactionConflict(refused[0])).toBe(true);
    // Arrivée telle quelle jusqu'à la réponse HTTP : un conflit à renvoyer, pas une panne.
    expect(toProblem(refused[0])).toEqual({
      status: 409,
      code: 'CONFLICT',
      detail: 'The request conflicted with another one. Please try again.',
    });
    expect(seen).toEqual([0, 0]);
    expect(await rowsOf(action)).toBe(1);
  });

  it('avec nouvelle tentative, toutes deux aboutissent — comme si elles s’étaient suivies', async () => {
    const action = `test.crossing_${randomUUID().replaceAll('-', '')}`;
    const { work, seen } = crossing(action);
    const options = { isolationLevel: 'Serializable', retry: DEFAULT_CONFLICT_RETRY } as const;
    const results = await Promise.all([
      unitOfWork.run(work, options),
      unitOfWork.run(work, options),
    ]);

    // L'une a vu la table vide ; l'autre, relancée, a vu la ligne de la première.
    expect([...results].sort()).toEqual([0, 1]);
    expect(seen).toEqual([0, 0, 1]);
    expect(await rowsOf(action)).toBe(2);
    const found = await prisma.auditLog.findMany({ where: { action }, select: { metadata: true } });
    expect(found.map(({ metadata }) => metadata).sort()).toEqual([{ found: 0 }, { found: 1 }]);
  });

  it('une règle que la base vérifie à la validation remonte avec son SQLSTATE, et rien n’est écrit', async () => {
    const key = `test:${randomUUID()}`;
    // Un en-tête d'écriture sans ses lignes : accepté à l'écriture, refusé à la validation.
    const outcome = await unitOfWork
      .run(
        async (tx) => {
          await tx.$executeRaw`
          INSERT INTO ledger_entries (idempotency_key, kind, posting_count, actor_type)
          VALUES (${key}, 'test.entry', 2, 'SYSTEM')`;
          return 'written';
        },
        { retry: DEFAULT_CONFLICT_RETRY },
      )
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect(sqlStateOf(outcome)).toBe('MGX08');
    expect(isTransactionConflict(outcome)).toBe(false);
    expect(await prisma.ledgerEntry.count({ where: { idempotencyKey: key } })).toBe(0);
  });
});
