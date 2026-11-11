import type { FeatureKey } from '@mgx/contracts';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../../../common/errors/app-error.js';
import { SystemSettingsService } from '../application/system-settings.service.js';
import { REQUIRED_FEATURE_KEY } from './access.metadata.js';

@Injectable()
export class FeatureEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: SystemSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRED_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (feature === undefined || (await this.settings.isFeatureEnabled(feature))) {
      return true;
    }
    throw new AppError('FEATURE_DISABLED', 'This feature is not available.');
  }
}
