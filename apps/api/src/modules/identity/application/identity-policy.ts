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

/** Mots de passe actuels erronés lors d'un changement : 5 en 15 minutes, par compte. */
export const PASSWORD_CHANGE_FAILURES_PER_ACCOUNT: RateLimitRule = {
  limit: 4,
  windowMs: 15 * MINUTE_MS,
};

/**
 * Durée de conservation d'une paire de jetons après son renouvellement. Pendant ce délai,
 * la réutilisation du jeton est détectée et révoque la session ; au-delà, le jeton est
 * simplement inconnu.
 */
export const CONSUMED_TOKEN_RETENTION_MS = 24 * 60 * MINUTE_MS;
