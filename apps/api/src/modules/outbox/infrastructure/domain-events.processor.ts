import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { DOMAIN_EVENTS_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import { DomainEventHandlerRegistry } from '../application/domain-event-handler.registry.js';
import type { DomainEventEnvelope } from '../domain/domain-event.js';

/**
 * Distribue chaque événement de domaine publié à ses consommateurs enregistrés.
 * Si l'un d'eux échoue, le traitement est retenté (délai exponentiel) : tous les
 * consommateurs de l'événement sont alors rappelés, d'où l'exigence d'idempotence.
 */
@Processor(DOMAIN_EVENTS_QUEUE)
export class DomainEventsProcessor extends WorkerHost {
  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(DomainEventsProcessor.name);
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    for (const handler of this.registry.handlersFor(job.data.eventType)) {
      await handler.handle(job.data);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<DomainEventEnvelope> | undefined, error: Error): void {
    this.logger.error(
      {
        err: error,
        eventId: job?.data.id,
        eventType: job?.data.eventType,
        attemptsMade: job?.attemptsMade,
      },
      'Domain event handling failed',
    );
  }
}
