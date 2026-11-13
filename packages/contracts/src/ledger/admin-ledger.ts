import {
  assetCodeSchema,
  decimalAmountSchema,
  isoDateTimeSchema,
  textLineSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

import { adminActionReasonSchema } from '../identity/admin-users.js';
import {
  ASSET_KINDS,
  ASSET_NAME_MAX_LENGTH,
  ASSET_SCALE_MAX,
  assetSchema,
  LEDGER_ACCOUNT_OWNERS,
  LEDGER_ACCOUNT_TYPE_KEYS,
  LEDGER_SIDES,
  ledgerCursorSchema,
  ledgerPageLimitSchema,
} from './ledger.js';

// --- Actifs -------------------------------------------------------------------------------------

/**
 * Enregistrement d'un actif. **Définitif** : ni le code, ni le nombre de décimales, ni la
 * nature, ni le libellé d'un actif enregistré ne se modifient, et un actif ne se retire pas —
 * tous les montants du grand livre s'expriment dans son unité minimale.
 */
export const registerAssetRequestSchema = z.strictObject({
  code: assetCodeSchema,
  name: textLineSchema(ASSET_NAME_MAX_LENGTH),
  kind: z.enum(ASSET_KINDS),
  scale: z.number().int().min(0).max(ASSET_SCALE_MAX),
  reason: adminActionReasonSchema,
});
export type RegisterAssetRequest = z.infer<typeof registerAssetRequestSchema>;

export const adminAssetSchema = assetSchema.extend({
  registeredAt: isoDateTimeSchema,
  /** Membre du personnel qui a enregistré l'actif ; `null` s'il l'a été hors de l'API. */
  registeredBy: uuidSchema.nullable(),
});
export type AdminAsset = z.infer<typeof adminAssetSchema>;

export const adminAssetListSchema = z.object({ assets: z.array(adminAssetSchema) });
export type AdminAssetList = z.infer<typeof adminAssetListSchema>;

// --- Comptes ------------------------------------------------------------------------------------

/**
 * Compte du grand livre. `balance` est exprimé dans le sens normal du compte (`normalSide`) :
 * il n'est jamais négatif.
 */
export const adminLedgerAccountSchema = z.object({
  id: uuidSchema,
  type: z.enum(LEDGER_ACCOUNT_TYPE_KEYS),
  owner: z.enum(LEDGER_ACCOUNT_OWNERS),
  /** Titulaire du compte ; `null` pour un compte de la plateforme. */
  userId: uuidSchema.nullable(),
  asset: assetSchema,
  normalSide: z.enum(LEDGER_SIDES),
  balance: decimalAmountSchema,
  /** Nombre de lignes passées sur ce compte depuis son ouverture. */
  postingCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});
export type AdminLedgerAccount = z.infer<typeof adminLedgerAccountSchema>;

export const adminLedgerAccountListQuerySchema = z.strictObject({
  userId: uuidSchema.optional(),
  assetCode: assetCodeSchema.optional(),
  type: z.enum(LEDGER_ACCOUNT_TYPE_KEYS).optional(),
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type AdminLedgerAccountListQuery = z.infer<typeof adminLedgerAccountListQuerySchema>;

/** Comptes, du plus anciennement ouvert au plus récent. */
export const adminLedgerAccountListSchema = z.object({
  accounts: z.array(adminLedgerAccountSchema),
  nextCursor: z.string().nullable(),
});
export type AdminLedgerAccountList = z.infer<typeof adminLedgerAccountListSchema>;

// --- Lignes d'un compte -------------------------------------------------------------------------

export const adminLedgerPostingSchema = z.object({
  id: uuidSchema,
  entryId: uuidSchema,
  lineNumber: z.number().int().positive(),
  kind: z.string(),
  side: z.enum(LEDGER_SIDES),
  amount: decimalAmountSchema,
  /** Solde du compte juste après cette ligne. */
  balanceAfter: decimalAmountSchema,
  /** Rang de la ligne sur ce compte : 1, 2, 3… sans trou. */
  accountSequence: z.number().int().positive(),
  postedAt: isoDateTimeSchema,
});
export type AdminLedgerPosting = z.infer<typeof adminLedgerPostingSchema>;

export const adminLedgerPostingListQuerySchema = z.strictObject({
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type AdminLedgerPostingListQuery = z.infer<typeof adminLedgerPostingListQuerySchema>;

/** Lignes d'un compte, de la plus récente à la plus ancienne. */
export const adminLedgerPostingListSchema = z.object({
  account: adminLedgerAccountSchema,
  postings: z.array(adminLedgerPostingSchema),
  nextCursor: z.string().nullable(),
});
export type AdminLedgerPostingList = z.infer<typeof adminLedgerPostingListSchema>;

// --- Écritures ----------------------------------------------------------------------------------

/** Qui a passé une écriture : un compte, la plateforme elle-même, ou un système tiers. */
export const LEDGER_ACTOR_TYPES = ['USER', 'SYSTEM', 'SERVICE'] as const;
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];

export const adminLedgerEntryLineSchema = z.object({
  id: uuidSchema,
  lineNumber: z.number().int().positive(),
  account: z.object({
    id: uuidSchema,
    type: z.enum(LEDGER_ACCOUNT_TYPE_KEYS),
    owner: z.enum(LEDGER_ACCOUNT_OWNERS),
    userId: uuidSchema.nullable(),
  }),
  asset: assetSchema,
  side: z.enum(LEDGER_SIDES),
  amount: decimalAmountSchema,
  balanceAfter: decimalAmountSchema,
  accountSequence: z.number().int().positive(),
});
export type AdminLedgerEntryLine = z.infer<typeof adminLedgerEntryLineSchema>;

/**
 * Écriture complète : son en-tête et toutes ses lignes, dans l'ordre. Pour chaque actif, le
 * total des débits égale celui des crédits.
 */
export const adminLedgerEntrySchema = z.object({
  id: uuidSchema,
  kind: z.string(),
  /** Clé qui rend l'écriture unique : la repasser ne l'écrit pas une seconde fois. */
  idempotencyKey: z.string(),
  actor: z.object({
    type: z.enum(LEDGER_ACTOR_TYPES),
    /** `null` pour la plateforme elle-même. */
    id: z.string().nullable(),
  }),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  postedAt: isoDateTimeSchema,
  postings: z.array(adminLedgerEntryLineSchema),
});
export type AdminLedgerEntry = z.infer<typeof adminLedgerEntrySchema>;

// --- Balance ------------------------------------------------------------------------------------

/**
 * Balance du grand livre : pour chaque actif, le total des soldes par type de compte.
 *
 * `debitBalance` additionne les comptes dont le solde augmente au débit (ce que la plateforme
 * conserve), `creditBalance` ceux dont il augmente au crédit (ce qu'elle doit aux titulaires,
 * ce qu'elle a gagné). Les deux sont égaux — `balanced` — tant que le grand livre est sain.
 */
export const trialBalanceSchema = z.object({
  generatedAt: isoDateTimeSchema,
  /** Vrai si chaque actif est équilibré. */
  balanced: z.boolean(),
  assets: z.array(
    z.object({
      asset: assetSchema,
      debitBalance: decimalAmountSchema,
      creditBalance: decimalAmountSchema,
      balanced: z.boolean(),
      /** Un élément par type du plan de comptes, y compris ceux qui n'ont aucun compte. */
      accountTypes: z.array(
        z.object({
          type: z.enum(LEDGER_ACCOUNT_TYPE_KEYS),
          owner: z.enum(LEDGER_ACCOUNT_OWNERS),
          normalSide: z.enum(LEDGER_SIDES),
          accounts: z.number().int().nonnegative(),
          balance: decimalAmountSchema,
        }),
      ),
    }),
  ),
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;
