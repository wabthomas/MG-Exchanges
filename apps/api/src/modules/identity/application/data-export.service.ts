import {
  DATA_EXPORT_ACTIVITY_MAX_ENTRIES,
  DATA_EXPORT_FORMAT_VERSION,
  DATA_EXPORTS_PER_DAY,
  type DataExport,
  type DataExportRequest,
} from '@mgx/contracts';
import { localeSchema } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import {
  type RateLimitRule,
  RedisRateLimiter,
} from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { AccountDataReader } from './account-data.reader.js';
import { AccountDataRegistry, type ExportedSections } from './account-data.registry.js';
import { ActivityService } from './activity.service.js';
import type { ClientContext } from './client-context.js';
import { HolderProofService } from './holder-proof.service.js';
import { TermsService } from './terms.service.js';

/** Copies des données remises à un même compte : `DATA_EXPORTS_PER_DAY` par vingt-quatre heures. */
export const DATA_EXPORTS_PER_ACCOUNT: RateLimitRule = {
  limit: DATA_EXPORTS_PER_DAY,
  windowMs: 24 * 60 * 60 * 1000,
};

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * Copie des données personnelles d'un compte, remise à son titulaire (droit d'accès et
 * portabilité).
 *
 * Elle rassemble tout ce que le titulaire pourrait consulter écran par écran : c'est
 * précisément ce qui en fait une cible. Elle exige donc la même preuve que la clôture — mot de
 * passe et second facteur —, son nombre est borné, elle est inscrite à l'historique du compte
 * et signalée par e-mail. Elle ne contient ni secret, ni fichier joint à un dossier de
 * vérification, ni le numéro complet d'une pièce d'identité.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly reader: AccountDataReader,
    private readonly holders: AccountDataRegistry,
    private readonly activity: ActivityService,
    private readonly proof: HolderProofService,
    private readonly terms: TermsService,
    private readonly limiter: RedisRateLimiter,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async export(
    auth: AuthenticatedUser,
    request: DataExportRequest,
    client: ClientContext,
  ): Promise<DataExport> {
    const user = await this.proof.confirm(auth, request, client, 'user.data_export_failed');

    const decision = await this.limiter.consume(`data-export:${user.id}`, DATA_EXPORTS_PER_ACCOUNT);
    if (decision.blocked) {
      throw new AppError('RATE_LIMITED', 'Too many copies requested. Please try again later.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    const generatedAt = this.clock.now();
    const data = await this.reader.read(this.prisma, user.id);
    if (data === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }
    const activity = await this.activity.collect(user.id, DATA_EXPORT_ACTIVITY_MAX_ENTRIES);
    const terms = await this.terms.exportOf(this.prisma, user.id);
    const others: ExportedSections = {};
    for (const holder of this.holders.holders()) {
      Object.assign(others, await holder.exportData(this.prisma, user.id));
    }

    await this.unitOfWork.run(async (tx) => {
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.data_exported',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: {
          formatVersion: DATA_EXPORT_FORMAT_VERSION,
          sessions: data.sessions.length,
          activityEntries: activity.entries.length,
          verificationCases: others.verification?.cases.length ?? 0,
          termsAcceptances: terms.acceptances.length,
        },
      });
      await this.outbox.append(tx, {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: SECURITY_NOTICE_REQUESTED_EVENT,
        payload: {
          userId: user.id,
          notice: 'DATA_EXPORTED',
          details: { occurredAt: iso(generatedAt), ipAddress: client.ipAddress ?? null },
        },
        metadata: { requestId: client.requestId },
      });
    });

    const { account, profile, security } = data;
    return {
      formatVersion: DATA_EXPORT_FORMAT_VERSION,
      generatedAt: iso(generatedAt),
      account: {
        id: account.id,
        email: account.email,
        emailVerified: account.emailVerifiedAt !== null,
        phone: account.phone,
        phoneVerified: account.phoneVerifiedAt !== null,
        countryCode: account.countryCode,
        locale: localeSchema.catch('fr').parse(account.locale),
        accountType: account.accountType,
        status: account.status,
        createdAt: iso(account.createdAt),
        roles: [...account.roles],
      },
      profile:
        profile === null
          ? null
          : {
              givenName: profile.givenName,
              familyName: profile.familyName,
              additionalName: profile.additionalName,
              dateOfBirth: profile.dateOfBirth?.toISOString().slice(0, 10) ?? null,
              addressLine1: profile.addressLine1,
              addressLine2: profile.addressLine2,
              city: profile.city,
              region: profile.region,
              postalCode: profile.postalCode,
              timeZone: profile.timeZone,
              updatedAt: iso(profile.updatedAt),
            },
      security: {
        passwordChangedAt: isoOrNull(security.passwordChangedAt),
        secondFactorEnabled: security.secondFactorEnabledAt !== null,
        secondFactorEnabledAt: isoOrNull(security.secondFactorEnabledAt),
        recoveryCodesRemaining: security.recoveryCodesRemaining,
      },
      sessions: data.sessions.map((session) => ({
        id: session.id,
        createdAt: iso(session.createdAt),
        lastUsedAt: iso(session.lastUsedAt),
        expiresAt: iso(session.expiresAt),
        revokedAt: isoOrNull(session.revokedAt),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        deviceName: session.deviceName,
      })),
      activity,
      verification: others.verification ?? { level: 0, cases: [] },
      terms,
    };
  }
}
