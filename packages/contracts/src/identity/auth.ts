import {
  countryCodeSchema,
  emailSchema,
  isoDateTimeSchema,
  localeSchema,
  passwordSchema,
  phoneNumberSchema,
  presentedPasswordSchema,
  uuidSchema,
  verificationCodeSchema,
} from '@mgx/validation';
import { z } from 'zod';

import { permissionKeySchema } from './permissions.js';

export const ACCOUNT_TYPES = ['INDIVIDUAL', 'BUSINESS'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * État d'un compte :
 *  - `PENDING_VERIFICATION` : créé, adresse e-mail pas encore vérifiée — connexion impossible ;
 *  - `ACTIVE` : utilisable ;
 *  - `SUSPENDED` : bloqué par la plateforme (sécurité, conformité) — réversible ;
 *  - `CLOSED` : clôturé — définitif.
 */
export const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// --- Inscription --------------------------------------------------------------------------

export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  phone: phoneNumberSchema.optional(),
  /** Pays de résidence. */
  countryCode: countryCodeSchema,
  locale: localeSchema.optional(),
  /** Acceptation explicite des conditions d'utilisation. */
  acceptTerms: z.literal(true, { error: 'The terms of service must be accepted.' }),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Réponse à une demande d'inscription ou de renvoi de code. Elle est **identique** que
 * l'adresse soit déjà associée à un compte ou non, afin de ne pas révéler l'existence d'un compte.
 */
export const verificationPendingSchema = z.object({
  nextStep: z.literal('VERIFY_EMAIL'),
  /** Durée de validité du code envoyé, en secondes. */
  codeTtlSeconds: z.number().int().positive(),
});
export type VerificationPending = z.infer<typeof verificationPendingSchema>;

export const verifyEmailRequestSchema = z.strictObject({
  email: emailSchema,
  code: verificationCodeSchema,
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/** Corps des demandes qui ne désignent qu'un compte : renvoi de code, mot de passe oublié. */
export const emailOnlyRequestSchema = z.strictObject({ email: emailSchema });
export type EmailOnlyRequest = z.infer<typeof emailOnlyRequestSchema>;

// --- Connexion et sessions ------------------------------------------------------------------

export const DEVICE_NAME_MAX_LENGTH = 64;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: presentedPasswordSchema,
  /** Nom affiché dans la liste des sessions (« iPhone de Jean »). */
  deviceName: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Jetons d'une session. Le jeton d'accès (courte durée) accompagne chaque requête :
 * `Authorization: Bearer <accessToken>`. Le jeton de renouvellement ne sert qu'à en obtenir
 * un nouveau ; il change à chaque utilisation.
 */
export const tokenPairSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: isoDateTimeSchema,
  refreshToken: z.string(),
  /** Au-delà, la session a expiré par inactivité : il faut se reconnecter. */
  refreshTokenExpiresAt: isoDateTimeSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const currentUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  countryCode: z.string(),
  locale: localeSchema,
  accountType: z.enum(ACCOUNT_TYPES),
  status: z.enum(USER_STATUSES),
  /** Rôles du back-office (vide pour un utilisateur final). */
  roles: z.array(z.string()),
  /** Permissions effectives, issues des rôles. */
  permissions: z.array(permissionKeySchema),
  createdAt: isoDateTimeSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Réponse de connexion. Les clients doivent se fonder sur `status` : d'autres valeurs
 * (second facteur requis…) s'ajouteront sans changement de version.
 */
export const loginResponseSchema = z.object({
  status: z.literal('AUTHENTICATED'),
  tokens: tokenPairSchema,
  sessionId: uuidSchema,
  user: currentUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(256),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = z.object({ tokens: tokenPairSchema });
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const sessionSchema = z.object({
  id: uuidSchema,
  /** Vrai pour la session qui effectue la requête. */
  current: z.boolean(),
  deviceName: z.string().nullable(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionListSchema = z.object({ sessions: z.array(sessionSchema) });
export type SessionList = z.infer<typeof sessionListSchema>;

// --- Mot de passe ---------------------------------------------------------------------------

export const resetPasswordRequestSchema = z.strictObject({
  email: emailSchema,
  code: verificationCodeSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: presentedPasswordSchema,
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** Réponse à une demande de réinitialisation — identique que le compte existe ou non. */
export const passwordResetPendingSchema = z.object({
  nextStep: z.literal('RESET_PASSWORD'),
  codeTtlSeconds: z.number().int().positive(),
});
export type PasswordResetPending = z.infer<typeof passwordResetPendingSchema>;
