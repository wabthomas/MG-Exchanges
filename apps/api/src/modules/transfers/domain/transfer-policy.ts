import { createHash } from 'node:crypto';

import { INTERNAL_TRANSFER_ENTRY_KIND } from '@mgx/contracts';

/** Plafonds d'envoi d'un niveau de vérification dans un actif, en unités minimales. */
export interface TransferCeilings {
  readonly perTransferMax: bigint;
  readonly dailyMax: bigint;
  readonly monthlyMax: bigint;
}

/** Ce qu'un émetteur a déjà envoyé dans un actif, en unités minimales. */
export interface TransferUsage {
  readonly last24Hours: bigint;
  readonly last31Days: bigint;
}

/** Plafond qu'un transfert dépasserait. */
export type CeilingBreach = 'PER_TRANSFER' | 'DAILY' | 'MONTHLY';

export type TransferDecision =
  | { readonly allowed: true }
  /** Le niveau de vérification n'a pas de plafond dans l'actif, ou un plafond nul. */
  | { readonly allowed: false; readonly reason: 'LEVEL_NOT_OPEN' }
  | { readonly allowed: false; readonly reason: 'LIMIT_EXCEEDED'; readonly breach: CeilingBreach };

/**
 * Vrai si un niveau de vérification prend part aux transferts d'un actif — en envoi comme en
 * réception : des plafonds y sont fixés, et celui d'un transfert n'est pas nul.
 */
export function isLevelOpen(ceilings: TransferCeilings | null): ceilings is TransferCeilings {
  return ceilings !== null && ceilings.perTransferMax > 0n;
}

/**
 * Dit si les plafonds admettent un transfert de `units`. Même règle, dans le même ordre, que la
 * base de données (`mgx_enforce_transfer`), qui a le dernier mot.
 */
export function decideTransfer(
  units: bigint,
  ceilings: TransferCeilings | null,
  usage: TransferUsage,
): TransferDecision {
  if (!isLevelOpen(ceilings)) {
    return { allowed: false, reason: 'LEVEL_NOT_OPEN' };
  }
  if (units > ceilings.perTransferMax) {
    return { allowed: false, reason: 'LIMIT_EXCEEDED', breach: 'PER_TRANSFER' };
  }
  if (usage.last24Hours + units > ceilings.dailyMax) {
    return { allowed: false, reason: 'LIMIT_EXCEEDED', breach: 'DAILY' };
  }
  if (usage.last31Days + units > ceilings.monthlyMax) {
    return { allowed: false, reason: 'LIMIT_EXCEEDED', breach: 'MONTHLY' };
  }
  return { allowed: true };
}

/**
 * Plus grand montant que les plafonds admettent à cet instant, en unités minimales : zéro si le
 * niveau n'est pas ouvert, ou si un cumul a atteint son plafond.
 */
export function remainingAllowance(
  ceilings: TransferCeilings | null,
  usage: TransferUsage,
): bigint {
  if (!isLevelOpen(ceilings)) {
    return 0n;
  }
  const candidates = [
    ceilings.perTransferMax,
    ceilings.dailyMax - usage.last24Hours,
    ceilings.monthlyMax - usage.last31Days,
  ];
  const smallest = candidates.reduce((left, right) => (right < left ? right : left));
  return smallest > 0n ? smallest : 0n;
}

/** Ce qui fait d'une requête de transfert « la même » : le destinataire, l'actif et le montant. */
export interface TransferRequestIdentity {
  /** Adresse du destinataire, normalisée. */
  readonly recipientEmail: string;
  readonly assetCode: string;
  /** Montant, en unités minimales : « 1.5 » et « 1.50 » désignent le même transfert. */
  readonly units: bigint;
}

/**
 * Empreinte SHA-256 d'une requête de transfert. Une clé d'idempotence ne vaut que pour la
 * requête qui l'a présentée la première : sous la même clé, une autre empreinte est refusée.
 */
export function requestDigest(request: TransferRequestIdentity): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify([
        INTERNAL_TRANSFER_ENTRY_KIND,
        request.recipientEmail,
        request.assetCode,
        request.units.toString(),
      ]),
      'utf8',
    )
    .digest();
}

/** Clé d'idempotence de l'écriture du grand livre qui réalise un transfert. */
export function ledgerKeyOf(transferId: string): string {
  return `transfer:${transferId}`;
}
