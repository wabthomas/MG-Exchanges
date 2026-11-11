import { SetMetadata } from '@nestjs/common';

import type { RateLimitRule } from './redis-rate-limiter.js';

export const RATE_LIMIT_POLICY_KEY = 'mgx:rate-limit-policy';
export const SKIP_RATE_LIMIT_KEY = 'mgx:skip-rate-limit';

export interface RateLimitPolicy extends RateLimitRule {
  /** Nom de la politique : chaque politique possède ses propres compteurs. */
  readonly name: string;
}

/**
 * Applique à la route (ou au contrôleur) une limite propre, plus stricte que la limite
 * globale — par exemple pour la connexion ou l'envoi de codes à usage unique.
 */
export const RateLimit = (policy: RateLimitPolicy): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

/** Exclut la route (ou le contrôleur) de la limitation de débit (sondes de santé). */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);
