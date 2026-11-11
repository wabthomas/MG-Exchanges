import { localeSchema } from '@mgx/validation';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { NotificationService } from '../../notifications/application/notification.service.js';
import { DomainEventHandlerRegistry } from '../../outbox/application/domain-event-handler.registry.js';
import type { DomainEventEnvelope, DomainEventHandler } from '../../outbox/domain/domain-event.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { ACCOUNT_EXISTS_NOTICES_PER_ACCOUNT } from './identity-policy.js';
import { UserRepository } from './user.repository.js';

const payloadSchema = z.object({
  userId: z.uuid(),
  notice: z.enum(['ACCOUNT_ALREADY_EXISTS', 'PASSWORD_CHANGED']),
});

/** Informe le titulaire d'un compte d'un événement de sécurité le concernant. */
@Injectable()
export class SecurityNoticeDispatcher implements DomainEventHandler, OnModuleInit {
  readonly name = 'identity.send-security-notice';
  readonly eventType = SECURITY_NOTICE_REQUESTED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly users: UserRepository,
    private readonly notifications: NotificationService,
    private readonly limiter: RedisRateLimiter,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const { userId, notice } = payloadSchema.parse(event.payload);

    const user = await this.users.findById(this.prisma, userId);
    if (user === null) {
      return;
    }

    if (notice === 'ACCOUNT_ALREADY_EXISTS') {
      // N'importe qui peut provoquer ce message en saisissant l'adresse d'autrui : un seul
      // par heure, pour qu'il ne devienne pas un moyen de harcèlement.
      const decision = await this.limiter.consume(
        `notice:account-exists:${user.id}`,
        ACCOUNT_EXISTS_NOTICES_PER_ACCOUNT,
      );
      if (decision.blocked) {
        return;
      }
    }

    await this.notifications.send({
      channel: 'EMAIL',
      recipient: user.email,
      locale: localeSchema.catch('fr').parse(user.locale),
      content: {
        template:
          notice === 'ACCOUNT_ALREADY_EXISTS' ? 'account_already_exists' : 'password_changed',
      },
    });
  }
}
