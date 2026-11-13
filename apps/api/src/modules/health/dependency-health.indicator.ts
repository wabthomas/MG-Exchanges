import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

const PROBE_TIMEOUT_MS = 2000;

/**
 * Sondes des dépendances de l'API. La cause d'une indisponibilité est journalisée mais
 * jamais renvoyée dans la réponse : un message d'erreur de connexion révélerait des
 * détails d'infrastructure (hôtes, ports).
 */
@Injectable()
export class DependencyHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DependencyHealthIndicator.name);
  }

  database(): Promise<HealthIndicatorResult> {
    return this.probe('database', async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  redisCache(): Promise<HealthIndicatorResult> {
    return this.probe('redis', async () => {
      await this.redis.client.ping();
    });
  }

  private async probe(key: string, check: () => Promise<void>): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Health probe timed out after ${PROBE_TIMEOUT_MS} ms`));
          }, PROBE_TIMEOUT_MS);
        }),
      ]);
      return indicator.up();
    } catch (error) {
      this.logger.error({ err: error, dependency: key }, 'Dependency health check failed');
      return indicator.down();
    } finally {
      clearTimeout(timer);
    }
  }
}
