import { randomUUID } from 'node:crypto';

import { REQUEST_ID_PATTERN } from '@mgx/validation';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Attribue à chaque requête un identifiant de corrélation, repris dans les journaux,
 * les réponses d'erreur et l'en-tête `X-Request-Id` de la réponse.
 *
 * Un identifiant fourni par l'appelant (ou par le reverse proxy) n'est conservé que s'il
 * respecte un format strict : il est recopié dans les journaux et ne doit pas permettre
 * d'y injecter du contenu.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const provided = request.get(REQUEST_ID_HEADER);
  const requestId =
    provided !== undefined && REQUEST_ID_PATTERN.test(provided) ? provided : randomUUID();

  request.id = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

/** Identifiant de corrélation de la requête (toujours défini après le middleware). */
export function getRequestId(request: Request): string {
  return typeof request.id === 'string' ? request.id : randomUUID();
}
