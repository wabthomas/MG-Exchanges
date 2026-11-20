import { assetCodeSchema, isoDateTimeSchema, uuidSchema } from '@mgx/validation';
import { z } from 'zod';

import { adminActionReasonSchema } from '../identity/admin-users.js';
import { assetSchema, ledgerCursorSchema, ledgerPageLimitSchema } from './ledger.js';

// --- Gel d'un portefeuille ----------------------------------------------------------------------

/**
 * Gèle le portefeuille d'un titulaire dans un actif : plus aucun mouvement n'y passe — ni
 * envoi, ni réception —, hors les ajustements du personnel sous double validation. `reason`
 * reste interne : le titulaire ne la voit jamais.
 */
export const freezeWalletRequestSchema = z.strictObject({
  /** Titulaire du portefeuille. */
  userId: uuidSchema,
  assetCode: assetCodeSchema,
  reason: adminActionReasonSchema,
});
export type FreezeWalletRequest = z.infer<typeof freezeWalletRequestSchema>;

/** Levée d'un gel : elle est motivée. */
export const liftWalletFreezeRequestSchema = z.strictObject({ reason: adminActionReasonSchema });
export type LiftWalletFreezeRequest = z.infer<typeof liftWalletFreezeRequestSchema>;

/** `ACTIVE` : le portefeuille est gelé ; `LIFTED` : le gel a été levé. */
export const WALLET_FREEZE_STATUSES = ['ACTIVE', 'LIFTED'] as const;
export type WalletFreezeStatus = (typeof WALLET_FREEZE_STATUSES)[number];

/** Gel d'un portefeuille, tel que le voit le back-office. Un gel levé reste : c'est sa trace. */
export const walletFreezeSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  asset: assetSchema,
  status: z.enum(WALLET_FREEZE_STATUSES),
  reason: z.string(),
  frozenBy: uuidSchema,
  frozenAt: isoDateTimeSchema,
  /** Auteur de la levée ; `null` tant que le gel est en vigueur. */
  liftedBy: uuidSchema.nullable(),
  liftedAt: isoDateTimeSchema.nullable(),
  liftReason: z.string().nullable(),
});
export type WalletFreeze = z.infer<typeof walletFreezeSchema>;

export const walletFreezeListQuerySchema = z.strictObject({
  status: z.enum(WALLET_FREEZE_STATUSES).optional(),
  /** Gels des portefeuilles de ce titulaire. */
  userId: uuidSchema.optional(),
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type WalletFreezeListQuery = z.infer<typeof walletFreezeListQuerySchema>;

/** Gels, du plus récent au plus ancien. */
export const walletFreezeListSchema = z.object({
  freezes: z.array(walletFreezeSchema),
  nextCursor: z.string().nullable(),
});
export type WalletFreezeList = z.infer<typeof walletFreezeListSchema>;
