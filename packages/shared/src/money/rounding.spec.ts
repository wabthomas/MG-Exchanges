import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';

import { MoneyError } from './money-error.js';
import { divideRounded, ROUNDING_MODES, type RoundingMode } from './rounding.js';

describe('divideRounded', () => {
  // Table de référence : java.math.RoundingMode (valeur × 10 divisée par 10).
  const cases: readonly [numerator: bigint, expected: Record<RoundingMode, bigint>][] = [
    [55n, { UP: 6n, DOWN: 5n, CEILING: 6n, FLOOR: 5n, HALF_UP: 6n, HALF_DOWN: 5n, HALF_EVEN: 6n }],
    [25n, { UP: 3n, DOWN: 2n, CEILING: 3n, FLOOR: 2n, HALF_UP: 3n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
    [16n, { UP: 2n, DOWN: 1n, CEILING: 2n, FLOOR: 1n, HALF_UP: 2n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
    [11n, { UP: 2n, DOWN: 1n, CEILING: 2n, FLOOR: 1n, HALF_UP: 1n, HALF_DOWN: 1n, HALF_EVEN: 1n }],
    [10n, { UP: 1n, DOWN: 1n, CEILING: 1n, FLOOR: 1n, HALF_UP: 1n, HALF_DOWN: 1n, HALF_EVEN: 1n }],
    [
      -10n,
      {
        UP: -1n,
        DOWN: -1n,
        CEILING: -1n,
        FLOOR: -1n,
        HALF_UP: -1n,
        HALF_DOWN: -1n,
        HALF_EVEN: -1n,
      },
    ],
    [
      -11n,
      {
        UP: -2n,
        DOWN: -1n,
        CEILING: -1n,
        FLOOR: -2n,
        HALF_UP: -1n,
        HALF_DOWN: -1n,
        HALF_EVEN: -1n,
      },
    ],
    [
      -16n,
      {
        UP: -2n,
        DOWN: -1n,
        CEILING: -1n,
        FLOOR: -2n,
        HALF_UP: -2n,
        HALF_DOWN: -2n,
        HALF_EVEN: -2n,
      },
    ],
    [
      -25n,
      {
        UP: -3n,
        DOWN: -2n,
        CEILING: -2n,
        FLOOR: -3n,
        HALF_UP: -3n,
        HALF_DOWN: -2n,
        HALF_EVEN: -2n,
      },
    ],
    [
      -55n,
      {
        UP: -6n,
        DOWN: -5n,
        CEILING: -5n,
        FLOOR: -6n,
        HALF_UP: -6n,
        HALF_DOWN: -5n,
        HALF_EVEN: -6n,
      },
    ],
  ];

  it.each(cases)('arrondit %s / 10 comme java.math.RoundingMode', (numerator, expected) => {
    for (const mode of ROUNDING_MODES) {
      expect({ mode, result: divideRounded(numerator, 10n, mode) }).toEqual({
        mode,
        result: expected[mode],
      });
    }
  });

  it('retourne le quotient exact, quel que soit le mode, lorsque la division tombe juste', () => {
    for (const mode of ROUNDING_MODES) {
      expect(divideRounded(-120n, 40n, mode)).toBe(-3n);
    }
  });

  it('refuse la division par zéro', () => {
    expect(() => divideRounded(1n, 0n, 'DOWN')).toThrow(MoneyError);
    expect(() => divideRounded(1n, 0n, 'DOWN')).toThrow(
      expect.objectContaining({ code: 'DIVISION_BY_ZERO' }),
    );
  });

  describe('propriétés', () => {
    const numerator = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n });
    const denominator = fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }).filter((d) => d !== 0n);
    const mode = fc.constantFrom(...ROUNDING_MODES);

    it('ne s’écarte jamais de plus d’une unité du quotient exact', () => {
      fc.assert(
        fc.property(numerator, denominator, mode, (n, d, m) => {
          const result = divideRounded(n, d, m);
          const absD = d < 0n ? -d : d;
          const error = n * (d < 0n ? -1n : 1n) - result * absD;
          expect(error > -absD && error < absD).toBe(true);
        }),
      );
    });

    it('est insensible au signe du dénominateur : n/d === (−n)/(−d)', () => {
      fc.assert(
        fc.property(numerator, denominator, mode, (n, d, m) => {
          expect(divideRounded(n, d, m)).toBe(divideRounded(-n, -d, m));
        }),
      );
    });

    it('encadre le résultat : FLOOR ≤ tout mode ≤ CEILING, et |DOWN| ≤ |tout mode| ≤ |UP|', () => {
      fc.assert(
        fc.property(numerator, denominator, mode, (n, d, m) => {
          const abs = (value: bigint): bigint => (value < 0n ? -value : value);
          const result = divideRounded(n, d, m);
          expect(result >= divideRounded(n, d, 'FLOOR')).toBe(true);
          expect(result <= divideRounded(n, d, 'CEILING')).toBe(true);
          expect(abs(result) >= abs(divideRounded(n, d, 'DOWN'))).toBe(true);
          expect(abs(result) <= abs(divideRounded(n, d, 'UP'))).toBe(true);
        }),
      );
    });

    it('les modes « au plus proche » minimisent l’erreur (≤ une demi-unité)', () => {
      fc.assert(
        fc.property(
          numerator,
          denominator,
          fc.constantFrom<RoundingMode>('HALF_UP', 'HALF_DOWN', 'HALF_EVEN'),
          (n, d, m) => {
            const result = divideRounded(n, d, m);
            const absD = d < 0n ? -d : d;
            const signedN = d < 0n ? -n : n;
            const error = signedN - result * absD;
            expect((error < 0n ? -error : error) * 2n <= absD).toBe(true);
          },
        ),
      );
    });

    it('HALF_EVEN arrondit les égalités parfaites vers un entier pair', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (k) => {
          // (2k + 1) / 2 est exactement à mi-chemin entre k et k + 1.
          expect(divideRounded(2n * k + 1n, 2n, 'HALF_EVEN') % 2n).toBe(0n);
        }),
      );
    });
  });
});
