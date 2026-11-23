import type { LedgerAdjustment } from '@mgx/contracts';

import { amountText, assetViewOf } from '../../ledger/application/ledger-views.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import type { AdjustmentRecord } from './adjustment.repository.js';

/**
 * Ajustement tel que le voit le back-office : chaque intervenant avec l'adresse que porte
 * aujourd'hui son compte — `null` s'il a été clôturé depuis.
 */
export function toAdjustmentView(
  adjustment: AdjustmentRecord,
  asset: AssetRecord,
  emails: ReadonlyMap<string, string | null>,
): LedgerAdjustment {
  const party = (id: string): { id: string; email: string | null } => ({
    id,
    email: emails.get(id) ?? null,
  });
  return {
    id: adjustment.id,
    user: party(adjustment.userId),
    asset: assetViewOf(asset),
    direction: adjustment.direction,
    amount: amountText(adjustment.units, asset),
    reason: adjustment.reason,
    status: adjustment.status,
    requestedBy: party(adjustment.requestedBy),
    requestedAt: adjustment.requestedAt.toISOString(),
    expiresAt: adjustment.expiresAt.toISOString(),
    decidedBy: adjustment.decidedBy === null ? null : party(adjustment.decidedBy),
    decidedAt: adjustment.decidedAt?.toISOString() ?? null,
    decisionNote: adjustment.decisionNote,
    entryId: adjustment.entryId,
  };
}
