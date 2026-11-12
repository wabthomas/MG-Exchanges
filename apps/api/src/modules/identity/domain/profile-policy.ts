import { MINIMUM_AGE_YEARS } from '@mgx/contracts';

/** Date de naissance la plus ancienne acceptée (la base de données applique la même borne). */
const EARLIEST_BIRTH_DATE = '1900-01-01';

export type BirthDateRejection = 'NOT_A_DATE' | 'TOO_OLD' | 'UNDER_MINIMUM_AGE';

export const BIRTH_DATE_REJECTION_MESSAGES: Readonly<Record<BirthDateRejection, string>> = {
  NOT_A_DATE: 'Must be a valid calendar date.',
  TOO_OLD: `Must not be before ${EARLIEST_BIRTH_DATE}.`,
  UNDER_MINIMUM_AGE: `You must be at least ${MINIMUM_AGE_YEARS} years old.`,
};

/** Minuit UTC du jour civil donné (`1990-05-17`), ou `null` si ce jour n'existe pas. */
export function parseCalendarDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  // `2023-02-30` est accepté par `Date`, qui le décale : la date relue doit être la même.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function formatCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Une date de naissance doit exister, ne pas être antérieure à 1900 et correspondre à une
 * personne majeure à la date `today` (jour civil UTC).
 */
export function checkBirthDate(value: string, today: Date): BirthDateRejection | null {
  const birth = parseCalendarDate(value);
  if (birth === null) {
    return 'NOT_A_DATE';
  }
  if (value < EARLIEST_BIRTH_DATE) {
    return 'TOO_OLD';
  }
  const majority = new Date(birth);
  majority.setUTCFullYear(birth.getUTCFullYear() + MINIMUM_AGE_YEARS);
  return majority.getTime() <= today.getTime() ? null : 'UNDER_MINIMUM_AGE';
}
