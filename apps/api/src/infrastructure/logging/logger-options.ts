import type { IncomingMessage } from 'node:http';

import type { Params } from 'nestjs-pino';
import {
  type DestinationStream,
  type SerializedRequest,
  type SerializedResponse,
  stdTimeFunctions,
} from 'pino';
import type { Options } from 'pino-http';

import { REDACTED, redactSensitive } from '../../common/security/redaction.js';
import type { AppConfig } from '../../config/app-config.js';

/** Chemins expurgés quoi qu'il arrive, même si un sérialiseur venait à exposer les en-têtes. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Seuls ces champs de la requête sont journalisés : ni en-têtes, ni corps, ni paramètres d'URL.
 * (pino-http fournit ici la requête déjà normalisée ; `raw` est la requête Express d'origine.)
 */
function serializeRequest(request: SerializedRequest): Record<string, unknown> {
  const queryStart = request.url.indexOf('?');
  const clientIp = (request.raw as IncomingMessage & { ip?: string }).ip;
  return {
    id: request.id,
    method: request.method,
    // La chaîne de requête peut contenir des jetons (liens de réinitialisation…) : non journalisée.
    path: queryStart === -1 ? request.url : request.url.slice(0, queryStart),
    // Adresse du client telle que résolue par Express (tient compte des proxys de confiance).
    clientIp: clientIp ?? request.remoteAddress,
    userAgent: request.headers['user-agent'],
  };
}

function serializeResponse(response: SerializedResponse): Record<string, unknown> {
  return { statusCode: response.statusCode };
}

/**
 * Options de journalisation structurée (Pino) : JSON sur la sortie standard, une ligne
 * par événement, niveau en toutes lettres, horodatage ISO 8601, identifiant de requête
 * sur chaque ligne, et expurgation systématique des données sensibles.
 */
export function buildLoggerOptions(config: AppConfig): Options {
  return {
    level: config.log.level,
    base: {
      service: config.app.name,
      environment: config.app.environment,
      version: config.app.version,
    },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (fields) => redactSensitive(fields),
    },
    redact: { paths: REDACTED_PATHS, censor: REDACTED },
    serializers: { req: serializeRequest, res: serializeResponse },
    // L'identifiant est attribué en amont par requestIdMiddleware.
    genReqId: (request) => request.id,
    customAttributeKeys: { reqId: 'requestId' },
    quietReqLogger: true,
    customLogLevel: (_request, response, error) => {
      if (error !== undefined || response.statusCode >= 500) {
        return 'error';
      }
      return response.statusCode >= 400 ? 'warn' : 'info';
    },
    autoLogging: {
      // Les sondes de l'orchestrateur ne polluent pas les journaux.
      ignore: (request) => (request.url ?? '').startsWith('/health/'),
    },
  };
}

/**
 * Paramètres du module de journalisation. En développement (`LOG_PRETTY=true`), la sortie
 * est mise en forme pour un terminal ; partout ailleurs elle reste du JSON brut, destiné
 * à l'agrégateur de journaux.
 */
export async function createLoggerParams(
  config: AppConfig,
  destination?: DestinationStream,
): Promise<Params> {
  const options = buildLoggerOptions(config);

  if (destination !== undefined) {
    return { pinoHttp: [options, destination] };
  }
  if (config.log.pretty) {
    const { default: pretty } = await import('pino-pretty');
    return {
      pinoHttp: [
        options,
        pretty({ colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss.l' }),
      ],
    };
  }
  return { pinoHttp: options };
}
