import type { RateLimitRule } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Transferts qu'un même compte peut tenter par heure, aboutis ou refusés : 30. Chaque transfert
 * abouti envoie un message au destinataire : la borne empêche d'en faire un moyen de
 * harcèlement.
 */
export const TRANSFER_ATTEMPTS_PER_ACCOUNT: RateLimitRule = { limit: 30, windowMs: HOUR_MS };

/**
 * Transferts refusés parce que le destinataire ne peut pas les recevoir : 10 en 24 heures, par
 * compte émetteur. Le dixième suspend tout transfert de ce compte pendant 24 heures : la route
 * ne sert pas à chercher quelles adresses ont un compte.
 */
export const RECIPIENT_REFUSALS_PER_ACCOUNT: RateLimitRule = { limit: 9, windowMs: 24 * HOUR_MS };
