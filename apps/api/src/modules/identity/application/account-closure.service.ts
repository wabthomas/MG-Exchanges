import type {
  AccountClosure,
  AccountClosureBlocker,
  AccountClosureGround,
  AccountClosureOrigin,
  AdminAccountClosure,
  CloseAccountRequest,
  CloseUserRequest,
} from '@mgx/contracts';
import { setTimeout as pause } from 'node:timers/promises';

import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isLockContention } from '../../../infrastructure/database/database-errors.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { erasureDueAt, latestRetention } from '../domain/account-closure.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { SecondFactorThrottle } from '../infrastructure/second-factor-throttle.js';
import {
  AccountClosureRepository,
  type ClosureRecord,
  ClosureRuleViolationError,
} from './account-closure.repository.js';
import { toAdminClosureView, toClosureView } from './account-closure.views.js';
import { AccountDataRegistry, type AfterClosure } from './account-data.registry.js';
import type { StaffActor } from './admin-users.service.js';
import type { ClientContext } from './client-context.js';
import { HolderProofService } from './holder-proof.service.js';
import { PendingLoginStore } from './pending-login.store.js';
import { UserRepository } from './user.repository.js';

const BLOCKER_MESSAGES: Record<AccountClosureBlocker, string> = {
  ROLE_HELD: 'it holds a back-office role, which must be removed first',
  VERIFICATION_PENDING_REVIEW:
    'an identity verification case awaits review, and must be decided first',
  FUNDS_REMAINING: 'it still holds funds, which must be withdrawn or transferred first',
};

function blocked(blockers: readonly AccountClosureBlocker[]): AppError {
  const reasons = blockers.map((blocker) => BLOCKER_MESSAGES[blocker]).join('; ');
  return new AppError('CONFLICT', `The account cannot be closed: ${reasons}.`);
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Account not found.');
}

/**
 * Attente maximale d'un verrou par une clôture, avant qu'elle ne cède le passage. Nettement
 * inférieure au délai de détection des interblocages de PostgreSQL (`deadlock_timeout`, une
 * seconde par défaut) : la clôture cède avant que la base n'interrompe quelqu'un.
 */
export const CLOSURE_LOCK_WAIT_MS = 300;

/** Pauses avant chaque nouvel essai d'une clôture qui a cédé le passage. */
export const CLOSURE_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300];

interface CommittedClosure {
  readonly closure: ClosureRecord;
  readonly afterClosure: AfterClosure[];
}

interface ClosureOrder {
  readonly userId: string;
  readonly origin: AccountClosureOrigin;
  readonly closedBy: string;
  readonly client: ClientContext;
  /** Clôture par le personnel : motif et justification, pour le journal d'audit. */
  readonly staff?: { readonly ground: AccountClosureGround; readonly reason: string };
}

/**
 * Clôture d'un compte — par son titulaire, ou par un membre du personnel habilité.
 *
 * Elle est **immédiate et définitive**. Dans une seule transaction :
 *  - la trace de la clôture est écrite ; elle garde l'adresse et le numéro du compte jusqu'à
 *    l'échéance d'effacement ;
 *  - le compte perd son adresse, son numéro, son mot de passe, son second facteur, ses
 *    sessions, ses codes et son profil : il n'en reste qu'une ligne sans identifiant ;
 *  - chaque module qui détient des données du compte y met fin, efface ce que la loi n'impose
 *    pas de conserver, et dit jusqu'à quand il conserve le reste (`AccountDataRegistry`).
 *
 * Un compte qui détient un rôle du back-office ne se clôt pas : ses rôles lui sont d'abord
 * retirés, sous double validation. Les règles essentielles sont aussi imposées par la base
 * (voir la migration `account_closure`).
 *
 * Une clôture qui croise une autre écriture du même compte lui cède le passage, puis
 * recommence (voir `commit`).
 */
@Injectable()
export class AccountClosureService {
  constructor(
    private readonly closures: AccountClosureRepository,
    private readonly holders: AccountDataRegistry,
    private readonly users: UserRepository,
    private readonly proof: HolderProofService,
    private readonly pendingLogins: PendingLoginStore,
    private readonly throttle: SecondFactorThrottle,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountClosureService.name);
  }

  /** Clôture demandée par le titulaire, depuis son compte. */
  async closeOwn(
    auth: AuthenticatedUser,
    request: CloseAccountRequest,
    client: ClientContext,
  ): Promise<AccountClosure> {
    const user = await this.proof.confirm(auth, request, client, 'user.closure_failed');
    const closure = await this.close({
      userId: user.id,
      origin: 'HOLDER',
      closedBy: user.id,
      client,
    });
    return toClosureView(closure);
  }

  /**
   * Clôture prononcée par un membre du personnel : à la demande du titulaire, reçue par un
   * autre canal, ou par décision de la plateforme. Le titulaire en est toujours informé, sans
   * que la justification lui soit donnée.
   */
  async closeByStaff(
    userId: string,
    request: CloseUserRequest,
    actor: StaffActor,
  ): Promise<AdminAccountClosure> {
    const target = await this.users.findById(this.prisma, userId);
    if (target === null) {
      throw notFound();
    }
    if (target.id === actor.userId) {
      await this.recordDenial(actor, userId, 'OWN_ACCOUNT');
      throw new AppError(
        'FORBIDDEN',
        'You cannot perform this action on your own account from the back office.',
      );
    }
    const closure = await this.close({
      userId,
      origin: 'STAFF',
      closedBy: actor.userId,
      client: actor.client,
      staff: { ground: request.ground, reason: request.reason },
    });
    return toAdminClosureView(closure);
  }

  private async close(order: ClosureOrder): Promise<ClosureRecord> {
    const { userId } = order;
    const { closure, afterClosure } = await this.commit(order);

    // La clôture est acquise et ne se rejoue pas : ce qui suit est du nettoyage. Un échec y est
    // signalé, sans faire échouer une demande dont l'effet est déjà définitif.
    const cleanup: AfterClosure[] = [
      // Une connexion restée à mi-chemin (seconde étape en attente) est annulée — la seconde
      // étape refuse de toute façon un compte clôturé.
      () => this.pendingLogins.invalidateAllForUser(userId),
      () => this.throttle.clear(userId),
      ...afterClosure,
    ];
    for (const work of cleanup) {
      try {
        await work();
      } catch (error) {
        this.logger.warn({ err: error, userId }, 'Cleanup after account closure failed');
      }
    }
    return closure;
  }

  /**
   * Valide la clôture, en cédant le passage aux autres écritures du même compte.
   *
   * La clôture verrouille le compte, puis efface ce qu'il porte. Une autre écriture du même
   * compte peut prendre ces verrous dans l'ordre inverse — annuler un code puis en ouvrir un
   * autre, par exemple. Plutôt que de s'attendre l'une l'autre jusqu'à ce que PostgreSQL
   * interrompe l'une des deux, au hasard, la clôture n'attend aucun verrou plus de
   * `CLOSURE_LOCK_WAIT_MS` : sa transaction est annulée — rien n'est écrit —, l'autre écriture
   * s'achève, et la clôture recommence. Si le compte reste occupé, elle renonce : `409`.
   */
  private async commit(order: ClosureOrder): Promise<CommittedClosure> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attempt(order);
      } catch (error) {
        if (!isLockContention(error)) {
          throw error;
        }
        const delay = CLOSURE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.logger.warn(
            { err: error, userId: order.userId, attempts: attempt + 1 },
            'Account closure abandoned: the account is busy',
          );
          throw new AppError(
            'CONFLICT',
            'The account is being modified by another request. Please try again.',
            { cause: error },
          );
        }
        await pause(delay);
      }
    }
  }

  /** Un essai de clôture : une transaction, validée entière ou annulée entière. */
  private attempt(order: ClosureOrder): Promise<CommittedClosure> {
    const { userId, origin } = order;
    const closedAt = this.clock.now();
    const holders = this.holders.holders();

    return this.unitOfWork
      .run(async (tx) => {
        await this.closures.boundLockWaits(tx, CLOSURE_LOCK_WAIT_MS);
        // Les modules verrouillent d'abord ce qu'ils détiennent, le compte ensuite : c'est
        // l'ordre de leurs propres écritures.
        for (const holder of holders) {
          await holder.lockForClosure(tx, userId);
        }
        const account = await this.closures.lockAccount(tx, userId);
        if (account === null) {
          throw notFound();
        }
        if (account.status !== 'ACTIVE' && account.status !== 'SUSPENDED') {
          throw new AppError(
            'CONFLICT',
            account.status === 'CLOSED'
              ? 'The account is already closed.'
              : 'Only an active or suspended account can be closed.',
          );
        }

        const blockers: AccountClosureBlocker[] = account.holdsRole ? ['ROLE_HELD'] : [];
        for (const holder of holders) {
          blockers.push(...(await holder.closureBlockers(tx, userId, origin)));
        }
        if (blockers.length > 0) {
          throw blocked(blockers);
        }

        const terms: (Date | null)[] = [];
        for (const holder of holders) {
          terms.push(await holder.legalRetentionUntil(tx, userId, closedAt));
        }
        const legalRetentionUntil = latestRetention(terms);
        const record: ClosureRecord = {
          userId,
          closedAt,
          origin,
          closedBy: order.closedBy,
          email: account.email,
          phone: account.phone,
          legalRetentionUntil,
          erasureDueAt: erasureDueAt(closedAt, legalRetentionUntil),
          erasedAt: null,
        };
        const closedSessions = await this.closures.close(tx, { ...record, email: account.email });

        const after: AfterClosure[] = [];
        for (const holder of holders) {
          const work = await holder.closeAccount(tx, userId, closedAt);
          if (work !== null) {
            after.push(work);
          }
        }

        await this.audit.record(tx, {
          actor: { type: 'USER', id: order.closedBy },
          action: 'user.closed',
          resource: { type: 'user', id: userId },
          outcome: 'SUCCESS',
          ...order.client,
          metadata: {
            origin,
            ...(order.staff === undefined
              ? {}
              : { ground: order.staff.ground, reason: order.staff.reason }),
            closedSessions,
            legalRetentionUntil: legalRetentionUntil?.toISOString() ?? null,
            erasureDueAt: record.erasureDueAt.toISOString(),
          },
        });
        // Le message part à l'adresse que garde la trace de la clôture : le compte n'en a plus.
        await this.outbox.append(tx, {
          aggregateType: 'user',
          aggregateId: userId,
          eventType: SECURITY_NOTICE_REQUESTED_EVENT,
          payload: {
            userId,
            notice: 'ACCOUNT_CLOSED',
            details: {
              byStaff: origin === 'STAFF',
              ...(legalRetentionUntil === null
                ? {}
                : { retainedUntil: legalRetentionUntil.toISOString() }),
              erasureDueAt: record.erasureDueAt.toISOString(),
            },
          },
          metadata: { requestId: order.client.requestId },
        });
        return { closure: record, afterClosure: after };
      })
      .catch((error: unknown) => {
        if (error instanceof ClosureRuleViolationError) {
          // Les contrôles ci-dessus auraient dû l'écarter : la base a eu le dernier mot.
          this.logger.error({ err: error, userId }, 'Account closure refused by the database');
          throw new AppError('CONFLICT', 'The account cannot be closed in its current state.', {
            cause: error,
          });
        }
        throw error;
      });
  }

  private async recordDenial(actor: StaffActor, userId: string, reason: string): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'user.closure_denied',
      resource: { type: 'user', id: userId },
      outcome: 'DENIED',
      ...actor.client,
      metadata: { reason },
    });
  }
}
