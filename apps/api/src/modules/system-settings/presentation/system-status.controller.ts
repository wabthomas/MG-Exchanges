import { type SystemStatus, systemStatusSchema } from '@mgx/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../../common/auth/auth.decorators.js';
import { ApiProblemResponses, toOpenApiSchema } from '../../../common/http/openapi.js';
import { AppConfig } from '../../../config/app-config.js';
import { SystemSettingsService } from '../application/system-settings.service.js';
import { AllowDuringMaintenance } from './access.decorators.js';

@ApiTags('System')
@Controller({ path: 'system', version: '1' })
export class SystemStatusController {
  constructor(
    private readonly config: AppConfig,
    private readonly settings: SystemSettingsService,
  ) {}

  @Get('status')
  @Public()
  @AllowDuringMaintenance()
  @ApiOperation({
    summary: 'Platform status',
    description:
      'What a client needs to know at start-up: API version, server time, whether the platform ' +
      'is under maintenance, and which features are currently open. Public endpoint.',
  })
  @ApiOkResponse({ schema: toOpenApiSchema(systemStatusSchema) })
  @ApiProblemResponses(429, 500)
  async getStatus(): Promise<SystemStatus> {
    const { maintenance, features } = await this.settings.getSnapshot();
    return {
      service: this.config.app.name,
      version: this.config.app.version,
      serverTime: new Date().toISOString(),
      maintenance,
      features,
    };
  }
}
