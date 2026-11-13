import { isAssetCode, isDecimalString } from '@mgx/shared';
import { z } from 'zod';

/**
 * Montant décimal sur le fil : toujours une **chaîne** canonique (`"12.34"`), jamais un
 * nombre JSON — un nombre JSON est un flottant IEEE 754 et perdrait de la précision.
 */
export const decimalAmountSchema = z
  .string()
  .refine(isDecimalString, { error: 'Must be a canonical decimal string, e.g. "12.34".' });

/** Code d'actif ou de devise : `USD`, `CDF`, `BTC`, `USDT`… */
export const assetCodeSchema = z
  .string()
  .refine(isAssetCode, { error: 'Must be an asset code such as "USD" or "BTC".' });

/** Montant accompagné de son actif, tel que sérialisé par `Money.toJSON()`. */
export const moneySchema = z.strictObject({
  amount: decimalAmountSchema,
  asset: assetCodeSchema,
});
export type MoneyDto = z.infer<typeof moneySchema>;

/** Horodatage ISO 8601 en UTC (`2026-01-31T12:00:00.000Z`). */
export const isoDateTimeSchema = z.iso.datetime();

/**
 * Identifiant de corrélation d'une requête (en-tête `X-Request-Id`).
 * Jeu de caractères restreint : l'identifiant est recopié dans les journaux et les réponses.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
export const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN, {
  error: 'Must be 8 to 128 characters: letters, digits, ".", "_" or "-".',
});
