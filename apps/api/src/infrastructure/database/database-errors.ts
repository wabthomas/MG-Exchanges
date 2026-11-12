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
