import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type AppEnvironment, envSchema, type LogLevel, type ValidatedEnv } from './env.schema.js';

export const SERVICE_NAME = 'mg-exchange-api';

/** Levée au démarrage lorsque la configuration est invalide. Ne contient jamais de valeur. */
export class ConfigValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

/**
 * Configuration typée de l'application, construite une seule fois à partir de
 * l'environnement validé. C'est l'unique point d'accès à la configuration : aucun autre
 * fichier ne lit `process.env`.
 */
export class AppConfig {
  readonly app: {
    readonly name: string;
    readonly version: string;
    readonly environment: AppEnvironment;
    readonly host: string;
    readonly port: number;
    readonly trustProxyHops: number;
  };

  readonly http: {
    readonly corsAllowedOrigins: readonly string[];
    readonly bodyLimitBytes: number;
    readonly rateLimit: { readonly windowMs: number; readonly maxRequests: number };
  };

  readonly log: { readonly level: LogLevel; readonly pretty: boolean };

  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly connectionTimeoutMs: number;
    readonly statementTimeoutMs: number;
  };

  readonly redis: {
    readonly url: string;
    readonly queueUrl: string;
    /** Préfixe de toutes les clés : isole les environnements partageant un même Redis. */
    readonly keyPrefix: string;
  };

  readonly swagger: {
    readonly enabled: boolean;
    readonly credentials: { readonly user: string; readonly password: string } | null;
  };

  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
  };

  constructor(env: ValidatedEnv, version: string) {
    this.app = {
      name: SERVICE_NAME,
      version,
      environment: env.APP_ENV,
      host: env.HOST,
      port: env.PORT,
      trustProxyHops: env.TRUST_PROXY_HOPS,
    };
    this.http = {
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
      bodyLimitBytes: env.HTTP_BODY_LIMIT_BYTES,
      rateLimit: {
        windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
        maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
      },
    };
    this.log = { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY };
    this.database = {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    };
    this.redis = {
      url: env.REDIS_URL,
      queueUrl: env.QUEUE_REDIS_URL ?? env.REDIS_URL,
      keyPrefix: `mgx:${env.APP_ENV}:`,
    };
    this.swagger = {
      // Par défaut : documentation servie uniquement sur les environnements de développement.
      enabled: env.SWAGGER_ENABLED ?? ['local', 'development', 'test'].includes(env.APP_ENV),
      credentials:
        env.SWAGGER_USER !== undefined && env.SWAGGER_PASSWORD !== undefined
          ? { user: env.SWAGGER_USER, password: env.SWAGGER_PASSWORD }
          : null,
    };
    this.outbox = {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    };
    Object.freeze(this);
  }

  get isProduction(): boolean {
    return this.app.environment === 'production';
  }
}

/**
 * Valide l'environnement et construit la configuration.
 *
 * @throws ConfigValidationError listant les variables fautives — sans jamais leurs valeurs,
 *   qui peuvent être des secrets.
 */
export function loadAppConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // Une variable définie mais vide est traitée comme absente.
  const defined = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );

  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.join('.') : '(environment)';
      const missing = issue.code === 'invalid_type' && !(variable in defined);
      return `${variable}: ${missing ? 'is required.' : issue.message}`;
    });
    throw new ConfigValidationError(problems);
  }

  return new AppConfig(result.data, readPackageVersion());
}

function readPackageVersion(): string {
  // Même profondeur relative depuis `src/config` (tests) et `dist/config` (exécution).
  const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
