import {
  LEDGER_ADJUSTMENT_ENTRY_KINDS,
  type LedgerAdjustmentDirection,
  type LedgerSide,
} from '@mgx/contracts';

/** Clé d'idempotence de l'écriture du grand livre qui réalise un ajustement. */
export function ledgerKeyOf(adjustmentId: string): string {
  return `adjustment:${adjustmentId}`;
}

/** Type de l'écriture que produit un ajustement, selon son sens. */
export function entryKindOf(direction: LedgerAdjustmentDirection): string {
  return LEDGER_ADJUSTMENT_ENTRY_KINDS[direction];
}

/**
 * Sens des deux lignes d'un ajustement. Le portefeuille du titulaire est mouvementé dans le
 * sens de l'ajustement ; le compte de conservation de la plateforme, dans le sens inverse : ce
 * que la plateforme conserve pour ses titulaires varie comme ce qu'elle leur doit.
 */
export function postingSidesOf(direction: LedgerAdjustmentDirection): {
  readonly wallet: LedgerSide;
  readonly custody: LedgerSide;
} {
  return direction === 'CREDIT'
    ? { wallet: 'CREDIT', custody: 'DEBIT' }
    : { wallet: 'DEBIT', custody: 'CREDIT' };
}
