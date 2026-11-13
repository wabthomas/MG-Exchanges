import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { AppConfig } from '../../../config/app-config.js';
import { OUTBOX_RELAY_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import { OutboxRelayService } from '../application/outbox-relay.service.js';

const SCHEDULER_ID = 'outbox-relay';
/** Borne le travail d'une exécution ; le reliquat est traité à l'exécution suivante. */
const MAX_BATCHES_PER_RUN = 10;

/**
 * Cadence le relais de la boîte d'envoi : un planificateur BullMQ unique (partagé par
 * toutes les instances) déclenche périodiquement la publication des événements en attente.
 */
@Processor(OUTBOX_RELAY_QUEUE)
export class OutboxRelayProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(OUTBOX_RELAY_QUEUE) private readonly queue: Queue,
    private readonly relay: OutboxRelayService,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: this.config.outbox.pollIntervalMs },
      {
        name: 'relay',
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
      },
    );
  }

  async process(): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const { claimed } = await this.relay.relayPendingBatch();
      if (claimed < this.config.outbox.batchSize) {
        return;
      }
    }
  }
}
