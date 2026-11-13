import { type NestApplicationOptions, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

import { isParsedGlobally } from '../common/http/deferred-json-body.js';
import { sendProblem } from '../common/http/problem-details.filter.js';
import { REQUEST_ID_HEADER, requestIdMiddleware } from '../common/http/request-id.middleware.js';
import { AppConfig } from '../config/app-config.js';
import { setupOpenApi } from './openapi.js';

export const API_PREFIX = 'api';

/** Routes servies hors préfixe `/api` : sondes de l'orchestrateur. */
const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];

/** Options de création de l'application, communes au lancement réel et aux tests de bout en bout. */
export const NEST_APPLICATION_OPTIONS: NestApplicationOptions = {
  // Les journaux émis pendant l'initialisation sont restitués par Pino une fois celui-ci prêt.
  bufferLogs: true,
  // L'analyse du corps est configurée explicitement ci-dessous (JSON uniquement, taille bornée).
  bodyParser: false,
};

function noStore(_request: Request, response: Response, next: NextFunction): void {
  // Aucune réponse de l'API (données financières et personnelles) ne doit être mise en cache.
  response.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Configuration HTTP de l'application : sécurité, analyse des requêtes, versionnage,
 * documentation. Appliquée à l'identique en exécution réelle et dans les tests.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  const isLocal = ['local', 'test'].includes(config.app.environment);

  app.useLogger(app.get(Logger));

  // En-têtes de sécurité (équivalents à Helmet 8), posés sur toutes les réponses.
  app.useSecurityHeaders({
    // Une API n'a jamais à être affichée dans un cadre : protection contre le détournement de clic.
    xFrameOptions: { action: 'deny' },
    contentSecurityPolicy: {
      directives: {
        frameAncestors: ["'none'"],
        // En local, l'API est servie en HTTP : pas de réécriture forcée vers HTTPS.
        ...(isLocal ? { upgradeInsecureRequests: null } : {}),
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
  });

  // Nombre de proxys de confiance : détermine l'adresse IP cliente (limitation de débit, audit).
  app.set('trust proxy', config.app.trustProxyHops);

  app.use(requestIdMiddleware);
  app.use(noStore);

  // API JSON uniquement : les formulaires (`x-www-form-urlencoded`, `multipart`) ne sont pas
  // analysés, ce qui écarte les requêtes inter-sites « simples » forgées par un formulaire.
  // Les rares routes dont le corps dépasse la limite commune le lisent elles-mêmes, après
  // l'authentification (voir `deferred-json-body.ts`).
  app.useBodyParser('json', { limit: config.http.bodyLimitBytes, type: isParsedGlobally });

  if (config.http.corsAllowedOrigins.length > 0) {
    app.enableCors({
      origin: config.http.corsAllowedOrigins.includes('*')
        ? true
        : [...config.http.corsAllowedOrigins],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
      maxAge: 600,
    });
  }

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  app.enableVersioning({ type: VersioningType.URI });
  app.enableShutdownHooks();

  setupOpenApi(app, config);
}

/**
 * Initialise l'application puis installe le dernier maillon de la chaîne HTTP : toute
 * requête qu'aucune route n'a traitée (y compris hors préfixe `/api`) reçoit une erreur
 * `NOT_FOUND` au format normalisé, plutôt que la page HTML par défaut d'Express.
 */
export async function initializeApp(app: NestExpressApplication): Promise<void> {
  await app.init();
  app.use((request: Request, response: Response) => {
    sendProblem(request, response, {
      status: 404,
      code: 'NOT_FOUND',
      detail: `Cannot ${request.method} ${request.path}`,
    });
  });
}
