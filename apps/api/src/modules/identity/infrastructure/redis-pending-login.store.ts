import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../infrastructure/redis/redis.service.js';
import {
  type IssuedPendingLogin,
  type PendingLogin,
  PendingLoginStore,
} from '../application/pending-login.store.js';
import { hashPresentedToken, issueSessionToken } from './session-tokens.js';

/**
 * Compte un essai et retourne la connexion en attente, en une opération atomique :
 *  - KEYS[1] connexion en attente ; ARGV[1] nombre maximal d'essais.
 * Retourne les champs de la connexion, ou rien si elle n'existe plus ou si le nombre d'essais
 * est dépassé (elle est alors supprimée).
 */
const REGISTER_ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {}
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return {}
end
return redis.call('HMGET', KEYS[1], 'userId', 'deviceName', 'deviceFingerprint', 'generation')
`;

/**
 * Connexions en attente du second facteur, dans Redis : elles expirent d'elles-mêmes et
 * sont partagées par toutes les instances de l'API. Le jeton n'y figure que sous forme
 * d'empreinte ; si Redis perd ses données, l'utilisateur ressaisit simplement son mot de passe.
 *
 * Chaque compte a une « génération » : une connexion en attente retient celle qui avait cours
 * à sa création et ne vaut que tant qu'elle n'a pas changé. Annuler toutes les connexions en
 * attente d'un compte revient à incrémenter sa génération — sans horloge ni parcours de clés.
 */
@Injectable()
export class RedisPendingLoginStore extends PendingLoginStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async create(login: PendingLogin, ttlSeconds: number): Promise<IssuedPendingLogin> {
    const issued = issueSessionToken('mfa');
    const key = this.key(issued.hash);
    // Lue avant l'écriture : si la génération change entre les deux, la connexion naît périmée.
    const generation = await this.generationOf(login.userId);
    await this.redis.client
      .multi()
      .hset(key, {
        userId: login.userId,
        deviceName: login.deviceName ?? '',
        deviceFingerprint: login.deviceFingerprint ?? '',
        generation,
        attempts: 0,
      })
      .expire(key, ttlSeconds)
      .exec();
    return { token: issued.token, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async registerAttempt(token: string, maxAttempts: number): Promise<PendingLogin | null> {
    const hash = hashPresentedToken('mfa', token);
    if (hash === null) {
      return null;
    }
    const key = this.key(hash);
    const [userId, deviceName, deviceFingerprint, generation] = (await this.redis.client.eval(
      REGISTER_ATTEMPT_SCRIPT,
      1,
      key,
      maxAttempts,
    )) as (string | null)[];
    if (userId === undefined || userId === null || userId === '') {
      return null;
    }
    if (generation !== (await this.generationOf(userId))) {
      // Annulée depuis sa création (mot de passe changé, sessions fermées d'autorité).
      await this.redis.client.del(key);
      return null;
    }
    return {
      userId,
      deviceName: deviceName === null || deviceName === '' ? null : (deviceName ?? null),
      deviceFingerprint:
        deviceFingerprint === null || deviceFingerprint === '' ? null : (deviceFingerprint ?? null),
    };
  }

  async consume(token: string): Promise<boolean> {
    const hash = hashPresentedToken('mfa', token);
    if (hash === null) {
      return false;
    }
    return (await this.redis.client.del(this.key(hash))) === 1;
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.redis.client.incr(this.generationKey(userId));
  }

  private async generationOf(userId: string): Promise<string> {
    return (await this.redis.client.get(this.generationKey(userId))) ?? '0';
  }

  private generationKey(userId: string): string {
    return `pending-login-generation:${userId}`;
  }

  private key(tokenHash: Uint8Array): string {
    return `pending-login:${Buffer.from(tokenHash).toString('hex')}`;
  }
}
