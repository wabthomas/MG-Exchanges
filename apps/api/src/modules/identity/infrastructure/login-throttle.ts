import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  type RateLimitRule,
  RedisRateLimiter,
} from '../../../infrastructure/rate-limit/redis-rate-limiter.js';

const MINUTE_MS = 60_000;

/** Par compte **et** par adresse : 5 échecs en 15 minutes bloquent ce client 15 minutes. */
export const FAILURES_PER_CLIENT: RateLimitRule = {
  limit: 4,
  windowMs: 15 * MINUTE_MS,
  blockMs: 15 * MINUTE_MS,
};

/**
 * Par compte, toutes adresses confondues : 20 échecs en une heure bloquent le compte une
 * heure. Borne une attaque répartie sur de nombreuses adresses.
 */
export const FAILURES_PER_ACCOUNT: RateLimitRule = {
  limit: 19,
  windowMs: 60 * MINUTE_MS,
  blockMs: 60 * MINUTE_MS,
};

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Blocage temporaire après des échecs de connexion répétés.
 *
 * Les compteurs portent sur l'**identifiant présenté**, que le compte existe ou non : la
 * réponse est donc la même dans les deux cas et ne révèle rien. Deux compteurs se complètent :
 * par (identifiant, adresse), pour qu'un attaquant ne puisse pas bloquer le titulaire depuis
 * une autre adresse dès les premiers essais ; par identifiant seul, pour borner une attaque
 * répartie. Les identifiants n'apparaissent dans Redis que sous forme d'empreinte.
 */
@Injectable()
export class LoginThrottle {
  constructor(private readonly limiter: RedisRateLimiter) {}

  /** Secondes à attendre avant un nouvel essai, ou 0 si aucun blocage n'est en cours. */
  async blockedForSeconds(identifier: string, clientAddress: string): Promise<number> {
    const [client, account] = await Promise.all([
      this.limiter.blockedForSeconds(this.clientKey(identifier, clientAddress)),
      this.limiter.blockedForSeconds(this.accountKey(identifier)),
    ]);
    return Math.max(client, account);
  }

  async recordFailure(identifier: string, clientAddress: string): Promise<void> {
    await Promise.all([
      this.limiter.consume(this.clientKey(identifier, clientAddress), FAILURES_PER_CLIENT),
      this.limiter.consume(this.accountKey(identifier), FAILURES_PER_ACCOUNT),
    ]);
  }

  /** Une connexion réussie efface les échecs de ce client (pas ceux des autres adresses). */
  async recordSuccess(identifier: string, clientAddress: string): Promise<void> {
    await this.limiter.reset(this.clientKey(identifier, clientAddress));
  }

  /**
   * Après une réinitialisation du mot de passe, le compte n'est plus bloqué — ni pour le
   * client qui vient de la réaliser.
   */
  async clearAccount(identifier: string, clientAddress: string): Promise<void> {
    await Promise.all([
      this.limiter.reset(this.accountKey(identifier)),
      this.limiter.reset(this.clientKey(identifier, clientAddress)),
    ]);
  }

  private clientKey(identifier: string, clientAddress: string): string {
    return `login-failures:client:${digest(`${identifier}|${clientAddress}`)}`;
  }

  private accountKey(identifier: string): string {
    return `login-failures:account:${digest(identifier)}`;
  }
}
