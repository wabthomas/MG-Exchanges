import type { AccountKey } from './ledger-account.js';

/** Ce qui rend une écriture irrecevable. */
export type LedgerRuleCode =
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_KIND'
  | 'INVALID_ACTOR'
  | 'INVALID_REQUEST_ID'
  | 'INVALID_METADATA'
  | 'METADATA_TOO_LARGE'
  | 'TOO_FEW_POSTINGS'
  | 'TOO_MANY_POSTINGS'
  | 'INVALID_ACCOUNT'
  | 'UNKNOWN_HOLDER'
  | 'HOLDER_NOT_ELIGIBLE'
  | 'NON_POSITIVE_AMOUNT'
  | 'AMOUNT_TOO_LARGE'
  | 'ASSET_MISMATCH'
  | 'SINGLE_ACCOUNT'
  | 'UNBALANCED';

/**
 * Écriture irrecevable — mal formée, ou passée au nom d'un compte qui ne peut pas détenir de
 * fonds : une erreur de l'appelant — un défaut du code, jamais une saisie du titulaire. Le
 * message ne contient aucun montant.
 */
export class LedgerRuleError extends Error {
  constructor(
    readonly code: LedgerRuleCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerRuleError';
  }
}

/**
 * Le solde d'un compte ne couvre pas la ligne qui le diminue. Cas **attendu** : c'est à
 * l'opération qui passe l'écriture d'en faire un refus compréhensible pour le titulaire.
 */
export class InsufficientFundsError extends Error {
  constructor(
    /**
     * Compte dont le solde est insuffisant ; `null` si c'est la base de données qui a refusé la
     * ligne, sans que l'application ait pu désigner le compte.
     */
    readonly account: AccountKey | null,
    options?: ErrorOptions,
  ) {
    super(
      account === null
        ? 'Insufficient funds.'
        : `Insufficient funds on the ${account.type} account in ${account.assetCode}.`,
      options,
    );
    this.name = 'InsufficientFundsError';
  }
}

/**
 * La clé d'idempotence a déjà servi à une écriture **différente**. Repasser la même écriture
 * est sans effet ; en présenter une autre sous la même clé est une erreur de l'appelant.
 */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('This idempotency key was already used for a different ledger entry.');
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Le titulaire d'un des comptes de l'écriture est clôturé : plus rien ne s'écrit sur ses
 * comptes. Cas **attendu** — le compte a pu être clôturé juste avant l'opération : à elle d'en
 * faire un refus compréhensible.
 */
export class HolderClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The holder of one of the accounts is closed: nothing can be posted to it.', options);
    this.name = 'HolderClosedError';
  }
}

/** L'actif d'un montant n'est pas tenu par le grand livre. */
export class UnknownAssetError extends Error {
  constructor(readonly assetCode: string) {
    super(`Asset ${assetCode} is not registered in the ledger.`);
    this.name = 'UnknownAssetError';
  }
}

/**
 * Un montant a été construit avec un autre nombre de décimales que celui de l'actif enregistré :
 * ses unités minimales n'auraient pas la valeur que l'appelant croit.
 */
export class AssetDefinitionMismatchError extends Error {
  constructor(readonly assetCode: string) {
    super(`Asset ${assetCode} does not have the number of decimals the ledger registered.`);
    this.name = 'AssetDefinitionMismatchError';
  }
}

/**
 * La base de données a refusé une écriture que les contrôles de l'application auraient dû
 * écarter : elle a eu le dernier mot. C'est un défaut à corriger, pas un cas d'usage.
 */
export class LedgerIntegrityError extends Error {
  constructor(options?: ErrorOptions) {
    super('The ledger refused the entry: one of its rules would have been broken.', options);
    this.name = 'LedgerIntegrityError';
  }
}
