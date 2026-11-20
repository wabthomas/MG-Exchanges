import type { IncomingMessage } from 'node:http';

import type { Request, Response } from 'express';
import type { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { type RawBodyLimits, readRawBody } from './raw-body.js';

/**
 * Corps JSON plus volumineux que la limite commune (`HTTP_BODY_LIMIT_BYTES`).
 *
 * L'analyseur global lit le corps de toute requête JSON **avant** l'authentification : sa
 * limite est donc basse. Les rares routes qui reçoivent davantage sont citées ici ; pour elles,
 * l'analyseur global ne lit rien, et la route lit elle-même son corps avec `readJsonBody`,
 * **après** les gardes — authentification, permissions, quotas.
 */
const DEFERRED_JSON_BODY_ROUTES: readonly { readonly method: string; readonly path: RegExp }[] = [
  // Publication d'une version des conditions d'utilisation.
  { method: 'POST', path: /^\/api\/v1\/admin\/terms\/versions\/?$/i },
];

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

function isJson(request: IncomingMessage): boolean {
  return JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '');
}

/** Vrai si le corps de cette requête est lu par la route elle-même. */
export function hasDeferredJsonBody(request: IncomingMessage): boolean {
  const path = (request.url ?? '').split('?')[0] ?? '';
  return DEFERRED_JSON_BODY_ROUTES.some(
    (route) => route.method === request.method && route.path.test(path),
  );
}

/** Vrai si l'analyseur global doit lire le corps de cette requête : JSON, et non différé. */
export function isParsedGlobally(request: IncomingMessage): boolean {
  return isJson(request) && !hasDeferredJsonBody(request);
}

/**
 * Lit et valide le corps JSON d'une route à corps différé. À n'appeler qu'après les contrôles
 * qui peuvent refuser la requête : jusque-là, rien n'a été lu.
 *
 * Le texte doit être de l'UTF-8 valide — un fichier enregistré dans un autre encodage est
 * refusé, plutôt que conservé avec des caractères de remplacement.
 *
 * @throws AppError `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `REQUEST_TIMEOUT`,
 *   `MALFORMED_REQUEST` ou `VALIDATION_FAILED`.
 */
export async function readJsonBody<Output>(
  request: Request,
  response: Response,
  schema: z.ZodType<Output>,
  limits: RawBodyLimits,
): Promise<Output> {
  if (!isJson(request)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The request body must be JSON.');
  }

  let value: unknown;
  if (request.readableEnded) {
    // L'analyseur global l'a déjà lu : la requête n'a pas été reconnue comme différée (variante
    // d'écriture du chemin). Un corps qui tient dans la limite commune reste accepté.
    value = request.body as unknown;
  } else {
    const raw = await readRawBody(request, response, limits);
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    } catch (error) {
      throw new AppError('MALFORMED_REQUEST', 'The request body is not valid JSON.', {
        cause: error,
      });
    }
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
