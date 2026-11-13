import { MoneyError } from './money-error.js';
import { divideRounded, type RoundingMode } from './rounding.js';

/** Nombre maximal de décimales pris en charge (18 pour l'ether ; marge jusqu'à 36). */
export const MAX_SCALE = 36;

/** Longueur maximale d'une chaîne décimale acceptée (protection contre les entrées abusives). */
export const MAX_DECIMAL_LENGTH = 80;

/**
 * Forme canonique stricte : signe « - » facultatif, pas de « + », pas de zéros de tête,
 * point décimal, aucun exposant, aucun séparateur de milliers, aucun espace.
 */
const DECIMAL_PATTERN = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?$/;

/** 10^exponent, exact (0 ≤ exponent ≤ {@link MAX_SCALE}). */
export function pow10(exponent: number): bigint {
  assertValidScale(exponent);
  return 10n ** BigInt(exponent);
}

export function assertValidScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new MoneyError('INVALID_SCALE', `Scale must be an integer between 0 and ${MAX_SCALE}.`);
  }
}

/** Indique si `value` est une chaîne décimale canonique (voir {@link parseDecimalToUnits}). */
export function isDecimalString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_DECIMAL_LENGTH && DECIMAL_PATTERN.test(value)
  );
}

export interface ParseDecimalOptions {
  /**
   * Arrondi appliqué lorsque la valeur comporte plus de décimales significatives que `scale`.
   * Sans cette option, une telle valeur est rejetée (`PRECISION_EXCEEDED`) : rien n'est
   * jamais arrondi silencieusement.
   */
  readonly rounding?: RoundingMode;
}

/**
 * Convertit une chaîne décimale en nombre entier d'unités minimales (`bigint`).
 *
 * @example parseDecimalToUnits('12.34', 2) === 1234n
 * @example parseDecimalToUnits('0.00000001', 8) === 1n
 *
 * @throws MoneyError `INVALID_DECIMAL` si la valeur n'est pas une chaîne décimale canonique
 *   (un `number` est toujours refusé), `PRECISION_EXCEEDED` si elle ne tient pas dans `scale`
 *   décimales et qu'aucun arrondi n'est demandé.
 */
export function parseDecimalToUnits(
  value: string,
  scale: number,
  options: ParseDecimalOptions = {},
): bigint {
  assertValidScale(scale);

  if (typeof value !== 'string') {
    throw new MoneyError(
      'INVALID_DECIMAL',
      'An amount must be provided as a decimal string, never as a number.',
    );
  }
  if (value.length > MAX_DECIMAL_LENGTH) {
    throw new MoneyError('INVALID_DECIMAL', 'Decimal string is too long.');
  }

  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    throw new MoneyError('INVALID_DECIMAL', 'Invalid decimal format.');
  }

  const negative = match[1] === '-';
  const integerDigits = match[2] ?? '0';
  const fractionDigits = match[3] ?? '';

  let magnitude: bigint;
  if (fractionDigits.length <= scale) {
    magnitude = BigInt(integerDigits + fractionDigits.padEnd(scale, '0'));
  } else {
    const kept = fractionDigits.slice(0, scale);
    const excess = fractionDigits.slice(scale);
    const truncated = BigInt(integerDigits + kept);

    if (/^0+$/.test(excess)) {
      // Zéros non significatifs au-delà de la précision : valeur exactement représentable.
      magnitude = truncated;
    } else if (options.rounding === undefined) {
      throw new MoneyError(
        'PRECISION_EXCEEDED',
        `Value has more than ${scale} significant decimal places.`,
      );
    } else {
      const numerator = BigInt(integerDigits + fractionDigits);
      const signed = negative ? -numerator : numerator;
      // L'excédent est borné par MAX_DECIMAL_LENGTH : la puissance reste petite.
      return divideRounded(signed, 10n ** BigInt(excess.length), options.rounding);
    }
  }

  return negative ? -magnitude : magnitude;
}

export interface FormatUnitsOptions {
  /** Supprime les zéros décimaux de fin (`'1.50'` → `'1.5'`, `'2.00'` → `'2'`). */
  readonly trimTrailingZeros?: boolean;
}

/**
 * Convertit un nombre entier d'unités minimales en chaîne décimale canonique.
 *
 * @example formatUnits(1234n, 2) === '12.34'
 * @example formatUnits(-5n, 2) === '-0.05'
 */
export function formatUnits(
  units: bigint,
  scale: number,
  options: FormatUnitsOptions = {},
): string {
  assertValidScale(scale);
  assertBigInt(units);

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const integerPart = digits.slice(0, digits.length - scale);
  let fractionPart = digits.slice(digits.length - scale);

  if (options.trimTrailingZeros === true) {
    fractionPart = fractionPart.replace(/0+$/, '');
  }

  const sign = negative ? '-' : '';
  return fractionPart.length > 0
    ? `${sign}${integerPart}.${fractionPart}`
    : `${sign}${integerPart}`;
}

/** Refuse à l'exécution toute valeur qui ne serait pas un `bigint` (appelants non typés). */
export function assertBigInt(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new MoneyError(
      'NOT_A_BIGINT',
      'Minor units must be a bigint, never a floating-point number.',
    );
  }
}
