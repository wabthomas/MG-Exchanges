import { Injectable } from '@nestjs/common';

import type { DomainEventHandler } from '../domain/domain-event.js';

/** Registre des consommateurs d'événements de domaine, alimenté par les modules au démarrage. */
@Injectable()
export class DomainEventHandlerRegistry {
  private readonly handlersByEventType = new Map<string, DomainEventHandler[]>();

  register(handler: DomainEventHandler): void {
    const handlers = this.handlersByEventType.get(handler.eventType) ?? [];
    if (handlers.some((existing) => existing.name === handler.name)) {
      throw new Error(
        `Domain event handler "${handler.name}" is already registered for "${handler.eventType}".`,
      );
    }
    this.handlersByEventType.set(handler.eventType, [...handlers, handler]);
  }

  handlersFor(eventType: string): readonly DomainEventHandler[] {
    return this.handlersByEventType.get(eventType) ?? [];
  }
}
