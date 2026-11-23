import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { AppConfig } from '../../../config/app-config.js';
import { JobSchedules } from '../../../infrastructure/queue/job-schedules.js';
import { OUTBOX_RELAY_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import { QueueErrorLog } from '../../../infrastructure/queue/queue-error-log.js';
import { OutboxRelayService } from '../application/outbox-relay.service.js';

const SCHEDULER_ID = 'outbox-relay';
/** Borne le travail d'une exécution ; le reliquat est traité à l'exécution suivante. */
const MAX_BATCHES_PER_RUN = 10;

/**
 * Cadence le relais de la boîte d'envoi : un planificateur BullMQ unique (partagé par
 * toutes les instances) déclenche périodiquement la publication des événements en attente.
 * Il est inscrit par `JobSchedules`, qui le réinscrit si Redis le perd.
 */
@Processor(OUTBOX_RELAY_QUEUE)
export class OutboxRelayProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(OUTBOX_RELAY_QUEUE) private readonly queue: Queue,
    private readonly relay: OutboxRelayService,
    private readonly config: AppConfig,
    private readonly queueErrors: QueueErrorLog,
    private readonly schedules: JobSchedules,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.schedules.register({
      queue: this.queue,
      id: SCHEDULER_ID,
      jobName: 'relay',
      everyMs: this.config.outbox.pollIntervalMs,
    });
  }

  async process(): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const { claimed } = await this.relay.relayPendingBatch();
      if (claimed < this.config.outbox.batchSize) {
        return;
      }
    }
  }

  /**
   * Un passage en échec — base injoignable ou saturée — n'est pas relancé : le suivant a lieu
   * à l'échéance. Sans cette ligne, il ne laisserait de trace que dans Redis.
   */
  @OnWorkerEvent('failed')
  onFailed(_job: Job | undefined, error: Error): void {
    this.queueErrors.runFailed(OUTBOX_RELAY_QUEUE, error);
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.queueErrors.workerError(OUTBOX_RELAY_QUEUE, error);
  }
}
