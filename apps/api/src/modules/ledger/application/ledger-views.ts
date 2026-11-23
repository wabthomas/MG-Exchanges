import { LEDGER_ACCOUNT_TYPES, type AssetView, type LedgerAccountOwner } from '@mgx/contracts';
import { Money } from '@mgx/shared';

import { AppError } from '../../../common/errors/app-error.js';
import type { AccountRecord, AssetRecord } from './ledger.repository.js';

export function assetViewOf(asset: AssetRecord): AssetView {
  return { code: asset.code, name: asset.name, kind: asset.kind, scale: asset.scale };
}

/** Montant en chaîne décimale, avec exactement le nombre de décimales de l'actif. */
export function amountText(units: bigint, asset: AssetRecord): string {
  return Money.ofUnits(units, { code: asset.code, scale: asset.scale }).toDecimalString();
}

/** À qui appartient un compte : son titulaire, ou la plateforme. */
export function ownerOf(account: Pick<AccountRecord, 'type'>): LedgerAccountOwner {
  return LEDGER_ACCOUNT_TYPES[account.type].owner;
}

/** Curseur opaque : la valeur du dernier élément de la page, encodée. */
export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Valeur d'un curseur rendu par une page précédente.
 *
 * @throws AppError `VALIDATION_FAILED` si le curseur n'a pas la forme attendue.
 */
export function decodeCursor(cursor: string, pattern: RegExp): string {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!pattern.test(value)) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      errors: [{ path: 'after', message: 'Must be a cursor returned by a previous page.' }],
    });
  }
  return value;
}

/** Rang d'une ligne sur son compte : un entier strictement positif, sur 64 bits au plus. */
export const SEQUENCE_CURSOR_PATTERN = /^[1-9][0-9]{0,17}$/;

/** Identifiant d'un compte. */
export const ACCOUNT_CURSOR_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
