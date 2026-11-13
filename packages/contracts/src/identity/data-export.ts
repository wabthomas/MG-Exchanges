import { isoDateSchema, isoDateTimeSchema, localeSchema, uuidSchema } from '@mgx/validation';
import { z } from 'zod';

import { exportedWalletSchema } from '../ledger/ledger.js';
import {
  AT_MOST_ONE_SECOND_FACTOR,
  atMostOneSecondFactor,
  holderProofShape,
} from './account-lifecycle.js';
import { ACCOUNT_TYPES, USER_STATUSES } from './auth.js';
import { kycCaseSchema } from './kyc.js';
import { kycVerifiedLevelSchema } from './kyc-levels.js';
import { activityEntrySchema } from './profile.js';
import { termsExportSchema } from './terms.js';

export const dataExportRequestSchema = z
  .strictObject(holderProofShape)
  .refine(atMostOneSecondFactor, AT_MOST_ONE_SECOND_FACTOR);
export type DataExportRequest = z.infer<typeof dataExportRequestSchema>;

/**
 * Version du format de la copie. `2` : les conditions d'utilisation acceptées figurent dans
 * `terms` ; `account.termsAcceptedAt` a disparu. `3` : les portefeuilles du titulaire et leurs
 * mouvements figurent dans `wallets`.
 */
export const DATA_EXPORT_FORMAT_VERSION = 3;

/** Nombre maximal d'événements d'activité inclus dans une copie (les plus récents). */
export const DATA_EXPORT_ACTIVITY_MAX_ENTRIES = 2000;

/** Copies des données qu'un compte peut demander par vingt-quatre heures. */
export const DATA_EXPORTS_PER_DAY = 3;

/**
 * Copie des données personnelles d'un compte, remise à son titulaire.
 *
 * Elle contient ce que la plateforme détient sur lui, sous une forme lisible par un programme.
 * Deux choses n'y figurent pas, par sécurité : le numéro complet de la pièce d'identité (il y
 * est masqué) et les fichiers joints aux dossiers de vérification (seule leur description y
 * est) — une session dérobée ne doit pas suffire à emporter une pièce d'identité. Aucun secret
 * d'authentification n'y figure non plus.
 */
export const dataExportSchema = z.object({
  formatVersion: z.literal(DATA_EXPORT_FORMAT_VERSION),
  generatedAt: isoDateTimeSchema,
  account: z.object({
    id: uuidSchema,
    email: z.string(),
    emailVerified: z.boolean(),
    phone: z.string().nullable(),
    phoneVerified: z.boolean(),
    countryCode: z.string(),
    locale: localeSchema,
    accountType: z.enum(ACCOUNT_TYPES),
    status: z.enum(USER_STATUSES),
    createdAt: isoDateTimeSchema,
    /** Rôles du back-office (vide pour un client). */
    roles: z.array(z.string()),
  }),
  /** Profil **déclaré** ; `null` s'il n'a jamais été renseigné. */
  profile: z
    .object({
      givenName: z.string().nullable(),
      familyName: z.string().nullable(),
      additionalName: z.string().nullable(),
      dateOfBirth: isoDateSchema.nullable(),
      addressLine1: z.string().nullable(),
      addressLine2: z.string().nullable(),
      city: z.string().nullable(),
      region: z.string().nullable(),
      postalCode: z.string().nullable(),
      timeZone: z.string().nullable(),
      updatedAt: isoDateTimeSchema,
    })
    .nullable(),
  security: z.object({
    passwordChangedAt: isoDateTimeSchema.nullable(),
    secondFactorEnabled: z.boolean(),
    secondFactorEnabledAt: isoDateTimeSchema.nullable(),
    recoveryCodesRemaining: z.number().int().nonnegative(),
  }),
  /** Sessions encore enregistrées, ouvertes ou terminées, de la plus récente à la plus ancienne. */
  sessions: z.array(
    z.object({
      id: uuidSchema,
      createdAt: isoDateTimeSchema,
      lastUsedAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema,
      revokedAt: isoDateTimeSchema.nullable(),
      ipAddress: z.string().nullable(),
      userAgent: z.string().nullable(),
      deviceName: z.string().nullable(),
    }),
  ),
  activity: z.object({
    /** Du plus récent au plus ancien. */
    entries: z.array(activityEntrySchema),
    /** Vrai si l'historique compte plus d'événements que la copie n'en contient. */
    truncated: z.boolean(),
  }),
  /** Vérification d'identité : niveau obtenu et dossiers, du plus récent au plus ancien. */
  verification: z.object({
    level: kycVerifiedLevelSchema,
    cases: z.array(kycCaseSchema),
  }),
  /** Conditions d'utilisation : les versions que le compte a acceptées. */
  terms: termsExportSchema,
  /**
   * Portefeuilles sur lesquels au moins un mouvement a été passé, dans l'ordre des codes
   * d'actif, avec leurs mouvements — les plus récents si le portefeuille en compte davantage
   * que la copie n'en contient.
   */
  wallets: z.array(exportedWalletSchema),
});
export type DataExport = z.infer<typeof dataExportSchema>;
