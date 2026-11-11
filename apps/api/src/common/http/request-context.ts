import { isIP } from 'node:net';

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { getRequestId } from './request-id.middleware.js';

/** Contexte technique d'une requête, conservé dans le journal d'audit et les sessions. */
export interface RequestContext {
  readonly requestId: string;
  /** Adresse du client, résolue selon le nombre de proxys de confiance. */
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
}

const USER_AGENT_MAX_LENGTH = 512;

export function toRequestContext(request: Request): RequestContext {
  // Ces valeurs sont enregistrées en base (audit, sessions) : l'adresse n'est retenue que si
  // c'en est une — derrière un proxy mal configuré, `X-Forwarded-For` peut contenir n'importe
  // quoi — et l'agent utilisateur est borné.
  const address = request.ip ?? request.socket.remoteAddress;
  return {
    requestId: getRequestId(request),
    ipAddress: address !== undefined && isIP(address) !== 0 ? address : undefined,
    userAgent: request.get('user-agent')?.slice(0, USER_AGENT_MAX_LENGTH),
  };
}

/** Injecte le {@link RequestContext} de la requête en cours. */
export const ReqContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext =>
    toRequestContext(context.switchToHttp().getRequest<Request>()),
);
