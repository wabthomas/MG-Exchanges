import { Money, MoneyError } from '@mgx/shared';

import { AppError } from '../../../common/errors/app-error.js';
import type { AssetRecord } from '../../ledger/application/ledger.repository.js';
import { LEDGER_AMOUNT_MAX_UNITS } from '../../ledger/domain/journal-entry.js';

/** Refus d'un champ de la requête, tel que le rend la validation des contrats. */
export function invalidField(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', 'Request validation failed.', {
    errors: [{ path, message }],
  });
}

/**
 * Montant d'une requête, dans l'unité minimale de l'actif. Le contrat garantit une chaîne
 * décimale canonique ; ce qui dépend de l'actif se vérifie ici : sa précision — rien n'est
 * arrondi — et ce que le grand livre sait tenir.
 *
 * @param path champ de la requête, nommé dans le refus.
 * @throws AppError `VALIDATION_FAILED`
 */
export function parseRequestAmount(value: string, asset: AssetRecord, path: string): Money {
  let amount: Money;
  try {
    amount = Money.parse(value, { code: asset.code, scale: asset.scale });
  } catch (error) {
    if (error instanceof MoneyError && error.code === 'PRECISION_EXCEEDED') {
      throw invalidField(
        path,
        `Must have at most ${String(asset.scale)} decimal places: the precision of ${asset.code}.`,
      );
    }
    throw error;
  }
  if (amount.units > LEDGER_AMOUNT_MAX_UNITS) {
    throw invalidField(path, 'Exceeds what the ledger can hold.');
  }
  return amount;
}
