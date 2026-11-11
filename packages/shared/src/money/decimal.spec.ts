import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';

import {
  formatUnits,
  isDecimalString,
  MAX_DECIMAL_LENGTH,
  MAX_SCALE,
  parseDecimalToUnits,
  pow10,
} from './decimal.js';
import { MoneyError } from './money-error.js';
import { ROUNDING_MODES } from './rounding.js';

const errorCode = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof MoneyError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
};

describe('parseDecimalToUnits', () => {
  it.each([
    ['0', 2, 0n],
    ['12.34', 2, 1234n],
    ['12.3', 2, 1230n],
    ['12', 2, 1200n],
    ['-0.05', 2, -5n],
    ['-0', 2, 0n],
    ['0.00000001', 8, 1n],
    ['21000000', 8, 2_100_000_000_000_000n],
    ['1.000000000000000001', 18, 1_000_000_000_000_000_001n],
    [
      '123456789012345678901234567890.123456789012345678',
      18,
      123456789012345678901234567890123456789012345678n,
    ],
    ['7', 0, 7n],
  ] as const)('analyse %s avec %i décimales', (value, scale, expected) => {
    expect(parseDecimalToUnits(value, scale)).toBe(expected);
  });

  it('accepte des zéros non significatifs au-delà de la précision', () => {
    expect(parseDecimalToUnits('1.5000', 2)).toBe(150n);
    expect(parseDecimalToUnits('3.0', 0)).toBe(3n);
  });

  it('refuse toute précision excédentaire significative lorsqu’aucun arrondi n’est demandé', () => {
    expect(errorCode(() => parseDecimalToUnits('1.005', 2))).toBe('PRECISION_EXCEEDED');
    expect(errorCode(() => parseDecimalToUnits('0.1', 0))).toBe('PRECISION_EXCEEDED');
  });

  it('arrondit explicitement lorsque le mode est fourni', () => {
    expect(parseDecimalToUnits('1.005', 2, { rounding: 'HALF_UP' })).toBe(101n);
    expect(parseDecimalToUnits('1.005', 2, { rounding: 'HALF_EVEN' })).toBe(100n);
    expect(parseDecimalToUnits('1.015', 2, { rounding: 'HALF_EVEN' })).toBe(102n);
    expect(parseDecimalToUnits('1.009', 2, { rounding: 'DOWN' })).toBe(100n);
    expect(parseDecimalToUnits('-1.001', 2, { rounding: 'UP' })).toBe(-101n);
    expect(parseDecimalToUnits('-1.001', 2, { rounding: 'CEILING' })).toBe(-100n);
    expect(parseDecimalToUnits('-0.004', 2, { rounding: 'HALF_UP' })).toBe(0n);
  });

  it.each([
    '',
    ' ',
    '1,5',
    '1.',
    '.5',
    '+1',
    '01',
    '00.1',
    '1e3',
    '1E-2',
    '0x10',
    '1_000',
    '1 000',
    ' 1',
    '1 ',
    '--1',
    '1.2.3',
    'NaN',
    'Infinity',
    '١٢٣',
    '1.5\n',
  ])('refuse le format non canonique %j', (value) => {
    expect(errorCode(() => parseDecimalToUnits(value, 2))).toBe('INVALID_DECIMAL');
    expect(isDecimalString(value)).toBe(false);
  });

  it('refuse un nombre flottant, même transmis par un appelant non typé', () => {
    expect(errorCode(() => parseDecimalToUnits(0.1 as unknown as string, 2))).toBe(
      'INVALID_DECIMAL',
    );
    expect(errorCode(() => parseDecimalToUnits(null as unknown as string, 2))).toBe(
      'INVALID_DECIMAL',
    );
    expect(isDecimalString(0.1)).toBe(false);
  });

  it('refuse les chaînes démesurées', () => {
    const tooLong = '1'.repeat(MAX_DECIMAL_LENGTH + 1);
    expect(errorCode(() => parseDecimalToUnits(tooLong, 2))).toBe('INVALID_DECIMAL');
    expect(isDecimalString(tooLong)).toBe(false);
    expect(parseDecimalToUnits('1'.repeat(MAX_DECIMAL_LENGTH), 0)).toBe(
      BigInt('1'.repeat(MAX_DECIMAL_LENGTH)),
    );
  });

  it.each([-1, 1.5, MAX_SCALE + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuse un nombre de décimales invalide (%p)',
    (scale) => {
      expect(errorCode(() => parseDecimalToUnits('1', scale))).toBe('INVALID_SCALE');
      expect(errorCode(() => formatUnits(1n, scale))).toBe('INVALID_SCALE');
      expect(errorCode(() => pow10(scale))).toBe('INVALID_SCALE');
    },
  );

  it('ne divulgue jamais la valeur fournie dans le message d’erreur', () => {
    const secretLooking = '4111111111111111.x';
    try {
      parseDecimalToUnits(secretLooking, 2);
      throw new Error('une erreur était attendue');
    } catch (error) {
      expect((error as Error).message).not.toContain('4111');
    }
  });
});

describe('formatUnits', () => {
  it.each([
    [0n, 2, '0.00'],
    [1234n, 2, '12.34'],
    [-5n, 2, '-0.05'],
    [5n, 0, '5'],
    [1n, 8, '0.00000001'],
    [-1_000_000_000_000_000_001n, 18, '-1.000000000000000001'],
  ] as const)('formate %s avec %i décimales', (units, scale, expected) => {
    expect(formatUnits(units, scale)).toBe(expected);
  });

  it('supprime les zéros de fin sur demande', () => {
    expect(formatUnits(150n, 2, { trimTrailingZeros: true })).toBe('1.5');
    expect(formatUnits(200n, 2, { trimTrailingZeros: true })).toBe('2');
    expect(formatUnits(0n, 8, { trimTrailingZeros: true })).toBe('0');
    expect(formatUnits(-10n, 2, { trimTrailingZeros: true })).toBe('-0.1');
  });

  it('refuse un nombre flottant à la place d’un bigint', () => {
    expect(errorCode(() => formatUnits(12.5 as unknown as bigint, 2))).toBe('NOT_A_BIGINT');
  });
});

describe('pow10', () => {
  it('calcule des puissances exactes', () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(18)).toBe(1_000_000_000_000_000_000n);
    expect(pow10(MAX_SCALE).toString()).toBe(`1${'0'.repeat(MAX_SCALE)}`);
  });
});

describe('propriétés analyse ↔ formatage', () => {
  const scale = fc.integer({ min: 0, max: MAX_SCALE });
  const units = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n });

  it('formatUnits puis parseDecimalToUnits restitue exactement les unités (aucune perte)', () => {
    fc.assert(
      fc.property(units, scale, (u, s) => {
        expect(parseDecimalToUnits(formatUnits(u, s), s)).toBe(u);
        expect(parseDecimalToUnits(formatUnits(u, s, { trimTrailingZeros: true }), s)).toBe(u);
      }),
    );
  });

  it('formatUnits produit toujours une chaîne canonique', () => {
    fc.assert(
      fc.property(units, scale, (u, s) => {
        expect(isDecimalString(formatUnits(u, s))).toBe(true);
      }),
    );
  });

  it('un arrondi à l’analyse ne s’écarte jamais de plus d’une unité minimale', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        fc.constantFrom(...ROUNDING_MODES),
        (u, targetScale, extraDigits, rounding) => {
          const precise = formatUnits(u, targetScale + extraDigits);
          const rounded = parseDecimalToUnits(precise, targetScale, { rounding });
          const difference = rounded * pow10(extraDigits) - u;
          const bound = pow10(extraDigits);
          expect(difference > -bound && difference < bound).toBe(true);
        },
      ),
    );
  });
});
