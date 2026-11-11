import type { Asset } from './asset.js';
import {
  assertBigInt,
  assertValidScale,
  formatUnits,
  type FormatUnitsOptions,
  parseDecimalToUnits,
  type ParseDecimalOptions,
} from './decimal.js';
import { MoneyError } from './money-error.js';
import { divideRounded, type RoundingMode } from './rounding.js';

/** Dénominateur des points de base : 1 pb = 0,01 % = 1/10 000. */
export const BASIS_POINTS_DENOMINATOR = 10_000n;

/** Représentation d'un montant sur le fil (JSON) : le montant est toujours une chaîne. */
export interface MoneyJson {
  readonly amount: string;
  readonly asset: string;
}

/**
 * Montant exact dans un actif donné.
 *
 * La valeur est un nombre entier d'unités minimales (`bigint`) : aucune opération ne passe
 * par un nombre flottant et aucune perte de précision n'est possible. Les instances sont
 * immuables ; chaque opération retourne un nouveau montant.
 *
 * Mélanger deux actifs (additionner des USD et des CDF) lève `ASSET_MISMATCH` : une conversion
 * est toujours une opération explicite, avec un taux et un arrondi choisis par l'appelant.
 */
export class Money {
  readonly units: bigint;
  readonly asset: Asset;

  private constructor(units: bigint, asset: Asset) {
    this.units = units;
    this.asset = asset;
    Object.freeze(this);
  }

  /** Construit un montant à partir d'unités minimales (centimes, satoshis, wei…). */
  static ofUnits(units: bigint, asset: Asset): Money {
    assertBigInt(units);
    assertValidScale(asset.scale);
    return new Money(units, asset);
  }

  /** Construit un montant à partir d'une chaîne décimale exprimée en unité principale. */
  static parse(value: string, asset: Asset, options: ParseDecimalOptions = {}): Money {
    return new Money(parseDecimalToUnits(value, asset.scale, options), asset);
  }

  static zero(asset: Asset): Money {
    return Money.ofUnits(0n, asset);
  }

  /** Somme d'une liste de montants du même actif (`zero(asset)` pour une liste vide). */
  static sum(amounts: readonly Money[], asset: Asset): Money {
    return amounts.reduce((total, amount) => total.plus(amount), Money.zero(asset));
  }

  plus(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.units + other.units, this.asset);
  }

  minus(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.units - other.units, this.asset);
  }

  negated(): Money {
    return new Money(-this.units, this.asset);
  }

  absolute(): Money {
    return this.units < 0n ? this.negated() : this;
  }

  /** Multiplication exacte par un entier. */
  times(multiplier: bigint): Money {
    assertBigInt(multiplier);
    return new Money(this.units * multiplier, this.asset);
  }

  /** Multiplication par la fraction `numerator / denominator`, arrondie à l'unité minimale. */
  timesRatio(numerator: bigint, denominator: bigint, rounding: RoundingMode): Money {
    assertBigInt(numerator);
    assertBigInt(denominator);
    return new Money(divideRounded(this.units * numerator, denominator, rounding), this.asset);
  }

  /**
   * Part du montant exprimée en points de base (250 pb = 2,5 %).
   * Sert au calcul des frais et commissions ; l'arrondi est toujours explicite.
   */
  basisPoints(basisPoints: bigint, rounding: RoundingMode): Money {
    return this.timesRatio(basisPoints, BASIS_POINTS_DENOMINATOR, rounding);
  }

  /**
   * Répartit le montant proportionnellement à `weights`, sans créer ni perdre d'unité :
   * la somme des parts est toujours exactement égale au montant d'origine.
   *
   * Les unités restantes après division entière sont attribuées aux plus forts restes
   * (à égalité, dans l'ordre des poids), ce qui rend le résultat déterministe.
   */
  allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) {
      throw new MoneyError('INVALID_WEIGHTS', 'At least one weight is required.');
    }
    let totalWeight = 0n;
    for (const weight of weights) {
      assertBigInt(weight);
      if (weight < 0n) {
        throw new MoneyError('INVALID_WEIGHTS', 'Weights cannot be negative.');
      }
      totalWeight += weight;
    }
    if (totalWeight === 0n) {
      throw new MoneyError('INVALID_WEIGHTS', 'The sum of weights must be strictly positive.');
    }

    const negative = this.units < 0n;
    const magnitude = negative ? -this.units : this.units;

    const shares = weights.map((weight) => (magnitude * weight) / totalWeight);
    const remainders = weights.map((weight, index) => ({
      index,
      remainder: (magnitude * weight) % totalWeight,
    }));
    const distributed = shares.reduce((total, share) => total + share, 0n);
    const leftover = Number(magnitude - distributed); // toujours < weights.length

    remainders.sort((a, b) => {
      if (a.remainder === b.remainder) {
        return a.index - b.index;
      }
      return a.remainder > b.remainder ? -1 : 1;
    });
    for (const { index } of remainders.slice(0, leftover)) {
      shares[index] = (shares[index] ?? 0n) + 1n;
    }

    return shares.map((share) => new Money(negative ? -share : share, this.asset));
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameAsset(other);
    if (this.units === other.units) {
      return 0;
    }
    return this.units < other.units ? -1 : 1;
  }

  equals(other: Money): boolean {
    return (
      this.asset.code === other.asset.code &&
      this.asset.scale === other.asset.scale &&
      this.units === other.units
    );
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  /** Chaîne décimale canonique en unité principale (`'12.34'`). */
  toDecimalString(options: FormatUnitsOptions = {}): string {
    return formatUnits(this.units, this.asset.scale, options);
  }

  /** Sérialisation JSON : le montant est une chaîne, jamais un nombre. */
  toJSON(): MoneyJson {
    return { amount: this.toDecimalString(), asset: this.asset.code };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.asset.code}`;
  }

  private assertSameAsset(other: Money): void {
    if (this.asset.code !== other.asset.code || this.asset.scale !== other.asset.scale) {
      throw new MoneyError(
        'ASSET_MISMATCH',
        `Cannot combine ${this.asset.code} and ${other.asset.code} without an explicit conversion.`,
      );
    }
  }
}
