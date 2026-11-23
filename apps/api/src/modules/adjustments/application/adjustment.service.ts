import type {
  ApproveLedgerAdjustmentRequest,
  CreateLedgerAdjustmentRequest,
  LedgerAdjustment,
  LedgerAdjustmentList,
  LedgerAdjustmentListQuery,
  RejectLedgerAdjustmentRequest,
} from '@mgx/contracts';
import { Money } from '@mgx/shared';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  UnitOfWork,
} from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import type { ClientContext } from '../../identity/application/client-context.js';
import { HolderProofService } from '../../identity/application/holder-proof.service.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import { LedgerReader } from '../../ledger/application/ledger-reader.js';
import {
  ACCOUNT_CURSOR_PATTERN,
  amountText,
  decodeCursor,
  encodeCursor,
} from '../../ledger/application/ledger-views.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import { LedgerService } from '../../ledger/application/ledger.service.js';
import { invalidField, parseRequestAmount } from '../../ledger/application/request-amounts.js';
import { platformAccount, userAccount } from '../../ledger/domain/ledger-account.js';
import { HolderClosedError, InsufficientFundsError } from '../../ledger/domain/ledger-errors.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { ADJUSTMENT_NOTICE_REQUESTED_EVENT } from '../domain/adjustment-events.js';
import { entryKindOf, ledgerKeyOf, postingSidesOf } from '../domain/adjustment.js';
import { toAdjustmentView } from './adjustment-views.js';
import {
  type AdjustmentRecord,
  AdjustmentRefusedByDatabaseError,
  AdjustmentRepository,
  PendingAdjustmentExistsError,
} from './adjustment.repository.js';

/** Ce qui fait refuser une approbation alors que la demande était recevable. */
type ApprovalRefusalReason = 'INSUFFICIENT_FUNDS' | 'ACCOUNT_CLOSED';

/** Approbation refusée : rien n'a été écrit. Levée dans la transaction, traduite à sa sortie. */
class ApprovalRefusal extends Error {
  constructor(readonly reason: ApprovalRefusalReason) {
    super(`Approval refused: ${reason}.`);
    this.name = 'ApprovalRefusal';
  }

  toAppError(): AppError {
    return this.reason === 'INSUFFICIENT_FUNDS'
      ? new AppError('INSUFFICIENT_FUNDS', 'The wallet does not hold this amount.')
      : new AppError('CONFLICT', 'This account is closed: nothing can be posted to its wallets.');
  }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Ledger adjustment not found.');
}

function alreadyClosed(record: AdjustmentRecord): AppError {
  return new AppError(
    'CONFLICT',
    `This adjustment is no longer pending (${record.status.toLowerCase()}).`,
  );
}

/** Une autre décision, simultanée, est passée la première. */
function decidedMeanwhile(): AppError {
  return new AppError('CONFLICT', 'This adjustment has just been decided by someone else.');
}

/** L'auteur n'a plus qualité au moment d'écrire : la base de données a refusé. */
function noLongerEntitled(error: unknown): AppError {
  return new AppError('FORBIDDEN', 'You do not have permission to perform this action.', {
    cause: error,
  });
}

/**
 * Ajustements manuels des portefeuilles, sous **double validation** : un membre du personnel
 * demande le crédit ou le débit du portefeuille d'un titulaire, un second l'approuve, et
 * l'écriture est passée au grand livre dans la transaction de l'approbation. La contrepartie
 * est le compte de conservation de la plateforme : ce qu'elle conserve pour ses titulaires
 * varie comme ce qu'elle leur doit.
 *
 * C'est le moyen de constater des fonds reçus ou rendus hors de l'API, de corriger une erreur
 * par une écriture inverse, et de faire sortir les fonds d'un compte suspendu, d'un
 * portefeuille gelé ou d'un compte à clôturer. Le titulaire en est prévenu, sans la
 * justification.
 *
 * **Quatre yeux.** Nul ne prend part à un ajustement de son propre portefeuille ; la décision
 * vient d'une autre personne que l'auteur de la demande. Les contrôles faits ici donnent des
 * réponses claires ; les mêmes règles sont imposées par la base (contraintes et déclencheurs de
 * `ledger_adjustments`), qui a le dernier mot — y compris sur l'écriture : à la validation de
 * la transaction, elle vérifie que c'est bien celle de l'ajustement.
 *
 * **Preuve de l'approbateur.** Une session ouverte ne suffit pas à déplacer des fonds :
 * l'approbateur présente à nouveau son mot de passe et son second facteur.
 *
 * **Ordre des verrous** : la demande, puis — par le grand livre — le titulaire, puis les
 * comptes. Deux décisions simultanées sur une même demande passent l'une après l'autre.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly adjustments: AdjustmentRepository,
    private readonly ledger: LedgerService,
    private readonly reader: LedgerReader,
    private readonly users: UserRepository,
    private readonly proof: HolderProofService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdjustmentService.name);
  }

  /** Ajustements, du plus récent au plus ancien. Chaque consultation est journalisée. */
  async list(query: LedgerAdjustmentListQuery, actor: StaffActor): Promise<LedgerAdjustmentList> {
    await this.closeOverdue();
    const beforeId =
      query.after === undefined ? undefined : decodeCursor(query.after, ACCOUNT_CURSOR_PATTERN);
    const found = await this.adjustments.list(this.prisma, {
      status: query.status,
      userId: query.userId,
      beforeId,
      limit: query.limit + 1,
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_adjustment.listed_by_admin',
      resource: { type: 'ledger_adjustment' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        limit: query.limit,
        results: page.length,
      },
    });

    return {
      adjustments: await this.present(page),
      nextCursor: found.length > query.limit && last !== undefined ? encodeCursor(last.id) : null,
    };
  }

  async get(id: string, actor: StaffActor): Promise<LedgerAdjustment> {
    await this.closeOverdue();
    const record = await this.find(id);
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_adjustment.viewed_by_admin',
      resource: { type: 'ledger_adjustment', id },
      outcome: 'SUCCESS',
      ...actor.client,
    });
    return this.view(record);
  }

  /** Demande un crédit ou un débit. Rien ne bouge tant qu'elle n'est pas approuvée. */
  async request(body: CreateLedgerAdjustmentRequest, actor: StaffActor): Promise<LedgerAdjustment> {
    if (body.userId === actor.userId) {
      await this.recordDenial(actor, 'ledger_adjustment.request_denied', null, 'OWN_WALLET');
      throw new AppError('FORBIDDEN', 'You cannot request an adjustment of your own wallet.');
    }
    const asset = await this.reader.asset(this.prisma, body.assetCode);
    if (asset === null) {
      throw invalidField('assetCode', 'The platform does not keep this asset.');
    }
    const amount = parseRequestAmount(body.amount, asset, 'amount');
    if (!amount.isPositive()) {
      throw invalidField('amount', 'Must be greater than zero.');
    }
    const holder = await this.users.findById(this.prisma, body.userId);
    if (holder === null) {
      throw new AppError('UNPROCESSABLE_ENTITY', 'Unknown account.');
    }
    if (holder.status !== 'ACTIVE' && holder.status !== 'SUSPENDED') {
      throw new AppError(
        'CONFLICT',
        holder.status === 'CLOSED'
          ? 'This account is closed: it has no wallet.'
          : 'This registration was never verified: it has no wallet.',
      );
    }
    // L'approbation refera ce contrôle, sous le verrou du compte : le dire ici évite de
    // déposer une demande qui ne pourrait pas être approuvée.
    if (
      body.direction === 'DEBIT' &&
      (await this.reader.availableBalance(this.prisma, holder.id, asset.code)) < amount.units
    ) {
      throw new AppError('INSUFFICIENT_FUNDS', 'The wallet does not hold this amount.');
    }

    await this.closeOverdue();
    let record: AdjustmentRecord;
    try {
      record = await this.unitOfWork.run(async (tx) => {
        const created = await this.adjustments.create(tx, {
          userId: holder.id,
          assetCode: asset.code,
          direction: body.direction,
          units: amount.units,
          reason: body.reason,
          requestedBy: actor.userId,
        });
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'ledger_adjustment.requested',
          resource: { type: 'ledger_adjustment', id: created.id },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { ...this.termsOf(created, asset), reason: body.reason },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof PendingAdjustmentExistsError) {
        throw new AppError(
          'CONFLICT',
          'An identical adjustment — same wallet, same direction, same amount — is already ' +
            'awaiting approval.',
        );
      }
      if (error instanceof HolderClosedError) {
        throw new AppError('CONFLICT', 'This account is closed: it has no wallet.', {
          cause: error,
        });
      }
      if (error instanceof AdjustmentRefusedByDatabaseError) {
        this.logger.warn(
          { err: error, actorId: actor.userId },
          'Ledger adjustment request refused by the database',
        );
        throw noLongerEntitled(error);
      }
      throw error;
    }
    return this.view(record, asset);
  }

  /**
   * Approuve une demande : l'écriture est passée au grand livre dans la même transaction, avec
   * la décision, sa trace au journal d'audit et l'avis au titulaire — ou rien.
   */
  async approve(
    id: string,
    body: ApproveLedgerAdjustmentRequest,
    auth: AuthenticatedUser,
    client: ClientContext,
  ): Promise<LedgerAdjustment> {
    // La preuve d'abord : sans elle, rien n'est examiné.
    const approver = await this.proof.confirm(
      auth,
      body,
      client,
      'ledger_adjustment.approval_proof_failed',
    );
    const actor: StaffActor = { userId: approver.id, client };

    const pending = await this.pendingOf(id);
    await this.assertSecondPerson(pending, actor, 'approved');
    const asset = await this.assetOf(pending);
    const amount = Money.ofUnits(pending.units, { code: asset.code, scale: asset.scale });

    let approved: AdjustmentRecord;
    try {
      approved = await this.unitOfWork.run(
        async (tx) => {
          // La demande d'abord : une autre décision, simultanée, attend ici — puis la trouve décidée.
          const locked = await this.adjustments.lock(tx, id);
          if (locked?.status !== 'PENDING') {
            throw decidedMeanwhile();
          }

          const sides = postingSidesOf(locked.direction);
          const wallet = { account: userAccount(locked.userId), side: sides.wallet, amount };
          const custody = {
            account: platformAccount('platform_custody'),
            side: sides.custody,
            amount,
          };
          let entryId: string;
          try {
            const entry = await this.ledger.postWithin(tx, {
              idempotencyKey: ledgerKeyOf(id),
              kind: entryKindOf(locked.direction),
              actor: { type: 'USER', id: actor.userId },
              requestId: client.requestId,
              metadata: { adjustmentId: id, requestedBy: locked.requestedBy },
              // La ligne qui débite passe la première : c'est elle qui peut manquer de fonds.
              postings: sides.wallet === 'DEBIT' ? [wallet, custody] : [custody, wallet],
            });
            if (entry.replayed) {
              throw new Error(`Ledger adjustment ${id} is pending but its entry already exists.`);
            }
            entryId = entry.id;
          } catch (error) {
            if (error instanceof InsufficientFundsError) {
              throw new ApprovalRefusal('INSUFFICIENT_FUNDS');
            }
            if (error instanceof HolderClosedError) {
              throw new ApprovalRefusal('ACCOUNT_CLOSED');
            }
            throw error;
          }

          const done = await this.adjustments.approve(tx, id, {
            decidedBy: actor.userId,
            note: body.note ?? null,
            entryId,
          });
          if (done === null) {
            throw decidedMeanwhile();
          }

          const terms = this.termsOf(done, asset);
          await this.audit.record(tx, {
            actor: { type: 'USER', id: actor.userId },
            action: 'ledger_adjustment.approved',
            resource: { type: 'ledger_adjustment', id },
            outcome: 'SUCCESS',
            ...client,
            metadata: {
              ...terms,
              requestedBy: done.requestedBy,
              entryId,
              ...(body.note === undefined ? {} : { note: body.note }),
            },
          });
          // Seconde entrée, rattachée au compte : son titulaire la lit dans son historique.
          await this.audit.record(tx, {
            actor: { type: 'USER', id: actor.userId },
            action: done.direction === 'CREDIT' ? 'user.wallet_credited' : 'user.wallet_debited',
            resource: { type: 'user', id: done.userId },
            outcome: 'SUCCESS',
            ...client,
            metadata: {
              adjustmentId: id,
              assetCode: terms.assetCode,
              amount: terms.amount,
              entryId,
              requestedBy: done.requestedBy,
            },
          });
          // Le titulaire est prévenu : des fonds ne bougent pas sur son portefeuille à son insu.
          await this.outbox.append(tx, {
            aggregateType: 'ledger_adjustment',
            aggregateId: id,
            eventType: ADJUSTMENT_NOTICE_REQUESTED_EVENT,
            payload: { adjustmentId: id },
            metadata: { requestId: client.requestId },
          });
          return done;
        },
        { retry: DEFAULT_CONFLICT_RETRY },
      );
    } catch (error) {
      if (error instanceof ApprovalRefusal) {
        await this.recordRefusal(actor, id, error.reason);
        throw error.toAppError();
      }
      if (error instanceof AdjustmentRefusedByDatabaseError) {
        // Les contrôles de l'application l'avaient admise : la demande est échue, ou l'un des
        // deux intervenants n'a plus qualité. Rien n'est écrit.
        this.logger.warn(
          { err: error, adjustmentId: id, actorId: actor.userId },
          'Ledger adjustment approval refused by the database',
        );
        await this.recordRefusal(actor, id, 'DATABASE_RULE');
        throw new AppError(
          'CONFLICT',
          'This adjustment can no longer be approved: the request has expired, or its author ' +
            'or you are no longer entitled.',
          { cause: error },
        );
      }
      throw error;
    }
    return this.view(approved, asset);
  }

  /** Refuse une demande. Le refus est motivé, et vient d'une autre personne que son auteur. */
  async reject(
    id: string,
    body: RejectLedgerAdjustmentRequest,
    actor: StaffActor,
  ): Promise<LedgerAdjustment> {
    const pending = await this.pendingOf(id);
    await this.assertSecondPerson(pending, actor, 'rejected');
    return this.close(pending, actor, 'REJECTED', body.note);
  }

  /** Retire une demande ; seul son auteur le peut. */
  async cancel(id: string, actor: StaffActor): Promise<LedgerAdjustment> {
    const pending = await this.pendingOf(id);
    if (pending.requestedBy !== actor.userId) {
      throw new AppError('FORBIDDEN', 'Only the author of a request can cancel it.');
    }
    return this.close(pending, actor, 'CANCELLED', null);
  }

  /**
   * Clôt les demandes échues. Appelé avant toute lecture ou décision — une demande affichée
   * « en attente » peut réellement être approuvée —, et par la maintenance périodique.
   *
   * @returns leur nombre.
   */
  closeOverdue(): Promise<number> {
    return this.adjustments.expireOverdue(this.prisma);
  }

  private async close(
    pending: AdjustmentRecord,
    actor: StaffActor,
    status: 'REJECTED' | 'CANCELLED',
    note: string | null,
  ): Promise<LedgerAdjustment> {
    const asset = await this.assetOf(pending);
    let closed: AdjustmentRecord;
    try {
      closed = await this.unitOfWork.run(async (tx) => {
        const done = await this.adjustments.close(tx, pending.id, {
          status,
          decidedBy: actor.userId,
          note,
        });
        if (done === null) {
          throw decidedMeanwhile();
        }
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action:
            status === 'REJECTED' ? 'ledger_adjustment.rejected' : 'ledger_adjustment.cancelled',
          resource: { type: 'ledger_adjustment', id: pending.id },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { ...this.termsOf(done, asset), ...(note === null ? {} : { note }) },
        });
        return done;
      });
    } catch (error) {
      if (error instanceof AdjustmentRefusedByDatabaseError) {
        this.logger.warn(
          { err: error, adjustmentId: pending.id, actorId: actor.userId },
          'Ledger adjustment decision refused by the database',
        );
        throw noLongerEntitled(error);
      }
      throw error;
    }
    return this.view(closed, asset);
  }

  /** La décision appartient à une autre personne que l'auteur de la demande et que le titulaire. */
  private async assertSecondPerson(
    pending: AdjustmentRecord,
    actor: StaffActor,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    if (pending.requestedBy === actor.userId) {
      await this.recordDenial(
        actor,
        'ledger_adjustment.decision_denied',
        pending.id,
        'OWN_REQUEST',
      );
      throw new AppError(
        'FORBIDDEN',
        `A ledger adjustment must be ${decision} by a second member of staff; you can cancel ` +
          'your own request.',
      );
    }
    if (pending.userId === actor.userId) {
      await this.recordDenial(actor, 'ledger_adjustment.decision_denied', pending.id, 'OWN_WALLET');
      throw new AppError('FORBIDDEN', 'You cannot decide on an adjustment of your own wallet.');
    }
  }

  private async pendingOf(id: string): Promise<AdjustmentRecord> {
    await this.closeOverdue();
    const record = await this.find(id);
    if (record.status !== 'PENDING') {
      throw alreadyClosed(record);
    }
    return record;
  }

  private async find(id: string): Promise<AdjustmentRecord> {
    const record = await this.adjustments.find(this.prisma, id);
    if (record === null) {
      throw notFound();
    }
    return record;
  }

  private async assetOf(record: AdjustmentRecord): Promise<AssetRecord> {
    const asset = await this.reader.asset(this.prisma, record.assetCode);
    if (asset === null) {
      throw new Error(
        `Asset ${record.assetCode} of ledger adjustment ${record.id} is not registered.`,
      );
    }
    return asset;
  }

  /** Les termes d'un ajustement, tels que le journal d'audit les garde. */
  private termsOf(
    record: AdjustmentRecord,
    asset: AssetRecord,
  ): {
    readonly userId: string;
    readonly assetCode: string;
    readonly direction: string;
    readonly amount: string;
  } {
    return {
      userId: record.userId,
      assetCode: record.assetCode,
      direction: record.direction,
      amount: amountText(record.units, asset),
    };
  }

  private async view(record: AdjustmentRecord, asset?: AssetRecord): Promise<LedgerAdjustment> {
    const [view] = await this.present([record], asset);
    if (view === undefined) {
      throw new Error(`Ledger adjustment ${record.id} cannot be presented.`);
    }
    return view;
  }

  private async present(
    records: readonly AdjustmentRecord[],
    known?: AssetRecord,
  ): Promise<LedgerAdjustment[]> {
    if (records.length === 0) {
      return [];
    }
    const assets = new Map(
      (known === undefined ? await this.reader.assets(this.prisma) : [known]).map((asset) => [
        asset.code,
        asset,
      ]),
    );
    const emails = await this.users.findEmails(this.prisma, [
      ...new Set(
        records.flatMap(({ decidedBy, requestedBy, userId }) =>
          decidedBy === null ? [userId, requestedBy] : [userId, requestedBy, decidedBy],
        ),
      ),
    ]);
    return records.map((record) => {
      const asset = assets.get(record.assetCode);
      if (asset === undefined) {
        throw new Error(
          `Asset ${record.assetCode} of ledger adjustment ${record.id} is not registered.`,
        );
      }
      return toAdjustmentView(record, asset, emails);
    });
  }

  /** Inscrit au journal d'audit une demande ou une décision refusée à son auteur. */
  private async recordDenial(
    actor: StaffActor,
    action: string,
    adjustmentId: string | null,
    reason: 'OWN_WALLET' | 'OWN_REQUEST',
  ): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action,
      resource:
        adjustmentId === null
          ? { type: 'ledger_adjustment' }
          : { type: 'ledger_adjustment', id: adjustmentId },
      outcome: 'DENIED',
      ...actor.client,
      metadata: { reason },
    });
  }

  /** Inscrit au journal d'audit une approbation qui n'a pas abouti — hors de la transaction, annulée. */
  private async recordRefusal(
    actor: StaffActor,
    adjustmentId: string,
    reason: ApprovalRefusalReason | 'DATABASE_RULE',
  ): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_adjustment.approval_refused',
      resource: { type: 'ledger_adjustment', id: adjustmentId },
      outcome: 'DENIED',
      ...actor.client,
      metadata: { reason },
    });
  }
}
