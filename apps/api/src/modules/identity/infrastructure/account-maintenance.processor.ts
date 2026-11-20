import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { JobSchedules } from '../../../infrastructure/queue/job-schedules.js';
import { ACCOUNT_MAINTENANCE_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import { QueueErrorLog } from '../../../infrastructure/queue/queue-error-log.js';
import { AccountMaintenanceService } from '../application/account-maintenance.service.js';

const SCHEDULER_ID = 'account-maintenance';
/** Les durées de conservation se comptent en jours : une exécution par heure suffit. */
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cadence la purge des données d'identité : un planificateur BullMQ unique, partagé par
 * toutes les instances, la déclenche toutes les heures. Il est inscrit par `JobSchedules`,
 * qui le réinscrit si Redis le perd.
 */
@Processor(ACCOUNT_MAINTENANCE_QUEUE)
export class AccountMaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ACCOUNT_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly maintenance: AccountMaintenanceService,
    private readonly queueErrors: QueueErrorLog,
    private readonly schedules: JobSchedules,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.schedules.register({
      queue: this.queue,
      id: SCHEDULER_ID,
      jobName: 'purge',
      everyMs: INTERVAL_MS,
    });
  }

  async process(): Promise<void> {
    const report = await this.maintenance.run();
    if (report.failures > 0) {
      // L'échec est visible dans la file (et dans les journaux) ; l'exécution suivante réessaie.
      throw new Error(`Account maintenance: ${String(report.failures)} step(s) failed.`);
    }
  }

  /** Le passage a échoué : une étape au moins (journalisée par ailleurs), ou la purge entière. */
  @OnWorkerEvent('failed')
  onFailed(_job: Job | undefined, error: Error): void {
    this.queueErrors.runFailed(ACCOUNT_MAINTENANCE_QUEUE, error);
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.queueErrors.workerError(ACCOUNT_MAINTENANCE_QUEUE, error);
  }
}
