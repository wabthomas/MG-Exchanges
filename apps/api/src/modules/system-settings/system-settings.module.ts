import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from '../audit/audit.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SettingsChangedHandler } from './application/settings-changed.handler.js';
import { SystemSettingsRepository } from './application/system-settings.repository.js';
import { SystemSettingsService } from './application/system-settings.service.js';
import { PrismaSystemSettingsRepository } from './infrastructure/prisma-system-settings.repository.js';
import { AdminSystemSettingsController } from './presentation/admin-system-settings.controller.js';
import { FeatureEnabledGuard } from './presentation/feature-enabled.guard.js';
import { MaintenanceGuard } from './presentation/maintenance.guard.js';
import { SystemStatusController } from './presentation/system-status.controller.js';

/**
 * Paramètres système : mode maintenance et activation des fonctionnalités.
 * Module global : `@RequiresFeature()` est utilisable par tous les modules métier.
 */
@Global()
@Module({
  imports: [AuditModule, OutboxModule],
  controllers: [SystemStatusController, AdminSystemSettingsController],
  providers: [
    { provide: SystemSettingsRepository, useClass: PrismaSystemSettingsRepository },
    SystemSettingsService,
    SettingsChangedHandler,
    FeatureEnabledGuard,
    { provide: APP_GUARD, useClass: MaintenanceGuard },
  ],
  exports: [SystemSettingsService, FeatureEnabledGuard],
})
export class SystemSettingsModule {}
