import { Injectable, type OnModuleInit } from '@nestjs/common';

import { DomainEventHandlerRegistry } from '../../outbox/application/domain-event-handler.registry.js';
import type { DomainEventHandler } from '../../outbox/domain/domain-event.js';
import { SYSTEM_SETTING_CHANGED_EVENT, SystemSettingsService } from './system-settings.service.js';

/**
 * À la réception de `system_setting.changed`, oublie l'état mémorisé pour que la
 * modification soit prise en compte immédiatement. Idempotent par nature.
 */
@Injectable()
export class SettingsChangedHandler implements DomainEventHandler, OnModuleInit {
  readonly name = 'system-settings.refresh-snapshot';
  readonly eventType = SYSTEM_SETTING_CHANGED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly settings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(): Promise<void> {
    this.settings.invalidate();
    return Promise.resolve();
  }
}
