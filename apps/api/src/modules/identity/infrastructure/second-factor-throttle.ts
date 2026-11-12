import { Injectable } from '@nestjs/common';

import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import {
  SECOND_FACTOR_FAILURES_PER_ACCOUNT,
  SECOND_FACTOR_FAILURES_PER_ACCOUNT_DAILY,
} from '../application/identity-policy.js';

/**
 * Blocage de la seconde étape après des codes erronés répétés.
 *
 * Les compteurs portent sur le **compte**, d'où que viennent les essais : celui qui essaie des
 * codes connaît déjà le mot de passe, et changer d'adresse ne doit rien lui apporter. Deux
 * compteurs se complètent : l'un, court, arrête une rafale ; l'autre, sur 24 heures, borne une
 * recherche patiente et n'est pas effacé par une connexion réussie du titulaire.
 */
@Injectable()
export class SecondFactorThrottle {
  constructor(private readonly limiter: RedisRateLimiter) {}

  /** Secondes à attendre avant un nouvel essai, ou 0 si aucun blocage n'est en cours. */
  async blockedForSeconds(userId: string): Promise<number> {
    const [burst, daily] = await Promise.all([
      this.limiter.blockedForSeconds(this.burstKey(userId)),
      this.limiter.blockedForSeconds(this.dailyKey(userId)),
    ]);
    return Math.max(burst, daily);
  }

  /**
   * Compte un code erroné.
   * @returns la durée (en secondes) du blocage que cet échec vient de déclencher, ou 0.
   */
  async recordFailure(userId: string): Promise<number> {
    const [burst, daily] = await Promise.all([
      this.limiter.consume(this.burstKey(userId), SECOND_FACTOR_FAILURES_PER_ACCOUNT),
      this.limiter.consume(this.dailyKey(userId), SECOND_FACTOR_FAILURES_PER_ACCOUNT_DAILY),
    ]);
    return Math.max(
      burst.blocked ? burst.retryAfterSeconds : 0,
      daily.blocked ? daily.retryAfterSeconds : 0,
    );
  }

  /** Un code accepté efface la rafale en cours — pas le compteur des 24 heures. */
  async recordSuccess(userId: string): Promise<void> {
    await this.limiter.reset(this.burstKey(userId));
  }

  /**
   * Lève tout blocage : le second facteur vient d'être retiré ou remplacé, les essais passés
   * ne concernent plus celui qui est en place.
   */
  async clear(userId: string): Promise<void> {
    await Promise.all([
      this.limiter.reset(this.burstKey(userId)),
      this.limiter.reset(this.dailyKey(userId)),
    ]);
  }

  private burstKey(userId: string): string {
    return `second-factor-failures:${userId}`;
  }

  private dailyKey(userId: string): string {
    return `second-factor-failures-daily:${userId}`;
  }
}
