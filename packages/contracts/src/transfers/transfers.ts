import {
  assetCodeSchema,
  decimalAmountSchema,
  emailSchema,
  isoDateTimeSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

import {
  AT_MOST_ONE_SECOND_FACTOR,
  atMostOneSecondFactor,
  holderProofShape,
} from '../identity/account-lifecycle.js';
import { adminActionReasonSchema } from '../identity/admin-users.js';
import { kycVerifiedLevelSchema } from '../identity/kyc-levels.js';
import { assetSchema, ledgerCursorSchema, ledgerPageLimitSchema } from '../ledger/ledger.js';

// --- Clé d'idempotence --------------------------------------------------------------------------

/**
 * En-tête exigé sur toute route qui déplace des fonds. Le client y place une valeur qu'il
 * choisit — un UUID convient — et **la même** s'il renvoie la requête : l'opération n'est alors
 * exécutée qu'une fois, et la réponse d'origine est rendue.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * En-tête de réponse, de valeur `true`, lorsque l'opération avait déjà été exécutée sous cette
 * clé : rien n'a été refait, et la réponse est celle de l'exécution d'origine.
 */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Clé d'idempotence fournie par le client : 16 à 128 caractères — lettres, chiffres, `.`, `_`,
 * `:`, `-` — dont le premier est une lettre ou un chiffre. Elle n'a de sens que pour le compte
 * qui la présente : deux comptes peuvent employer la même.
 */
export const CLIENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export const clientIdempotencyKeySchema = z.string().regex(CLIENT_IDEMPOTENCY_KEY_PATTERN, {
  error: 'Must be 16 to 128 characters: letters, digits, ".", "_", ":" or "-".',
});

// --- Montants -----------------------------------------------------------------------------------

/** Montant strictement positif, en chaîne décimale. */
export const positiveAmountSchema = decimalAmountSchema.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  { error: 'Must be greater than zero.' },
);

/** Montant positif ou nul, en chaîne décimale. */
export const nonNegativeAmountSchema = decimalAmountSchema.refine(
  (value) => !value.startsWith('-'),
  { error: 'Must not be negative.' },
);

// --- Transfert entre deux titulaires ------------------------------------------------------------

/** Type des écritures que produit un transfert entre deux titulaires. */
export const INTERNAL_TRANSFER_ENTRY_KIND = 'transfer.internal';

/**
 * Transfert de fonds à un autre titulaire, désigné par son adresse e-mail. **Immédiat et
 * définitif.** Exige la preuve du titulaire : son mot de passe et — si la validation en deux
 * étapes est activée sur le compte — `code` ou `recoveryCode`.
 *
 * `amount` est une chaîne décimale, avec au plus le nombre de décimales de l'actif.
 */
export const createTransferRequestSchema = z
  .strictObject({
    recipientEmail: emailSchema,
    assetCode: assetCodeSchema,
    amount: positiveAmountSchema,
    ...holderProofShape,
  })
  .refine(atMostOneSecondFactor, AT_MOST_ONE_SECOND_FACTOR);
export type CreateTransferRequest = z.infer<typeof createTransferRequestSchema>;

/** Sens d'un transfert, vu du compte qui le consulte. */
export const TRANSFER_DIRECTIONS = ['SENT', 'RECEIVED'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

/**
 * Transfert, vu d'une de ses deux parties. `counterparty.email` est l'adresse que porte
 * aujourd'hui le compte de l'autre partie ; `null` si ce compte a été clôturé depuis.
 * `entryId` est l'écriture du grand livre : les mouvements de portefeuille qui la partagent
 * appartiennent à ce transfert.
 */
export const transferSchema = z.object({
  id: uuidSchema,
  direction: z.enum(TRANSFER_DIRECTIONS),
  asset: assetSchema,
  amount: decimalAmountSchema,
  counterparty: z.object({ email: z.string().nullable() }),
  entryId: uuidSchema,
  createdAt: isoDateTimeSchema,
});
export type Transfer = z.infer<typeof transferSchema>;

export const transferListQuerySchema = z.strictObject({
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type TransferListQuery = z.infer<typeof transferListQuerySchema>;

/** Transferts envoyés et reçus, du plus récent au plus ancien. */
export const transferListSchema = z.object({
  transfers: z.array(transferSchema),
  nextCursor: z.string().nullable(),
});
export type TransferList = z.infer<typeof transferListSchema>;

// --- Plafonds -----------------------------------------------------------------------------------

/** Durée, en heures, de la fenêtre glissante du plafond journalier. */
export const TRANSFER_LIMIT_DAILY_WINDOW_HOURS = 24;

/**
 * Durée, en jours, de la fenêtre glissante du plafond mensuel. Trente et un jours : aucun mois
 * civil, dans quelque fuseau horaire que ce soit, ne peut alors dépasser le plafond.
 */
export const TRANSFER_LIMIT_MONTHLY_WINDOW_DAYS = 31;

/**
 * Plafonds d'envoi d'un niveau de vérification dans un actif : par transfert, sur 24 heures
 * glissantes, sur 31 jours glissants. Chaînes décimales, au nombre de décimales de l'actif.
 */
export const transferLimitAmountsSchema = z.object({
  perTransfer: decimalAmountSchema,
  daily: decimalAmountSchema,
  monthly: decimalAmountSchema,
});
export type TransferLimitAmounts = z.infer<typeof transferLimitAmountsSchema>;

/**
 * Ce que le titulaire peut envoyer dans un actif.
 *
 * `limit` vaut `null` tant qu'aucun plafond n'est fixé pour son niveau de vérification dans cet
 * actif : il n'y envoie ni n'y reçoit rien — de même si le plafond par transfert est nul.
 * `remaining` est le plus grand montant que les plafonds admettent à cet instant, sans tenir
 * compte du solde du portefeuille.
 */
export const transferAllowanceSchema = z.object({
  asset: assetSchema,
  limit: transferLimitAmountsSchema.nullable(),
  used: z.object({ last24Hours: decimalAmountSchema, last31Days: decimalAmountSchema }),
  remaining: decimalAmountSchema,
});
export type TransferAllowance = z.infer<typeof transferAllowanceSchema>;

/**
 * Plafonds du titulaire, un par actif tenu par la plateforme, dans l'ordre des codes.
 * `enabled` dit si les transferts entre titulaires sont ouverts ; `level` est son niveau de
 * vérification, celui dont les plafonds s'appliquent.
 */
export const transferAllowanceListSchema = z.object({
  enabled: z.boolean(),
  level: kycVerifiedLevelSchema,
  allowances: z.array(transferAllowanceSchema),
});
export type TransferAllowanceList = z.infer<typeof transferAllowanceListSchema>;

// --- Back-office : plafonds ---------------------------------------------------------------------

/** Plafonds d'envoi d'un niveau de vérification dans un actif, tels que le back-office les fixe. */
export const adminTransferLimitSchema = transferLimitAmountsSchema.extend({
  asset: assetSchema,
  level: kycVerifiedLevelSchema,
  /** `null` : fixé hors de l'API, avec le rôle propriétaire de la base. */
  setBy: uuidSchema.nullable(),
  setAt: isoDateTimeSchema,
});
export type AdminTransferLimit = z.infer<typeof adminTransferLimitSchema>;

/** Plafonds fixés, dans l'ordre des actifs puis des niveaux. Un couple absent n'en a pas. */
export const adminTransferLimitListSchema = z.object({
  limits: z.array(adminTransferLimitSchema),
});
export type AdminTransferLimitList = z.infer<typeof adminTransferLimitListSchema>;

/** Niveau de vérification dans un chemin d'URL : `0`, `1`, `2` ou `3`. */
export const transferLimitLevelParamSchema = z
  .string()
  .regex(/^[0-3]$/, { error: 'Must be a verification level: 0, 1, 2 or 3.' })
  .transform((value) => kycVerifiedLevelSchema.parse(Number(value)));

/**
 * Fixe — ou remplace — les plafonds d'un niveau de vérification dans un actif. Les trois
 * montants vont croissant : par transfert ≤ sur 24 heures ≤ sur 31 jours. Les ramener à zéro
 * referme les transferts de ce niveau dans cet actif, en envoi comme en réception. `reason` est
 * inscrite au journal d'audit.
 */
export const setTransferLimitRequestSchema = z.strictObject({
  perTransfer: nonNegativeAmountSchema,
  daily: nonNegativeAmountSchema,
  monthly: nonNegativeAmountSchema,
  reason: adminActionReasonSchema,
});
export type SetTransferLimitRequest = z.infer<typeof setTransferLimitRequestSchema>;

// --- Copie des données --------------------------------------------------------------------------

/** Nombre maximal de transferts inclus dans une copie des données (les plus récents). */
export const DATA_EXPORT_TRANSFERS_MAX_ENTRIES = 2000;

/** Transferts du titulaire tels qu'ils figurent dans la copie des données. */
export const exportedTransfersSchema = z.object({
  /** Du plus récent au plus ancien. */
  items: z.array(transferSchema),
  /** Vrai si le compte compte plus de transferts que la copie n'en contient. */
  truncated: z.boolean(),
});
export type ExportedTransfers = z.infer<typeof exportedTransfersSchema>;
