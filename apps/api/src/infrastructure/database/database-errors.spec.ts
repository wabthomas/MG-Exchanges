import { describe, expect, it } from '@jest/globals';

import { Prisma } from '../../generated/prisma/client.js';
import {
  ACCOUNT_CLOSED_SQLSTATE,
  isAccountClosedError,
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
});
