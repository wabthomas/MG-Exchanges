import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../../common/errors/app-error.js';
import {
  ACCOUNT_CURSOR_PATTERN,
  amountText,
  assetViewOf,
  decodeCursor,
  encodeCursor,
  ownerOf,
  SEQUENCE_CURSOR_PATTERN,
} from './ledger-views.js';
import type { AssetRecord } from './ledger.repository.js';

const asset = (code: string, scale: number): AssetRecord => ({
  code,
  name: `Asset ${code}`,
  kind: scale > 2 ? 'CRYPTO' : 'FIAT',
  scale,
  registeredBy: null,
  registeredAt: new Date('2026-11-13T10:00:00Z'),
});

describe('vues du grand livre', () => {
  it('un montant s’écrit avec exactement le nombre de décimales de son actif', () => {
    expect(amountText(0n, asset('USD', 2))).toBe('0.00');
    expect(amountText(5n, asset('USD', 2))).toBe('0.05');
    expect(amountText(123_456n, asset('USD', 2))).toBe('1234.56');
    expect(amountText(1500n, asset('XAF', 0))).toBe('1500');
    expect(amountText(0n, asset('XAF', 0))).toBe('0');
    expect(amountText(12_345n, asset('BTC', 8))).toBe('0.00012345');
    expect(amountText(10n ** 18n, asset('ETH', 18))).toBe('1.000000000000000000');
    // Sans passer par un nombre flottant : exact jusqu'au dernier chiffre.
    expect(amountText(10n ** 38n - 1n, asset('USD', 2))).toBe(
      '999999999999999999999999999999999999.99',
    );
  });

  it('la vue d’un actif ne dit ni qui l’a enregistré, ni quand', () => {
    expect(assetViewOf(asset('BTC', 8))).toEqual({
      code: 'BTC',
      name: 'Asset BTC',
      kind: 'CRYPTO',
      scale: 8,
    });
  });

  it('le propriétaire d’un compte se déduit de son type', () => {
    expect(ownerOf({ type: 'user_available' })).toBe('USER');
    expect(ownerOf({ type: 'platform_custody' })).toBe('PLATFORM');
    expect(ownerOf({ type: 'platform_fees' })).toBe('PLATFORM');
  });
});

describe('curseurs de pagination', () => {
  const ACCOUNT = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  it('un curseur rend la valeur qu’on y a mise, sous une forme sûre dans une URL', () => {
    for (const value of ['1', '42', '999999999999999999', ACCOUNT]) {
      const cursor = encodeCursor(value);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor, /^.*$/)).toBe(value);
    }
    expect(encodeCursor('42')).toBe('NDI');
    expect(decodeCursor('NDI', SEQUENCE_CURSOR_PATTERN)).toBe('42');
    expect(decodeCursor(encodeCursor(ACCOUNT), ACCOUNT_CURSOR_PATTERN)).toBe(ACCOUNT);
  });

  const refused = (cursor: string, pattern: RegExp): unknown => {
    try {
      decodeCursor(cursor, pattern);
    } catch (error) {
      return error;
    }
    return null;
  };

  it('un rang : un entier strictement positif, sur dix-huit chiffres au plus', () => {
    for (const value of [
      '0',
      '-1',
      '01',
      '1.5',
      '1e3',
      ' 1',
      '1 ',
      '1\n',
      '',
      'abc',
      '1'.repeat(19),
    ]) {
      const error = refused(encodeCursor(value), SEQUENCE_CURSOR_PATTERN);
      expect({ value, error }).toEqual({ value, error: expect.any(AppError) });
      expect(error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        errors: [{ path: 'after', message: 'Must be a cursor returned by a previous page.' }],
      });
    }
    expect(refused(encodeCursor('9'.repeat(18)), SEQUENCE_CURSOR_PATTERN)).toBeNull();
    // Dix-huit chiffres tiennent toujours dans un entier de 64 bits.
    expect(BigInt('9'.repeat(18))).toBeLessThan(2n ** 63n);
  });

  it('un identifiant de compte : un UUID en minuscules, et rien d’autre', () => {
    for (const value of [
      ACCOUNT.toUpperCase(),
      ACCOUNT.slice(1),
      `${ACCOUNT}0`,
      `${ACCOUNT}\n`,
      ` ${ACCOUNT}`,
      ACCOUNT.replaceAll('-', ''),
      `${ACCOUNT}' OR '1'='1`,
      '42',
      '',
    ]) {
      expect({ value, error: refused(encodeCursor(value), ACCOUNT_CURSOR_PATTERN) }).toEqual({
        value,
        error: expect.any(AppError),
      });
    }
    // Un curseur d'une autre liste n'est pas accepté ici, ni l'inverse.
    expect(refused(encodeCursor('42'), ACCOUNT_CURSOR_PATTERN)).toBeInstanceOf(AppError);
    expect(refused(encodeCursor(ACCOUNT), SEQUENCE_CURSOR_PATTERN)).toBeInstanceOf(AppError);
  });
});
