import { Injectable, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { MAINTENANCE_BATCH_SIZE, RETENTION } from './identity-policy.js';
import { type MaintenanceStep, MaintenanceStepRegistry } from './maintenance-step.registry.js';

/**
 * Supprime les événements de la boîte d'envoi publiés depuis plus de
 * `RETENTION.publishedEventMs`. Un événement publié a été remis à la file de traitement : il
 * ne sert plus qu'au diagnostic, et peut désigner un compte, une adresse IP ou un appareil.
 * Les événements en attente ou abandonnés ne sont jamais concernés.
 *
 * Étape de la purge périodique des données d'identité (même cadence, mêmes journaux).
 */
@Injectable()
export class PublishedEventsPurge implements MaintenanceStep, OnModuleInit {
  readonly name = 'purge-published-events';

  constructor(
    private readonly outbox: OutboxService,
    private readonly registry: MaintenanceStepRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  run(now: Date): Promise<number> {
    return this.outbox.deletePublished(
      this.prisma,
      new Date(now.getTime() - RETENTION.publishedEventMs),
      MAINTENANCE_BATCH_SIZE,
    );
  }
}
