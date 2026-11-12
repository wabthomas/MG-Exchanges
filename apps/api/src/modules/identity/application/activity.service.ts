import type { ActivityList, ActivityQuery, ActivityType } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditTrailReader } from '../../audit/application/audit-trail.reader.js';

/**
 * Événements du journal d'audit qu'un utilisateur peut consulter sur son propre compte, et
 * le nom public de chacun. Tout ce qui n'est pas dans cette table reste interne : l'historique
 * n'expose ni les actions d'administration étrangères au compte, ni le détail des entrées.
 */
const ACTIVITY_BY_ACTION: Readonly<Record<string, ActivityType>> = {
  'user.registered': 'ACCOUNT_CREATED',
  'user.email_verified': 'EMAIL_VERIFIED',
  'session.opened': 'SIGN_IN',
  'session.login_failed': 'SIGN_IN_FAILED',
  'session.login_denied': 'SIGN_IN_DENIED',
  'session.second_factor_failed': 'SECOND_FACTOR_FAILED',
  'session.closed': 'SIGN_OUT',
  'session.revoked': 'SESSION_CLOSED',
  'session.others_revoked': 'OTHER_SESSIONS_CLOSED',
  'session.refresh_token_reused': 'SESSION_REVOKED_TOKEN_REUSE',
  'user.password_changed': 'PASSWORD_CHANGED',
  'user.password_change_failed': 'PASSWORD_CHANGE_FAILED',
  'user.password_reset_requested': 'PASSWORD_RESET_REQUESTED',
  'user.password_reset': 'PASSWORD_RESET',
  'mfa.enabled': 'TWO_FACTOR_ENABLED',
  'mfa.disabled': 'TWO_FACTOR_DISABLED',
  'mfa.recovery_codes_regenerated': 'RECOVERY_CODES_REGENERATED',
  'mfa.recovery_code_used': 'RECOVERY_CODE_USED',
  'user.profile_updated': 'PROFILE_UPDATED',
  'user.phone_verified': 'PHONE_VERIFIED',
  'user.suspended': 'ACCOUNT_SUSPENDED',
  'user.reactivated': 'ACCOUNT_REACTIVATED',
  'user.sessions_revoked_by_admin': 'SESSIONS_CLOSED_BY_SUPPORT',
  'mfa.reset_by_admin': 'TWO_FACTOR_RESET_BY_SUPPORT',
  'kyc_case.submitted': 'IDENTITY_VERIFICATION_SUBMITTED',
  'user.verification_approved': 'IDENTITY_VERIFICATION_APPROVED',
  'user.verification_rejected': 'IDENTITY_VERIFICATION_REJECTED',
  'user.verification_revoked': 'IDENTITY_VERIFICATION_REVOKED',
};

const VISIBLE_ACTIONS = Object.keys(ACTIVITY_BY_ACTION);

/** Historique d'activité d'un compte, tel que le voit son titulaire. */
@Injectable()
export class ActivityService {
  constructor(
    private readonly trail: AuditTrailReader,
    private readonly prisma: PrismaService,
  ) {}

  async list(userId: string, query: ActivityQuery): Promise<ActivityList> {
    // Une entrée de plus que demandé : elle dit s'il existe une page suivante.
    const records = await this.trail.listForUser(this.prisma, userId, {
      limit: query.limit + 1,
      before: query.before,
      actions: VISIBLE_ACTIONS,
    });
    const page = records.slice(0, query.limit);

    return {
      entries: page.flatMap((record) => {
        const type = ACTIVITY_BY_ACTION[record.action];
        if (type === undefined) {
          return [];
        }
        // L'adresse et l'appareil d'un membre du personnel ne regardent pas l'utilisateur.
        const byStaff = record.actorType === 'USER' && record.actorId !== userId;
        return [
          {
            id: record.id,
            type,
            occurredAt: record.occurredAt.toISOString(),
            outcome: record.outcome,
            ipAddress: byStaff ? null : record.ipAddress,
            userAgent: byStaff ? null : record.userAgent,
          },
        ];
      }),
      nextCursor: records.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
