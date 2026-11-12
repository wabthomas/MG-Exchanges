import { CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS } from '@mgx/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Domaine des adresses factices des comptes clôturés. `.invalid` est réservé (RFC 2606) : une
 * telle adresse ne peut ni exister, ni recevoir de message. La base de données réserve ce
 * domaine aux comptes clôturés.
 */
export const CLOSED_ACCOUNT_EMAIL_DOMAIN = 'closed.invalid';

/**
 * Adresse factice que porte la ligne d'un compte clôturé, à la place de la sienne : dérivée de
 * son identifiant, elle est unique sans rien dire du titulaire. La base de données impose
 * exactement cette forme.
 */
export function closedAccountEmail(userId: string): string {
  return `closed-${userId}@${CLOSED_ACCOUNT_EMAIL_DOMAIN}`;
}

/** Vrai pour toute adresse du domaine réservé aux comptes clôturés : nul ne s'y inscrit. */
export function isReservedEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${CLOSED_ACCOUNT_EMAIL_DOMAIN}`);
}

/**
 * Date à partir de laquelle ce qui reste d'un compte clôturé est effacé : le terme de la
 * conservation légale s'il y en a une, et jamais moins de
 * `CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS` jours après la clôture — le temps, pour le
 * titulaire, de contester une clôture qu'il n'aurait pas voulue.
 */
export function erasureDueAt(closedAt: Date, legalRetentionUntil: Date | null): Date {
  const earliest = closedAt.getTime() + CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS * DAY_MS;
  return new Date(Math.max(earliest, legalRetentionUntil?.getTime() ?? 0));
}

/**
 * Même instant, `years` années civiles plus tard (UTC). Un 29 février donne le 1ᵉʳ mars si
 * l'année d'arrivée n'est pas bissextile : jamais plus tôt que le calcul de la base de données
 * (`+ INTERVAL 'n years'`), qui retient le 28 février.
 */
export function addYearsUtc(date: Date, years: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() + years,
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** Terme le plus lointain parmi ceux que les modules déclarent ; `null` si aucun n'en déclare. */
export function latestRetention(terms: readonly (Date | null)[]): Date | null {
  let latest: Date | null = null;
  for (const term of terms) {
    if (term !== null && (latest === null || term > latest)) {
      latest = term;
    }
  }
  return latest;
}
