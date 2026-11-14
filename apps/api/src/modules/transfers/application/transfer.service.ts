import {
  type CreateTransferRequest,
  DATA_EXPORT_TRANSFERS_MAX_ENTRIES,
  type ExportedTransfers,
  INTERNAL_TRANSFER_ENTRY_KIND,
  type Transfer,
  type TransferList,
  type TransferListQuery,
  type UserStatus,
} from '@mgx/contracts';
import type { Money } from '@mgx/shared';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  UnitOfWork,
} from '../../../infrastructure/database/unit-of-work.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { ClientContext } from '../../identity/application/client-context.js';
import { HolderProofService } from '../../identity/application/holder-proof.service.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import type { UserRecord } from '../../identity/domain/user.js';
import { LedgerReader } from '../../ledger/application/ledger-reader.js';
import {
  ACCOUNT_CURSOR_PATTERN,
  amountText,
  decodeCursor,
  encodeCursor,
} from '../../ledger/application/ledger-views.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import { LedgerService } from '../../ledger/application/ledger.service.js';
import { userAccount } from '../../ledger/domain/ledger-account.js';
import { HolderClosedError, InsufficientFundsError } from '../../ledger/domain/ledger-errors.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { TRANSFER_NOTICE_REQUESTED_EVENT, TRANSFER_PARTIES } from '../domain/transfer-events.js';
import {
  type CeilingBreach,
  decideTransfer,
  isLevelOpen,
  ledgerKeyOf,
  requestDigest,
} from '../domain/transfer-policy.js';
import { invalidField, parseRequestAmount } from './transfer-amounts.js';
import {
  RECIPIENT_REFUSALS_PER_ACCOUNT,
  TRANSFER_ATTEMPTS_PER_ACCOUNT,
} from './transfer-quotas.js';
import { toTransferView } from './transfer-views.js';
import {
  type TransferRecord,
  TransferRefusedByDatabaseError,
  TransferRepository,
} from './transfer.repository.js';

/** Ce qui fait refuser un transfert — des cas attendus, que l'émetteur doit comprendre. */
type RefusalReason =
  | 'SENDER_NOT_ACTIVE'
  | 'LEVEL_NOT_OPEN'
  | 'LIMIT_EXCEEDED'
  | 'INSUFFICIENT_FUNDS'
  | 'RECIPIENT_UNAVAILABLE';

const BREACH_MESSAGES: Record<CeilingBreach, string> = {
  PER_TRANSFER: 'The amount exceeds the limit per transfer of your verification level.',
  DAILY: 'The amount exceeds what your verification level may still send over 24 hours.',
  MONTHLY: 'The amount exceeds what your verification level may still send over 31 days.',
};

/** Transfert refusé : rien n'a été écrit. Levé dans la transaction, traduit à sa sortie. */
class TransferRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly details: {
      /** Statut trouvé au compte de l'émetteur, une fois verrouillé ; `null` s'il n'existe plus. */
      readonly senderStatus?: UserStatus | null;
      readonly breach?: CeilingBreach;
      /** Compte désigné par l'adresse du destinataire, s'il existe. */
      readonly recipientId?: string | null;
    } = {},
  ) {
    super(`Transfer refused: ${reason}.`);
    this.name = 'TransferRefusal';
  }

  toAppError(): AppError {
    switch (this.reason) {
      case 'SENDER_NOT_ACTIVE':
        // Le compte a changé pendant la requête. Clôturé : la réponse de toute écriture qui
        // croise une clôture. Suspendu : celle que reçoit sa connexion.
        return this.details.senderStatus === 'SUSPENDED'
          ? new AppError('ACCOUNT_DISABLED', 'This account is disabled. Please contact support.')
          : new AppError('CONFLICT', 'This account is closed.');
      case 'LEVEL_NOT_OPEN':
        return new AppError(
          'TRANSFER_NOT_PERMITTED',
          'Transfers in this asset are not open to your verification level.',
        );
      case 'LIMIT_EXCEEDED':
        return new AppError(
          'TRANSFER_LIMIT_EXCEEDED',
          BREACH_MESSAGES[this.details.breach ?? 'PER_TRANSFER'],
        );
      case 'INSUFFICIENT_FUNDS':
        return new AppError('INSUFFICIENT_FUNDS', 'Your wallet does not hold this amount.');
      case 'RECIPIENT_UNAVAILABLE':
        // Un seul message, quelle qu'en soit la cause : la route ne dit pas quelles adresses
        // ont un compte.
        return new AppError('RECIPIENT_UNAVAILABLE', 'This recipient cannot receive transfers.');
    }
  }
}

function tooManyAttempts(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 'Too many transfers attempted. Please try again later.', {
    retryAfterSeconds,
  });
}

/** Ce qu'un transfert demandé devient : un transfert écrit, ou celui qui l'était déjà. */
export interface TransferOutcome {
  readonly transfer: Transfer;
  /**
   * Vrai si le transfert existait déjà sous cette clé d'idempotence : rien n'a été écrit, et ce
   * qui est rendu est le transfert d'origine.
   */
  readonly replayed: boolean;
}

/**
 * Transfert de fonds entre deux titulaires — la première opération qui passe une écriture au
 * grand livre.
 *
 * Il est **immédiat et définitif** : une seule transaction écrit le transfert, l'écriture qui le
 * réalise, son inscription au journal d'audit et les événements qui préviendront les deux
 * parties.
 *
 * **Preuve du titulaire.** Une session ouverte ne suffit pas : le mot de passe est présenté à
 * nouveau et, s'il y a lieu, le second facteur — avant toute autre vérification.
 *
 * **Idempotence.** Le client fournit une clé. Renvoyer la même requête sous la même clé ne
 * transfère rien de plus : le transfert d'origine est rendu. Une autre requête sous une clé
 * déjà utilisée est refusée. Une requête *refusée* ne retient pas sa clé.
 *
 * **Plafonds.** Ceux du niveau de vérification de l'émetteur, dans l'actif : par transfert, sur
 * 24 heures, sur 31 jours. Sans plafond fixé, rien ne part. Les cumuls sont comptés sous le
 * verrou de l'émetteur — ses transferts passent un à un — et la base de données refait le
 * calcul avant d'écrire (voir la migration `internal_transfers`).
 *
 * **Destinataire.** Désigné par son adresse e-mail. Qu'elle soit inconnue, que le compte soit
 * fermé ou suspendu, ou que son niveau de vérification ne soit pas ouvert dans l'actif, le
 * refus est le même — et il vient **en dernier**, après les plafonds et le solde : apprendre
 * qu'une adresse a un compte coûte un transfert réel. Ces refus sont comptés par émetteur.
 *
 * **Ordre des verrous** : le compte de l'émetteur, puis — par le grand livre — les titulaires
 * de l'écriture, puis ses comptes. Deux transferts croisés ne s'interbloquent pas.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly transfers: TransferRepository,
    private readonly ledger: LedgerService,
    private readonly reader: LedgerReader,
    private readonly users: UserRepository,
    private readonly proof: HolderProofService,
    private readonly limiter: RedisRateLimiter,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TransferService.name);
  }

  async create(
    auth: AuthenticatedUser,
    request: CreateTransferRequest,
    idempotencyKey: string,
    client: ClientContext,
  ): Promise<TransferOutcome> {
    const sender = await this.proof.confirm(auth, request, client, 'transfer.proof_failed');

    const asset = await this.reader.asset(this.prisma, request.assetCode);
    if (asset === null) {
      throw invalidField('assetCode', 'The platform does not keep this asset.');
    }
    const amount = parseRequestAmount(request.amount, asset, 'amount');
    if (!amount.isPositive()) {
      throw invalidField('amount', 'Must be greater than zero.');
    }
    if (request.recipientEmail === sender.email) {
      throw new AppError('UNPROCESSABLE_ENTITY', 'You cannot transfer funds to your own account.');
    }
    const digest = requestDigest({
      recipientEmail: request.recipientEmail,
      assetCode: asset.code,
      units: amount.units,
    });

    // Déjà fait ? Rien n'est alors compté ni verrouillé.
    const known = await this.transfers.findByKey(this.prisma, sender.id, idempotencyKey);
    if (known !== null) {
      return this.replay(known, digest, sender.id);
    }

    const refusalsKey = `transfer-recipient-refusals:${sender.id}`;
    const blockedFor = await this.limiter.blockedForSeconds(refusalsKey);
    if (blockedFor > 0) {
      throw tooManyAttempts(blockedFor);
    }
    const attempts = await this.limiter.consume(
      `transfer-attempts:${sender.id}`,
      TRANSFER_ATTEMPTS_PER_ACCOUNT,
    );
    if (attempts.blocked) {
      throw tooManyAttempts(attempts.retryAfterSeconds);
    }

    let outcome: { readonly record: TransferRecord; readonly replayed: boolean };
    try {
      outcome = await this.unitOfWork.run(
        (tx) =>
          this.attempt(tx, sender, request.recipientEmail, amount, idempotencyKey, digest, client),
        { retry: DEFAULT_CONFLICT_RETRY },
      );
    } catch (error) {
      if (error instanceof TransferRefusal) {
        await this.recordRefusal(error, sender, asset, amount, client);
        if (error.reason === 'RECIPIENT_UNAVAILABLE') {
          await this.limiter.consume(refusalsKey, RECIPIENT_REFUSALS_PER_ACCOUNT);
        }
        throw error.toAppError();
      }
      if (error instanceof TransferRefusedByDatabaseError) {
        // Les contrôles de l'application l'avaient admis : un niveau de vérification, un statut
        // ou des plafonds ont changé pendant la requête. Rien n'est écrit ; renvoyée, la requête
        // sera examinée dans l'état nouveau.
        this.logger.warn(
          { err: error, senderId: sender.id },
          'Transfer refused by the database after the application admitted it',
        );
        throw new AppError(
          'CONFLICT',
          'The transfer could not be completed because the account changed meanwhile. Please try again.',
          { cause: error },
        );
      }
      throw error;
    }

    if (outcome.replayed) {
      return this.replay(outcome.record, digest, sender.id);
    }
    return {
      transfer: toTransferView(
        outcome.record,
        sender.id,
        asset,
        new Map([[outcome.record.recipientId, request.recipientEmail]]),
      ),
      replayed: false,
    };
  }

  /** Transferts envoyés et reçus par un compte, du plus récent au plus ancien. */
  async list(userId: string, query: TransferListQuery): Promise<TransferList> {
    const beforeId =
      query.after === undefined ? undefined : decodeCursor(query.after, ACCOUNT_CURSOR_PATTERN);
    const found = await this.transfers.listForParty(this.prisma, userId, {
      beforeId,
      limit: query.limit + 1,
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    return {
      transfers: await this.present(this.prisma, page, userId),
      nextCursor: found.length > query.limit && last !== undefined ? encodeCursor(last.id) : null,
    };
  }

  /** Un transfert, pour l'une de ses deux parties. Pour tout autre compte, il n'existe pas. */
  async find(userId: string, transferId: string): Promise<Transfer> {
    const record = await this.transfers.findForParty(this.prisma, transferId, userId);
    if (record === null) {
      throw new AppError('NOT_FOUND', 'Transfer not found.');
    }
    const [view] = await this.present(this.prisma, [record], userId);
    if (view === undefined) {
      throw new Error(`Transfer ${record.id} cannot be presented.`);
    }
    return view;
  }

  /**
   * Transferts d'un compte pour la copie de ses données — les plus récents, s'il en compte
   * plus que la copie n'en contient.
   */
  async exportOf(db: DbClient, userId: string): Promise<ExportedTransfers> {
    const found = await this.transfers.listForParty(db, userId, {
      limit: DATA_EXPORT_TRANSFERS_MAX_ENTRIES + 1,
    });
    return {
      items: await this.present(db, found.slice(0, DATA_EXPORT_TRANSFERS_MAX_ENTRIES), userId),
      truncated: found.length > DATA_EXPORT_TRANSFERS_MAX_ENTRIES,
    };
  }

  /**
   * Un essai de transfert : une transaction, validée entière ou annulée entière. Elle peut être
   * relancée si PostgreSQL l'annule parce qu'elle en croisait une autre : elle ne fait donc
   * rien d'autre qu'écrire avec `tx`.
   *
   * @throws TransferRefusal
   */
  private async attempt(
    tx: DbClient,
    sender: UserRecord,
    recipientEmail: string,
    amount: Money,
    idempotencyKey: string,
    digest: Buffer,
    client: ClientContext,
  ): Promise<{ readonly record: TransferRecord; readonly replayed: boolean }> {
    const { code: assetCode } = amount.asset;

    // Les transferts d'un émetteur passent un à un : ce qui suit voit tout ce qu'il a envoyé.
    const status = await this.transfers.lockSender(tx, sender.id);
    if (status !== 'ACTIVE') {
      throw new TransferRefusal('SENDER_NOT_ACTIVE', { senderStatus: status });
    }

    // La même requête a pu aboutir pendant l'attente du verrou.
    const concurrent = await this.transfers.findByKey(tx, sender.id, idempotencyKey);
    if (concurrent !== null) {
      return { record: concurrent, replayed: true };
    }

    const allowance = await this.transfers.allowance(tx, sender.id, assetCode);
    const decision = decideTransfer(amount.units, allowance.ceilings, allowance.usage);
    if (!decision.allowed) {
      throw new TransferRefusal(
        decision.reason,
        decision.reason === 'LIMIT_EXCEEDED' ? { breach: decision.breach } : {},
      );
    }

    // Le grand livre refusera lui-même, sous le verrou du compte, des fonds insuffisants. Le
    // dire ici, d'abord, fait passer ce refus avant celui du destinataire.
    if ((await this.reader.availableBalance(tx, sender.id, assetCode)) < amount.units) {
      throw new TransferRefusal('INSUFFICIENT_FUNDS');
    }

    // Le destinataire en dernier : tout ce qui précède ne dépend que de l'émetteur.
    const recipient = await this.users.findByEmail(tx, recipientEmail);
    if (recipient?.status !== 'ACTIVE') {
      throw new TransferRefusal('RECIPIENT_UNAVAILABLE', { recipientId: recipient?.id ?? null });
    }
    const receiving = await this.transfers.allowance(tx, recipient.id, assetCode);
    if (!isLevelOpen(receiving.ceilings)) {
      throw new TransferRefusal('RECIPIENT_UNAVAILABLE', { recipientId: recipient.id });
    }

    const id = await this.transfers.newId(tx);
    let entryId: string;
    try {
      const entry = await this.ledger.postWithin(tx, {
        idempotencyKey: ledgerKeyOf(id),
        kind: INTERNAL_TRANSFER_ENTRY_KIND,
        actor: { type: 'USER', id: sender.id },
        requestId: client.requestId,
        metadata: { transferId: id },
        postings: [
          { account: userAccount(sender.id), side: 'DEBIT', amount },
          { account: userAccount(recipient.id), side: 'CREDIT', amount },
        ],
      });
      entryId = entry.id;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new TransferRefusal('INSUFFICIENT_FUNDS');
      }
      // L'émetteur est verrouillé et actif : c'est le destinataire qui vient d'être clôturé.
      if (error instanceof HolderClosedError) {
        throw new TransferRefusal('RECIPIENT_UNAVAILABLE', { recipientId: recipient.id });
      }
      throw error;
    }

    const record = await this.transfers.insert(tx, {
      id,
      senderId: sender.id,
      recipientId: recipient.id,
      assetCode,
      units: amount.units,
      entryId,
      idempotencyKey,
      requestDigest: digest,
      senderLevel: allowance.level,
    });

    await this.audit.record(tx, {
      actor: { type: 'USER', id: sender.id },
      action: 'transfer.created',
      resource: { type: 'transfer', id },
      outcome: 'SUCCESS',
      ...client,
      metadata: {
        assetCode,
        amount: amount.toDecimalString(),
        recipientId: recipient.id,
        senderLevel: allowance.level,
        entryId,
      },
    });
    // Les deux parties sont prévenues : l'émetteur, pour qu'un transfert qu'il n'a pas fait ne
    // lui échappe pas ; le destinataire, pour qu'il sache d'où viennent les fonds.
    for (const party of TRANSFER_PARTIES) {
      await this.outbox.append(tx, {
        aggregateType: 'transfer',
        aggregateId: id,
        eventType: TRANSFER_NOTICE_REQUESTED_EVENT,
        payload: { transferId: id, party },
        metadata: { requestId: client.requestId },
      });
    }
    return { record, replayed: false };
  }

  /**
   * Le transfert existe déjà sous cette clé : rend celui d'origine, sans rien écrire.
   *
   * @throws AppError `IDEMPOTENCY_KEY_REUSED` si la requête n'est pas celle qui l'a créé.
   */
  private async replay(
    recorded: TransferRecord,
    digest: Buffer,
    senderId: string,
  ): Promise<TransferOutcome> {
    if (!recorded.requestDigest.equals(digest)) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different transfer.',
      );
    }
    const [transfer] = await this.present(this.prisma, [recorded], senderId);
    if (transfer === undefined) {
      throw new Error(`Transfer ${recorded.id} cannot be presented.`);
    }
    return { transfer, replayed: true };
  }

  /** Inscrit un refus au journal d'audit — hors de la transaction, qui a été annulée. */
  private async recordRefusal(
    refusal: TransferRefusal,
    sender: UserRecord,
    asset: AssetRecord,
    amount: Money,
    client: ClientContext,
  ): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: sender.id },
      action: 'transfer.refused',
      resource: { type: 'transfer' },
      outcome: 'DENIED',
      ...client,
      metadata: {
        reason: refusal.reason,
        assetCode: asset.code,
        amount: amountText(amount.units, asset),
        ...(refusal.details.senderStatus === undefined
          ? {}
          : { accountStatus: refusal.details.senderStatus }),
        ...(refusal.details.breach === undefined ? {} : { limit: refusal.details.breach }),
        // L'adresse saisie n'est pas conservée : elle peut être celle de n'importe qui.
        ...(refusal.details.recipientId === undefined
          ? {}
          : { recipientId: refusal.details.recipientId }),
      },
    });
  }

  private async present(
    db: DbClient,
    records: readonly TransferRecord[],
    viewerId: string,
  ): Promise<Transfer[]> {
    if (records.length === 0) {
      return [];
    }
    const assets = new Map((await this.reader.assets(db)).map((asset) => [asset.code, asset]));
    const emails = await this.users.findEmails(
      db,
      records.map(({ recipientId, senderId }) => (senderId === viewerId ? recipientId : senderId)),
    );
    return records.map((record) => {
      const asset = assets.get(record.assetCode);
      if (asset === undefined) {
        throw new Error(`Asset ${record.assetCode} of transfer ${record.id} is not registered.`);
      }
      return toTransferView(record, viewerId, asset, emails);
    });
  }
}
