import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimitGuard } from './rate-limit.guard.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

/**
 * Limitation de débit globale par adresse IP cliente (compteurs Redis partagés).
 * Les routes sensibles déclarent une limite plus stricte avec `@RateLimit()`.
 */
@Module({
  providers: [RedisRateLimiter, { provide: APP_GUARD, useClass: RateLimitGuard }],
  exports: [RedisRateLimiter],
})
export class RateLimitModule {}
