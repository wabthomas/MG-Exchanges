import { describe, expect, it } from '@jest/globals';

import {
  ACTIVITY_TYPES,
  activityQuerySchema,
  adminUserListQuerySchema,
  adminUserLookupRequestSchema,
  approveRoleChangeRequestSchema,
  createRoleChangeRequestSchema,
  ERROR_CODE_VALUES,
  ERROR_CODES,
  FEATURE_KEYS,
  featureFlagsSchema,
  isErrorCode,
  loginRequestSchema,
  loginResponseSchema,
  mfaLoginRequestSchema,
  PERMISSION_KEY_PATTERN,
  PERMISSION_KEYS,
  permissionKeySchema,
  PERMISSIONS,
  problemDetailsSchema,
  registerRequestSchema,
  rejectRoleChangeRequestSchema,
  ROLE_CHANGE_STATUSES,
  ROLE_KEY_PATTERN,
  ROLE_MANAGEMENT_PERMISSION,
  suspendUserRequestSchema,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLES,
  systemStatusSchema,
  totpDisableRequestSchema,
  updateProfileRequestSchema,
  updateSystemSettingRequestSchema,
  verifyEmailRequestSchema,
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

describe('contrats de sécurité du compte', () => {
  const UUID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  it('vérifier l’adresse exige aussi le mot de passe de l’inscription', () => {
    const valid = { email: 'a@b.cd', code: '123456', password: 'lumumba-boulevard-30' };
    expect(verifyEmailRequestSchema.safeParse(valid).success).toBe(true);
    expect(verifyEmailRequestSchema.safeParse({ email: 'a@b.cd', code: '123456' }).success).toBe(
      false,
    );
  });

  it('la réponse de connexion se lit par son `status`', () => {
    const pending = {
      status: 'MFA_REQUIRED',
      mfaToken: 'mgx_mfa_x',
      mfaTokenExpiresAt: '2026-11-11T20:15:42.123Z',
      methods: ['TOTP', 'RECOVERY_CODE'],
    };
    expect(loginResponseSchema.parse(pending)).toEqual(pending);
    expect(loginResponseSchema.safeParse({ ...pending, status: 'AUTHENTICATED' }).success).toBe(
      false,
    );
    expect(loginResponseSchema.safeParse({ ...pending, methods: ['SMS'] }).success).toBe(false);
  });

  it('la seconde étape et la désactivation exigent exactement une preuve du second facteur', () => {
    const token = { mfaToken: 'mgx_mfa_x' };
    expect(mfaLoginRequestSchema.parse({ ...token, code: '012345' })).toEqual({
      ...token,
      code: '012345',
    });
    // Le code de secours est normalisé par le contrat.
    expect(mfaLoginRequestSchema.parse({ ...token, recoveryCode: 'abcde-12345' })).toEqual({
      ...token,
      recoveryCode: 'ABCDE12345',
    });
    for (const body of [
      token,
      { ...token, code: '012345', recoveryCode: 'ABCDE-12345' },
      { code: '012345' },
      { ...token, code: '012345', email: 'a@b.cd' },
      { mfaToken: 'x'.repeat(257), code: '012345' },
    ]) {
      expect(mfaLoginRequestSchema.safeParse(body).success).toBe(false);
    }

    const password = { currentPassword: 'whatever-it-is' };
    expect(totpDisableRequestSchema.safeParse({ ...password, code: '012345' }).success).toBe(true);
    expect(
      totpDisableRequestSchema.safeParse({ ...password, recoveryCode: 'ABCDE-12345' }).success,
    ).toBe(true);
    expect(totpDisableRequestSchema.safeParse(password).success).toBe(false);
    expect(totpDisableRequestSchema.safeParse({ code: '012345' }).success).toBe(false);
  });

  it('le profil se modifie champ par champ ; seule la langue ne s’efface pas', () => {
    expect(updateProfileRequestSchema.parse({ givenName: ' Jean ', city: null })).toEqual({
      givenName: 'Jean',
      city: null,
    });
    expect(updateProfileRequestSchema.parse({ locale: 'en' })).toEqual({ locale: 'en' });
    for (const body of [
      {},
      { locale: null },
      { email: 'a@b.cd' },
      { givenName: 'Jean', id: UUID },
    ]) {
      expect(updateProfileRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('l’historique d’activité est une liste fermée, paginée et bornée', () => {
    expect(new Set(ACTIVITY_TYPES).size).toBe(ACTIVITY_TYPES.length);
    expect(activityQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(activityQuerySchema.parse({ limit: '100', before: UUID })).toEqual({
      limit: 100,
      before: UUID,
    });
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { userId: UUID }]) {
      expect(activityQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('contrats du back-office', () => {
  const UUID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
  const REASON = 'Signalement du service conformité';

  it('chaque rôle système ne détient que des permissions du catalogue ; seul super_admin gère les rôles', () => {
    expect(SYSTEM_ROLE_KEYS).toEqual(['super_admin', 'support']);
    for (const key of SYSTEM_ROLE_KEYS) {
      expect(key).toMatch(ROLE_KEY_PATTERN);
      const permissions: readonly string[] = SYSTEM_ROLES[key];
      expect(new Set(permissions).size).toBe(permissions.length);
      for (const permission of permissions) {
        expect(PERMISSION_KEYS).toContain(permission);
      }
    }
    expect([...SYSTEM_ROLES.super_admin].sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(PERMISSION_KEYS).toContain(ROLE_MANAGEMENT_PERMISSION);
    expect([...SYSTEM_ROLES.support].sort()).toEqual([
      'users.read',
      'users.revoke_sessions',
      'users.suspend',
    ]);
  });

  it('la recherche d’un compte prend exactement un identifiant, complet', () => {
    expect(adminUserLookupRequestSchema.parse({ email: ' Jean@Example.CD ' })).toEqual({
      email: 'jean@example.cd',
    });
    expect(adminUserLookupRequestSchema.parse({ phone: '+243812345678' })).toEqual({
      phone: '+243812345678',
    });
    expect(adminUserLookupRequestSchema.parse({ id: UUID })).toEqual({ id: UUID });
    for (const body of [
      {},
      { email: 'jean' },
      { email: '%@example.cd' },
      { phone: '0812345678' },
      { phone: '+2438123%' },
      { id: 'abc' },
      { email: 'a@b.cd', id: UUID },
      { phone: '+243812345678', email: 'a@b.cd' },
      { q: 'jean' },
      { email: 'a@b.cd', status: 'ACTIVE' },
    ]) {
      expect(adminUserLookupRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('la liste des comptes se parcourt par pages bornées, sans aucun identifiant dans l’URL', () => {
    expect(adminUserListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      adminUserListQuerySchema.parse({ status: 'SUSPENDED', limit: '50', before: UUID }),
    ).toEqual({ status: 'SUSPENDED', limit: 50, before: UUID });
    for (const query of [
      { status: 'DELETED' },
      { limit: '0' },
      { limit: '101' },
      { before: 'abc' },
      { email: 'a@b.cd' },
      { phone: '+243812345678' },
      { id: UUID },
    ]) {
      expect(adminUserListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('une action sur un compte est justifiée ; la suspension prévient le titulaire par défaut', () => {
    expect(suspendUserRequestSchema.parse({ reason: `  ${REASON} ` })).toEqual({
      reason: REASON,
      notifyUser: true,
    });
    expect(suspendUserRequestSchema.parse({ reason: REASON, notifyUser: false }).notifyUser).toBe(
      false,
    );
    for (const body of [
      {},
      { reason: 'neuf car.' },
      { reason: ' '.repeat(20) },
      { reason: 'x'.repeat(501) },
      { reason: REASON, notifyUser: 'no' },
      { reason: REASON, until: '2027-01-01' },
    ]) {
      expect(suspendUserRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('une demande de changement de rôle désigne un compte, un rôle, un sens et une raison', () => {
    const valid = { userId: UUID, roleKey: 'support', action: 'GRANT', reason: REASON };
    expect(createRoleChangeRequestSchema.parse(valid)).toEqual(valid);
    for (const body of [
      { ...valid, action: 'TRANSFER' },
      { ...valid, roleKey: 'Support Agent' },
      { ...valid, roleKey: 'x'.repeat(65) },
      { ...valid, userId: 'me' },
      { ...valid, reason: 'court' },
      { ...valid, status: 'APPROVED' },
      { ...valid, requestedBy: UUID },
    ]) {
      expect(createRoleChangeRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(ROLE_CHANGE_STATUSES).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
      'EXPIRED',
    ]);
  });

  it('une approbation se passe de note et même de corps ; un refus est motivé', () => {
    expect(approveRoleChangeRequestSchema.parse(undefined)).toEqual({});
    expect(approveRoleChangeRequestSchema.parse({})).toEqual({});
    expect(approveRoleChangeRequestSchema.parse({ note: ' Vu ' })).toEqual({ note: 'Vu' });
    expect(approveRoleChangeRequestSchema.safeParse({ note: '' }).success).toBe(false);
    expect(approveRoleChangeRequestSchema.safeParse({ decision: 'yes' }).success).toBe(false);

    expect(rejectRoleChangeRequestSchema.parse({ note: 'Formation non terminée' })).toEqual({
      note: 'Formation non terminée',
    });
    for (const body of [undefined, {}, { note: 'non' }, { reason: 'Mauvais champ utilisé' }]) {
      expect(rejectRoleChangeRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});
