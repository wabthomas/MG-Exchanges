import {
  type AdminAsset,
  type AdminAssetList,
  type AdminLedgerAccount,
  type AdminLedgerAccountList,
  type AdminLedgerAccountListQuery,
  type AdminLedgerEntry,
  type AdminLedgerPostingList,
  type AdminLedgerPostingListQuery,
  LEDGER_ACCOUNT_TYPE_KEYS,
  LEDGER_ACCOUNT_TYPES,
  type RegisterAssetRequest,
  type TrialBalance,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import {
  ACCOUNT_CURSOR_PATTERN,
  amountText,
  assetViewOf,
  decodeCursor,
  encodeCursor,
  ownerOf,
  SEQUENCE_CURSOR_PATTERN,
} from './ledger-views.js';
import {
  type AccountRecord,
  type AssetRecord,
  AssetRegistrationDeniedError,
  LedgerRepository,
} from './ledger.repository.js';

function adminAssetOf(asset: AssetRecord): AdminAsset {
  return {
    ...assetViewOf(asset),
    registeredAt: asset.registeredAt.toISOString(),
    registeredBy: asset.registeredBy,
  };
}

function adminAccountOf(
  account: AccountRecord,
  asset: AssetRecord,
  state: Pick<AccountRecord, 'balance' | 'postingCount'> = account,
): AdminLedgerAccount {
  return {
    id: account.id,
    type: account.type,
    owner: ownerOf(account),
    userId: account.userId,
    asset: assetViewOf(asset),
    normalSide: account.normalSide,
    balance: amountText(state.balance, asset),
    postingCount: Number(state.postingCount),
    createdAt: account.createdAt.toISOString(),
  };
}

function notFound(what: string): AppError {
  return new AppError('NOT_FOUND', `${what} not found.`);
}

/**
 * Back-office : actifs tenus par le grand livre, et consultation de ses comptes, de ses
 * écritures et de sa balance.
 *
 * Rien ici ne passe d'écriture. **Toute consultation est inscrite au journal d'audit** — les
 * comptes et leurs lignes sont les opérations des titulaires —, comme l'enregistrement d'un
 * actif, dans la transaction qui l'applique.
 */
@Injectable()
export class LedgerAdministrationService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Tous les actifs, dans l'ordre de leurs codes. */
  async listAssets(actor: StaffActor): Promise<AdminAssetList> {
    const assets = await this.ledger.listAssets(this.prisma);
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'asset.listed_by_admin',
      resource: { type: 'asset' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: { results: assets.length },
    });
    return { assets: assets.map(adminAssetOf) };
  }

  /**
   * Enregistre un actif — **définitivement** : ni son code, ni son nombre de décimales, ni sa
   * nature, ni son libellé ne se modifient ensuite, et un actif ne se retire pas. La base
   * vérifie elle-même que l'auteur détient la permission.
   */
  async registerAsset(request: RegisterAssetRequest, actor: StaffActor): Promise<AdminAsset> {
    try {
      return await this.unitOfWork.run(async (tx) => {
        const asset = await this.ledger.insertAsset(tx, {
          code: request.code,
          name: request.name,
          kind: request.kind,
          scale: request.scale,
          registeredBy: actor.userId,
        });
        if (asset === null) {
          throw new AppError('CONFLICT', `Asset ${request.code} is already registered.`);
        }
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'asset.registered',
          resource: { type: 'asset', id: asset.code },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: {
            name: asset.name,
            kind: asset.kind,
            scale: asset.scale,
            reason: request.reason,
          },
        });
        return adminAssetOf(asset);
      });
    } catch (error) {
      // La base a vérifié elle-même le droit d'enregistrer : l'auteur ne l'a plus.
      if (error instanceof AssetRegistrationDeniedError) {
        throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
    }
  }

  /** Comptes, du plus anciennement ouvert au plus récent. */
  async listAccounts(
    query: AdminLedgerAccountListQuery,
    actor: StaffActor,
  ): Promise<AdminLedgerAccountList> {
    const found = await this.ledger.listAccounts(this.prisma, {
      userId: query.userId,
      assetCode: query.assetCode,
      type: query.type,
      afterId:
        query.after === undefined ? undefined : decodeCursor(query.after, ACCOUNT_CURSOR_PATTERN),
      limit: query.limit + 1,
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    const assets = await this.assetsOf(page.map(({ assetCode }) => assetCode));

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_account.listed_by_admin',
      resource: { type: 'ledger_account' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        ...(query.assetCode === undefined ? {} : { assetCode: query.assetCode }),
        ...(query.type === undefined ? {} : { type: query.type }),
        limit: query.limit,
        results: page.length,
      },
    });

    return {
      accounts: page.map((account) => adminAccountOf(account, assets(account.assetCode))),
      nextCursor: found.length > query.limit && last !== undefined ? encodeCursor(last.id) : null,
    };
  }

  /** Un compte et ses lignes, de la plus récente à la plus ancienne. */
  async listPostings(
    accountId: string,
    query: AdminLedgerPostingListQuery,
    actor: StaffActor,
  ): Promise<AdminLedgerPostingList> {
    const before =
      query.after === undefined
        ? undefined
        : BigInt(decodeCursor(query.after, SEQUENCE_CURSOR_PATTERN));
    const account = await this.ledger.findAccount(this.prisma, accountId);
    const statement =
      account === null
        ? null
        : await this.ledger.readStatement(this.prisma, account.id, {
            beforeSequence: before,
            limit: query.limit + 1,
          });
    if (account === null || statement === null) {
      throw notFound('Ledger account');
    }
    const asset = (await this.assetsOf([account.assetCode]))(account.assetCode);
    const page = statement.lines.slice(0, query.limit);
    const last = page.at(-1);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_account.viewed_by_admin',
      resource: { type: 'ledger_account', id: account.id },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        ...(account.userId === null ? {} : { userId: account.userId }),
        type: account.type,
        assetCode: account.assetCode,
        limit: query.limit,
        results: page.length,
      },
    });

    return {
      account: adminAccountOf(account, asset, statement),
      postings: page.map((line) => ({
        id: line.id,
        entryId: line.entryId,
        lineNumber: line.lineNumber,
        kind: line.kind,
        side: line.side,
        amount: amountText(line.units, asset),
        balanceAfter: amountText(line.balanceAfter, asset),
        accountSequence: Number(line.accountSequence),
        postedAt: line.postedAt.toISOString(),
      })),
      nextCursor:
        statement.lines.length > query.limit && last !== undefined
          ? encodeCursor(last.accountSequence.toString())
          : null,
    };
  }

  /** Une écriture complète : son en-tête et toutes ses lignes. */
  async getEntry(entryId: string, actor: StaffActor): Promise<AdminLedgerEntry> {
    const entry = await this.ledger.findEntry(this.prisma, entryId);
    if (entry === null) {
      throw notFound('Ledger entry');
    }
    const assets = await this.assetsOf(entry.postings.map(({ assetCode }) => assetCode));

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger_entry.viewed_by_admin',
      resource: { type: 'ledger_entry', id: entry.id },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: { kind: entry.kind, postings: entry.postings.length },
    });

    return {
      id: entry.id,
      kind: entry.kind,
      idempotencyKey: entry.idempotencyKey,
      actor: { type: entry.actorType, id: entry.actorId },
      requestId: entry.requestId,
      metadata: { ...entry.metadata },
      postedAt: entry.postedAt.toISOString(),
      postings: entry.postings.map((line) => {
        const asset = assets(line.assetCode);
        return {
          id: line.id,
          lineNumber: line.lineNumber,
          account: {
            id: line.accountId,
            type: line.accountType,
            owner: ownerOf({ type: line.accountType }),
            userId: line.accountUserId,
          },
          asset: assetViewOf(asset),
          side: line.side,
          amount: amountText(line.units, asset),
          balanceAfter: amountText(line.balanceAfter, asset),
          accountSequence: Number(line.accountSequence),
        };
      }),
    };
  }

  /**
   * Balance du grand livre : pour chaque actif, le total des soldes par type de compte. Les
   * soldes qui augmentent au débit égalent ceux qui augmentent au crédit tant que le grand
   * livre est sain.
   */
  async trialBalance(actor: StaffActor): Promise<TrialBalance> {
    const generatedAt = this.clock.now();
    const assets = await this.ledger.listAssets(this.prisma);
    // Une seule instruction : tous les totaux sont lus au même instant.
    const totals = await this.ledger.balanceTotals(this.prisma);

    const balance: TrialBalance['assets'] = assets.map((asset) => {
      const accountTypes = LEDGER_ACCOUNT_TYPE_KEYS.map((type) => {
        const total = totals.find(
          (candidate) => candidate.assetCode === asset.code && candidate.type === type,
        );
        const { normalSide, owner } = LEDGER_ACCOUNT_TYPES[type];
        return {
          type,
          owner,
          normalSide,
          accounts: total?.accounts ?? 0,
          units: total?.balance ?? 0n,
        };
      });
      const sumOf = (side: 'DEBIT' | 'CREDIT'): bigint =>
        accountTypes
          .filter(({ normalSide }) => normalSide === side)
          .reduce((sum, { units }) => sum + units, 0n);
      const debit = sumOf('DEBIT');
      const credit = sumOf('CREDIT');
      return {
        asset: assetViewOf(asset),
        debitBalance: amountText(debit, asset),
        creditBalance: amountText(credit, asset),
        balanced: debit === credit,
        accountTypes: accountTypes.map(({ units, ...accountType }) => ({
          ...accountType,
          balance: amountText(units, asset),
        })),
      };
    });
    const balanced = balance.every((asset) => asset.balanced);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'ledger.trial_balance_viewed',
      resource: { type: 'ledger' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: { assets: balance.length, balanced },
    });

    return { generatedAt: generatedAt.toISOString(), balanced, assets: balance };
  }

  /** Définition des actifs désignés ; un actif qui manquerait est un défaut du grand livre. */
  private async assetsOf(codes: readonly string[]): Promise<(code: string) => AssetRecord> {
    const assets = await this.ledger.findAssets(this.prisma, [...new Set(codes)]);
    return (code) => {
      const asset = assets.find((candidate) => candidate.code === code);
      if (asset === undefined) {
        throw new Error(`Asset ${code} is used by the ledger but is not registered.`);
      }
      return asset;
    };
  }
}
