import type {
  ChangePasswordRequest,
  EmailOnlyRequest,
  PasswordResetPending,
  ResetPasswordRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isAccountClosedError } from '../../../infrastructure/database/database-errors.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { LoginThrottle } from '../infrastructure/login-throttle.js';
import type { ClientContext } from './client-context.js';
import { PasswordHasher } from './password-hasher.js';
import { assertAcceptablePassword } from './password-rules.js';
import { PendingLoginStore } from './pending-login.store.js';
import { ReauthenticationService } from './reauthentication.service.js';
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
    private readonly reauthentication: ReauthenticationService,
    private readonly pendingLogins: PendingLoginStore,
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
    // Seul un compte actif se réinitialise : un compte suspendu ou clôturé ne se rouvre pas
    // ainsi, et une inscription inachevée ne s'achève que par la vérification de l'adresse.
    if (user?.status === 'ACTIVE') {
      await this.unitOfWork
        .run(async (tx) => {
          if (await this.verification.request(tx, user, 'PASSWORD_RESET', client)) {
            await this.audit.record(tx, {
              actor: { type: 'SYSTEM' },
              action: 'user.password_reset_requested',
              resource: { type: 'user', id: user.id },
              outcome: 'SUCCESS',
              ...client,
            });
          }
        })
        .catch((error: unknown) => {
          // Le compte a été clôturé pendant la requête. La réponse reste celle d'une adresse
          // inconnue : elle ne dit pas qu'un compte portait cette adresse à l'instant.
          if (!isAccountClosedError(error)) {
            throw error;
          }
        });
    } else if (user?.status === 'PENDING_VERIFICATION') {
      // La personne croit avoir un compte : elle est invitée, par e-mail, à reprendre
      // l'inscription. Réinitialiser activerait un compte dont les informations déclarées
      // et l'acceptation des conditions peuvent venir de quelqu'un d'autre.
      await this.unitOfWork.run(async (tx) => {
        await this.audit.record(tx, {
          actor: { type: 'SYSTEM' },
          action: 'user.password_reset_requested',
          resource: { type: 'user', id: user.id },
          outcome: 'DENIED',
          ...client,
          metadata: { reason: 'REGISTRATION_INCOMPLETE' },
        });
        await this.outbox.append(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: SECURITY_NOTICE_REQUESTED_EVENT,
          payload: { userId: user.id, notice: 'REGISTRATION_INCOMPLETE' },
          metadata: { requestId: client.requestId },
        });
      });
    }
    return { nextStep: 'RESET_PASSWORD', codeTtlSeconds: this.verification.codeTtlSeconds };
  }

  async reset(request: ResetPasswordRequest, client: ClientContext): Promise<void> {
    // Ne dépend que de la requête : cette erreur ne dit rien de l'existence du compte.
    assertAcceptablePassword(request.newPassword, { email: request.email }, 'newPassword');

    const now = new Date();
    const user = await this.users.findByEmail(this.prisma, request.email);
    if (user?.status !== 'ACTIVE') {
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
      if (
        !(await this.verification.consume(tx, challenge.id, now)) ||
        // Plus de mot de passe à remplacer : le compte a été clôturé entre-temps.
        !(await this.users.updatePasswordHash(tx, user.id, passwordHash, now))
      ) {
        return false;
      }
      // Quiconque détenait une session — y compris un intrus — la perd. Le second facteur,
      // lui, reste en place : l'accès à la boîte aux lettres ne suffit pas à le contourner.
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

    // Une connexion restée en attente du second facteur a été ouverte avec l'ancien mot de passe.
    await this.pendingLogins.invalidateAllForUser(user.id);
    await this.throttle.clearAccount(user.email, client.ipAddress ?? 'unknown');
  }

  async change(
    auth: AuthenticatedUser,
    request: ChangePasswordRequest,
    client: ClientContext,
  ): Promise<void> {
    // Une session ouverte ne suffit pas : le mot de passe actuel prouve que c'est bien le titulaire.
    const user = await this.reauthentication.confirmPassword(
      auth,
      request.currentPassword,
      client,
      'user.password_change_failed',
    );
    assertAcceptablePassword(request.newPassword, user, 'newPassword');

    const now = new Date();
    const passwordHash = await this.hasher.hash(request.newPassword);
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.updatePasswordHash(tx, user.id, passwordHash, now))) {
        // Le compte a été clôturé pendant la requête, après la confirmation du mot de passe :
        // même réponse que pour toute écriture arrivée après la clôture.
        throw new AppError('CONFLICT', 'This account is closed.');
      }
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
    await this.pendingLogins.invalidateAllForUser(user.id);
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
