import { describe, expect, it } from '@jest/globals';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { toProblem } from './problem-details.filter.js';

const GENERIC = 'An unexpected error occurred. Please try again later.';

/** Erreur telle que Prisma la lève lorsque PostgreSQL refuse une instruction. */
function databaseError(sqlState: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2010',
    clientVersion: 'test',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', originalCode: sqlState, originalMessage: message },
      },
    },
  });
}

describe('toProblem', () => {
  it('traduit une erreur applicative selon le catalogue public', () => {
    const errors = [{ path: 'amount', message: 'Must be a canonical decimal string.' }];
    expect(
      toProblem(new AppError('VALIDATION_FAILED', 'Request validation failed.', { errors })),
    ).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Request validation failed.',
      errors,
    });
    expect(
      toProblem(new AppError('FEATURE_DISABLED', 'This feature is not available.')),
    ).toMatchObject({
      status: 403,
      code: 'FEATURE_DISABLED',
    });
    expect(toProblem(new AppError('MAINTENANCE', 'Back soon.'))).toMatchObject({
      status: 503,
      code: 'MAINTENANCE',
    });
  });

  it('associe un code stable aux exceptions HTTP du framework', () => {
    expect(toProblem(new NotFoundException('Cannot GET /x'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Cannot GET /x',
    });
    expect(toProblem(new BadRequestException('Malformed body'))).toMatchObject({
      status: 400,
      code: 'MALFORMED_REQUEST',
    });
    expect(toProblem(new HttpException('Too many', 429))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    expect(toProblem(new HttpException('Teapot', 418))).toMatchObject({
      status: 418,
      code: 'MALFORMED_REQUEST',
    });
    expect(toProblem(new ServiceUnavailableException('Not ready'))).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'Not ready',
    });
  });

  it('reprend le code explicite d’une exception HTTP lorsqu’il appartient au catalogue', () => {
    expect(toProblem(new BadRequestException('Nope', { errorCode: 'CONFLICT' }))).toMatchObject({
      status: 400,
      code: 'CONFLICT',
    });
    expect(
      toProblem(new BadRequestException('Nope', { errorCode: 'NOT_IN_CATALOGUE' })),
    ).toMatchObject({
      code: 'MALFORMED_REQUEST',
    });
  });

  it('une écriture arrivée après la clôture du compte est un conflit, pas une panne', () => {
    const message =
      'account 0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d is closed: nothing can be added to it (user_sessions)';
    // Le message de la base — identifiant du compte, nom de la table — ne sort pas.
    expect(toProblem(databaseError('MGX05', message))).toEqual({
      status: 409,
      code: 'CONFLICT',
      detail: 'This account is closed.',
    });
  });

  it('toute autre erreur de la base reste une erreur serveur, sans détail', () => {
    for (const sqlState of ['MGX01', 'MGX02', 'MGX03', 'MGX04', '23505', '23503', '40P01']) {
      expect({ sqlState, problem: toProblem(databaseError(sqlState, 'relation "users"')) }).toEqual(
        { sqlState, problem: { status: 500, code: 'INTERNAL_ERROR', detail: GENERIC } },
      );
    }
    // Le code ne se lit que dans l'erreur d'origine : un message qui le cite ne suffit pas.
    expect(toProblem(new Error('MGX05'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(toProblem({ code: 'MGX05' })).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('masque toute erreur serveur ou inattendue derrière un message générique', () => {
    const leaks = [
      new Error('connect ECONNREFUSED 10.0.0.12:5432'),
      new TypeError("Cannot read properties of undefined (reading 'secret')"),
      new InternalServerErrorException('stack trace with password=hunter2'),
      new HttpException('weird status', 302),
      'a thrown string',
      { message: 'a thrown object' },
      undefined,
    ];
    for (const exception of leaks) {
      const problem = toProblem(exception);
      expect(problem).toMatchObject({ code: 'INTERNAL_ERROR', detail: GENERIC });
      expect(problem.status).toBe(500);
      expect(problem.errors).toBeUndefined();
    }
  });
});
