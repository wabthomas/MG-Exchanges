import {
  countryCodeSchema,
  deviceIdSchema,
  emailSchema,
  isoDateTimeSchema,
  localeSchema,
  passwordSchema,
  phoneNumberSchema,
  presentedPasswordSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  uuidSchema,
  verificationCodeSchema,
} from '@mgx/validation';
import { z } from 'zod';

import { kycVerifiedLevelSchema } from './kyc-levels.js';
import { permissionKeySchema } from './permissions.js';
import { termsVersionNumberSchema } from './terms.js';

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
  /**
   * Acceptation explicite des conditions d'utilisation : le numéro de la version que la
   * personne a eue sous les yeux (`GET /terms/current`). Ce doit être la version en vigueur.
   */
  acceptedTermsVersion: termsVersionNumberSchema,
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

/**
 * Le mot de passe choisi à l'inscription accompagne le code : l'adresse n'est vérifiée — et le
 * compte activé — que par la personne qui connaît **les deux**. Sans cela, un tiers pourrait
 * préparer un compte à l'adresse d'autrui, avec son propre mot de passe, et attendre que le
 * titulaire de la boîte aux lettres l'active à sa place.
 */
export const verifyEmailRequestSchema = z.strictObject({
  email: emailSchema,
  code: verificationCodeSchema,
  password: presentedPasswordSchema,
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
  /**
   * Identifiant aléatoire créé par l'application à son installation et conservé sur
   * l'appareil. Il permet de reconnaître un appareil déjà utilisé : une connexion depuis un
   * appareil inconnu est signalée au titulaire du compte.
   */
  deviceId: deviceIdSchema.optional(),
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
  /** Vrai si la validation en deux étapes est activée. Elle est exigée pour le back-office. */
  secondFactorEnabled: z.boolean(),
  /** Niveau de vérification d'identité atteint : de `0` (aucun) à `3`. */
  verificationLevel: kycVerifiedLevelSchema,
  /**
   * Vrai si le compte doit accepter la version en vigueur des conditions d'utilisation avant
   * de continuer (voir `GET /me/terms`).
   */
  termsAcceptanceRequired: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** Session ouverte : la connexion est terminée. */
export const authenticatedLoginSchema = z.object({
  status: z.literal('AUTHENTICATED'),
  tokens: tokenPairSchema,
  sessionId: uuidSchema,
  user: currentUserSchema,
});
export type AuthenticatedLogin = z.infer<typeof authenticatedLoginSchema>;

/** Moyens de franchir la seconde étape : code de l'application d'authentification, ou code de secours. */
export const SECOND_FACTOR_METHODS = ['TOTP', 'RECOVERY_CODE'] as const;
export type SecondFactorMethod = (typeof SECOND_FACTOR_METHODS)[number];

/**
 * Mot de passe correct, mais le compte exige une seconde étape : aucune session n'est encore
 * ouverte. Présenter `mfaToken` et un code à `POST /auth/mfa/verify` avant son expiration.
 */
export const mfaRequiredLoginSchema = z.object({
  status: z.literal('MFA_REQUIRED'),
  /** Jeton à usage unique de la connexion en cours. N'ouvre aucun droit par lui-même. */
  mfaToken: z.string(),
  mfaTokenExpiresAt: isoDateTimeSchema,
  methods: z.array(z.enum(SECOND_FACTOR_METHODS)),
});
export type MfaRequiredLogin = z.infer<typeof mfaRequiredLoginSchema>;

/**
 * Réponse de connexion. Les clients doivent se fonder sur `status` : d'autres valeurs
 * pourront s'ajouter sans changement de version.
 */
export const loginResponseSchema = z.discriminatedUnion('status', [
  authenticatedLoginSchema,
  mfaRequiredLoginSchema,
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * Seconde étape de la connexion : le jeton reçu avec `MFA_REQUIRED`, et **soit** le code de
 * l'application d'authentification, **soit** un code de secours (à usage unique).
 */
export const mfaLoginRequestSchema = z
  .strictObject({
    mfaToken: z.string().min(1).max(256),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((value) => (value.code === undefined) !== (value.recoveryCode === undefined), {
    error: 'Provide either "code" or "recoveryCode".',
    path: ['code'],
  });
export type MfaLoginRequest = z.infer<typeof mfaLoginRequestSchema>;

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
