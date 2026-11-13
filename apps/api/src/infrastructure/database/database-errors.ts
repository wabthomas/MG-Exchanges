import { Prisma } from '../../generated/prisma/client.js';

/**
 * Code SQLSTATE de l'erreur PostgreSQL à l'origine d'une erreur Prisma, ou `null`.
 *
 * Sert à reconnaître les erreurs levées par la base elle-même — contraintes, déclencheurs
 * (`MGX01`, `MGX02`) — pour les traduire en erreurs métier.
 */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const adapterError = error.meta?.['driverAdapterError'];
  if (typeof adapterError !== 'object' || adapterError === null) {
    return null;
  }
  const { cause } = adapterError as { readonly cause?: unknown };
  if (typeof cause !== 'object' || cause === null) {
    return null;
  }
  const { originalCode } = cause as { readonly originalCode?: unknown };
  return typeof originalCode === 'string' ? originalCode : null;
}

/** Violation d'une contrainte d'unicité, d'où qu'elle vienne (modèle Prisma ou SQL brut). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    sqlStateOf(error) === '23505'
  );
}

/**
 * SQLSTATE levé par la base lorsqu'une écriture vise un compte clôturé (voir la migration
 * `account_closure`).
 */
export const ACCOUNT_CLOSED_SQLSTATE = 'MGX05';

/** Vrai si la base a refusé une écriture parce que le compte visé est clôturé. */
export function isAccountClosedError(error: unknown): boolean {
  return sqlStateOf(error) === ACCOUNT_CLOSED_SQLSTATE;
}

/**
 * Vrai si la transaction a été interrompue faute d'obtenir un verrou : délai d'attente dépassé
 * (`lock_timeout`, SQLSTATE 55P03) ou interblocage résolu par PostgreSQL (40P01). Rien n'a été
 * écrit : la transaction peut être relancée.
 */
export function isLockContention(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  return sqlState === '55P03' || sqlState === '40P01';
}
