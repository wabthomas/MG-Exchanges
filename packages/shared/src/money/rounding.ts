import { MoneyError } from './money-error.js';

/**
 * Modes d'arrondi (sémantique identique à `java.math.RoundingMode`).
 *
 * - `DOWN` : vers zéro (troncature) — `UP` : en s'éloignant de zéro ;
 * - `FLOOR` : vers −∞ — `CEILING` : vers +∞ ;
 * - `HALF_UP` / `HALF_DOWN` / `HALF_EVEN` : au plus proche, l'égalité parfaite étant
 *   tranchée respectivement loin de zéro, vers zéro, ou vers le chiffre pair (arrondi bancaire).
 *
 * Aucun mode par défaut n'existe : chaque appelant choisit explicitement, car le sens
 * de l'arrondi d'un frais ou d'une conversion est une décision métier.
 */
export const ROUNDING_MODES = [
  'DOWN',
  'UP',
  'FLOOR',
  'CEILING',
  'HALF_UP',
  'HALF_DOWN',
  'HALF_EVEN',
] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

/**
 * Division entière exacte de deux `bigint`, arrondie selon `mode`.
 *
 * C'est l'unique endroit où un arrondi est calculé : toutes les autres primitives
 * (analyse décimale, ratio, points de base) s'appuient sur cette fonction.
 */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new MoneyError('DIVISION_BY_ZERO', 'Division by zero.');
  }

  // Normalisation : dénominateur strictement positif, le signe est porté par le numérateur.
  const n = denominator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d; // tronqué vers zéro
  const remainder = n % d; // du signe de `n`
  if (remainder === 0n) {
    return quotient;
  }

  const negative = n < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;

  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return awayFromZero;
    case 'FLOOR':
      return negative ? awayFromZero : quotient;
    case 'CEILING':
      return negative ? quotient : awayFromZero;
    case 'HALF_UP':
    case 'HALF_DOWN':
    case 'HALF_EVEN': {
      const twiceRemainder = (negative ? -remainder : remainder) * 2n;
      if (twiceRemainder > d) {
        return awayFromZero;
      }
      if (twiceRemainder < d) {
        return quotient;
      }
      // Égalité parfaite : exactement à mi-chemin entre deux entiers.
      if (mode === 'HALF_UP') {
        return awayFromZero;
      }
      if (mode === 'HALF_DOWN') {
        return quotient;
      }
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
  }
}
