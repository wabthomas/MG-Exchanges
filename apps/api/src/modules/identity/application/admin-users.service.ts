import {
  ADMIN_LOOKUP_MAX_RESULTS,
  type AdminUserActionRequest,
  type AdminUserDetail,
  type AdminUserList,
  type AdminUserListQuery,
  type AdminUserLookupRequest,
  type AdminUserLookupResult,
  type AdminUserSummary,
  ROLE_MANAGEMENT_PERMISSION,
  type SuspendUserRequest,
  type UserStatus,
} from '@mgx/contracts';
import { localeSchema } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { identifierDigest } from '../domain/identifier-digest.js';
import { SECURITY_NOTICE_REQUESTED_EVENT, type SecurityNotice } from '../domain/identity-events.js';
import { SecondFactorThrottle } from '../infrastructure/second-factor-throttle.js';
import type { ClientContext } from './client-context.js';
import { effectiveProfileOf } from './effective-profile.js';
import { MfaRepository } from './mfa.repository.js';
import { PendingLoginStore } from './pending-login.store.js';
import { ProfileRepository } from './profile.repository.js';
import { SessionRepository } from './session.repository.js';
import { type DirectoryEntry, UserDirectory } from './user-directory.js';
import { UserRepository } from './user.repository.js';
import { VerificationStatusReader } from './verification-status.reader.js';

/** Membre du personnel à l'origine d'une action du back-office. */
export interface StaffActor {
  readonly userId: string;
  readonly client: ClientContext;
}

function toSummary(entry: DirectoryEntry): AdminUserSummary {
  return {
    id: entry.id,
    email: entry.email,
    emailVerified: entry.emailVerifiedAt !== null,
    phone: entry.phone,
    phoneVerified: entry.phoneVerifiedAt !== null,
    countryCode: entry.countryCode,
    accountType: entry.accountType,
    status: entry.status,
    roles: [...entry.roles],
    secondFactorEnabled: entry.secondFactorEnabled,
    createdAt: entry.createdAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Account not found.');
}

const STATUS_DESCRIPTIONS: Record<UserStatus, string> = {
  PENDING_VERIFICATION: 'is a registration that has not been verified yet',
  ACTIVE: 'is active',
  SUSPENDED: 'is already suspended',
  CLOSED: 'is closed',
};

/**
 * Actions du personnel sur les comptes : recherche, consultation, suspension, fermeture des
 * sessions, retrait du second facteur.
 *
 * Règles communes :
 *  - toute action est justifiée, et écrite au journal d'audit dans la transaction qui
 *    l'applique — y compris la consultation d'un compte, qui donne accès à des données
 *    personnelles ;
 *  - nul n'agit sur son propre compte par le back-office ;
 *  - agir sur le compte d'un membre du personnel exige, en plus de la permission de la route,
 *    celle de gérer les rôles : le support ne peut ni suspendre ni déconnecter un
 *    administrateur, ni lui retirer son second facteur.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly directory: UserDirectory,
    private readonly users: UserRepository,
    private readonly profiles: ProfileRepository,
    private readonly mfa: MfaRepository,
    private readonly sessions: SessionRepository,
    private readonly pendingLogins: PendingLoginStore,
    private readonly throttle: SecondFactorThrottle,
    private readonly verification: VerificationStatusReader,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /**
   * Parcours de la liste des comptes. Chaque page consultée est journalisée : un parcours
   * systématique doit se voir.
   */
  async list(query: AdminUserListQuery, actor: StaffActor): Promise<AdminUserList> {
    const found = await this.directory.search(this.prisma, { ...query, limit: query.limit + 1 });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'user.listed_by_admin',
      resource: { type: 'user' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.before === undefined ? {} : { before: query.before }),
        limit: query.limit,
        results: page.length,
      },
    });

    return {
      users: page.map(toSummary),
      nextCursor: found.length > query.limit && last !== undefined ? last.id : null,
    };
  }

  /**
   * Recherche par identifiant complet (adresse, numéro, identifiant) : il n'y a pas de
   * recherche par fragment. Chaque recherche est journalisée, qu'elle aboutisse ou non. Le
   * journal retient le critère et le nombre de résultats — de l'identifiant saisi, qui peut
   * être celui d'un tiers, seulement une empreinte.
   */
  async lookup(request: AdminUserLookupRequest, actor: StaffActor): Promise<AdminUserLookupResult> {
    const found = await this.directory.search(this.prisma, {
      ...request,
      limit: ADMIN_LOOKUP_MAX_RESULTS,
    });

    const typed = request.email ?? request.phone;
    const match = found.length === 1 ? found[0] : undefined;
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'user.searched_by_admin',
      resource: match === undefined ? { type: 'user' } : { type: 'user', id: match.id },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        criterion:
          request.email !== undefined ? 'EMAIL' : request.phone !== undefined ? 'PHONE' : 'ID',
        ...(typed === undefined ? {} : { identifierDigest: identifierDigest(typed) }),
        results: found.length,
      },
    });

    return { users: found.map(toSummary) };
  }

  /** Fiche d'un compte. La consultation est journalisée. */
  async get(userId: string, actor: StaffActor): Promise<AdminUserDetail> {
    const now = this.clock.now();
    const [entry, declared, verification, totp, recoveryCodesRemaining, activeSessions] =
      await Promise.all([
        this.directory.find(this.prisma, userId),
        this.profiles.find(this.prisma, userId),
        this.verification.read(this.prisma, userId),
        this.mfa.findTotp(this.prisma, userId),
        this.mfa.countUnusedRecoveryCodes(this.prisma, userId),
        this.sessions.countActive(this.prisma, userId, now),
      ]);
    if (entry === null) {
      throw notFound();
    }
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'user.viewed_by_admin',
      resource: { type: 'user', id: userId },
      outcome: 'SUCCESS',
      ...actor.client,
    });

    const enabledAt = totp?.confirmedAt ?? null;
    const { identityVerified, addressVerified, dateOfBirth, ...profile } = effectiveProfileOf(
      declared,
      verification,
    );
    return {
      ...toSummary(entry),
      locale: localeSchema.catch('fr').parse(entry.locale),
      termsAcceptedAt: entry.termsAcceptedAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
      profile: { ...profile, dateOfBirth: dateOfBirth?.toISOString().slice(0, 10) ?? null },
      verification: { level: verification.level, identityVerified, addressVerified },
      secondFactor: {
        enabled: enabledAt !== null,
        enabledAt: enabledAt?.toISOString() ?? null,
        recoveryCodesRemaining: enabledAt === null ? 0 : recoveryCodesRemaining,
      },
      activeSessions,
    };
  }

  /**
   * Suspend un compte actif : ses sessions sont fermées et il ne peut plus se connecter.
   * Le titulaire est prévenu par e-mail, sans que la raison lui soit donnée, sauf demande
   * contraire (`notifyUser: false`).
   */
  async suspend(
    userId: string,
    request: SuspendUserRequest,
    actor: StaffActor,
  ): Promise<AdminUserSummary> {
    const target = await this.targetOf(userId, actor, 'user.suspension_denied');
    if (target.status !== 'ACTIVE') {
      throw new AppError(
        'CONFLICT',
        `Only an active account can be suspended: this one ${STATUS_DESCRIPTIONS[target.status]}.`,
      );
    }

    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.changeStatus(tx, userId, 'ACTIVE', 'SUSPENDED'))) {
        throw new AppError('CONFLICT', 'The account is no longer active.');
      }
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        userId,
        'ACCOUNT_DISABLED',
        now,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: actor.userId },
        action: 'user.suspended',
        resource: { type: 'user', id: userId },
        outcome: 'SUCCESS',
        ...actor.client,
        metadata: { reason: request.reason, revokedSessions, userNotified: request.notifyUser },
      });
      if (request.notifyUser) {
        await this.notify(tx, userId, 'ACCOUNT_SUSPENDED', actor.client);
      }
    });
    // Une connexion restée à mi-chemin (seconde étape en attente) ne doit pas aboutir.
    await this.pendingLogins.invalidateAllForUser(userId);
    return this.summaryOf(userId);
  }

  /** Lève la suspension d'un compte : il peut de nouveau se connecter. */
  async reactivate(
    userId: string,
    request: AdminUserActionRequest,
    actor: StaffActor,
  ): Promise<AdminUserSummary> {
    const target = await this.targetOf(userId, actor, 'user.reactivation_denied');
    if (target.status !== 'SUSPENDED') {
      throw new AppError('CONFLICT', 'Only a suspended account can be reactivated.');
    }

    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.changeStatus(tx, userId, 'SUSPENDED', 'ACTIVE'))) {
        throw new AppError('CONFLICT', 'The account is no longer suspended.');
      }
      // Réactiver ne ranime aucune session : une connexion qui se serait achevée à l'instant
      // même de la suspension — donc sans avoir été fermée par elle — est fermée ici.
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        userId,
        'ACCOUNT_DISABLED',
        now,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: actor.userId },
        action: 'user.reactivated',
        resource: { type: 'user', id: userId },
        outcome: 'SUCCESS',
        ...actor.client,
        metadata: { reason: request.reason, revokedSessions },
      });
      await this.notify(tx, userId, 'ACCOUNT_REACTIVATED', actor.client);
    });
    await this.pendingLogins.invalidateAllForUser(userId);
    return this.summaryOf(userId);
  }

  /** Ferme toutes les sessions d'un compte (appareil perdu, soupçon de compromission). */
  async revokeSessions(
    userId: string,
    request: AdminUserActionRequest,
    actor: StaffActor,
  ): Promise<{ readonly revokedSessions: number }> {
    await this.targetOf(userId, actor, 'user.session_revocation_denied');

    const now = this.clock.now();
    const revokedSessions = await this.unitOfWork.run(async (tx) => {
      const revoked = await this.sessions.revokeAllForUser(tx, userId, 'ADMIN_REVOKED', now);
      await this.audit.record(tx, {
        actor: { type: 'USER', id: actor.userId },
        action: 'user.sessions_revoked_by_admin',
        resource: { type: 'user', id: userId },
        outcome: 'SUCCESS',
        ...actor.client,
        metadata: { reason: request.reason, revokedSessions: revoked },
      });
      return revoked;
    });
    await this.pendingLogins.invalidateAllForUser(userId);
    return { revokedSessions };
  }

  /**
   * Retire le second facteur d'un compte dont le titulaire a perdu son application
   * d'authentification **et** ses codes de secours. C'est l'action la plus sensible du
   * support — elle ramène le compte à la seule protection du mot de passe — : le titulaire
   * est toujours prévenu, toutes ses sessions sont fermées, et la procédure du support doit
   * avoir établi son identité auparavant (voir docs/SECURITY.md).
   */
  async resetSecondFactor(
    userId: string,
    request: AdminUserActionRequest,
    actor: StaffActor,
  ): Promise<void> {
    await this.targetOf(userId, actor, 'mfa.reset_denied');
    if (!(await this.mfa.isTotpEnabled(this.prisma, userId))) {
      throw new AppError('CONFLICT', 'Two-step verification is not enabled on this account.');
    }

    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.mfa.deleteTotp(tx, userId))) {
        throw new AppError('CONFLICT', 'Two-step verification is not enabled on this account.');
      }
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        userId,
        'SECOND_FACTOR_CHANGED',
        now,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: actor.userId },
        action: 'mfa.reset_by_admin',
        resource: { type: 'user', id: userId },
        outcome: 'SUCCESS',
        ...actor.client,
        metadata: { reason: request.reason, method: 'TOTP', revokedSessions },
      });
      await this.notify(tx, userId, 'TWO_FACTOR_RESET_BY_SUPPORT', actor.client);
    });
    await this.pendingLogins.invalidateAllForUser(userId);
    await this.throttle.clear(userId);
  }

  /**
   * Compte visé par une action, après vérification que l'auteur a qualité pour agir sur lui.
   * Un refus est journalisé sous `deniedAction`.
   */
  private async targetOf(
    userId: string,
    actor: StaffActor,
    deniedAction: string,
  ): Promise<DirectoryEntry> {
    const target = await this.directory.find(this.prisma, userId);
    if (target === null) {
      throw notFound();
    }
    if (target.id === actor.userId) {
      await this.recordDenial(actor, userId, deniedAction, 'OWN_ACCOUNT');
      throw new AppError(
        'FORBIDDEN',
        'You cannot perform this action on your own account from the back office.',
      );
    }
    if (target.roles.length > 0) {
      const { permissions } = await this.users.findAccess(this.prisma, actor.userId);
      if (!permissions.includes(ROLE_MANAGEMENT_PERMISSION)) {
        await this.recordDenial(actor, userId, deniedAction, 'STAFF_ACCOUNT');
        throw new AppError(
          'FORBIDDEN',
          `Acting on a staff account requires the "${ROLE_MANAGEMENT_PERMISSION}" permission.`,
        );
      }
    }
    return target;
  }

  private async recordDenial(
    actor: StaffActor,
    userId: string,
    action: string,
    reason: 'OWN_ACCOUNT' | 'STAFF_ACCOUNT',
  ): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action,
      resource: { type: 'user', id: userId },
      outcome: 'DENIED',
      ...actor.client,
      metadata: { reason },
    });
  }

  private async summaryOf(userId: string): Promise<AdminUserSummary> {
    const entry = await this.directory.find(this.prisma, userId);
    if (entry === null) {
      throw notFound();
    }
    return toSummary(entry);
  }

  private async notify(
    tx: DbClient,
    userId: string,
    notice: SecurityNotice,
    client: ClientContext,
  ): Promise<void> {
    await this.outbox.append(tx, {
      aggregateType: 'user',
      aggregateId: userId,
      eventType: SECURITY_NOTICE_REQUESTED_EVENT,
      payload: { userId, notice },
      metadata: { requestId: client.requestId },
    });
  }
}
