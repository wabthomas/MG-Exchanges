import { describe, expect, it } from '@jest/globals';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AppError } from '../errors/app-error.js';
import { toProblem } from './problem-details.filter.js';

const GENERIC = 'An unexpected error occurred. Please try again later.';

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
