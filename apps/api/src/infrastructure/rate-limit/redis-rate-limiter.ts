import { Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service.js';

/**
 * Compteur à fenêtre fixe, atomique (script Lua) :
 *  - KEYS[1] compteur de la fenêtre courante, KEYS[2] marqueur de blocage ;
 *  - ARGV[1] durée de la fenêtre (ms), ARGV[2] limite, ARGV[3] durée de blocage (ms).
 * Retourne { requêtes comptées, ms avant fin de fenêtre, bloqué (0/1), ms avant fin de blocage }.
 */
const CONSUME_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local windowTtl = redis.call('PTTL', KEYS[1])
  if windowTtl < 0 then windowTtl = 0 end
  return { tonumber(ARGV[2]) + 1, windowTtl, 1, blockTtl }
end

local hits = redis.call('INCR', KEYS[1])
local windowTtl = redis.call('PTTL', KEYS[1])
if hits == 1 or windowTtl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  windowTtl = tonumber(ARGV[1])
end

if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, windowTtl, 1, tonumber(ARGV[3]) }
end
return { hits, windowTtl, 0, 0 }
`;

export interface RateLimitRule {
  /** Nombre maximal de requêtes par fenêtre. */
  readonly limit: number;
  /** Durée de la fenêtre, en millisecondes. */
  readonly windowMs: number;
  /** Durée du blocage après dépassement (par défaut : la durée de la fenêtre). */
  readonly blockMs?: number;
}

export interface RateLimitDecision {
  readonly blocked: boolean;
  /** Requêtes encore autorisées dans la fenêtre courante. */
  readonly remaining: number;
  /** Secondes avant la remise à zéro de la fenêtre. */
  readonly resetSeconds: number;
  /** Secondes à attendre avant de réessayer (0 si la requête est autorisée). */
  readonly retryAfterSeconds: number;
}

/**
 * Limiteur de débit adossé à Redis : les compteurs sont partagés par toutes les instances
 * de l'API (un compteur en mémoire serait contournable en multipliant les instances).
 * Si Redis est indisponible, l'appel échoue : la limitation ne « s'ouvre » jamais en silence.
 */
@Injectable()
export class RedisRateLimiter {
  constructor(private readonly redis: RedisService) {}

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    // Accolades : les deux clés partagent le même « hash slot » (compatibilité Redis Cluster).
    const base = `rate-limit:{${key}}`;
    const [hits, windowTtlMs, blocked, blockTtlMs] = (await this.redis.client.eval(
      CONSUME_SCRIPT,
      2,
      `${base}:hits`,
      `${base}:blocked`,
      rule.windowMs,
      rule.limit,
      rule.blockMs ?? rule.windowMs,
    )) as [number, number, number, number];

    return {
      blocked: blocked === 1,
      remaining: Math.max(0, rule.limit - hits),
      resetSeconds: Math.ceil(windowTtlMs / 1000),
      retryAfterSeconds: Math.ceil(blockTtlMs / 1000),
    };
  }

  /**
   * Secondes restantes du blocage en cours pour cette clé, ou 0. Ne compte aucune requête :
   * sert aux compteurs d'échecs (connexion), incrémentés seulement lorsqu'un essai échoue.
   */
  async blockedForSeconds(key: string): Promise<number> {
    const ttlMs = await this.redis.client.pttl(`rate-limit:{${key}}:blocked`);
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0;
  }

  /** Remet le compteur à zéro et lève le blocage éventuel. */
  async reset(key: string): Promise<void> {
    const base = `rate-limit:{${key}}`;
    await this.redis.client.del(`${base}:hits`, `${base}:blocked`);
  }
}
