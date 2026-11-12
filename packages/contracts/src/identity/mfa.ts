import {
  isoDateTimeSchema,
  presentedPasswordSchema,
  recoveryCodeSchema,
  totpCodeSchema,
} from '@mgx/validation';
import { z } from 'zod';

/** Nombre de codes de secours remis à l'activation de la validation en deux étapes. */
export const RECOVERY_CODE_COUNT = 10;

/** Paramètres TOTP (RFC 6238) — ceux que toutes les applications d'authentification acceptent. */
export const TOTP_PARAMETERS = { algorithm: 'SHA1', digits: 6, periodSeconds: 30 } as const;

export const mfaStatusSchema = z.object({
  totp: z.object({
    enabled: z.boolean(),
    enabledAt: isoDateTimeSchema.nullable(),
  }),
  /** Codes de secours encore utilisables. */
  recoveryCodesRemaining: z.number().int().nonnegative(),
});
export type MfaStatus = z.infer<typeof mfaStatusSchema>;

/** Toute modification du second facteur exige de présenter à nouveau le mot de passe. */
export const totpEnrollmentRequestSchema = z.strictObject({
  currentPassword: presentedPasswordSchema,
});
export type TotpEnrollmentRequest = z.infer<typeof totpEnrollmentRequestSchema>;

/**
 * Secret à enregistrer dans l'application d'authentification. Il n'est communiqué qu'ici :
 * l'afficher sous forme de QR code (`otpauthUri`) ou le faire saisir (`secret`).
 */
export const totpEnrollmentSchema = z.object({
  /** Secret en base32, pour une saisie manuelle. */
  secret: z.string(),
  /** URI `otpauth://` à présenter sous forme de QR code. */
  otpauthUri: z.string(),
  algorithm: z.literal(TOTP_PARAMETERS.algorithm),
  digits: z.literal(TOTP_PARAMETERS.digits),
  periodSeconds: z.literal(TOTP_PARAMETERS.periodSeconds),
});
export type TotpEnrollment = z.infer<typeof totpEnrollmentSchema>;

export const totpConfirmationRequestSchema = z.strictObject({ code: totpCodeSchema });
export type TotpConfirmationRequest = z.infer<typeof totpConfirmationRequestSchema>;

/**
 * Codes de secours, **affichés une seule fois** : chacun remplace, une fois, le code de
 * l'application d'authentification. Seules leurs empreintes sont conservées.
 */
export const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodes = z.infer<typeof recoveryCodesSchema>;

/** Désactivation : le mot de passe **et** une preuve du second facteur (code ou code de secours). */
export const totpDisableRequestSchema = z
  .strictObject({
    currentPassword: presentedPasswordSchema,
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((value) => (value.code === undefined) !== (value.recoveryCode === undefined), {
    error: 'Provide either "code" or "recoveryCode".',
    path: ['code'],
  });
export type TotpDisableRequest = z.infer<typeof totpDisableRequestSchema>;

export const recoveryCodesRegenerationRequestSchema = z.strictObject({
  currentPassword: presentedPasswordSchema,
  code: totpCodeSchema,
});
export type RecoveryCodesRegenerationRequest = z.infer<
  typeof recoveryCodesRegenerationRequestSchema
>;
