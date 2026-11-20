import { LEDGER_ADJUSTMENT_ENTRY_KINDS } from '@mgx/contracts';

/**
 * Types d'écriture qui passent sur un portefeuille gelé : les ajustements du personnel, sous
 * double validation — c'est par eux que des fonds quittent un portefeuille gelé. Toute autre
 * écriture y est refusée, y compris celles des opérations qui restent à écrire.
 *
 * Même liste que la base de données (`mgx_forbid_frozen_wallet_posting`), qui a le dernier
 * mot ; un test vérifie que les deux s'accordent.
 */
export const ENTRY_KINDS_PASSING_A_FREEZE: readonly string[] = Object.values(
  LEDGER_ADJUSTMENT_ENTRY_KINDS,
);

/** Vrai si une écriture de ce type passe sur un portefeuille gelé. */
export function passesFrozenWallet(kind: string): boolean {
  return ENTRY_KINDS_PASSING_A_FREEZE.includes(kind);
}

/** Portefeuille d'un titulaire : ses comptes dans un actif. */
export interface WalletRef {
  readonly userId: string;
  readonly assetCode: string;
}

/** Forme textuelle d'un portefeuille : deux portefeuilles égaux ont le même texte. */
export function walletRefText(wallet: WalletRef): string {
  return `${wallet.userId}|${wallet.assetCode}`;
}
