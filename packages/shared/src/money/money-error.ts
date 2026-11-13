/** Codes d'erreur stables des primitives monétaires. */
export type MoneyErrorCode =
  | 'INVALID_DECIMAL'
  | 'PRECISION_EXCEEDED'
  | 'INVALID_SCALE'
  | 'INVALID_ASSET'
  | 'ASSET_MISMATCH'
  | 'NOT_A_BIGINT'
  | 'DIVISION_BY_ZERO'
  | 'INVALID_WEIGHTS';

/**
 * Erreur levée par les primitives monétaires.
 *
 * Le message ne contient jamais le montant fourni : une valeur invalide peut provenir
 * d'une saisie utilisateur et ne doit pas se retrouver telle quelle dans les journaux.
 */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}
