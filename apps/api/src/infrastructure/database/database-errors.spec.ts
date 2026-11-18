import { describe, expect, it } from '@jest/globals';

import { Prisma } from '../../generated/prisma/client.js';
import {
  ACCOUNT_CLOSED_SQLSTATE,
  isAccountClosedError,
  isDatabaseSaturated,
  isLockContention,
  isTransactionConflict,
  isUniqueViolation,
  sqlStateOf,
} from './database-errors.js';

/** Erreur telle que Prisma la lève lorsque PostgreSQL refuse une instruction. */
function databaseError(code: string, sqlState?: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Database error', {
    code,
    clientVersion: 'test',
    ...(sqlState === undefined
      ? {}
      : {
          meta: {
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: { kind: 'postgres', originalCode: sqlState, originalMessage: 'refused' },
            },
          },
        }),
  });
}

/**
 * Erreur telle que le pilote la lève lui-même à la validation d'une transaction (`COMMIT`) :
 * une règle vérifiée en fin de transaction, ou un conflit de sérialisation constaté alors.
 */
function commitError(cause: unknown, name = 'DriverAdapterError'): Error {
  return Object.assign(new Error('Commit refused'), { name, cause });
}

/** Erreur de Prisma à propos d'une transaction elle-même (`P2028`), et non d'une instruction. */
function transactionApiError(
  message: string,
  code = 'P2028',
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Transaction API error: ${message}`, {
    code,
    clientVersion: 'test',
  });
}

describe('erreurs de base de données', () => {
  it('retrouve le code SQLSTATE d’une erreur levée par PostgreSQL', () => {
    expect(sqlStateOf(databaseError('P2010', 'MGX02'))).toBe('MGX02');
    expect(sqlStateOf(databaseError('P2039', '42501'))).toBe('42501');
    expect(sqlStateOf(databaseError('P2004', '23514'))).toBe('23514');
  });

  it('le retrouve aussi quand la base refuse à la validation de la transaction', () => {
    expect(sqlStateOf(commitError({ kind: 'postgres', originalCode: 'MGX08' }))).toBe('MGX08');
    expect(
      sqlStateOf(commitError({ kind: 'TransactionWriteConflict', originalCode: '40001' })),
    ).toBe('40001');

    // Seule l'erreur du pilote est lue ainsi : une autre, qui lui ressemblerait, ne l'est pas.
    expect(sqlStateOf(commitError({ originalCode: '40001' }, 'Error'))).toBeNull();
    expect(sqlStateOf(commitError({ originalCode: '40001' }, 'DriverAdapterErrorLike'))).toBeNull();
    expect(sqlStateOf({ name: 'DriverAdapterError', cause: { originalCode: '40001' } })).toBeNull();
    for (const cause of [undefined, null, 'MGX08', 40001, {}, { originalCode: 40001 }]) {
      expect(sqlStateOf(commitError(cause))).toBeNull();
    }
  });

  it('ne devine rien : sans code d’origine, pas de SQLSTATE', () => {
    expect(sqlStateOf(databaseError('P2025'))).toBeNull();
    expect(sqlStateOf(new Error('MGX02'))).toBeNull();
    expect(sqlStateOf({ code: 'MGX02', meta: {} })).toBeNull();
    expect(sqlStateOf(null)).toBeNull();
    expect(sqlStateOf(undefined)).toBeNull();

    const malformed = [
      { driverAdapterError: null },
      { driverAdapterError: 'MGX02' },
      { driverAdapterError: { cause: null } },
      { driverAdapterError: { cause: { originalCode: 23505 } } },
    ];
    for (const meta of malformed) {
      const error = new Prisma.PrismaClientKnownRequestError('Database error', {
        code: 'P2010',
        clientVersion: 'test',
        meta,
      });
      expect(sqlStateOf(error)).toBeNull();
    }
  });

  it('reconnaît une violation d’unicité, qu’elle vienne d’un modèle ou d’une requête SQL', () => {
    expect(isUniqueViolation(databaseError('P2002'))).toBe(true);
    expect(isUniqueViolation(databaseError('P2010', '23505'))).toBe(true);

    expect(isUniqueViolation(databaseError('P2010', '23514'))).toBe(false);
    expect(isUniqueViolation(databaseError('P2003'))).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(
      false,
    );
  });

  it('reconnaît une écriture refusée parce que le compte est clôturé, et elle seule', () => {
    expect(ACCOUNT_CLOSED_SQLSTATE).toBe('MGX05');
    expect(isAccountClosedError(databaseError('P2010', 'MGX05'))).toBe(true);
    expect(isAccountClosedError(databaseError('P2039', 'MGX05'))).toBe(true);

    expect(isAccountClosedError(databaseError('P2010', 'MGX04'))).toBe(false);
    expect(isAccountClosedError(databaseError('P2039', '55P03'))).toBe(false);
    // Une ligne absente n'est pas un refus de la base : elle n'est pas devinée.
    expect(isAccountClosedError(databaseError('P2025'))).toBe(false);
    expect(isAccountClosedError(new Error('account is closed'))).toBe(false);
  });

  it('reconnaît une transaction interrompue faute de verrou : délai dépassé, ou interblocage', () => {
    // Les formes que Prisma leur donne : requête d'un modèle, requête SQL, conflit d'écriture.
    expect(isLockContention(databaseError('P2039', '55P03'))).toBe(true);
    expect(isLockContention(databaseError('P2010', '55P03'))).toBe(true);
    expect(isLockContention(databaseError('P2034', '40P01'))).toBe(true);
  });

  it('reconnaît une transaction annulée parce qu’elle en croisait une autre : sérialisation, ou interblocage', () => {
    expect(isTransactionConflict(databaseError('P2010', '40001'))).toBe(true);
    expect(isTransactionConflict(databaseError('P2034', '40P01'))).toBe(true);
    expect(isTransactionConflict(commitError({ originalCode: '40001' }))).toBe(true);
    expect(isTransactionConflict(commitError({ originalCode: '40P01' }))).toBe(true);
  });

  it('ne prend aucune autre erreur pour un tel conflit : celle-là ne se relance pas', () => {
    // 55P03 : délai d'attente d'un verrou — la clôture le relance elle-même, à sa façon.
    for (const sqlState of ['55P03', '40002', '40003', 'MGX05', 'MGX08', 'MGX09', '23505']) {
      expect(isTransactionConflict(databaseError('P2010', sqlState))).toBe(false);
      expect(isTransactionConflict(commitError({ originalCode: sqlState }))).toBe(false);
    }
    // Le code Prisma « conflit d'écriture » ne suffit pas sans le SQLSTATE d'origine.
    expect(isTransactionConflict(databaseError('P2034'))).toBe(false);
    expect(isTransactionConflict(new Error('could not serialize access'))).toBe(false);
    expect(isTransactionConflict(null)).toBe(false);
  });

  it('ne prend aucune autre erreur pour une attente de verrou : celle-là ne se relance pas', () => {
    for (const sqlState of ['MGX04', 'MGX05', '23505', '40001', '57014', '53300']) {
      expect(isLockContention(databaseError('P2010', sqlState))).toBe(false);
    }
    expect(isLockContention(databaseError('P2034'))).toBe(false);
    expect(isLockContention(new Error('canceling statement due to lock timeout'))).toBe(false);
    expect(isLockContention(null)).toBe(false);
  });

  it('reconnaît une base saturée : aucune connexion ne s’est libérée à temps', () => {
    // Prisma renonce le premier, pour une transaction qui n'a pas pu commencer.
    expect(
      isDatabaseSaturated(transactionApiError('Unable to start a transaction in the given time.')),
    ).toBe(true);
    // Le pool renonce le premier : une erreur nue, que Prisma laisse passer telle quelle…
    expect(isDatabaseSaturated(new Error('timeout exceeded when trying to connect'))).toBe(true);
    // … ou en y notant sa version.
    expect(
      isDatabaseSaturated(
        Object.assign(new Error('timeout exceeded when trying to connect'), {
          clientVersion: '7.10.1',
        }),
      ),
    ).toBe(true);
  });

  it('ne prend pour une saturation ni une transaction trop longue, ni une base injoignable', () => {
    // Autres erreurs `P2028` : la transaction avait commencé — rien ne dit ce qu'elle a fait.
    for (const message of [
      'A query cannot be executed on an expired transaction. The timeout for this transaction ' +
        'was 5000 ms, however 5012 ms passed since the start of the transaction.',
      'Transaction already closed: A commit cannot be executed on a committed transaction.',
      'Transaction already closed: A query cannot be executed on a transaction that was rolled back.',
      'Transaction not found. Transaction ID is invalid.',
    ]) {
      expect({ message, saturated: isDatabaseSaturated(transactionApiError(message)) }).toEqual({
        message,
        saturated: false,
      });
    }
    // Les mots de Prisma sous un autre code, ou hors d'une erreur de Prisma : ce n'est pas elle.
    expect(
      isDatabaseSaturated(
        transactionApiError('Unable to start a transaction in the given time.', 'P2010'),
      ),
    ).toBe(false);
    expect(isDatabaseSaturated(new Error('Unable to start a transaction in the given time.'))).toBe(
      false,
    );
    // Les mots du pool dans une erreur de Prisma : ce n'est pas celle du pool.
    expect(
      isDatabaseSaturated(
        new Prisma.PrismaClientKnownRequestError('timeout exceeded when trying to connect', {
          code: 'P2028',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
    // Base injoignable, connexion rompue, autre service : des pannes, pas une file d'attente.
    for (const message of [
      'Connection terminated due to connection timeout',
      'Connection terminated unexpectedly',
      'connect ECONNREFUSED 10.0.0.12:5432',
      'redis: timeout exceeded when trying to connect',
      'timeout exceeded when trying to connect to the cache',
    ]) {
      expect({ message, saturated: isDatabaseSaturated(new Error(message)) }).toEqual({
        message,
        saturated: false,
      });
    }
    // Seule une erreur compte : ni un objet qui lui ressemble, ni une chaîne, ni rien.
    expect(isDatabaseSaturated({ message: 'timeout exceeded when trying to connect' })).toBe(false);
    expect(isDatabaseSaturated('timeout exceeded when trying to connect')).toBe(false);
    expect(isDatabaseSaturated(null)).toBe(false);
    expect(isDatabaseSaturated(undefined)).toBe(false);
  });
});
