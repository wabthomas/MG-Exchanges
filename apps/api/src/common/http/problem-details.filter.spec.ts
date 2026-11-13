import { describe, expect, it } from '@jest/globals';
import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';

import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { ProblemDetailsFilter, toProblem } from './problem-details.filter.js';

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

  it('une transaction annulée parce qu’elle en croisait une autre est un conflit à renvoyer, pas une panne', () => {
    const conflict = {
      status: 409,
      code: 'CONFLICT',
      detail: 'The request conflicted with another one. Please try again.',
    };
    for (const sqlState of ['40001', '40P01']) {
      // Refusée pendant une instruction…
      expect({
        sqlState,
        problem: toProblem(databaseError(sqlState, 'deadlock detected on relation "users"')),
      }).toEqual({ sqlState, problem: conflict });
      // … ou à la validation de la transaction : l'erreur du pilote, telle quelle.
      const atCommit = Object.assign(new Error('could not serialize access'), {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict', originalCode: sqlState },
      });
      expect({ sqlState, problem: toProblem(atCommit) }).toEqual({ sqlState, problem: conflict });
    }
  });

  it('une règle refusée à la validation de la transaction se lit comme pendant une instruction', () => {
    const atCommit = (sqlState: string): Error =>
      Object.assign(new Error('account is closed'), {
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', originalCode: sqlState },
      });
    expect(toProblem(atCommit('MGX05'))).toEqual({
      status: 409,
      code: 'CONFLICT',
      detail: 'This account is closed.',
    });
    expect(toProblem(atCommit('MGX08'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: GENERIC,
    });
  });

  it('toute autre erreur de la base reste une erreur serveur, sans détail', () => {
    for (const sqlState of [
      'MGX01',
      'MGX02',
      'MGX03',
      'MGX04',
      'MGX08',
      'MGX09',
      '23505',
      '23503',
      '55P03',
      '40002',
      '40003',
    ]) {
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

describe('ProblemDetailsFilter', () => {
  const REQUEST_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  interface Logged {
    readonly level: 'error' | 'warn';
    readonly fields: unknown;
    readonly message: string;
  }

  interface Sent {
    status?: number;
    type?: string;
    body?: Record<string, unknown>;
    readonly headers: Record<string, unknown>;
  }

  /** Le filtre, un journal qui retient ce qu'on lui confie, et une requête HTTP simulée. */
  function setup(options: { headersSent?: boolean; transport?: string } = {}): {
    filter: ProblemDetailsFilter;
    host: ArgumentsHost;
    logged: Logged[];
    sent: Sent;
  } {
    const logged: Logged[] = [];
    const logger = {
      setContext: (): void => undefined,
      error: (fields: unknown, message: string): void => {
        logged.push({ level: 'error', fields, message });
      },
      warn: (fields: unknown, message: string): void => {
        logged.push({ level: 'warn', fields, message });
      },
    } as unknown as PinoLogger;

    const sent: Sent = { headers: {} };
    const response = {
      headersSent: options.headersSent ?? false,
      setHeader(name: string, value: unknown): void {
        sent.headers[name] = value;
      },
      status(code: number): unknown {
        sent.status = code;
        return response;
      },
      type(mediaType: string): unknown {
        sent.type = mediaType;
        return response;
      },
      json(body: Record<string, unknown>): unknown {
        sent.body = body;
        return response;
      },
    };
    const request = {
      id: REQUEST_ID,
      originalUrl: '/api/v1/me/wallets?limit=5',
      path: '/api/v1/me/wallets',
    };
    const host = {
      getType: () => options.transport ?? 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    return { filter: new ProblemDetailsFilter(logger), host, logged, sent };
  }

  /** Transaction annulée par PostgreSQL à sa validation (`COMMIT`). */
  const conflictAtCommit = (sqlState: string): Error =>
    Object.assign(new Error('could not serialize access'), {
      name: 'DriverAdapterError',
      cause: { kind: 'TransactionWriteConflict', originalCode: sqlState },
    });

  it('journalise une erreur inattendue avec sa cause, et ne répond qu’un message générique', () => {
    const { filter, host, logged, sent } = setup();
    const failure = new Error('connect ECONNREFUSED 10.0.0.12:5432');
    filter.catch(failure, host);

    expect(logged).toEqual([
      {
        level: 'error',
        fields: { err: failure, requestId: REQUEST_ID, code: 'INTERNAL_ERROR' },
        message: 'Request failed',
      },
    ]);
    expect(sent.status).toBe(500);
    expect(sent.type).toBe('application/problem+json');
    expect(sent.body).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: GENERIC,
      // Le chemin demandé, sans ses paramètres.
      instance: '/api/v1/me/wallets',
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(sent.body)).not.toContain('ECONNREFUSED');
  });

  it('une transaction abandonnée pour conflit répond 409 et laisse un avertissement, pas une erreur', () => {
    const conflicts = [
      databaseError('40P01', 'deadlock detected'),
      databaseError('40001', 'could not serialize access'),
      conflictAtCommit('40001'),
      conflictAtCommit('40P01'),
    ];
    for (const conflict of conflicts) {
      const { filter, host, logged, sent } = setup();
      filter.catch(conflict, host);

      expect(logged).toEqual([
        {
          level: 'warn',
          fields: { err: conflict, requestId: REQUEST_ID },
          message: 'Request abandoned: its transaction conflicted with another one',
        },
      ]);
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({
        code: 'CONFLICT',
        detail: 'The request conflicted with another one. Please try again.',
        requestId: REQUEST_ID,
      });
    }
  });

  it('un refus ordinaire ne laisse rien dans les journaux', () => {
    const refusals: [unknown, number][] = [
      [new AppError('VALIDATION_FAILED', 'Request validation failed.'), 400],
      [new AppError('CONFLICT', 'Asset USD is already registered.'), 409],
      [new NotFoundException('Cannot GET /x'), 404],
      // Écriture arrivée après la clôture du compte : un conflit, mais pas entre transactions.
      [databaseError('MGX05', 'account is closed'), 409],
    ];
    for (const [refusal, status] of refusals) {
      const { filter, host, logged, sent } = setup();
      filter.catch(refusal, host);
      expect(logged).toEqual([]);
      expect(sent.status).toBe(status);
    }
  });

  it('une erreur 401 annonce le schéma d’authentification attendu', () => {
    const { filter, host, logged, sent } = setup();
    filter.catch(new AppError('UNAUTHENTICATED', 'Authentication is required.'), host);
    expect(sent.status).toBe(401);
    expect(sent.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    expect(logged).toEqual([]);
  });

  it('réponse déjà commencée : l’erreur est journalisée, rien de plus n’est écrit', () => {
    const { filter, host, logged, sent } = setup({ headersSent: true });
    filter.catch(new Error('stream interrupted'), host);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'error', message: 'Request failed' });
    expect(sent).toEqual({ headers: {} });
  });

  it('hors HTTP, l’erreur est relancée telle quelle', () => {
    const { filter, host, logged, sent } = setup({ transport: 'rpc' });
    const failure = new Error('not an HTTP request');
    expect(() => {
      filter.catch(failure, host);
    }).toThrow(failure);
    expect(logged).toEqual([]);
    expect(sent).toEqual({ headers: {} });
  });
});
