import { describe, expect, it } from '@jest/globals';
import { FEATURE_KEYS } from '@mgx/contracts';

import {
  FEATURE_SETTING_KEYS,
  isSettingKey,
  resolveSnapshot,
  SETTING_KEYS,
  settingSchema,
} from './setting-definitions.js';

describe('paramètres système', () => {
  it('chaque fonctionnalité possède une clé de paramètre unique et bien formée', () => {
    const keys = FEATURE_KEYS.map((feature) => FEATURE_SETTING_KEYS[feature]);
    expect(new Set(keys).size).toBe(FEATURE_KEYS.length);
    for (const key of SETTING_KEYS) {
      // Même format que la contrainte CHECK de la table system_settings.
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      expect(isSettingKey(key)).toBe(true);
    }
    expect(isSettingKey('features.unknown')).toBe(false);
  });

  it('sans décision enregistrée, tout est désactivé et la plateforme n’est pas en maintenance', () => {
    const snapshot = resolveSnapshot(new Map());
    expect(snapshot.maintenance).toEqual({ enabled: false, message: null });
    expect(Object.keys(snapshot.features)).toEqual([...FEATURE_KEYS]);
    expect(Object.values(snapshot.features).every((enabled) => !enabled)).toBe(true);
  });

  it('applique les valeurs stockées valides', () => {
    const snapshot = resolveSnapshot(
      new Map<string, unknown>([
        ['features.exchange', true],
        ['maintenance.mode', { enabled: true, message: 'Mise à niveau en cours' }],
        ['unknown.key', 'ignored'],
      ]),
    );
    expect(snapshot.features.exchange).toBe(true);
    expect(snapshot.features.p2p).toBe(false);
    expect(snapshot.maintenance).toEqual({ enabled: true, message: 'Mise à niveau en cours' });
  });

  it('une valeur stockée invalide est ignorée au profit du défaut sûr, et signalée', () => {
    const invalid: string[] = [];
    const snapshot = resolveSnapshot(
      new Map<string, unknown>([
        ['features.fiat_withdrawals', 'true'],
        ['features.crypto_withdrawals', 1],
        ['maintenance.mode', { enabled: 'yes' }],
      ]),
      (key) => invalid.push(key),
    );

    expect(snapshot.features.fiatWithdrawals).toBe(false);
    expect(snapshot.features.cryptoWithdrawals).toBe(false);
    expect(snapshot.maintenance.enabled).toBe(false);
    expect(invalid.sort()).toEqual([
      'features.crypto_withdrawals',
      'features.fiat_withdrawals',
      'maintenance.mode',
    ]);
  });

  it('valide les valeurs par type de paramètre', () => {
    expect(settingSchema('features.p2p').safeParse(true).success).toBe(true);
    expect(settingSchema('features.p2p').safeParse('true').success).toBe(false);
    expect(
      settingSchema('maintenance.mode').safeParse({ enabled: true, message: null }).success,
    ).toBe(true);
    expect(settingSchema('maintenance.mode').safeParse({ enabled: true }).success).toBe(false);
  });
});
