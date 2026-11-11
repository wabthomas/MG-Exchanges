import {
  FEATURE_KEYS,
  type FeatureFlags,
  type FeatureKey,
  type MaintenanceStatus,
  maintenanceStatusSchema,
} from '@mgx/contracts';
import { z } from 'zod';

/** Clé du paramètre de maintenance. */
export const MAINTENANCE_SETTING_KEY = 'maintenance.mode';

/** Clé de paramètre de chaque fonctionnalité activable. */
export const FEATURE_SETTING_KEYS = {
  registration: 'features.registration',
  kyc: 'features.kyc',
  internalTransfers: 'features.internal_transfers',
  fiatDeposits: 'features.fiat_deposits',
  fiatWithdrawals: 'features.fiat_withdrawals',
  cryptoDeposits: 'features.crypto_deposits',
  cryptoWithdrawals: 'features.crypto_withdrawals',
  exchange: 'features.exchange',
  p2p: 'features.p2p',
} as const satisfies Record<FeatureKey, string>;

export type FeatureSettingKey = (typeof FEATURE_SETTING_KEYS)[FeatureKey];
export type SettingKey = typeof MAINTENANCE_SETTING_KEY | FeatureSettingKey;

/** Type de la valeur associée à chaque clé de paramètre. */
export type SettingValue<K extends SettingKey> = K extends typeof MAINTENANCE_SETTING_KEY
  ? MaintenanceStatus
  : boolean;

/** État résolu de l'ensemble des paramètres (valeurs stockées, complétées par les défauts). */
export interface SettingsSnapshot {
  readonly maintenance: MaintenanceStatus;
  readonly features: FeatureFlags;
}

export const DEFAULT_MAINTENANCE: MaintenanceStatus = Object.freeze({
  enabled: false,
  message: null,
});

/**
 * Valeur par défaut d'une fonctionnalité : **désactivée**. Une fonctionnalité réglementée
 * ne s'ouvre que par une décision explicite et tracée (voir docs/SECURITY.md).
 */
export const DEFAULT_FEATURE_ENABLED = false;

const featureEnabledSchema = z.boolean();

export const SETTING_KEYS: readonly SettingKey[] = [
  MAINTENANCE_SETTING_KEY,
  ...FEATURE_KEYS.map((feature) => FEATURE_SETTING_KEYS[feature]),
];

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

/** Schéma de validation de la valeur d'un paramètre. */
export function settingSchema(key: SettingKey): z.ZodType {
  return key === MAINTENANCE_SETTING_KEY ? maintenanceStatusSchema : featureEnabledSchema;
}

/**
 * Construit l'état résolu à partir des valeurs stockées. Une valeur stockée invalide est
 * ignorée au profit de la valeur par défaut (sûre) et signalée via `onInvalid`.
 */
export function resolveSnapshot(
  stored: ReadonlyMap<string, unknown>,
  onInvalid: (key: SettingKey) => void = () => undefined,
): SettingsSnapshot {
  const read = <T>(key: SettingKey, schema: z.ZodType<T>, fallback: T): T => {
    if (!stored.has(key)) {
      return fallback;
    }
    const parsed = schema.safeParse(stored.get(key));
    if (!parsed.success) {
      onInvalid(key);
      return fallback;
    }
    return parsed.data;
  };

  const features = Object.fromEntries(
    FEATURE_KEYS.map((feature) => [
      feature,
      read(FEATURE_SETTING_KEYS[feature], featureEnabledSchema, DEFAULT_FEATURE_ENABLED),
    ]),
  ) as FeatureFlags;

  return {
    maintenance: read(MAINTENANCE_SETTING_KEY, maintenanceStatusSchema, DEFAULT_MAINTENANCE),
    features,
  };
}
