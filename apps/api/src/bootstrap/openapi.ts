import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import { PROBLEM_OPENAPI_SCHEMA, PROBLEM_SCHEMA_NAME } from '../common/http/openapi.js';
import type { AppConfig } from '../config/app-config.js';
import { basicAuthMiddleware } from './basic-auth.middleware.js';

/** Chemin de l'interface Swagger ; le document brut est servi sous `<chemin>-json`. */
export const OPENAPI_PATH = 'api/docs';

const DESCRIPTION = [
  'MG-Exchange platform API.',
  '',
  '**Conventions**',
  '- Versioned routes: `/api/v1/...`.',
  '- Monetary amounts are decimal **strings** (`"12.34"`), never JSON numbers.',
  '- Timestamps are ISO 8601 in UTC.',
  '- Errors use `application/problem+json` (RFC 9457) with a stable `code` and the `requestId`.',
  '- Every route requires `Authorization: Bearer <accessToken>` unless stated otherwise.',
  '- Every response carries an `X-Request-Id` header for support and log correlation.',
].join('\n');

export function buildOpenApiDocument(
  app: NestExpressApplication,
  config: AppConfig,
): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('MG-Exchange API')
    .setDescription(DESCRIPTION)
    .setVersion(config.app.version)
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'opaque',
      description: 'Access token of a session, returned by `POST /api/v1/auth/login`.',
    })
    .addTag('System', 'Platform status and feature availability')
    .addTag('Authentication', 'Sign-up, sign-in, session tokens, password')
    .addTag('Account', 'The signed-in account and its sessions')
    .addTag('Wallets', 'Balances and movements of the signed-in account (read-only)')
    .addTag('Administration', 'Back-office (requires permissions)')
    .addTag('Health', 'Liveness and readiness probes (infrastructure)')
    .build();

  const document = SwaggerModule.createDocument(app, options);
  // Schéma d'erreur partagé : référencé par toutes les réponses d'erreur.
  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      [PROBLEM_SCHEMA_NAME]: PROBLEM_OPENAPI_SCHEMA,
    },
  };
  return document;
}

/**
 * Expose la documentation OpenAPI selon les règles d'environnement : jamais en production,
 * derrière une authentification en pré-production, librement en développement
 * (règles appliquées à la validation de la configuration).
 */
export function setupOpenApi(app: NestExpressApplication, config: AppConfig): void {
  if (!config.swagger.enabled) {
    return;
  }

  if (config.swagger.credentials !== null) {
    app.use(
      [`/${OPENAPI_PATH}`, `/${OPENAPI_PATH}-json`, `/${OPENAPI_PATH}-yaml`],
      basicAuthMiddleware(config.swagger.credentials),
    );
  }

  SwaggerModule.setup(OPENAPI_PATH, app, () => buildOpenApiDocument(app, config), {
    customSiteTitle: 'MG-Exchange API',
  });
}
