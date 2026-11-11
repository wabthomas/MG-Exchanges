import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../../../common/errors/app-error.js';
import { SystemSettingsService } from '../application/system-settings.service.js';
import { ALLOW_DURING_MAINTENANCE_KEY } from './access.metadata.js';

const DEFAULT_MAINTENANCE_MESSAGE = 'The platform is under maintenance. Please try again later.';

/**
 * Garde globale : en mode maintenance, toutes les routes répondent `503 MAINTENANCE`,
 * sauf celles marquées `@AllowDuringMaintenance()` (sondes de santé, état de la plateforme).
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SystemSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed === true) {
      return true;
    }

    const { maintenance } = await this.settings.getSnapshot();
    if (maintenance.enabled) {
      throw new AppError('MAINTENANCE', maintenance.message ?? DEFAULT_MAINTENANCE_MESSAGE);
    }
    return true;
  }
}
