import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';

import { AppError } from '../../common/errors/app-error.js';
import { ApiProblemResponses } from '../../common/http/openapi.js';
import { SkipRateLimit } from '../../infrastructure/rate-limit/rate-limit.decorators.js';
import { AllowDuringMaintenance } from '../system-settings/presentation/access.decorators.js';
import { DependencyHealthIndicator } from './dependency-health.indicator.js';

/**
 * Sondes destinées à l'orchestrateur et au reverse proxy (hors préfixe `/api`, non versionnées).
 *  - `live`  : le processus répond — ne dépend d'aucun service externe ;
 *  - `ready` : l'instance peut servir du trafic (PostgreSQL et Redis joignables).
 */
@ApiTags('Health')
@SkipRateLimit()
@AllowDuringMaintenance()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } },
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (PostgreSQL, Redis)' })
  @ApiProblemResponses(503)
  async ready(): Promise<HealthCheckResult> {
    try {
      return await this.health.check([
        () => this.dependencies.database(),
        () => this.dependencies.redisCache(),
      ]);
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', 'The service is not ready.', { cause: error });
    }
  }
}
