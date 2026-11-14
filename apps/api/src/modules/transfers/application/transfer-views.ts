import type { AdminTransferLimit, Transfer, TransferLimitAmounts } from '@mgx/contracts';

import { amountText, assetViewOf } from '../../ledger/application/ledger-views.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import type { TransferCeilings } from '../domain/transfer-policy.js';
import type { LimitRecord, TransferRecord } from './transfer.repository.js';

/**
 * Transfert tel que le voit une de ses deux parties : son sens, et l'adresse que porte
 * aujourd'hui le compte de l'autre — `null` si ce compte a été clôturé depuis.
 */
export function toTransferView(
  transfer: TransferRecord,
  viewerId: string,
  asset: AssetRecord,
  emails: ReadonlyMap<string, string | null>,
): Transfer {
  const sent = transfer.senderId === viewerId;
  const counterpartyId = sent ? transfer.recipientId : transfer.senderId;
  return {
    id: transfer.id,
    direction: sent ? 'SENT' : 'RECEIVED',
    asset: assetViewOf(asset),
    amount: amountText(transfer.units, asset),
    counterparty: { email: emails.get(counterpartyId) ?? null },
    entryId: transfer.entryId,
    createdAt: transfer.createdAt.toISOString(),
  };
}

/** Plafonds en chaînes décimales, au nombre de décimales de l'actif. */
export function toLimitAmounts(
  ceilings: TransferCeilings,
  asset: AssetRecord,
): TransferLimitAmounts {
  return {
    perTransfer: amountText(ceilings.perTransferMax, asset),
    daily: amountText(ceilings.dailyMax, asset),
    monthly: amountText(ceilings.monthlyMax, asset),
  };
}

export function toAdminLimitView(limit: LimitRecord, asset: AssetRecord): AdminTransferLimit {
  return {
    ...toLimitAmounts(limit, asset),
    asset: assetViewOf(asset),
    level: limit.level,
    setBy: limit.setBy,
    setAt: limit.setAt.toISOString(),
  };
}
