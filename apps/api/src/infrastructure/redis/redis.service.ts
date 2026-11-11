import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AppConfig } from '../../config/app-config.js';
import { parseRedisUrl } from './redis-url.js';

/**
 * Connexion Redis de l'application (cache, limitation de débit, données temporaires).
 * Toutes les clés sont préfixées par environnement (`mgx:<env>:`). Les files BullMQ
 * utilisent leurs propres connexions (voir QueueModule).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  readonly client: Redis;

  constructor(config: AppConfig) {
    this.client = new Redis({
      ...parseRedisUrl(config.redis.url),
      keyPrefix: config.redis.keyPrefix,
      lazyConnect: true,
      connectTimeout: 5000,
      // Une commande échoue rapidement plutôt que de rester en attente si Redis est injoignable.
      maxRetriesPerRequest: 2,
    });
    // Les erreurs de connexion sont remontées par les commandes ; sans écouteur, ioredis
    // les signalerait en plus comme événements non gérés.
    this.client.on('error', () => undefined);
  }

  /** Échec immédiat au démarrage si Redis est injoignable. */
  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status !== 'end') {
      await this.client.quit();
    }
  }
}
