import { KYC_REJECTION_REASONS, KYC_REJECTION_REASONS_MAX, kycLevelSchema } from '@mgx/contracts';
import { localeSchema } from '@mgx/validation';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import {
  type RateLimitRule,
  RedisRateLimiter,
} from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { NotificationService } from '../../notifications/application/notification.service.js';
import type { NotificationContent } from '../../notifications/domain/notification.js';
import { DomainEventHandlerRegistry } from '../../outbox/application/domain-event-handler.registry.js';
import type { DomainEventEnvelope, DomainEventHandler } from '../../outbox/domain/domain-event.js';
import {
  SECURITY_NOTICE_REQUESTED_EVENT,
  SECURITY_NOTICES,
  type SecurityNotice,
} from '../domain/identity-events.js';
import type { UserRecord } from '../domain/user.js';
import { AccountClosureRepository } from './account-closure.repository.js';
import {
  ACCOUNT_EXISTS_NOTICES_PER_ACCOUNT,
  REGISTRATION_INCOMPLETE_NOTICES_PER_ACCOUNT,
} from './identity-policy.js';
import { UserRepository } from './user.repository.js';

const payloadSchema = z.object({
  userId: z.uuid(),
  notice: z.enum(SECURITY_NOTICES),
  /** Précisions propres à certains messages ; ignorées par les autres. */
  details: z
    .object({
      occurredAt: z.iso.datetime().optional(),
      ipAddress: z.string().max(64).nullable().optional(),
      device: z.string().max(64).nullable().optional(),
      remaining: z.number().int().nonnegative().optional(),
      blockedMinutes: z.number().int().positive().optional(),
      /** Vérification d'identité : niveau concerné et motifs d'un refus. */
      level: kycLevelSchema.optional(),
      reasons: z.array(z.enum(KYC_REJECTION_REASONS)).max(KYC_REJECTION_REASONS_MAX).optional(),
      /** Clôture du compte : son origine et ce qu'il advient des données. */
      byStaff: z.boolean().optional(),
      erasureDueAt: z.iso.datetime().optional(),
      retainedUntil: z.iso.datetime().optional(),
    })
    .optional(),
});

type Details = NonNullable<z.infer<typeof payloadSchema>['details']>;

/**
 * Messages que n'importe qui peut provoquer en saisissant l'adresse d'autrui : un seul par
 * heure et par compte, pour qu'ils ne deviennent pas un moyen de harcèlement.
 */
const THROTTLED: Partial<Record<SecurityNotice, RateLimitRule>> = {
  ACCOUNT_ALREADY_EXISTS: ACCOUNT_EXISTS_NOTICES_PER_ACCOUNT,
  REGISTRATION_INCOMPLETE: REGISTRATION_INCOMPLETE_NOTICES_PER_ACCOUNT,
};

function contentOf(notice: SecurityNotice, details: Details, sentAt: string): NotificationContent {
  switch (notice) {
    case 'ACCOUNT_ALREADY_EXISTS':
      return { template: 'account_already_exists' };
    case 'REGISTRATION_INCOMPLETE':
      return { template: 'registration_incomplete' };
    case 'PASSWORD_CHANGED':
      return { template: 'password_changed' };
    case 'NEW_SIGN_IN':
      return {
        template: 'new_sign_in',
        occurredAt: details.occurredAt ?? sentAt,
        ipAddress: details.ipAddress ?? null,
        device: details.device ?? null,
      };
    case 'TWO_FACTOR_ENABLED':
      return { template: 'two_factor_enabled' };
    case 'TWO_FACTOR_DISABLED':
      return { template: 'two_factor_disabled', bySupport: false };
    case 'TWO_FACTOR_RESET_BY_SUPPORT':
      return { template: 'two_factor_disabled', bySupport: true };
    case 'RECOVERY_CODE_USED':
      return { template: 'recovery_code_used', remaining: details.remaining ?? 0 };
    case 'SECOND_FACTOR_BLOCKED':
      return { template: 'second_factor_blocked', blockedMinutes: details.blockedMinutes ?? 15 };
    case 'ACCOUNT_SUSPENDED':
      return { template: 'account_suspended' };
    case 'ACCOUNT_REACTIVATED':
      return { template: 'account_reactivated' };
    case 'IDENTITY_VERIFICATION_APPROVED':
      return { template: 'identity_verification_approved', level: details.level ?? 1 };
    case 'IDENTITY_VERIFICATION_REJECTED':
      return {
        template: 'identity_verification_rejected',
        level: details.level ?? 1,
        reasons: details.reasons ?? ['OTHER'],
      };
    case 'IDENTITY_VERIFICATION_REVOKED':
      return { template: 'identity_verification_revoked', level: details.level ?? 1 };
    case 'ACCOUNT_CLOSED':
      return {
        template: 'account_closed',
        byStaff: details.byStaff ?? false,
        erasureDueAt: details.erasureDueAt ?? sentAt,
        retainedUntil: details.retainedUntil ?? null,
      };
    case 'DATA_EXPORTED':
      return {
        template: 'data_exported',
        occurredAt: details.occurredAt ?? sentAt,
        ipAddress: details.ipAddress ?? null,
      };
  }
}

/** Informe le titulaire d'un compte, par e-mail, d'un événement de sécurité le concernant. */
@Injectable()
export class SecurityNoticeDispatcher implements DomainEventHandler, OnModuleInit {
  readonly name = 'identity.send-security-notice';
  readonly eventType = SECURITY_NOTICE_REQUESTED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly users: UserRepository,
    private readonly closures: AccountClosureRepository,
    private readonly notifications: NotificationService,
    private readonly limiter: RedisRateLimiter,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const { userId, notice, details } = payloadSchema.parse(event.payload);

    const user = await this.users.findById(this.prisma, userId);
    if (user === null) {
      return;
    }
    const recipient = await this.recipientOf(user, notice);
    if (recipient === null) {
      return;
    }
    // Ces messages informent, ils ne conditionnent aucun parcours : sans moyen de remise
    // configuré, l'événement est abandonné plutôt que retenté indéfiniment.
    if (!this.notifications.canDeliver('EMAIL')) {
      return;
    }

    const rule = THROTTLED[notice];
    if (rule !== undefined) {
      const decision = await this.limiter.consume(`notice:${notice}:${user.id}`, rule);
      if (decision.blocked) {
        return;
      }
    }

    await this.notifications.send({
      channel: 'EMAIL',
      recipient,
      locale: localeSchema.catch('fr').parse(user.locale),
      content: contentOf(notice, details ?? {}, event.occurredAt),
    });
  }

  /**
   * Adresse à laquelle écrire. Un compte clôturé n'en porte plus : seul l'avis de clôture lui
   * est encore adressé, à l'adresse que garde la trace de la clôture — tant qu'elle n'a pas
   * été effacée. Tout autre message resté en attente est abandonné.
   */
  private async recipientOf(user: UserRecord, notice: SecurityNotice): Promise<string | null> {
    if (user.status !== 'CLOSED') {
      return user.email;
    }
    if (notice !== 'ACCOUNT_CLOSED') {
      return null;
    }
    const closure = await this.closures.find(this.prisma, user.id);
    return closure?.email ?? null;
  }
}
