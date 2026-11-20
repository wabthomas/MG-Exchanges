import { describe, expect, it, jest } from '@jest/globals';

import { Prisma } from '../../generated/prisma/client.js';
import type { DbClient, PrismaService } from './prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  retryPauseMs,
  type RetryPolicy,
  UnitOfWork,
} from './unit-of-work.js';

const TX = { marker: 'transaction client' } as unknown as DbClient;

/** Erreur telle que le pilote la lève à la validation d'une transaction (`COMMIT`). */
function commitError(sqlState: string): Error {
  return Object.assign(new Error('commit refused'), {
    name: 'DriverAdapterError',
    cause: { kind: 'postgres', originalCode: sqlState, originalMessage: 'refused' },
  });
}

/** Erreur telle que Prisma la lève lorsque PostgreSQL refuse une instruction. */
function statementError(sqlState: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('statement refused', {
    code: 'P2010',
    clientVersion: 'test',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', originalCode: sqlState, originalMessage: 'refused' },
      },
    },
  });
}

interface Recorded {
  readonly options: unknown[];
  transactions: number;
}

/** Unité de travail sur une base simulée : chaque transaction exécute `work`, sans rien valider. */
function unitOfWork(): { unit: UnitOfWork; recorded: Recorded } {
  const recorded: Recorded = { options: [], transactions: 0 };
  const prisma = {
    $transaction: async <T>(work: (tx: DbClient) => Promise<T>, options: unknown): Promise<T> => {
      recorded.transactions += 1;
      recorded.options.push(options);
      return work(TX);
    },
  } as unknown as PrismaService;
  return { unit: new UnitOfWork(prisma), recorded };
}

const QUICK: RetryPolicy = { delaysMs: [1, 1, 1] };

/** Travail qui échoue avec `errors`, dans l'ordre, puis rend `'done'`. */
function failingWith(errors: readonly (Error | undefined)[]): {
  work: () => Promise<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    work: () => {
      const error = errors[calls];
      calls += 1;
      return error === undefined ? Promise.resolve('done') : Promise.reject(error);
    },
  };
}

describe('UnitOfWork', () => {
  it('exécute le travail dans une transaction, avec son client, et rend son résultat', async () => {
    const { unit, recorded } = unitOfWork();
    const seen: DbClient[] = [];
    const result = await unit.run((tx) => {
      seen.push(tx);
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(seen).toEqual([TX]);
    expect(recorded).toEqual({ options: [{}], transactions: 1 });
  });

  it('transmet le niveau d’isolation et la durée maximale, et eux seuls', async () => {
    const { unit, recorded } = unitOfWork();
    await unit.run(() => Promise.resolve(), { isolationLevel: 'Serializable' });
    await unit.run(() => Promise.resolve(), { timeoutMs: 1500 });
    await unit.run(() => Promise.resolve(), {
      isolationLevel: 'RepeatableRead',
      timeoutMs: 20,
      retry: QUICK,
    });
    expect(recorded.options).toEqual([
      { isolationLevel: 'Serializable' },
      { timeout: 1500 },
      { isolationLevel: 'RepeatableRead', timeout: 20 },
    ]);
  });

  it('sans option, un conflit n’est pas relancé : l’erreur remonte telle quelle', async () => {
    for (const conflict of [commitError('40001'), statementError('40P01')]) {
      const { unit, recorded } = unitOfWork();
      const { work, calls } = failingWith([conflict]);
      await expect(unit.run(work)).rejects.toBe(conflict);
      expect(calls()).toBe(1);
      expect(recorded.transactions).toBe(1);
    }
  });

  it('avec l’option, la transaction annulée pour conflit est relancée entière — quelle que soit la forme de l’erreur', async () => {
    for (const conflict of [
      commitError('40001'),
      commitError('40P01'),
      statementError('40001'),
      statementError('40P01'),
    ]) {
      const { unit, recorded } = unitOfWork();
      const { work, calls } = failingWith([conflict, conflict]);
      expect(await unit.run(work, { retry: QUICK })).toBe('done');
      expect(calls()).toBe(3);
      // Une nouvelle transaction à chaque essai.
      expect(recorded.transactions).toBe(3);
    }
  });

  it('une erreur d’une autre nature n’est jamais relancée', async () => {
    const others = [
      new Error('40001'),
      statementError('23505'),
      statementError('MGX09'),
      statementError('55P03'),
      commitError('MGX08'),
      Object.assign(new Error('not the driver'), { cause: { originalCode: '40001' } }),
    ];
    for (const error of others) {
      const { unit } = unitOfWork();
      const { work, calls } = failingWith([error]);
      await expect(unit.run(work, { retry: QUICK })).rejects.toBe(error);
      expect(calls()).toBe(1);
    }
    // Ni après un conflit : le second échec remonte, sans troisième essai.
    const { unit } = unitOfWork();
    const refused = statementError('MGX09');
    const { work, calls } = failingWith([commitError('40001'), refused, commitError('40001')]);
    await expect(unit.run(work, { retry: QUICK })).rejects.toBe(refused);
    expect(calls()).toBe(2);
  });

  it('les tentatives sont comptées : épuisées, le dernier conflit remonte', async () => {
    const { unit } = unitOfWork();
    const conflicts = [1, 2, 3, 4, 5].map(() => commitError('40001'));
    const { work, calls } = failingWith(conflicts);
    await expect(unit.run(work, { retry: QUICK })).rejects.toBe(conflicts[3]);
    // Un essai, puis une nouvelle tentative par délai.
    expect(calls()).toBe(4);

    const none = unitOfWork();
    const single = failingWith([conflicts[0]]);
    await expect(none.unit.run(single.work, { retry: { delaysMs: [] } })).rejects.toBe(
      conflicts[0],
    );
    expect(single.calls()).toBe(1);
  });

  it('la pause va de la moitié du délai prévu à sa totalité, selon le tirage', () => {
    expect(retryPauseMs(40, 0)).toBe(20);
    expect(retryPauseMs(40, 0.25)).toBe(25);
    expect(retryPauseMs(40, 0.5)).toBe(30);
    expect(retryPauseMs(150, 0)).toBe(75);
    expect(retryPauseMs(150, 0.5)).toBe(112.5);
    // `Math.random()` ne rend jamais 1 : la pause reste en deçà du délai prévu.
    expect(retryPauseMs(40, 0.999)).toBeCloseTo(39.98, 10);
    expect(retryPauseMs(40, 0.999)).toBeLessThan(40);
    expect(retryPauseMs(0, 0.999)).toBe(0);
  });

  it('attend avant chaque nouvelle tentative, le temps que le tirage a fixé', async () => {
    const random = jest.spyOn(Math, 'random');
    try {
      const elapsedWith = async (drawn: number): Promise<number> => {
        random.mockReturnValue(drawn);
        const { unit } = unitOfWork();
        const { work, calls } = failingWith([commitError('40001'), commitError('40001')]);
        const started = performance.now();
        await unit.run(work, { retry: { delaysMs: [40, 80] } });
        expect(calls()).toBe(3);
        return performance.now() - started;
      };
      // Seules des durées minimales sont vérifiées : une machine chargée allonge une attente,
      // elle ne la raccourcit pas. (Une minuterie peut partir une milliseconde en avance.)
      // Tirage le plus bas : 20 ms, puis 40.
      expect(await elapsedWith(0)).toBeGreaterThanOrEqual(58);
      // Tirage le plus haut : près de 40 ms, puis près de 80.
      expect(await elapsedWith(0.999)).toBeGreaterThanOrEqual(117);
    } finally {
      random.mockRestore();
    }
  });

  it('par défaut : trois nouvelles tentatives, de plus en plus espacées', () => {
    expect(DEFAULT_CONFLICT_RETRY).toEqual({ delaysMs: [20, 60, 150] });
  });
});
