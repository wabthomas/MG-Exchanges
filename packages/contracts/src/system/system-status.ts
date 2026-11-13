import { isoDateTimeSchema } from '@mgx/validation';
import { z } from 'zod';

/**
 * Fonctionnalités activables de la plateforme.
 *
 * Toutes sont **désactivées par défaut** : une fonctionnalité réglementée n'est ouverte
 * qu'après obtention des autorisations requises, par une décision d'administration tracée.
 */
export const FEATURE_KEYS = [
  'registration',
  'kyc',
  'internalTransfers',
  'fiatDeposits',
  'fiatWithdrawals',
  'cryptoDeposits',
  'cryptoWithdrawals',
  'exchange',
  'p2p',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const featureFlagsSchema = z.object(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean()])) as Record<
    FeatureKey,
    z.ZodBoolean
  >,
);
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export const maintenanceStatusSchema = z.object({
  enabled: z.boolean(),
  /** Message destiné aux utilisateurs, ou `null`. */
  message: z.string().max(500).nullable(),
});
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

/**
 * Réponse de `GET /api/v1/system/status` : ce qu'un client doit savoir au démarrage
 * (version de l'API, maintenance en cours, fonctionnalités ouvertes).
 */
export const systemStatusSchema = z.object({
  service: z.string(),
  version: z.string(),
  serverTime: isoDateTimeSchema,
  maintenance: maintenanceStatusSchema,
  features: featureFlagsSchema,
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;
