import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Authentification HTTP « Basic » protégeant la documentation de l'API hors développement.
 * La comparaison s'effectue en temps constant, sur des condensés de longueur fixe.
 */
export function basicAuthMiddleware(credentials: { user: string; password: string }) {
  const expected = digest(`${credentials.user}:${credentials.password}`);

  return (request: Request, response: Response, next: NextFunction): void => {
    const header = request.get('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');

    if (scheme?.toLowerCase() === 'basic' && encoded !== undefined) {
      const provided = digest(Buffer.from(encoded, 'base64').toString('utf8'));
      if (timingSafeEqual(provided, expected)) {
        next();
        return;
      }
    }

    response
      .status(401)
      .setHeader('WWW-Authenticate', 'Basic realm="MG-Exchange API documentation", charset="UTF-8"')
      .type('text/plain')
      .send('Authentication required.');
  };
}
