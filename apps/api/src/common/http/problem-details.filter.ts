import {
  ERROR_CODES,
  type ErrorCode,
  type FieldError,
  isErrorCode,
  PROBLEM_JSON_MEDIA_TYPE,
  type ProblemDetails,
} from '@mgx/contracts';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCOUNT_CLOSED_SQLSTATE,
  isTransactionConflict,
  sqlStateOf,
} from '../../infrastructure/database/database-errors.js';
import { AppError } from '../errors/app-error.js';
import { getRequestId } from './request-id.middleware.js';

const GENERIC_SERVER_ERROR_DETAIL = 'An unexpected error occurred. Please try again later.';

/** Code du catalogue associé par défaut à un statut HTTP levé sans code explicite. */
const DEFAULT_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'MALFORMED_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export interface Problem {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly errors?: readonly FieldError[] | undefined;
  /** Délai avant nouvelle tentative (en-tête `Retry-After`), en secondes. */
  readonly retryAfterSeconds?: number | undefined;
}

/** Traduit n'importe quelle exception en erreur publique, sans jamais exposer de détail interne. */
export function toProblem(exception: unknown): Problem {
  if (exception instanceof AppError) {
    return {
      status: ERROR_CODES[exception.code].status,
      code: exception.code,
      detail: exception.message,
      errors: exception.errors,
      retryAfterSeconds: exception.retryAfterSeconds,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status < 400 || status > 599) {
      return { status: 500, code: 'INTERNAL_ERROR', detail: GENERIC_SERVER_ERROR_DETAIL };
    }
    if (status >= 500 && status !== 503) {
      return { status, code: 'INTERNAL_ERROR', detail: GENERIC_SERVER_ERROR_DETAIL };
    }
    const code = isErrorCode(exception.errorCode)
      ? exception.errorCode
      : (DEFAULT_CODE_BY_STATUS[status] ?? 'MALFORMED_REQUEST');
    return { status, code, detail: exception.message };
  }

  // Écriture refusée par la base parce que le compte est clôturé. Ce n'est pas un défaut : la
  // requête était en cours quand le compte a été clôturé. Aucun service n'a à s'en soucier —
  // la réponse est la même partout.
  if (sqlStateOf(exception) === ACCOUNT_CLOSED_SQLSTATE) {
    return { status: 409, code: 'CONFLICT', detail: 'This account is closed.' };
  }

  // Transaction annulée par la base parce qu'elle en croisait une autre, y compris après ses
  // nouvelles tentatives. Rien n'a été écrit : la requête peut être renvoyée telle quelle.
  if (isTransactionConflict(exception)) {
    return {
      status: 409,
      code: 'CONFLICT',
      detail: 'The request conflicted with another one. Please try again.',
    };
  }

  return { status: 500, code: 'INTERNAL_ERROR', detail: GENERIC_SERVER_ERROR_DETAIL };
}

/** Écrit la réponse d'erreur normalisée (`application/problem+json`). */
export function sendProblem(request: Request, response: Response, problem: Problem): void {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: ERROR_CODES[problem.code].title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    // `originalUrl` : chemin complet demandé, sans la chaîne de requête.
    instance: request.originalUrl.split('?')[0] ?? request.path,
    requestId: getRequestId(request),
    timestamp: new Date().toISOString(),
    ...(problem.errors !== undefined && problem.errors.length > 0
      ? { errors: [...problem.errors] }
      : {}),
  };

  if (problem.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', Math.max(1, Math.ceil(problem.retryAfterSeconds)));
  }
  // RFC 6750 : une réponse 401 indique le schéma d'authentification attendu.
  if (problem.status === 401) {
    response.setHeader('WWW-Authenticate', 'Bearer');
  }
  response.status(problem.status).type(PROBLEM_JSON_MEDIA_TYPE).json(body);
}

/**
 * Gestion centralisée des erreurs HTTP.
 *
 * Toute exception — applicative, HTTP ou inattendue — produit la même forme de réponse
 * (`application/problem+json`, RFC 9457) portant un `code` stable et l'identifiant de la
 * requête. Les erreurs inattendues sont journalisées avec leur pile d'appels et masquées
 * au client derrière un message générique.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ProblemDetailsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const problem = toProblem(exception);
    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: getRequestId(request), code: problem.code },
        'Request failed',
      );
    } else if (isTransactionConflict(exception)) {
      // Pas un défaut, mais un signal : des requêtes se disputent les mêmes lignes.
      this.logger.warn(
        { err: exception, requestId: getRequestId(request) },
        'Request abandoned: its transaction conflicted with another one',
      );
    }

    if (response.headersSent) {
      return;
    }

    sendProblem(request, response, problem);
  }
}
