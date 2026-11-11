import { Module } from '@nestjs/common';

import { DomainEventHandlerRegistry } from './application/domain-event-handler.registry.js';
import { OutboxRelayService } from './application/outbox-relay.service.js';
import { OutboxService } from './application/outbox.service.js';
import { DomainEventsProcessor } from './infrastructure/domain-events.processor.js';
import { OutboxRelayProcessor } from './infrastructure/outbox-relay.processor.js';

@Module({
  providers: [
    OutboxService,
    OutboxRelayService,
    DomainEventHandlerRegistry,
    OutboxRelayProcessor,
    DomainEventsProcessor,
  ],
  exports: [OutboxService, OutboxRelayService, DomainEventHandlerRegistry],
})
export class OutboxModule {}
