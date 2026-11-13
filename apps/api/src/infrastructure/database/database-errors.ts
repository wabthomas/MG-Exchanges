import { Prisma } from '../../generated/prisma/client.js';

/** Nom de l'erreur que le pilote de base de données lève lui-même (hors d'une requête Prisma). */
const DRIVER_ADAPTER_ERROR = 'DriverAdapterError';

/**
 * Ce que le pilote dit de l'erreur PostgreSQL d'origine, ou `null`.
 *
 * Deux formes, selon le moment où la base refuse :
 *  - pendant une requête : une erreur Prisma « connue », qui porte celle du pilote ;
 *  - **à la validation de la transaction** (`COMMIT`) — règle vérifiée en fin de transaction,
 *    conflit de sérialisation constaté à ce moment-là : l'erreur du pilote, telle quelle.
 */
function driverCauseOf(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const adapterError = error.meta?.['driverAdapterError'];
    if (typeof adapterError !== 'object' || adapterError === null) {
      return null;
    }
    return (adapterError as { readonly cause?: unknown }).cause;
  }
  if (error instanceof Error && error.name === DRIVER_ADAPTER_ERROR) {
    return error.cause;
  }
  return null;
}

/**
 * Code SQLSTATE de l'erreur PostgreSQL à l'origine d'une erreur Prisma, ou `null`.
 *
 * Sert à reconnaître les erreurs levées par la base elle-même — contraintes, déclencheurs
 * (`MGX01`, `MGX02`…) — pour les traduire en erreurs métier, qu'elles surviennent pendant une
 * requête ou à la validation de la transaction.
 */
export function sqlStateOf(error: unknown): string | null {
  const cause = driverCauseOf(error);
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

/**
 * Vrai si PostgreSQL a annulé la transaction parce qu'elle en croisait une autre : conflit de
 * sérialisation (40001) ou interblocage (40P01). Ce n'est pas un défaut de la requête, et rien
 * n'a été écrit : la transaction peut être relancée entière (`UnitOfWork.run`, option `retry`).
 */
export function isTransactionConflict(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  return sqlState === '40001' || sqlState === '40P01';
}
