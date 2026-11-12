import { isAbsolute } from 'node:path';

import { emailSchema } from '@mgx/validation';
import { z } from 'zod';

export const APP_ENVIRONMENTS = ['local', 'development', 'staging', 'production', 'test'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Environnements exposés à des utilisateurs ou à des données réelles : règles durcies. */
const HARDENED_ENVIRONMENTS: readonly AppEnvironment[] = ['staging', 'production'];

/**
 * Modes de remise des notifications : boîte en mémoire (développement, tests), serveur SMTP
 * d'un prestataire d'e-mail, ou aucun.
 */
export const NOTIFICATION_DELIVERY_MODES = ['memory', 'smtp', 'none'] as const;
export type NotificationDelivery = (typeof NOTIFICATION_DELIVERY_MODES)[number];

/**
 * Chiffrement de la connexion SMTP : `starttls` (port 587, chiffrement exigé avant tout
 * échange), `tls` (port 465, chiffrée dès l'ouverture) ou `none` (aucune exigence — outils
 * locaux uniquement).
 */
export const SMTP_SECURITY_MODES = ['starttls', 'tls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

/** Expéditeur des e-mails : adresse, et nom affiché facultatif. */
export interface EmailSender {
  readonly name: string | null;
  readonly address: string;
}

/**
 * Coût minimal d'Argon2id hors développement (recommandation OWASP : 19 Mio, 2 passes).
 * Les tests utilisent un coût réduit ; un environnement réel ne le peut pas.
 */
export const MIN_PASSWORD_HASH_MEMORY_KIB = 19_456;
export const MIN_PASSWORD_HASH_PASSES = 2;

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, { error: 'Must be a whole number.' })
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const urlWithProtocol = (protocols: readonly string[]) =>
  z.string().refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { error: `Must be a URL using one of: ${protocols.join(', ')}` },
  );

const SENDER_PATTERN = /^(?:(?<name>[^<>"]*)<(?<bracketed>[^<>\s]+)>|(?<bare>[^<>\s]+))$/u;
const SENDER_NAME_MAX_LENGTH = 64;

/** Expéditeur au format `adresse` ou `Nom affiché <adresse>`. */
const emailSender = z.string().transform((value, context): EmailSender => {
  const groups = SENDER_PATTERN.exec(value.trim())?.groups;
  const address = emailSchema.safeParse(groups?.['bracketed'] ?? groups?.['bare'] ?? '');
  const name = groups?.['name']?.trim() ?? '';
  // Un nom affiché ne contient ni caractère de contrôle ni saut de ligne : il devient un en-tête.
  const nameIsSafe = name.length <= SENDER_NAME_MAX_LENGTH && !/\p{Cc}/u.test(name);
  if (!address.success || !nameIsSafe) {
    context.addIssue({
      code: 'custom',
      message: 'Must look like "no-reply@example.com" or "Display name <no-reply@example.com>".',
    });
    return z.NEVER;
  }
  return { name: name === '' ? null : name, address: address.data };
});

/** Vrai si `value` est l'encodage base64 canonique d'exactement 32 octets (clé AES-256). */
function isBase64Key32(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

/** Liste d'origines CORS séparées par des virgules ; `*` n'est toléré qu'hors environnements durcis. */
const originList = z.string().transform((value, context) => {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (!origins.every((origin) => origin === '*' || isOrigin(origin))) {
    context.addIssue({
      code: 'custom',
      message: 'Each origin must look like "https://app.example.com" (scheme and host, no path).',
    });
    return z.NEVER;
  }
  return origins;
});

/**
 * Schéma des variables d'environnement de l'API.
 *
 * Toute la configuration est validée au démarrage : une valeur absente ou invalide empêche
 * le lancement (échec immédiat et explicite plutôt qu'un comportement indéfini en production).
 */
export const envSchema = z
  .object({
    // --- Application ---
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_ENV: z.enum(APP_ENVIRONMENTS).default('local'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: integer(1, 65_535).default(3000),
    /** Nombre de proxys de confiance devant l'API (0 = connexion directe, 1 = Nginx). */
    TRUST_PROXY_HOPS: integer(0, 5).default(0),

    // --- HTTP ---
    CORS_ALLOWED_ORIGINS: originList.default([]),
    HTTP_BODY_LIMIT_BYTES: integer(1024, 10_485_760).default(102_400),
    RATE_LIMIT_WINDOW_SECONDS: integer(1, 3600).default(60),
    RATE_LIMIT_MAX_REQUESTS: integer(1, 100_000).default(120),

    // --- Journalisation ---
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_PRETTY: booleanFlag.default(false),

    // --- PostgreSQL ---
    DATABASE_URL: urlWithProtocol(['postgresql:', 'postgres:']),
    DATABASE_POOL_MAX: integer(1, 200).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: integer(100, 60_000).default(5000),
    DATABASE_STATEMENT_TIMEOUT_MS: integer(100, 600_000).default(15_000),

    // --- Redis ---
    REDIS_URL: urlWithProtocol(['redis:', 'rediss:']),
    /** Redis dédié aux files BullMQ (politique `noeviction`). Par défaut : REDIS_URL. */
    QUEUE_REDIS_URL: urlWithProtocol(['redis:', 'rediss:']).optional(),

    // --- Documentation OpenAPI ---
    SWAGGER_ENABLED: booleanFlag.optional(),
    SWAGGER_USER: z.string().min(1).optional(),
    SWAGGER_PASSWORD: z.string().min(12).optional(),

    // --- Boîte d'envoi transactionnelle ---
    OUTBOX_POLL_INTERVAL_MS: integer(100, 60_000).default(1000),
    OUTBOX_BATCH_SIZE: integer(1, 1000).default(100),
    OUTBOX_MAX_ATTEMPTS: integer(1, 100).default(10),

    // --- Identité et sessions ---
    /**
     * Clé du HMAC des codes à usage unique : un code n'est jamais stocké, et son empreinte
     * est inexploitable sans cette clé, absente de la base de données.
     */
    AUTH_CODE_HMAC_SECRET: z.string().min(32, { error: 'Must be at least 32 characters.' }),
    AUTH_CODE_TTL_SECONDS: integer(60, 3600).default(900),
    /**
     * Clé AES-256 des secrets que l'application doit pouvoir relire (secret TOTP du second
     * facteur) : ils sont chiffrés en base, et inexploitables sans cette clé. 32 octets
     * aléatoires encodés en base64 (`openssl rand -base64 32`).
     */
    AUTH_SECRETS_ENCRYPTION_KEY: z.string().refine(isBase64Key32, {
      error: 'Must be 32 random bytes encoded in base64 (openssl rand -base64 32).',
    }),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: integer(60, 3600).default(600),
    /** Durée d'inactivité au-delà de laquelle une session expire (14 jours). */
    AUTH_SESSION_IDLE_TTL_SECONDS: integer(300, 7_776_000).default(1_209_600),
    /** Durée de vie maximale d'une session, quelle que soit son activité (60 jours). */
    AUTH_SESSION_ABSOLUTE_TTL_SECONDS: integer(300, 31_536_000).default(5_184_000),
    /**
     * Délai pendant lequel un jeton de renouvellement déjà utilisé reste accepté (réponse
     * perdue sur un réseau instable). Au-delà, sa réutilisation révoque la session.
     */
    AUTH_REFRESH_REUSE_GRACE_SECONDS: integer(0, 60).default(10),
    /** Coût d'Argon2id : mémoire (Kio) et nombre de passes. */
    AUTH_PASSWORD_HASH_MEMORY_KIB: integer(8, 1_048_576).default(MIN_PASSWORD_HASH_MEMORY_KIB),
    AUTH_PASSWORD_HASH_PASSES: integer(1, 10).default(MIN_PASSWORD_HASH_PASSES),

    // --- Notifications ---
    /**
     * Par défaut : `smtp` dès que SMTP_HOST est défini ; sinon `memory` en local, development
     * et test, et `none` ailleurs.
     */
    NOTIFICATION_DELIVERY: z.enum(NOTIFICATION_DELIVERY_MODES).optional(),
    /** Serveur SMTP du prestataire d'e-mail. Le définir active l'envoi réel des e-mails. */
    SMTP_HOST: z
      .string()
      .regex(/^[A-Za-z0-9.:-]+$/, { error: 'Must be a host name or an IP address.' })
      .optional(),
    /** Par défaut : 465 si SMTP_SECURITY vaut `tls`, 587 sinon. */
    SMTP_PORT: integer(1, 65_535).optional(),
    SMTP_SECURITY: z.enum(SMTP_SECURITY_MODES).default('starttls'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    /** Expéditeur des e-mails : `adresse` ou `Nom affiché <adresse>`. */
    EMAIL_FROM: emailSender.optional(),

    // --- Vérification d'identité (KYC) ---
    /**
     * Répertoire (chemin absolu) où sont conservées, chiffrées, les pièces jointes aux dossiers
     * de vérification. Défini avec KYC_ENCRYPTION_KEY, il rend la vérification d'identité
     * utilisable ; sans eux, ses routes répondent « indisponible ».
     */
    KYC_STORAGE_DIR: z
      .string()
      .refine((value) => isAbsolute(value), { error: 'Must be an absolute path.' })
      .optional(),
    /**
     * Clé maîtresse du chiffrement des pièces et des numéros de pièce d'identité : 32 octets
     * aléatoires encodés en base64 (`openssl rand -base64 32`). Distincte de
     * AUTH_SECRETS_ENCRYPTION_KEY. La perdre, c'est perdre toutes les pièces.
     */
    KYC_ENCRYPTION_KEY: z
      .string()
      .refine(isBase64Key32, {
        error: 'Must be 32 random bytes encoded in base64 (openssl rand -base64 32).',
      })
      .optional(),
  })
  .superRefine((env, context) => {
    const hardened = HARDENED_ENVIRONMENTS.includes(env.APP_ENV);
    const issue = (path: string, message: string): void => {
      context.addIssue({ code: 'custom', path: [path], message });
    };

    if (hardened && env.NODE_ENV !== 'production') {
      issue('NODE_ENV', `Must be "production" when APP_ENV is "${env.APP_ENV}".`);
    }
    if (env.APP_ENV === 'test' && env.NODE_ENV !== 'test') {
      issue('NODE_ENV', 'Must be "test" when APP_ENV is "test".');
    }
    if (hardened && env.LOG_PRETTY) {
      issue(
        'LOG_PRETTY',
        `Must be "false" when APP_ENV is "${env.APP_ENV}" (structured JSON logs only).`,
      );
    }
    if (hardened && env.CORS_ALLOWED_ORIGINS.includes('*')) {
      issue(
        'CORS_ALLOWED_ORIGINS',
        `The "*" wildcard is forbidden when APP_ENV is "${env.APP_ENV}".`,
      );
    }

    // Règles d'exposition de la documentation OpenAPI (voir docs/SECURITY.md).
    if (env.APP_ENV === 'production' && env.SWAGGER_ENABLED === true) {
      issue('SWAGGER_ENABLED', 'The API documentation is never served in production.');
    }
    if (env.APP_ENV === 'staging' && env.SWAGGER_ENABLED === true) {
      if (env.SWAGGER_USER === undefined || env.SWAGGER_PASSWORD === undefined) {
        issue('SWAGGER_ENABLED', 'In staging, SWAGGER_USER and SWAGGER_PASSWORD are required.');
      }
    }
    if ((env.SWAGGER_USER === undefined) !== (env.SWAGGER_PASSWORD === undefined)) {
      issue('SWAGGER_USER', 'SWAGGER_USER and SWAGGER_PASSWORD must be set together.');
    }

    // Identité : durées cohérentes, et aucun affaiblissement possible hors développement.
    if (env.AUTH_SESSION_IDLE_TTL_SECONDS > env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS) {
      issue('AUTH_SESSION_IDLE_TTL_SECONDS', 'Must not exceed AUTH_SESSION_ABSOLUTE_TTL_SECONDS.');
    }
    if (hardened && env.AUTH_PASSWORD_HASH_MEMORY_KIB < MIN_PASSWORD_HASH_MEMORY_KIB) {
      issue(
        'AUTH_PASSWORD_HASH_MEMORY_KIB',
        `Must be at least ${MIN_PASSWORD_HASH_MEMORY_KIB} when APP_ENV is "${env.APP_ENV}".`,
      );
    }
    if (hardened && env.AUTH_PASSWORD_HASH_PASSES < MIN_PASSWORD_HASH_PASSES) {
      issue(
        'AUTH_PASSWORD_HASH_PASSES',
        `Must be at least ${MIN_PASSWORD_HASH_PASSES} when APP_ENV is "${env.APP_ENV}".`,
      );
    }
    // La boîte en mémoire expose les codes à usage unique : outil de développement uniquement.
    if (hardened && env.NOTIFICATION_DELIVERY === 'memory') {
      issue(
        'NOTIFICATION_DELIVERY',
        `"memory" is a development tool and is forbidden when APP_ENV is "${env.APP_ENV}".`,
      );
    }

    // Envoi des e-mails par SMTP : configuration complète, et chiffrée hors développement.
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      issue('SMTP_USER', 'SMTP_USER and SMTP_PASSWORD must be set together.');
    }
    if (resolveNotificationDelivery(env) === 'smtp') {
      if (env.SMTP_HOST === undefined) {
        issue('SMTP_HOST', 'Is required when NOTIFICATION_DELIVERY is "smtp".');
      }
      if (env.EMAIL_FROM === undefined) {
        issue('EMAIL_FROM', 'Is required to send emails (sender address).');
      }
      // Les e-mails portent des codes à usage unique, et la connexion un mot de passe.
      if (hardened && env.SMTP_SECURITY === 'none') {
        issue(
          'SMTP_SECURITY',
          `Must be "starttls" or "tls" when APP_ENV is "${env.APP_ENV}" (encrypted connection).`,
        );
      }
    }

    // Vérification d'identité : le stockage des pièces et sa clé vont ensemble, et la clé
    // ne sert qu'à cela.
    if ((env.KYC_STORAGE_DIR === undefined) !== (env.KYC_ENCRYPTION_KEY === undefined)) {
      issue('KYC_STORAGE_DIR', 'KYC_STORAGE_DIR and KYC_ENCRYPTION_KEY must be set together.');
    }
    if (
      env.KYC_ENCRYPTION_KEY !== undefined &&
      env.KYC_ENCRYPTION_KEY === env.AUTH_SECRETS_ENCRYPTION_KEY
    ) {
      issue('KYC_ENCRYPTION_KEY', 'Must be a key of its own, not AUTH_SECRETS_ENCRYPTION_KEY.');
    }
  });

/**
 * Mode de remise effectif : celui qui est demandé ; à défaut, SMTP dès qu'un serveur est
 * configuré, sinon la boîte en mémoire sur les environnements de développement, et rien ailleurs.
 */
export function resolveNotificationDelivery(env: {
  readonly APP_ENV: AppEnvironment;
  readonly NOTIFICATION_DELIVERY?: NotificationDelivery | undefined;
  readonly SMTP_HOST?: string | undefined;
}): NotificationDelivery {
  if (env.NOTIFICATION_DELIVERY !== undefined) {
    return env.NOTIFICATION_DELIVERY;
  }
  if (env.SMTP_HOST !== undefined) {
    return 'smtp';
  }
  return ['local', 'development', 'test'].includes(env.APP_ENV) ? 'memory' : 'none';
}

export type ValidatedEnv = z.infer<typeof envSchema>;
