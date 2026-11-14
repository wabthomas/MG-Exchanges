import type { RateLimitPolicy } from '../../../infrastructure/rate-limit/rate-limit.decorators.js';

const MINUTE_MS = 60_000;

/**
 * Limites par adresse IP des routes d'authentification.
 *
 * Elles sont volontairement larges : derrière un opérateur mobile, de nombreux clients
 * partagent une même adresse. La protection fine se fait par compte (essais de connexion,
 * codes à usage unique) — voir `LoginThrottle` et `identity-policy.ts`.
 */
export const REGISTRATION_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-registration',
  limit: 10,
  windowMs: 60 * MINUTE_MS,
};

export const LOGIN_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-login',
  limit: 30,
  windowMs: 5 * MINUTE_MS,
};

/** Routes qui envoient ou examinent un code à usage unique (compteur commun). */
export const VERIFICATION_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-verification',
  limit: 20,
  windowMs: 15 * MINUTE_MS,
};

/**
 * Lecture publique des conditions d'utilisation : une réponse peut peser plusieurs centaines
 * de kilo-octets, et la route n'exige pas d'être connecté.
 */
export const TERMS_READING_RATE_LIMIT: RateLimitPolicy = {
  name: 'terms-reading',
  limit: 60,
  windowMs: MINUTE_MS,
};

/** Publication d'une version des conditions d'utilisation (back-office) : un acte rare. */
export const TERMS_PUBLICATION_RATE_LIMIT: RateLimitPolicy = {
  name: 'terms-publication',
  limit: 20,
  windowMs: 60 * MINUTE_MS,
};
