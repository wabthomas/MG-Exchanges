import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';

import { defineAsset, isAssetCode } from './asset.js';
import { Money } from './money.js';
import { MoneyError } from './money-error.js';
import { ROUNDING_MODES } from './rounding.js';

const USD = defineAsset('USD', 2);
const CDF = defineAsset('CDF', 2);
const BTC = defineAsset('BTC', 8);
const ETH = defineAsset('ETH', 18);

const errorCode = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof MoneyError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
};

describe('defineAsset', () => {
  it('construit un actif immuable', () => {
    expect(USD).toEqual({ code: 'USD', scale: 2 });
    expect(Object.isFrozen(USD)).toBe(true);
  });

  it.each(['usd', 'U', '1BTC', 'TOO_LONG_CODE', 'US D', '', 'ABCDEFGHIJKLM'])(
    'refuse le code %j',
    (code) => {
      expect(errorCode(() => defineAsset(code, 2))).toBe('INVALID_ASSET');
      expect(isAssetCode(code)).toBe(false);
    },
  );

  it('refuse un nombre de décimales invalide', () => {
    expect(errorCode(() => defineAsset('USD', -1))).toBe('INVALID_SCALE');
    expect(errorCode(() => defineAsset('USD', 2.5))).toBe('INVALID_SCALE');
  });
});

describe('Money', () => {
  describe('construction', () => {
    it('se construit depuis des unités minimales ou une chaîne décimale', () => {
      expect(Money.ofUnits(1234n, USD).units).toBe(1234n);
      expect(Money.parse('12.34', USD).units).toBe(1234n);
      expect(Money.parse('0.00000001', BTC).units).toBe(1n);
      expect(Money.zero(ETH).isZero()).toBe(true);
    });

    it('refuse un nombre flottant à la place d’un bigint', () => {
      expect(errorCode(() => Money.ofUnits(12.34 as unknown as bigint, USD))).toBe('NOT_A_BIGINT');
      expect(errorCode(() => Money.ofUnits(1234 as unknown as bigint, USD))).toBe('NOT_A_BIGINT');
      expect(errorCode(() => Money.parse(12.34 as unknown as string, USD))).toBe('INVALID_DECIMAL');
    });

    it('refuse un actif dont la précision est invalide', () => {
      expect(errorCode(() => Money.ofUnits(1n, { code: 'USD', scale: 99 }))).toBe('INVALID_SCALE');
    });

    it('est immuable', () => {
      const amount = Money.parse('1.00', USD);
      expect(Object.isFrozen(amount)).toBe(true);
      expect(() => {
        (amount as unknown as { units: bigint }).units = 5n;
      }).toThrow(TypeError);
    });
  });

  describe('arithmétique exacte', () => {
    it('additionne sans l’erreur classique des flottants (0.1 + 0.2)', () => {
      const sum = Money.parse('0.10', USD).plus(Money.parse('0.20', USD));
      expect(sum.toDecimalString()).toBe('0.30');
      expect(sum.equals(Money.parse('0.30', USD))).toBe(true);
    });

    it('conserve la précision au-delà de Number.MAX_SAFE_INTEGER', () => {
      const big = Money.parse('123456789012345678.123456789012345678', ETH);
      const one = Money.ofUnits(1n, ETH);
      expect(big.plus(one).toDecimalString()).toBe('123456789012345678.123456789012345679');
      expect(big.plus(one).minus(one).equals(big)).toBe(true);
    });

    it('soustrait, oppose, prend la valeur absolue et multiplie par un entier', () => {
      const amount = Money.parse('10.00', USD);
      expect(amount.minus(Money.parse('12.50', USD)).toDecimalString()).toBe('-2.50');
      expect(amount.negated().toDecimalString()).toBe('-10.00');
      expect(amount.negated().absolute().equals(amount)).toBe(true);
      expect(amount.absolute()).toBe(amount);
      expect(amount.times(3n).toDecimalString()).toBe('30.00');
      expect(errorCode(() => amount.times(1.5 as unknown as bigint))).toBe('NOT_A_BIGINT');
    });

    it('refuse de mélanger deux actifs', () => {
      const usd = Money.parse('1.00', USD);
      const cdf = Money.parse('1.00', CDF);
      expect(errorCode(() => usd.plus(cdf))).toBe('ASSET_MISMATCH');
      expect(errorCode(() => usd.minus(cdf))).toBe('ASSET_MISMATCH');
      expect(errorCode(() => usd.compareTo(cdf))).toBe('ASSET_MISMATCH');
      expect(usd.equals(cdf)).toBe(false);
      // Même code mais précision différente : toujours refusé.
      expect(errorCode(() => usd.plus(Money.ofUnits(100n, { code: 'USD', scale: 4 })))).toBe(
        'ASSET_MISMATCH',
      );
    });

    it('somme une liste de montants', () => {
      const amounts = ['0.10', '0.20', '0.30'].map((value) => Money.parse(value, USD));
      expect(Money.sum(amounts, USD).toDecimalString()).toBe('0.60');
      expect(Money.sum([], USD).isZero()).toBe(true);
      expect(errorCode(() => Money.sum([Money.zero(CDF)], USD))).toBe('ASSET_MISMATCH');
    });
  });

  describe('frais et ratios', () => {
    it('calcule une part en points de base avec un arrondi explicite', () => {
      const amount = Money.parse('100.00', USD);
      expect(amount.basisPoints(250n, 'HALF_EVEN').toDecimalString()).toBe('2.50');
      // 0,15 % de 0,33 USD = 0,000495 USD
      const small = Money.parse('0.33', USD);
      expect(small.basisPoints(15n, 'DOWN').toDecimalString()).toBe('0.00');
      expect(small.basisPoints(15n, 'UP').toDecimalString()).toBe('0.01');
      // 1,25 % de 2 USD = 0,025 USD : égalité parfaite.
      const tie = Money.parse('2.00', USD);
      expect(tie.basisPoints(125n, 'HALF_UP').toDecimalString()).toBe('0.03');
      expect(tie.basisPoints(125n, 'HALF_EVEN').toDecimalString()).toBe('0.02');
    });

    it('multiplie par une fraction', () => {
      const amount = Money.parse('10.00', USD);
      expect(amount.timesRatio(1n, 3n, 'DOWN').toDecimalString()).toBe('3.33');
      expect(amount.timesRatio(1n, 3n, 'UP').toDecimalString()).toBe('3.34');
      expect(errorCode(() => amount.timesRatio(1n, 0n, 'DOWN'))).toBe('DIVISION_BY_ZERO');
      expect(errorCode(() => amount.timesRatio(0.5 as unknown as bigint, 1n, 'DOWN'))).toBe(
        'NOT_A_BIGINT',
      );
    });
  });

  describe('répartition', () => {
    it('répartit sans créer ni perdre de centime', () => {
      const parts = Money.parse('100.00', USD).allocate([1n, 1n, 1n]);
      expect(parts.map((part) => part.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
      expect(Money.sum(parts, USD).toDecimalString()).toBe('100.00');
    });

    it('attribue les unités restantes aux plus forts restes', () => {
      const parts = Money.ofUnits(10n, USD).allocate([1n, 2n, 4n]);
      // parts exactes : 1,43 / 2,86 / 5,71 → planchers 1 / 2 / 5, reste 2 → restes 0,86 puis 0,71
      expect(parts.map((part) => part.units)).toEqual([1n, 3n, 6n]);
    });

    it('ne donne jamais rien à un poids nul', () => {
      const parts = Money.ofUnits(5n, USD).allocate([0n, 3n, 0n, 3n]);
      expect(parts.map((part) => part.units)).toEqual([0n, 3n, 0n, 2n]);
    });

    it('répartit un montant négatif symétriquement', () => {
      const parts = Money.ofUnits(-100n, USD).allocate([1n, 1n, 1n]);
      expect(parts.map((part) => part.units)).toEqual([-34n, -33n, -33n]);
    });

    it('refuse des poids invalides', () => {
      const amount = Money.parse('1.00', USD);
      expect(errorCode(() => amount.allocate([]))).toBe('INVALID_WEIGHTS');
      expect(errorCode(() => amount.allocate([0n, 0n]))).toBe('INVALID_WEIGHTS');
      expect(errorCode(() => amount.allocate([1n, -1n]))).toBe('INVALID_WEIGHTS');
      expect(errorCode(() => amount.allocate([0.5 as unknown as bigint]))).toBe('NOT_A_BIGINT');
    });
  });

  describe('comparaison', () => {
    it('compare deux montants du même actif', () => {
      const one = Money.parse('1.00', USD);
      const two = Money.parse('2.00', USD);
      expect(one.compareTo(two)).toBe(-1);
      expect(two.compareTo(one)).toBe(1);
      expect(one.compareTo(Money.ofUnits(100n, USD))).toBe(0);
      expect(one.isPositive()).toBe(true);
      expect(one.negated().isNegative()).toBe(true);
      expect(one.isZero()).toBe(false);
    });
  });

  describe('sérialisation', () => {
    it('sérialise le montant en chaîne, jamais en nombre', () => {
      const amount = Money.parse('1234.50', USD);
      expect(amount.toJSON()).toEqual({ amount: '1234.50', asset: 'USD' });
      expect(JSON.stringify({ balance: amount })).toBe(
        '{"balance":{"amount":"1234.50","asset":"USD"}}',
      );
      expect(amount.toString()).toBe('1234.50 USD');
      expect(amount.toDecimalString({ trimTrailingZeros: true })).toBe('1234.5');
    });
  });

  describe('propriétés', () => {
    const units = fc.bigInt({ min: -(10n ** 36n), max: 10n ** 36n });
    const money = units.map((value) => Money.ofUnits(value, ETH));

    it('l’addition est commutative et associative, et la soustraction en est l’inverse', () => {
      fc.assert(
        fc.property(money, money, money, (a, b, c) => {
          expect(a.plus(b).equals(b.plus(a))).toBe(true);
          expect(
            a
              .plus(b)
              .plus(c)
              .equals(a.plus(b.plus(c))),
          ).toBe(true);
          expect(a.plus(b).minus(b).equals(a)).toBe(true);
          expect(a.plus(a.negated()).isZero()).toBe(true);
        }),
      );
    });

    it('la sérialisation décimale est sans perte', () => {
      fc.assert(
        fc.property(money, (a) => {
          expect(Money.parse(a.toDecimalString(), ETH).equals(a)).toBe(true);
          expect(Money.parse(a.toJSON().amount, ETH).equals(a)).toBe(true);
        }),
      );
    });

    it('une répartition conserve toujours exactement le total', () => {
      fc.assert(
        fc.property(
          units,
          fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 12 }),
          (value, weights) => {
            fc.pre(weights.some((weight) => weight > 0n));
            const amount = Money.ofUnits(value, ETH);
            const parts = amount.allocate(weights);

            expect(parts).toHaveLength(weights.length);
            expect(Money.sum(parts, ETH).equals(amount)).toBe(true);

            const totalWeight = weights.reduce((total, weight) => total + weight, 0n);
            const magnitude = value < 0n ? -value : value;
            parts.forEach((part, index) => {
              const weight = weights[index] ?? 0n;
              const exactFloor = (magnitude * weight) / totalWeight;
              const share = part.units < 0n ? -part.units : part.units;
              // Chaque part vaut le plancher de la part exacte, ou une unité de plus.
              expect(share === exactFloor || share === exactFloor + 1n).toBe(true);
              if (weight === 0n) {
                expect(part.isZero()).toBe(true);
              }
              // Aucune part n'est de signe opposé au total.
              expect(value < 0n ? part.units <= 0n : part.units >= 0n).toBe(true);
            });
          },
        ),
      );
    });

    it('un frais en points de base ne dépasse jamais le montant et s’écarte de moins d’une unité', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 36n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.constantFrom(...ROUNDING_MODES),
          (value, basisPoints, rounding) => {
            const amount = Money.ofUnits(value, ETH);
            const fee = amount.basisPoints(basisPoints, rounding);
            expect(fee.units >= 0n && fee.units <= amount.units).toBe(true);
            const difference = fee.units * 10_000n - value * basisPoints;
            expect(difference > -10_000n && difference < 10_000n).toBe(true);
          },
        ),
      );
    });
  });
});
