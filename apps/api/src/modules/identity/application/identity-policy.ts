import type { RateLimitRule } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';

const MINUTE_MS = 60_000;

/** Nombre d'essais autorisés pour un code à usage unique ; au-delà, il faut en demander un autre. */
export const CODE_MAX_ATTEMPTS = 5;

/** Codes envoyés à un même compte, par usage : 3 par quart d'heure. */
export const CODE_REQUESTS_PER_ACCOUNT: RateLimitRule = { limit: 3, windowMs: 15 * MINUTE_MS };

/** Message « vous avez déjà un compte » : un par heure et par compte (pas de harcèlement par e-mail). */
export const ACCOUNT_EXISTS_NOTICES_PER_ACCOUNT: RateLimitRule = {
  limit: 1,
  windowMs: 60 * MINUTE_MS,
};

/**
 * Mots de passe actuels erronés lors d'une opération sensible (changement de mot de passe,
 * gestion du second facteur) : 5 en 15 minutes, par compte.
 */
export const PASSWORD_CONFIRMATION_FAILURES_PER_ACCOUNT: RateLimitRule = {
  limit: 4,
  windowMs: 15 * MINUTE_MS,
};

/**
 * Codes du second facteur erronés : 5 en 15 minutes bloquent la seconde étape du compte
 * pendant 15 minutes, d'où que viennent les essais. Un code à six chiffres ne résiste aux
 * essais que par cette limite. Un code accepté remet ce compteur à zéro.
 */
export const SECOND_FACTOR_FAILURES_PER_ACCOUNT: RateLimitRule = {
  limit: 4,
  windowMs: 15 * MINUTE_MS,
  blockMs: 15 * MINUTE_MS,
};

/**
 * Codes du second facteur erronés, sur la durée : 20 en 24 heures bloquent la seconde étape
 * pendant 24 heures. Ce compteur-ci n'est **pas** remis à zéro par un code accepté : il borne
 * une recherche patiente menée par quelqu'un qui connaît le mot de passe (au plus 20 essais par
 * jour, quand trois codes sur un million sont valides à un instant donné).
 */
export const SECOND_FACTOR_FAILURES_PER_ACCOUNT_DAILY: RateLimitRule = {
  limit: 19,
  windowMs: 24 * 60 * MINUTE_MS,
  blockMs: 24 * 60 * MINUTE_MS,
};

/**
 * Durée de validité d'un enrôlement du second facteur resté sans confirmation. Au-delà, il
 * faut le recommencer — donc présenter à nouveau le mot de passe.
 */
export const TOTP_ENROLLMENT_TTL_MS = 30 * MINUTE_MS;

/** Message « inscription inachevée » : un par heure et par compte. */
export const REGISTRATION_INCOMPLETE_NOTICES_PER_ACCOUNT: RateLimitRule = {
  limit: 1,
  windowMs: 60 * MINUTE_MS,
};

/** Codes envoyés par SMS à un même numéro, tous comptes confondus : 3 par heure. */
export const SMS_CODES_PER_NUMBER: RateLimitRule = { limit: 3, windowMs: 60 * MINUTE_MS };

/**
 * Durée de conservation d'une paire de jetons après son renouvellement. Pendant ce délai,
 * la réutilisation du jeton est détectée et révoque la session ; au-delà, le jeton est
 * simplement inconnu.
 */
export const CONSUMED_TOKEN_RETENTION_MS = 24 * 60 * MINUTE_MS;

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Durées de conservation appliquées par la purge périodique (`AccountMaintenanceService`).
 * Le journal d'audit n'est pas concerné : il ne se purge pas.
 */
export const RETENTION = {
  /**
   * Inscription dont l'adresse n'a jamais été vérifiée : ce n'est pas un compte, et l'adresse
   * saisie appartient peut-être à quelqu'un d'autre. Elle est supprimée après ce délai.
   */
  unverifiedRegistrationMs: 7 * DAY_MS,
  /** Session inutilisable (expirée ou révoquée), après son échéance d'inactivité. */
  endedSessionMs: 90 * DAY_MS,
  /** Code à usage unique, après son expiration. */
  expiredChallengeMs: 7 * DAY_MS,
  /** Enrôlement d'un second facteur jamais confirmé. */
  unconfirmedTotpMs: DAY_MS,
  /** Événement de la boîte d'envoi, après sa publication. */
  publishedEventMs: 30 * DAY_MS,
} as const;

/** Nombre maximal de lignes supprimées par catégorie à chaque exécution de la purge. */
export const MAINTENANCE_BATCH_SIZE = 500;
