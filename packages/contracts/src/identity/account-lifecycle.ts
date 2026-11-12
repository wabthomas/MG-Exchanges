import {
  isoDateTimeSchema,
  presentedPasswordSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

// --- Preuve du titulaire ------------------------------------------------------------------------

/**
 * Ce que le titulaire présente à nouveau avant une opération définitive ou qui rassemble ses
 * données : son mot de passe et — **si** la validation en deux étapes est activée sur le
 * compte — le code de son application d'authentification ou un code de secours. Une session
 * ouverte ne suffit pas.
 */
export const holderProofShape = {
  currentPassword: presentedPasswordSchema,
  code: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
} as const;

export const AT_MOST_ONE_SECOND_FACTOR = {
  error: 'Provide "code" or "recoveryCode", not both.',
  path: ['code'],
};

export function atMostOneSecondFactor(value: {
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
}): boolean {
  return value.code === undefined || value.recoveryCode === undefined;
}

// --- Clôture du compte --------------------------------------------------------------------------

/** Délai, en jours, après lequel l'adresse et le numéro d'un compte clôturé sont effacés. */
export const CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS = 30;

/**
 * Durée, en années, pendant laquelle les dossiers de vérification d'identité sur lesquels une
 * décision a été prise sont conservés après la clôture du compte. La base de données impose
 * elle-même ce plancher.
 */
export const VERIFICATION_RECORDS_RETENTION_YEARS = 10;

/**
 * Clôture du compte par son titulaire. Elle est **immédiate et définitive** : `confirm` doit
 * valoir `true`.
 */
export const closeAccountRequestSchema = z
  .strictObject({
    ...holderProofShape,
    confirm: z.literal(true, { error: 'Closing the account is permanent: confirm it.' }),
  })
  .refine(atMostOneSecondFactor, AT_MOST_ONE_SECOND_FACTOR);
export type CloseAccountRequest = z.infer<typeof closeAccountRequestSchema>;

/** Ce qu'il advient des données d'un compte clôturé. */
export const accountClosureSchema = z.object({
  closedAt: isoDateTimeSchema,
  /**
   * Terme de la conservation imposée par la loi (dossiers de vérification d'identité examinés) ;
   * `null` si rien n'est conservé à ce titre.
   */
  legalRetentionUntil: isoDateTimeSchema.nullable(),
  /**
   * Date à partir de laquelle ce qui reste du compte — son adresse e-mail, son numéro et, le
   * cas échéant, les dossiers conservés — est effacé.
   */
  erasureDueAt: isoDateTimeSchema,
});
export type AccountClosure = z.infer<typeof accountClosureSchema>;

/** Ce qui empêche la clôture d'un compte ; la réponse `409` les cite dans son message. */
export const ACCOUNT_CLOSURE_BLOCKERS = ['ROLE_HELD', 'VERIFICATION_PENDING_REVIEW'] as const;
export type AccountClosureBlocker = (typeof ACCOUNT_CLOSURE_BLOCKERS)[number];

// --- Clôture par le personnel (back-office) -----------------------------------------------------

/**
 * `HOLDER_REQUEST` : le titulaire l'a demandée par un autre canal (il n'a plus accès à son
 * compte, par exemple) ; `PLATFORM_DECISION` : la plateforme met fin à la relation.
 */
export const ACCOUNT_CLOSURE_GROUNDS = ['HOLDER_REQUEST', 'PLATFORM_DECISION'] as const;
export type AccountClosureGround = (typeof ACCOUNT_CLOSURE_GROUNDS)[number];

export const ACCOUNT_CLOSURE_ORIGINS = ['HOLDER', 'STAFF'] as const;
export type AccountClosureOrigin = (typeof ACCOUNT_CLOSURE_ORIGINS)[number];

/** Clôture d'un compte, telle que la voit le back-office. */
export const adminAccountClosureSchema = accountClosureSchema.extend({
  origin: z.enum(ACCOUNT_CLOSURE_ORIGINS),
  /** Auteur : le titulaire lui-même, ou le membre du personnel. */
  closedBy: uuidSchema,
  /** Adresse et numéro que portait le compte ; `null` une fois effacés. */
  formerEmail: z.string().nullable(),
  formerPhone: z.string().nullable(),
  erasedAt: isoDateTimeSchema.nullable(),
});
export type AdminAccountClosure = z.infer<typeof adminAccountClosureSchema>;
