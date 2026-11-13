import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { ACCOUNT_MAINTENANCE_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import { AccountMaintenanceService } from '../application/account-maintenance.service.js';

const SCHEDULER_ID = 'account-maintenance';
/** Les durées de conservation se comptent en jours : une exécution par heure suffit. */
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cadence la purge des données d'identité : un planificateur BullMQ unique, partagé par
 * toutes les instances, la déclenche toutes les heures.
 */
@Processor(ACCOUNT_MAINTENANCE_QUEUE)
export class AccountMaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ACCOUNT_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly maintenance: AccountMaintenanceService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: INTERVAL_MS },
      {
        name: 'purge',
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
      },
    );
  }

  async process(): Promise<void> {
    const report = await this.maintenance.run();
    if (report.failures > 0) {
      // L'échec est visible dans la file (et dans les journaux) ; l'exécution suivante réessaie.
      throw new Error(`Account maintenance: ${String(report.failures)} step(s) failed.`);
    }
  }
}
