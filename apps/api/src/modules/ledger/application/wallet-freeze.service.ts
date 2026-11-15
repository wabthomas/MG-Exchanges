import type {
  FreezeWalletRequest,
  LiftWalletFreezeRequest,
  WalletFreeze,
  WalletFreezeList,
  WalletFreezeListQuery,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import { HolderClosedError } from '../domain/ledger-errors.js';
import { ACCOUNT_CURSOR_PATTERN, assetViewOf, decodeCursor, encodeCursor } from './ledger-views.js';
import { type AssetRecord, LedgerRepository } from './ledger.repository.js';
import { invalidField } from './request-amounts.js';
import {
  WalletAlreadyFrozenError,
  type WalletFreezeRecord,
  WalletFreezeRefusedByDatabaseError,
  WalletFreezeRepository,
} from './wallet-freeze.repository.js';

function toView(record: WalletFreezeRecord, asset: AssetRecord): WalletFreeze {
  return {
    id: record.id,
    userId: record.userId,
    asset: assetViewOf(asset),
    status: record.liftedAt === null ? 'ACTIVE' : 'LIFTED',
    reason: record.reason,
    frozenBy: record.frozenBy,
    frozenAt: record.frozenAt.toISOString(),
    liftedBy: record.liftedBy,
    liftedAt: record.liftedAt?.toISOString() ?? null,
    liftReason: record.liftReason,
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Wallet freeze not found.');
}

/** L'auteur n'a plus qualité au moment d'écrire : la base de données a refusé. */
function noLongerEntitled(error: unknown): AppError {
  return new AppError('FORBIDDEN', 'You do not have permission to perform this action.', {
    cause: error,
  });
}

/**
 * Gel des portefeuilles par le personnel.
 *
 * Geler le portefeuille d'un titulaire dans un actif, c'est y arrêter tout mouvement : plus
 * aucune ligne ne passe sur ses comptes dans cet actif — ni envoi, ni réception —, hors les
 * ajustements du personnel sous double validation, par lesquels des fonds peuvent encore en
 * sortir. Le solde demeure. C'est la base de données qui applique le gel, à chaque ligne
 * d'écriture, quelle que soit l'opération (voir la migration `staff_ledger_operations`) : le
 * gel attend l'écriture en cours sur le portefeuille, et toute écriture qui le suit le voit.
 *
 * Geler et lever sont deux permissions distinctes. L'un et l'autre sont justifiés, inscrits au
 * journal d'audit dans la transaction qui les applique, et visibles du titulaire dans
 * l'historique de son compte — sans la justification. Nul ne gèle son propre portefeuille, ni
 * n'en lève le gel.
 */
@Injectable()
export class WalletFreezeService {
  constructor(
    private readonly freezes: WalletFreezeRepository,
    private readonly ledger: LedgerRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WalletFreezeService.name);
  }

  /** Gels, du plus récent au plus ancien. Chaque consultation est journalisée. */
  async list(query: WalletFreezeListQuery, actor: StaffActor): Promise<WalletFreezeList> {
    const beforeId =
      query.after === undefined ? undefined : decodeCursor(query.after, ACCOUNT_CURSOR_PATTERN);
    const found = await this.freezes.list(this.prisma, {
      userId: query.userId,
      status: query.status,
      beforeId,
      limit: query.limit + 1,
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'wallet_freeze.listed_by_admin',
      resource: { type: 'wallet_freeze' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: {
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: query.limit,
        results: page.length,
      },
    });

    const assets = new Map(
      (await this.ledger.listAssets(this.prisma)).map((asset) => [asset.code, asset]),
    );
    return {
      freezes: page.map((record) => toView(record, this.assetOf(assets, record))),
      nextCursor: found.length > query.limit && last !== undefined ? encodeCursor(last.id) : null,
    };
  }

  /** Gèle le portefeuille d'un titulaire dans un actif. */
  async freeze(request: FreezeWalletRequest, actor: StaffActor): Promise<WalletFreeze> {
    if (request.userId === actor.userId) {
      await this.recordDenial(actor, request.userId, 'user.wallet_freeze_denied');
      throw new AppError('FORBIDDEN', 'You cannot freeze your own wallet.');
    }
    const [asset] = await this.ledger.findAssets(this.prisma, [request.assetCode]);
    if (asset === undefined) {
      throw invalidField('assetCode', 'The platform does not keep this asset.');
    }
    const holder = await this.users.findById(this.prisma, request.userId);
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

    let record: WalletFreezeRecord;
    try {
      record = await this.unitOfWork.run(async (tx) => {
        const frozen = await this.freezes.insert(tx, {
          userId: holder.id,
          assetCode: asset.code,
          reason: request.reason,
          frozenBy: actor.userId,
        });
        // Rattachée au compte : son titulaire la lit dans son historique, sans la justification.
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'user.wallet_frozen',
          resource: { type: 'user', id: holder.id },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { freezeId: frozen.id, assetCode: asset.code, reason: request.reason },
        });
        return frozen;
      });
    } catch (error) {
      if (error instanceof WalletAlreadyFrozenError) {
        throw new AppError('CONFLICT', 'This wallet is already frozen.');
      }
      if (error instanceof HolderClosedError) {
        throw new AppError('CONFLICT', 'This account is closed: it has no wallet.', {
          cause: error,
        });
      }
      if (error instanceof WalletFreezeRefusedByDatabaseError) {
        this.logger.warn(
          { err: error, userId: holder.id, actorId: actor.userId },
          'Wallet freeze refused by the database',
        );
        throw noLongerEntitled(error);
      }
      throw error;
    }
    return toView(record, asset);
  }

  /** Lève un gel : le portefeuille redevient utilisable aussitôt. */
  async lift(
    id: string,
    request: LiftWalletFreezeRequest,
    actor: StaffActor,
  ): Promise<WalletFreeze> {
    const freeze = await this.freezes.find(this.prisma, id);
    if (freeze === null) {
      throw notFound();
    }
    if (freeze.liftedAt !== null) {
      throw new AppError('CONFLICT', 'This freeze was already lifted.');
    }
    if (freeze.userId === actor.userId) {
      await this.recordDenial(actor, freeze.userId, 'user.wallet_unfreeze_denied');
      throw new AppError('FORBIDDEN', 'You cannot lift the freeze of your own wallet.');
    }

    let record: WalletFreezeRecord;
    try {
      record = await this.unitOfWork.run(async (tx) => {
        const lifted = await this.freezes.lift(tx, id, {
          liftedBy: actor.userId,
          reason: request.reason,
        });
        if (lifted === null) {
          throw new AppError('CONFLICT', 'This freeze has just been lifted by someone else.');
        }
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'user.wallet_unfrozen',
          resource: { type: 'user', id: lifted.userId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { freezeId: lifted.id, assetCode: lifted.assetCode, reason: request.reason },
        });
        return lifted;
      });
    } catch (error) {
      if (error instanceof WalletFreezeRefusedByDatabaseError) {
        this.logger.warn(
          { err: error, freezeId: id, actorId: actor.userId },
          'Lift of a wallet freeze refused by the database',
        );
        throw noLongerEntitled(error);
      }
      throw error;
    }
    const assets = new Map(
      (await this.ledger.findAssets(this.prisma, [record.assetCode])).map((asset) => [
        asset.code,
        asset,
      ]),
    );
    return toView(record, this.assetOf(assets, record));
  }

  private assetOf(
    assets: ReadonlyMap<string, AssetRecord>,
    record: WalletFreezeRecord,
  ): AssetRecord {
    const asset = assets.get(record.assetCode);
    if (asset === undefined) {
      throw new Error(`Asset ${record.assetCode} of wallet freeze ${record.id} is not registered.`);
    }
    return asset;
  }

  private async recordDenial(actor: StaffActor, userId: string, action: string): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action,
      resource: { type: 'user', id: userId },
      outcome: 'DENIED',
      ...actor.client,
      metadata: { reason: 'OWN_WALLET' },
    });
  }
}
