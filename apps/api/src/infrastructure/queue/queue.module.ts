import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { AppConfig } from '../../config/app-config.js';
import { parseRedisUrl } from '../redis/redis-url.js';
import {
  ACCOUNT_MAINTENANCE_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  OUTBOX_RELAY_QUEUE,
} from './queue.constants.js';

/**
 * Files de traitement asynchrone (BullMQ sur Redis).
 *
 * Par défaut, un traitement en échec est retenté 5 fois avec un délai exponentiel ; les
 * traitements terminés sont purgés, les échecs définitifs conservés 7 jours pour analyse.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // BullMQ exige `maxRetriesPerRequest: null` pour ses connexions bloquantes.
        connection: { ...parseRedisUrl(config.redis.queueUrl), maxRetriesPerRequest: null },
        prefix: `${config.redis.keyPrefix}queues`,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: DOMAIN_EVENTS_QUEUE },
      { name: OUTBOX_RELAY_QUEUE },
      { name: ACCOUNT_MAINTENANCE_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
