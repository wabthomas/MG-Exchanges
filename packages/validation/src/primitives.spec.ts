import { describe, expect, it } from '@jest/globals';
import { defineAsset, Money } from '@mgx/shared';

import {
  assetCodeSchema,
  decimalAmountSchema,
  isoDateTimeSchema,
  moneySchema,
  requestIdSchema,
} from './primitives.js';

describe('decimalAmountSchema', () => {
  it.each(['0', '12.34', '-0.05', '123456789012345678.123456789012345678'])(
    'accepte %j',
    (value) => {
      expect(decimalAmountSchema.parse(value)).toBe(value);
    },
  );

  it.each([12.34, 1, '1e3', '1,5', '.5', '01', ' 1', '', null, undefined, 10n])(
    'refuse %p (un montant n’est jamais un nombre JSON)',
    (value) => {
      expect(decimalAmountSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('assetCodeSchema', () => {
  it('accepte les codes en majuscules et refuse le reste', () => {
    expect(assetCodeSchema.parse('USDT')).toBe('USDT');
    for (const value of ['usd', 'U', '', '1INCH', 42]) {
      expect(assetCodeSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('moneySchema', () => {
  it('valide exactement ce que Money sérialise', () => {
    const amount = Money.parse('1234.50', defineAsset('USD', 2));
    const wire: unknown = JSON.parse(JSON.stringify(amount));
    expect(moneySchema.parse(wire)).toEqual({ amount: '1234.50', asset: 'USD' });
  });

  it('refuse un montant numérique et les propriétés inconnues', () => {
    expect(moneySchema.safeParse({ amount: 1234.5, asset: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: '1.00', asset: 'USD', extra: true }).success).toBe(
      false,
    );
    expect(moneySchema.safeParse({ amount: '1.00' }).success).toBe(false);
  });
});

describe('isoDateTimeSchema', () => {
  it('accepte un horodatage UTC et refuse les formats ambigus', () => {
    expect(isoDateTimeSchema.parse(new Date(0).toISOString())).toBe('1970-01-01T00:00:00.000Z');
    for (const value of ['2026-01-31', '2026-01-31T12:00:00', '31/01/2026', 1_700_000_000]) {
      expect(isoDateTimeSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('requestIdSchema', () => {
  it.each(['0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d', 'req_12345678', 'a.b-c_d1'])(
    'accepte %j',
    (value) => {
      expect(requestIdSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    'short',
    'a'.repeat(129),
    'has space 123',
    'new\nline-123',
    '<script>alert(1)</script>',
    '-starts-with-dash',
    '',
  ])('refuse %j (injection dans les journaux, longueur)', (value) => {
    expect(requestIdSchema.safeParse(value).success).toBe(false);
  });
});
