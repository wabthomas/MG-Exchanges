import { describe, expect, it } from '@jest/globals';

import {
  ERROR_CODE_VALUES,
  ERROR_CODES,
  FEATURE_KEYS,
  featureFlagsSchema,
  isErrorCode,
  loginRequestSchema,
  PERMISSION_KEY_PATTERN,
  PERMISSION_KEYS,
  permissionKeySchema,
  PERMISSIONS,
  problemDetailsSchema,
  registerRequestSchema,
  systemStatusSchema,
  updateSystemSettingRequestSchema,
} from './index.js';

describe('catalogue des codes d’erreur', () => {
  it('associe chaque code à un statut HTTP d’erreur et à un titre', () => {
    expect(ERROR_CODE_VALUES.length).toBeGreaterThan(0);
    for (const code of ERROR_CODE_VALUES) {
      const { status, title } = ERROR_CODES[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
      expect(title.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('reconnaît uniquement les codes du catalogue', () => {
    expect(isErrorCode('VALIDATION_FAILED')).toBe(true);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('UNKNOWN')).toBe(false);
    expect(isErrorCode(404)).toBe(false);
  });
});

describe('problemDetailsSchema', () => {
  const valid = {
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    code: 'VALIDATION_FAILED',
    detail: 'Request validation failed.',
    instance: '/api/v1/example',
    requestId: '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
    timestamp: '2026-01-31T12:00:00.000Z',
    errors: [{ path: 'body.amount', message: 'Must be a canonical decimal string.' }],
  };

  it('accepte une erreur conforme, avec ou sans détail par champ', () => {
    expect(problemDetailsSchema.parse(valid)).toEqual(valid);
    const { errors: _errors, ...withoutErrors } = valid;
    expect(problemDetailsSchema.parse(withoutErrors)).toEqual(withoutErrors);
  });

  it('refuse un code inconnu ou un statut qui n’est pas une erreur', () => {
    expect(problemDetailsSchema.safeParse({ ...valid, code: 'SOMETHING_ELSE' }).success).toBe(
      false,
    );
    expect(problemDetailsSchema.safeParse({ ...valid, status: 200 }).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...valid, requestId: 'bad id' }).success).toBe(false);
  });
});

describe('systemStatusSchema', () => {
  const allDisabled = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]));

  it('exige un état explicite pour chaque fonctionnalité', () => {
    expect(featureFlagsSchema.parse(allDisabled)).toEqual(allDisabled);
    const { p2p: _p2p, ...missingOne } = allDisabled;
    expect(featureFlagsSchema.safeParse(missingOne).success).toBe(false);
  });

  it('valide une réponse complète', () => {
    const status = {
      service: 'mg-exchange-api',
      version: '0.1.0',
      serverTime: '2026-01-31T12:00:00.000Z',
      maintenance: { enabled: false, message: null },
      features: allDisabled,
    };
    expect(systemStatusSchema.parse(status)).toEqual(status);
  });
});

describe('contrats d’identité', () => {
  it('l’inscription exige l’acceptation explicite des conditions et refuse toute propriété inconnue', () => {
    const valid = {
      email: ' Jean@Example.com ',
      password: 'correct horse battery',
      countryCode: 'CD',
      acceptTerms: true,
    };
    expect(registerRequestSchema.parse(valid)).toEqual({ ...valid, email: 'jean@example.com' });

    expect(registerRequestSchema.safeParse({ ...valid, acceptTerms: false }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...valid, role: 'super_admin' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...valid, status: 'ACTIVE' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('la connexion n’applique pas les règles de choix du mot de passe', () => {
    expect(loginRequestSchema.parse({ email: 'A@b.cd', password: 'old' })).toEqual({
      email: 'a@b.cd',
      password: 'old',
    });
    expect(loginRequestSchema.safeParse({ email: 'a@b.cd', password: '' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.cd', password: 'x', deviceName: ' ' }).success,
    ).toBe(false);
  });

  it('chaque permission suit le format ressource.action et porte une description', () => {
    expect(PERMISSION_KEYS.length).toBeGreaterThan(0);
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(PERMISSION_KEY_PATTERN);
      expect(PERMISSIONS[key].length).toBeGreaterThan(10);
    }
    expect(permissionKeySchema.safeParse('wallets.drain').success).toBe(false);
  });

  it('une modification de paramètre exige une valeur typée et une justification', () => {
    expect(
      updateSystemSettingRequestSchema.parse({
        value: true,
        reason: '  Regulatory approval received  ',
      }),
    ).toEqual({ value: true, reason: 'Regulatory approval received' });
    expect(
      updateSystemSettingRequestSchema.parse({
        value: { enabled: true, message: null },
        reason: 'Planned database upgrade',
      }).value,
    ).toEqual({ enabled: true, message: null });

    expect(
      updateSystemSettingRequestSchema.safeParse({ value: true, reason: 'short' }).success,
    ).toBe(false);
    expect(
      updateSystemSettingRequestSchema.safeParse({ reason: 'No value provided here' }).success,
    ).toBe(false);
    expect(
      updateSystemSettingRequestSchema.safeParse({
        value: 'yes',
        reason: 'A string is not a value',
      }).success,
    ).toBe(false);
  });
});
