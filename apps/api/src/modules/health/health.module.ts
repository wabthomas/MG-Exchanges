import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { DependencyHealthIndicator } from './dependency-health.indicator.js';
import { HealthController } from './health.controller.js';

@Module({
  // Les échecs sont journalisés par les sondes elles-mêmes (sans doublon de Terminus).
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [DependencyHealthIndicator],
})
export class HealthModule {}
