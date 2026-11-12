import { describe, expect, it } from '@jest/globals';

import { Prisma } from '../../generated/prisma/client.js';
import { isUniqueViolation, sqlStateOf } from './database-errors.js';

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

describe('erreurs de base de données', () => {
  it('retrouve le code SQLSTATE d’une erreur levée par PostgreSQL', () => {
    expect(sqlStateOf(databaseError('P2010', 'MGX02'))).toBe('MGX02');
    expect(sqlStateOf(databaseError('P2039', '42501'))).toBe('42501');
    expect(sqlStateOf(databaseError('P2004', '23514'))).toBe('23514');
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
});
