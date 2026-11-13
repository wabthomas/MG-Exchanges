import {
  isoDateSchema,
  isoDateTimeSchema,
  localeSchema,
  personNameSchema,
  phoneNumberSchema,
  textLineSchema,
  timeZoneSchema,
  uuidSchema,
  verificationCodeSchema,
} from '@mgx/validation';
import { z } from 'zod';

// --- Profil et préférences ----------------------------------------------------------------------

/**
 * Profil d'un compte : identité déclarée, adresse et préférences.
 *
 * Les noms suivent l'usage congolais : prénom (`givenName`), nom (`familyName`) et postnom
 * (`additionalName`). Ces informations sont **déclaratives** tant que l'identité n'a pas été
 * vérifiée (KYC). Une fois l'identité vérifiée (`identityVerified`), les noms, la date et le
 * lieu de naissance et la nationalité sont ceux du dossier accepté et ne se modifient plus ici ;
 * il en va de même de l'adresse une fois celle-ci vérifiée (`addressVerified`). Les changer
 * passe par un nouveau dossier de vérification.
 */
export const profileSchema = z.object({
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  /** Postnom. */
  additionalName: z.string().nullable(),
  /** Date de naissance : `1990-05-17`. */
  dateOfBirth: isoDateSchema.nullable(),
  /** Lieu de naissance ; connu seulement une fois l'identité vérifiée. */
  placeOfBirth: z.string().nullable(),
  /** Nationalité (ISO 3166-1 alpha-2) ; connue seulement une fois l'identité vérifiée. */
  nationality: z.string().nullable(),
  /** Vrai si les noms et la naissance ont été vérifiés sur une pièce d'identité. */
  identityVerified: z.boolean(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  /** Province ou région. */
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  /** Vrai si l'adresse a été vérifiée sur un justificatif de domicile. */
  addressVerified: z.boolean(),
  /** Langue des messages adressés à l'utilisateur. */
  locale: localeSchema,
  /** Fuseau horaire IANA, ou `null` si aucun n'a été choisi. */
  timeZone: z.string().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

/**
 * Modification partielle : seuls les champs présents changent ; `null` efface un champ
 * (sauf `locale`, toujours renseignée). Un champ vérifié ne se modifie pas : la requête est
 * alors refusée (`CONFLICT`).
 */
export const updateProfileRequestSchema = z
  .strictObject({
    givenName: personNameSchema.nullable(),
    familyName: personNameSchema.nullable(),
    additionalName: personNameSchema.nullable(),
    dateOfBirth: isoDateSchema.nullable(),
    addressLine1: textLineSchema(200).nullable(),
    addressLine2: textLineSchema(200).nullable(),
    city: textLineSchema(100).nullable(),
    region: textLineSchema(100).nullable(),
    postalCode: textLineSchema(20).nullable(),
    locale: localeSchema,
    timeZone: timeZoneSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Provide at least one field to change.',
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/** Âge minimal pour détenir un compte. */
export const MINIMUM_AGE_YEARS = 18;

// --- Numéro de téléphone ------------------------------------------------------------------------

export const phoneVerificationRequestSchema = z.strictObject({ phone: phoneNumberSchema });
export type PhoneVerificationRequest = z.infer<typeof phoneVerificationRequestSchema>;

/** Réponse à une demande de vérification — identique que le numéro soit déjà utilisé ou non. */
export const phoneVerificationPendingSchema = z.object({
  nextStep: z.literal('VERIFY_PHONE'),
  /** Durée de validité du code envoyé par SMS, en secondes. */
  codeTtlSeconds: z.number().int().positive(),
});
export type PhoneVerificationPending = z.infer<typeof phoneVerificationPendingSchema>;

export const verifyPhoneRequestSchema = z.strictObject({ code: verificationCodeSchema });
export type VerifyPhoneRequest = z.infer<typeof verifyPhoneRequestSchema>;

// --- Historique d'activité ----------------------------------------------------------------------

/**
 * Événements de sécurité qu'un utilisateur peut consulter sur son propre compte. La liste
 * est fermée : seuls ces événements sont exposés, jamais le journal d'audit brut.
 */
export const ACTIVITY_TYPES = [
  'ACCOUNT_CREATED',
  'EMAIL_VERIFIED',
  'SIGN_IN',
  'SIGN_IN_FAILED',
  'SIGN_IN_DENIED',
  'SECOND_FACTOR_FAILED',
  'SIGN_OUT',
  'SESSION_CLOSED',
  'OTHER_SESSIONS_CLOSED',
  'SESSION_REVOKED_TOKEN_REUSE',
  'PASSWORD_CHANGED',
  'PASSWORD_CHANGE_FAILED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET',
  'TWO_FACTOR_ENABLED',
  'TWO_FACTOR_DISABLED',
  'RECOVERY_CODES_REGENERATED',
  'RECOVERY_CODE_USED',
  'PROFILE_UPDATED',
  'PHONE_VERIFIED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REACTIVATED',
  'SESSIONS_CLOSED_BY_SUPPORT',
  'TWO_FACTOR_RESET_BY_SUPPORT',
  'IDENTITY_VERIFICATION_SUBMITTED',
  'IDENTITY_VERIFICATION_APPROVED',
  'IDENTITY_VERIFICATION_REJECTED',
  'IDENTITY_VERIFICATION_REVOKED',
  'DATA_EXPORTED',
  'DATA_EXPORT_FAILED',
  'ACCOUNT_CLOSURE_FAILED',
  'TERMS_ACCEPTED',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const activityEntrySchema = z.object({
  id: uuidSchema,
  type: z.enum(ACTIVITY_TYPES),
  occurredAt: isoDateTimeSchema,
  outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']),
  /**
   * Adresse et appareil à l'origine de l'événement ; `null` s'ils sont inconnus, ou si
   * l'action a été réalisée par la plateforme (support, sécurité).
   */
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const ACTIVITY_PAGE_MAX_SIZE = 100;

export const activityQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_MAX_SIZE).default(20),
  /** Curseur : identifiant du dernier événement de la page précédente. */
  before: uuidSchema.optional(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const activityListSchema = z.object({
  /** Du plus récent au plus ancien. */
  entries: z.array(activityEntrySchema),
  /** À passer en `before` pour obtenir la page suivante ; `null` s'il n'y en a pas. */
  nextCursor: uuidSchema.nullable(),
});
export type ActivityList = z.infer<typeof activityListSchema>;
