import { describe, expect, it } from '@jest/globals';

import {
  ERROR_CODE_VALUES,
  ERROR_CODES,
  FEATURE_KEYS,
  featureFlagsSchema,
  isErrorCode,
  problemDetailsSchema,
  systemStatusSchema,
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
