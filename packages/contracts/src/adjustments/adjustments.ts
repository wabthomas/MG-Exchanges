import {
  assetCodeSchema,
  decimalAmountSchema,
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
import { assetSchema, ledgerCursorSchema, ledgerPageLimitSchema } from '../ledger/ledger.js';
import { positiveAmountSchema } from '../transfers/transfers.js';

// --- Ajustement manuel d'un portefeuille --------------------------------------------------------

/**
 * Sens d'un ajustement, vu du portefeuille du titulaire — celui d'un relevé : `CREDIT`, des
 * fonds y entrent ; `DEBIT`, des fonds en sortent.
 */
export const LEDGER_ADJUSTMENT_DIRECTIONS = ['CREDIT', 'DEBIT'] as const;
export type LedgerAdjustmentDirection = (typeof LEDGER_ADJUSTMENT_DIRECTIONS)[number];

/**
 * Type des écritures que produit un ajustement approuvé, selon son sens. Ce sont les seules
 * écritures qui passent sur un portefeuille gelé.
 */
export const LEDGER_ADJUSTMENT_ENTRY_KINDS = {
  CREDIT: 'adjustment.credit',
  DEBIT: 'adjustment.debit',
} as const satisfies Record<LedgerAdjustmentDirection, string>;

/**
 * `PENDING` attend la décision d'un second membre du personnel ; `APPROVED` a été passé au
 * grand livre ; `REJECTED` a été refusé ; `CANCELLED` a été retiré par son auteur ; `EXPIRED`
 * est resté sans décision jusqu'à son échéance.
 */
export const LEDGER_ADJUSTMENT_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type LedgerAdjustmentStatus = (typeof LEDGER_ADJUSTMENT_STATUSES)[number];

/**
 * Durée, en heures, pendant laquelle une demande d'ajustement peut être approuvée. La base de
 * données fixe elle-même l'échéance, à sa propre horloge.
 */
export const LEDGER_ADJUSTMENT_TTL_HOURS = 72;

/**
 * Demande de crédit ou de débit du portefeuille d'un titulaire, par un membre du personnel.
 * **Rien ne bouge tant qu'un second ne l'a pas approuvée.** `amount` est une chaîne décimale,
 * avec au plus le nombre de décimales de l'actif ; `reason` reste interne : le titulaire ne la
 * voit jamais.
 */
export const createLedgerAdjustmentRequestSchema = z.strictObject({
  /** Titulaire du portefeuille. */
  userId: uuidSchema,
  assetCode: assetCodeSchema,
  direction: z.enum(LEDGER_ADJUSTMENT_DIRECTIONS),
  amount: positiveAmountSchema,
  reason: adminActionReasonSchema,
});
export type CreateLedgerAdjustmentRequest = z.infer<typeof createLedgerAdjustmentRequestSchema>;

/** Un compte, et l'adresse qu'il porte aujourd'hui — `null` s'il a été clôturé depuis. */
const adjustmentPartySchema = z.object({ id: uuidSchema, email: z.string().nullable() });

/**
 * Ajustement, tel que le voit le back-office. `entryId` est l'écriture du grand livre qui le
 * réalise : `null` tant qu'il n'est pas approuvé.
 */
export const ledgerAdjustmentSchema = z.object({
  id: uuidSchema,
  user: adjustmentPartySchema,
  asset: assetSchema,
  direction: z.enum(LEDGER_ADJUSTMENT_DIRECTIONS),
  amount: decimalAmountSchema,
  reason: z.string(),
  status: z.enum(LEDGER_ADJUSTMENT_STATUSES),
  requestedBy: adjustmentPartySchema,
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** Auteur de la décision ; `null` pour une demande en attente ou échue. */
  decidedBy: adjustmentPartySchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decisionNote: z.string().nullable(),
  entryId: uuidSchema.nullable(),
});
export type LedgerAdjustment = z.infer<typeof ledgerAdjustmentSchema>;

export const ledgerAdjustmentListQuerySchema = z.strictObject({
  status: z.enum(LEDGER_ADJUSTMENT_STATUSES).optional(),
  /** Ajustements du portefeuille de ce titulaire. */
  userId: uuidSchema.optional(),
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type LedgerAdjustmentListQuery = z.infer<typeof ledgerAdjustmentListQuerySchema>;

/** Ajustements, du plus récent au plus ancien. */
export const ledgerAdjustmentListSchema = z.object({
  adjustments: z.array(ledgerAdjustmentSchema),
  nextCursor: z.string().nullable(),
});
export type LedgerAdjustmentList = z.infer<typeof ledgerAdjustmentListSchema>;

/**
 * Approbation : elle passe l'écriture. L'approbateur présente **de nouveau** son mot de passe
 * et son second facteur — une session ouverte ne suffit pas à déplacer des fonds. Une note est
 * facultative.
 */
export const approveLedgerAdjustmentRequestSchema = z
  .strictObject({
    ...holderProofShape,
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine(atMostOneSecondFactor, AT_MOST_ONE_SECOND_FACTOR);
export type ApproveLedgerAdjustmentRequest = z.infer<typeof approveLedgerAdjustmentRequestSchema>;

/** Refus : il est motivé. */
export const rejectLedgerAdjustmentRequestSchema = z.strictObject({
  note: adminActionReasonSchema,
});
export type RejectLedgerAdjustmentRequest = z.infer<typeof rejectLedgerAdjustmentRequestSchema>;
