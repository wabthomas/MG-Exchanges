import { assertValidScale } from './decimal.js';
import { MoneyError } from './money-error.js';

/**
 * Actif ou devise dans lequel un montant est exprimé.
 *
 * `scale` est le nombre de décimales de l'unité minimale : 2 pour USD et CDF (centimes),
 * 8 pour BTC (satoshi), 6 pour USDT/USDC, 18 pour ETH (wei). La liste des actifs proposés
 * par la plateforme vit en base de données (phase 3) ; ce type n'en fixe que la forme.
 */
export interface Asset {
  readonly code: string;
  readonly scale: number;
}

const ASSET_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;

export function isAssetCode(value: unknown): value is string {
  return typeof value === 'string' && ASSET_CODE_PATTERN.test(value);
}

/** Construit un {@link Asset} validé et immuable. */
export function defineAsset(code: string, scale: number): Asset {
  if (!isAssetCode(code)) {
    throw new MoneyError(
      'INVALID_ASSET',
      'Invalid asset code: 2 to 12 uppercase letters or digits, starting with a letter.',
    );
  }
  assertValidScale(scale);
  return Object.freeze({ code, scale });
}
