import type {
  ChangePasswordRequest,
  EmailOnlyRequest,
  PasswordResetPending,
  ResetPasswordRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { LoginThrottle } from '../infrastructure/login-throttle.js';
import type { ClientContext } from './client-context.js';
import { PASSWORD_CHANGE_FAILURES_PER_ACCOUNT } from './identity-policy.js';
import { PasswordHasher } from './password-hasher.js';
import { assertAcceptablePassword } from './password-rules.js';
import { SessionRepository } from './session.repository.js';
import { UserRepository } from './user.repository.js';
import { invalidCodeError, VerificationService } from './verification.service.js';

/** Réinitialisation (mot de passe oublié) et changement du mot de passe. */
@Injectable()
export class PasswordService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly verification: VerificationService,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly limiter: RedisRateLimiter,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Envoie un code de réinitialisation si le compte existe. La réponse est toujours la même. */
  async requestReset(
    request: EmailOnlyRequest,
    client: ClientContext,
  ): Promise<PasswordResetPending> {
    this.verification.assertDeliveryAvailable();

    const user = await this.users.findByEmail(this.prisma, request.email);
    // Un compte suspendu ou clôturé ne se rouvre pas par une réinitialisation.
    if (user !== null && (user.status === 'ACTIVE' || user.status === 'PENDING_VERIFICATION')) {
      await this.unitOfWork.run(async (tx) => {
        if (await this.verification.request(tx, user, 'PASSWORD_RESET', client)) {
          await this.audit.record(tx, {
            actor: { type: 'SYSTEM' },
            action: 'user.password_reset_requested',
            resource: { type: 'user', id: user.id },
            outcome: 'SUCCESS',
            ...client,
          });
        }
      });
    }
    return { nextStep: 'RESET_PASSWORD', codeTtlSeconds: this.verification.codeTtlSeconds };
  }

  async reset(request: ResetPasswordRequest, client: ClientContext): Promise<void> {
    // Ne dépend que de la requête : cette erreur ne dit rien de l'existence du compte.
    assertAcceptablePassword(request.newPassword, { email: request.email }, 'newPassword');

    const now = new Date();
    const user = await this.users.findByEmail(this.prisma, request.email);
    if (user === null) {
      throw invalidCodeError();
    }

    const challenge = await this.verification.check(user.id, 'PASSWORD_RESET', request.code, now);
    if (challenge?.target !== user.email) {
      await this.audit.record(this.prisma, {
        actor: { type: 'SYSTEM' },
        action: 'user.password_reset_failed',
        resource: { type: 'user', id: user.id },
        outcome: 'FAILURE',
        ...client,
      });
      throw invalidCodeError();
    }
    assertAcceptablePassword(request.newPassword, user, 'newPassword');

    const passwordHash = await this.hasher.hash(request.newPassword);
    const done = await this.unitOfWork.run(async (tx) => {
      if (!(await this.verification.consume(tx, challenge.id, now))) {
        return false;
      }
      await this.users.updatePasswordHash(tx, user.id, passwordHash, now);
      // Le code est arrivé dans la boîte aux lettres : l'adresse est, de fait, vérifiée.
      await this.users.markEmailVerified(tx, user.id, now);
      // Quiconque détenait une session — y compris un intrus — la perd.
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        user.id,
        'PASSWORD_RESET',
        now,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.password_reset',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { revokedSessions },
      });
      await this.notifyPasswordChanged(tx, user.id, client);
      return true;
    });
    if (!done) {
      throw invalidCodeError();
    }

    await this.throttle.clearAccount(user.email, client.ipAddress ?? 'unknown');
  }

  async change(
    auth: AuthenticatedUser,
    request: ChangePasswordRequest,
    client: ClientContext,
  ): Promise<void> {
    const failuresKey = `password-change-failures:${auth.userId}`;
    const blockedFor = await this.limiter.blockedForSeconds(failuresKey);
    if (blockedFor > 0) {
      throw new AppError('RATE_LIMITED', 'Too many failed attempts. Please try again later.', {
        retryAfterSeconds: blockedFor,
      });
    }

    const user = await this.users.findById(this.prisma, auth.userId);
    const currentHash = await this.users.findPasswordHash(this.prisma, auth.userId);
    if (user === null || currentHash === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }

    // Une session ouverte ne suffit pas : le mot de passe actuel prouve que c'est bien le titulaire.
    if (!(await this.hasher.verify(currentHash, request.currentPassword))) {
      await this.limiter.consume(failuresKey, PASSWORD_CHANGE_FAILURES_PER_ACCOUNT);
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.id },
        action: 'user.password_change_failed',
        resource: { type: 'user', id: user.id },
        outcome: 'FAILURE',
        ...client,
      });
      throw new AppError('INVALID_CREDENTIALS', 'The current password is incorrect.');
    }
    assertAcceptablePassword(request.newPassword, user, 'newPassword');

    const now = new Date();
    const passwordHash = await this.hasher.hash(request.newPassword);
    await this.unitOfWork.run(async (tx) => {
      await this.users.updatePasswordHash(tx, user.id, passwordHash, now);
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        user.id,
        'PASSWORD_CHANGED',
        now,
        auth.sessionId,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.password_changed',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { revokedSessions },
      });
      await this.notifyPasswordChanged(tx, user.id, client);
    });
    await this.limiter.reset(failuresKey);
  }

  private async notifyPasswordChanged(
    tx: DbClient,
    userId: string,
    client: ClientContext,
  ): Promise<void> {
    await this.outbox.append(tx, {
      aggregateType: 'user',
      aggregateId: userId,
      eventType: SECURITY_NOTICE_REQUESTED_EVENT,
      payload: { userId, notice: 'PASSWORD_CHANGED' },
      metadata: { requestId: client.requestId },
    });
  }
}
