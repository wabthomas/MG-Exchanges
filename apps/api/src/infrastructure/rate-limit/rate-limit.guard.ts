import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { AppError } from '../../common/errors/app-error.js';
import { AppConfig } from '../../config/app-config.js';
import {
  RATE_LIMIT_POLICY_KEY,
  type RateLimitPolicy,
  SKIP_RATE_LIMIT_KEY,
} from './rate-limit.decorators.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

/**
 * Garde globale de limitation de débit, par adresse IP cliente.
 *
 * L'adresse retenue est celle résolue par Express selon `TRUST_PROXY_HOPS` : derrière le
 * reverse proxy, l'en-tête `X-Forwarded-For` n'est pris en compte que pour le nombre de
 * proxys de confiance configuré — un client ne peut pas usurper une autre adresse.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly defaultPolicy: RateLimitPolicy;

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RedisRateLimiter,
    config: AppConfig,
  ) {
    this.defaultPolicy = {
      name: 'default',
      limit: config.http.rateLimit.maxRequests,
      windowMs: config.http.rateLimit.windowMs,
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(SKIP_RATE_LIMIT_KEY, targets) === true
    ) {
      return true;
    }

    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(
        RATE_LIMIT_POLICY_KEY,
        targets,
      ) ?? this.defaultPolicy;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const client = request.ip ?? request.socket.remoteAddress ?? 'unknown';

    const decision = await this.limiter.consume(`${policy.name}:${client}`, policy);

    response.setHeader('X-RateLimit-Limit', policy.limit);
    response.setHeader('X-RateLimit-Remaining', decision.remaining);
    response.setHeader('X-RateLimit-Reset', decision.resetSeconds);

    if (decision.blocked) {
      response.setHeader('Retry-After', decision.retryAfterSeconds);
      throw new AppError('RATE_LIMITED', 'Too many requests. Please retry later.');
    }
    return true;
  }
}
