import type {
  ExportedWallet,
  Wallet,
  WalletList,
  WalletMovement,
  WalletMovementList,
  WalletMovementListQuery,
} from '@mgx/contracts';
import { DATA_EXPORT_MOVEMENTS_MAX_ENTRIES } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { WALLET_ACCOUNT_TYPE } from '../domain/ledger-account.js';
import {
  amountText,
  assetViewOf,
  decodeCursor,
  encodeCursor,
  SEQUENCE_CURSOR_PATTERN,
} from './ledger-views.js';
import { type AssetRecord, LedgerRepository, type StatementLine } from './ledger.repository.js';

function walletOf(asset: AssetRecord, balance: bigint): Wallet {
  return { asset: assetViewOf(asset), available: amountText(balance, asset) };
}

/**
 * Le compte « fonds disponibles » augmente au crédit : le sens d'une ligne y est déjà celui
 * d'un relevé — `CREDIT`, des fonds entrent ; `DEBIT`, des fonds sortent.
 */
function movementOf(line: StatementLine, asset: AssetRecord): WalletMovement {
  return {
    id: line.id,
    entryId: line.entryId,
    kind: line.kind,
    side: line.side,
    amount: amountText(line.units, asset),
    balanceAfter: amountText(line.balanceAfter, asset),
    postedAt: line.postedAt.toISOString(),
  };
}

/**
 * Portefeuilles d'un titulaire : ce que le grand livre tient à son nom, tel qu'il le voit.
 *
 * Lecture seule. Un portefeuille existe dans chaque actif tenu par la plateforme, à zéro tant
 * qu'aucune écriture n'y a été passée — le compte du grand livre, lui, n'est ouvert qu'à la
 * première écriture. Chaque lecture est filtrée par le compte de l'appelant.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly prisma: PrismaService,
  ) {}

  async list(userId: string): Promise<WalletList> {
    const assets = await this.ledger.listAssets(this.prisma);
    const accounts = await this.ledger.accountsOfUser(this.prisma, userId);
    const balances = new Map(
      accounts
        .filter(({ type }) => type === WALLET_ACCOUNT_TYPE)
        .map(({ assetCode, balance }) => [assetCode, balance]),
    );
    return { wallets: assets.map((asset) => walletOf(asset, balances.get(asset.code) ?? 0n)) };
  }

  /** Mouvements d'un portefeuille, du plus récent au plus ancien. */
  async movements(
    userId: string,
    assetCode: string,
    query: WalletMovementListQuery,
  ): Promise<WalletMovementList> {
    const before =
      query.after === undefined
        ? undefined
        : BigInt(decodeCursor(query.after, SEQUENCE_CURSOR_PATTERN));
    const [asset] = await this.ledger.findAssets(this.prisma, [assetCode]);
    if (asset === undefined) {
      throw new AppError('NOT_FOUND', 'Wallet not found.');
    }
    const [account] = await this.ledger.findAccounts(this.prisma, [
      { type: WALLET_ACCOUNT_TYPE, assetCode, userId },
    ]);
    const statement =
      account === undefined
        ? null
        : await this.ledger.readStatement(this.prisma, account.id, {
            beforeSequence: before,
            limit: query.limit + 1,
          });
    if (statement === null) {
      return { wallet: walletOf(asset, 0n), movements: [], nextCursor: null };
    }

    const page = statement.lines.slice(0, query.limit);
    const last = page.at(-1);
    return {
      wallet: walletOf(asset, statement.balance),
      movements: page.map((line) => movementOf(line, asset)),
      nextCursor:
        statement.lines.length > query.limit && last !== undefined
          ? encodeCursor(last.accountSequence.toString())
          : null,
    };
  }

  /**
   * Portefeuilles sur lesquels au moins un mouvement a été passé, avec leurs mouvements — les
   * plus récents, si le portefeuille en compte plus que la copie des données n'en contient.
   */
  async exportOf(db: DbClient, userId: string): Promise<ExportedWallet[]> {
    const accounts = (await this.ledger.accountsOfUser(db, userId)).filter(
      ({ postingCount, type }) => type === WALLET_ACCOUNT_TYPE && postingCount > 0n,
    );
    const assets = await this.ledger.findAssets(
      db,
      accounts.map(({ assetCode }) => assetCode),
    );

    const wallets: ExportedWallet[] = [];
    for (const account of accounts) {
      const asset = assets.find(({ code }) => code === account.assetCode);
      const statement = await this.ledger.readStatement(db, account.id, {
        limit: DATA_EXPORT_MOVEMENTS_MAX_ENTRIES,
      });
      if (asset === undefined || statement === null) {
        throw new Error(`Ledger account ${account.id} cannot be read back.`);
      }
      wallets.push({
        ...walletOf(asset, statement.balance),
        movements: statement.lines.map((line) => movementOf(line, asset)),
        truncated: statement.postingCount > BigInt(statement.lines.length),
      });
    }
    return wallets;
  }
}
