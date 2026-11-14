import type {
  AdminTransferLimit,
  AdminTransferLimitList,
  KycVerifiedLevel,
  SetTransferLimitRequest,
  TransferAllowanceList,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { StaffActor } from '../../identity/application/admin-users.service.js';
import { LedgerReader } from '../../ledger/application/ledger-reader.js';
import { amountText, assetViewOf } from '../../ledger/application/ledger-views.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import { SystemSettingsService } from '../../system-settings/application/system-settings.service.js';
import { remainingAllowance, type TransferCeilings } from '../domain/transfer-policy.js';
import { invalidField, parseRequestAmount } from './transfer-amounts.js';
import { toAdminLimitView, toLimitAmounts } from './transfer-views.js';
import { LimitChangeDeniedError, TransferRepository } from './transfer.repository.js';

type CeilingField = 'perTransfer' | 'daily' | 'monthly';

/** Plafond d'une requête, dans l'unité minimale de l'actif. */
function parseCeiling(value: string, field: CeilingField, asset: AssetRecord): bigint {
  const amount = parseRequestAmount(value, asset, field);
  if (amount.isNegative()) {
    throw invalidField(field, 'Must not be negative.');
  }
  return amount.units;
}

/**
 * Plafonds de transfert : ce que chaque niveau de vérification d'identité peut envoyer dans
 * chaque actif — par transfert, sur 24 heures glissantes, sur 31 jours glissants.
 *
 * **Fermé tant que rien n'est fixé** : un niveau sans plafond dans un actif n'y envoie ni n'y
 * reçoit rien. Aucune valeur n'est livrée avec le code ; les plafonds se fixent au back-office,
 * un couple actif-niveau à la fois, avec une justification inscrite au journal d'audit. Des
 * plafonds ne se suppriment pas : refermer un niveau, c'est les ramener à zéro. La base de
 * données vérifie elle-même le droit de les fixer, et leur ordre.
 */
@Injectable()
export class TransferLimitsService {
  constructor(
    private readonly transfers: TransferRepository,
    private readonly reader: LedgerReader,
    private readonly settings: SystemSettingsService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Ce que le titulaire peut envoyer, actif par actif : les plafonds de son niveau, ce qu'il a
   * déjà envoyé, ce qu'ils admettent encore. Calculé par la base, comme elle le fera en dernier
   * ressort lors d'un transfert.
   */
  async allowancesOf(userId: string): Promise<TransferAllowanceList> {
    const enabled = await this.settings.isFeatureEnabled('internalTransfers');
    const assets = await this.reader.assets(this.prisma);
    const { byAsset, level } = await this.transfers.allowances(this.prisma, userId);
    return {
      enabled,
      level,
      allowances: assets.map((asset) => {
        const allowance = byAsset.get(asset.code);
        const ceilings = allowance?.ceilings ?? null;
        const usage = allowance?.usage ?? { last24Hours: 0n, last31Days: 0n };
        return {
          asset: assetViewOf(asset),
          limit: ceilings === null ? null : toLimitAmounts(ceilings, asset),
          used: {
            last24Hours: amountText(usage.last24Hours, asset),
            last31Days: amountText(usage.last31Days, asset),
          },
          remaining: amountText(remainingAllowance(ceilings, usage), asset),
        };
      }),
    };
  }

  /** Tous les plafonds fixés, dans l'ordre des actifs puis des niveaux. */
  async list(actor: StaffActor): Promise<AdminTransferLimitList> {
    const limits = await this.transfers.listLimits(this.prisma);
    const assets = new Map(
      (await this.reader.assets(this.prisma)).map((asset) => [asset.code, asset]),
    );
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: actor.userId },
      action: 'transfer_limit.listed_by_admin',
      resource: { type: 'transfer_limit' },
      outcome: 'SUCCESS',
      ...actor.client,
      metadata: { results: limits.length },
    });
    return {
      limits: limits.map((limit) => {
        const asset = assets.get(limit.assetCode);
        if (asset === undefined) {
          throw new Error(`Asset ${limit.assetCode} of a transfer limit is not registered.`);
        }
        return toAdminLimitView(limit, asset);
      }),
    };
  }

  /**
   * Fixe — ou remplace — les plafonds d'un niveau de vérification dans un actif. L'effet est
   * immédiat : le transfert suivant est examiné avec eux.
   */
  async set(
    assetCode: string,
    level: KycVerifiedLevel,
    request: SetTransferLimitRequest,
    actor: StaffActor,
  ): Promise<AdminTransferLimit> {
    const asset = await this.reader.asset(this.prisma, assetCode);
    if (asset === null) {
      throw new AppError('NOT_FOUND', 'Asset not found.');
    }
    const ceilings: TransferCeilings = {
      perTransferMax: parseCeiling(request.perTransfer, 'perTransfer', asset),
      dailyMax: parseCeiling(request.daily, 'daily', asset),
      monthlyMax: parseCeiling(request.monthly, 'monthly', asset),
    };
    if (ceilings.dailyMax < ceilings.perTransferMax) {
      throw invalidField('daily', 'Must be at least the limit per transfer.');
    }
    if (ceilings.monthlyMax < ceilings.dailyMax) {
      throw invalidField('monthly', 'Must be at least the limit over 24 hours.');
    }

    try {
      return await this.unitOfWork.run(async (tx) => {
        const { after, before } = await this.transfers.setLimit(tx, {
          ...ceilings,
          assetCode: asset.code,
          level,
          setBy: actor.userId,
        });
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'transfer_limit.set',
          resource: { type: 'transfer_limit', id: `${asset.code}:${String(level)}` },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: {
            assetCode: asset.code,
            level,
            before: before === null ? null : toLimitAmounts(before, asset),
            after: toLimitAmounts(after, asset),
            reason: request.reason,
          },
        });
        return toAdminLimitView(after, asset);
      });
    } catch (error) {
      // La base a vérifié elle-même le droit de fixer des plafonds : l'auteur ne l'a plus.
      if (error instanceof LimitChangeDeniedError) {
        throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
    }
  }
}
