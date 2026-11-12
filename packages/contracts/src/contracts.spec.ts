import { describe, expect, it } from '@jest/globals';

import {
  ACTIVITY_TYPES,
  activityQuerySchema,
  ADMIN_KYC_CASE_STATUSES,
  adminKycCaseListQuerySchema,
  adminUserListQuerySchema,
  adminUserLookupRequestSchema,
  approveKycCaseRequestSchema,
  approveRoleChangeRequestSchema,
  createRoleChangeRequestSchema,
  ERROR_CODE_VALUES,
  ERROR_CODES,
  FEATURE_KEYS,
  featureFlagsSchema,
  isErrorCode,
  KYC_ADDRESS_PROOF_MAX_AGE_DAYS,
  KYC_CASE_STATUSES,
  KYC_CURSOR_PATTERN,
  KYC_DOCUMENT_CONTENT_TYPES,
  KYC_DOCUMENT_KINDS,
  KYC_DOCUMENT_MAX_BYTES,
  KYC_DOCUMENT_RULES,
  KYC_DRAFT_RETENTION_DAYS,
  KYC_FUNDS_EXPLANATION_MIN_LENGTH,
  KYC_FUNDS_SOURCES,
  KYC_IDENTITY_DOCUMENT_TYPES,
  KYC_LEVELS,
  KYC_REJECTION_REASONS,
  KYC_REJECTION_REASONS_MAX,
  KYC_REVIEW_PERMISSION,
  KYC_REVOCATION_PERMISSION,
  KYC_SELFIE_CONTENT_TYPES,
  KYC_TWO_SIDED_IDENTITY_DOCUMENTS,
  kycAddressDeclarationSchema,
  kycDocumentRule,
  kycDocumentUploadQuerySchema,
  kycFundsDeclarationSchema,
  kycIdentityDeclarationSchema,
  kycIdentitySchema,
  kycLevelSchema,
  kycVerifiedLevelSchema,
  loginRequestSchema,
  loginResponseSchema,
  mfaLoginRequestSchema,
  PERMISSION_KEY_PATTERN,
  PERMISSION_KEYS,
  permissionKeySchema,
  PERMISSIONS,
  problemDetailsSchema,
  registerRequestSchema,
  rejectKycCaseRequestSchema,
  rejectRoleChangeRequestSchema,
  revokeKycCaseRequestSchema,
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
    expect(SYSTEM_ROLE_KEYS).toEqual(['super_admin', 'support', 'compliance']);
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
    // La conformité examine les dossiers ; elle n'a aucune prise sur les comptes ni sur les rôles.
    expect([...SYSTEM_ROLES.compliance].sort()).toEqual([
      'kyc.read',
      'kyc.review',
      'kyc.revoke',
      'users.read',
    ]);
    // Seuls super_admin et la conformité voient des pièces d'identité.
    for (const key of SYSTEM_ROLE_KEYS) {
      const permissions: readonly string[] = SYSTEM_ROLES[key];
      expect(permissions.some((permission) => permission.startsWith('kyc.'))).toBe(
        key !== 'support',
      );
      expect(permissions.includes(ROLE_MANAGEMENT_PERMISSION)).toBe(key === 'super_admin');
    }
    expect(KYC_REVIEW_PERMISSION).toBe('kyc.review');
    expect(KYC_REVOCATION_PERMISSION).toBe('kyc.revoke');
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

describe('contrats de la vérification d’identité', () => {
  const UUID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
  const NOTE = 'Photo de la pièce illisible, ticket 311';

  const identity = {
    givenName: 'Jean',
    familyName: 'Mukendi',
    additionalName: 'Kabongo',
    dateOfBirth: '1990-05-17',
    placeOfBirth: 'Lubumbashi',
    nationality: 'CD',
    document: {
      type: 'PASSPORT',
      number: 'OP1234567',
      issuingCountry: 'CD',
      issuedOn: '2024-01-10',
      issuedAt: 'Kinshasa',
      expiresOn: '2029-01-09',
    },
  };
  const address = {
    addressLine1: '12 avenue Kasa-Vubu',
    city: 'Kinshasa',
    country: 'CD',
    proof: { type: 'UTILITY_BILL', issuedOn: '2026-10-20' },
  };
  const funds = {
    sources: ['EMPLOYMENT', 'SAVINGS'],
    occupation: 'Ingénieur des mines',
    explanation: 'Salaire mensuel et épargne constituée depuis 2015.',
  };

  it('trois niveaux, dans l’ordre ; le niveau vérifié d’un compte commence à zéro', () => {
    expect(KYC_LEVELS).toEqual([1, 2, 3]);
    for (const level of KYC_LEVELS) {
      expect(kycLevelSchema.parse(level)).toBe(level);
      expect(kycVerifiedLevelSchema.parse(level)).toBe(level);
    }
    expect(kycVerifiedLevelSchema.parse(0)).toBe(0);
    for (const invalid of [0, 4, -1, 1.5, '1', null]) {
      expect(kycLevelSchema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of [4, -1, 0.5, '0', null]) {
      expect(kycVerifiedLevelSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('la conformité ne voit jamais un dossier en préparation', () => {
    expect(KYC_CASE_STATUSES).toContain('DRAFT');
    expect(ADMIN_KYC_CASE_STATUSES).not.toContain('DRAFT');
    expect([...ADMIN_KYC_CASE_STATUSES].sort()).toEqual(
      KYC_CASE_STATUSES.filter((status) => status !== 'DRAFT').sort(),
    );
  });

  it('pièces attendues : chaque nature a sa place dans un seul niveau', () => {
    expect(kycDocumentRule(1, 'IDENTITY_FRONT')).toEqual({ min: 1, max: 1 });
    expect(kycDocumentRule(1, 'SELFIE')).toEqual({ min: 1, max: 1 });
    expect(kycDocumentRule(2, 'PROOF_OF_ADDRESS')).toEqual({ min: 1, max: 3 });
    expect(kycDocumentRule(3, 'SOURCE_OF_FUNDS')).toEqual({ min: 1, max: 5 });
    for (const kind of KYC_DOCUMENT_KINDS) {
      const levels = KYC_LEVELS.filter((level) => kycDocumentRule(level, kind) !== null);
      expect(levels).toHaveLength(1);
    }
    expect(kycDocumentRule(1, 'PROOF_OF_ADDRESS')).toBeNull();
    expect(kycDocumentRule(2, 'SELFIE')).toBeNull();
    expect(kycDocumentRule(3, 'IDENTITY_FRONT')).toBeNull();
  });

  it('le verso est exigé pour une pièce à deux faces, facultatif pour un passeport', () => {
    expect(kycDocumentRule(1, 'IDENTITY_BACK')).toEqual({ min: 0, max: 1 });
    expect(kycDocumentRule(1, 'IDENTITY_BACK', null)).toEqual({ min: 0, max: 1 });
    expect(kycDocumentRule(1, 'IDENTITY_BACK', 'PASSPORT')).toEqual({ min: 0, max: 1 });
    for (const type of KYC_TWO_SIDED_IDENTITY_DOCUMENTS) {
      expect(kycDocumentRule(1, 'IDENTITY_BACK', type)).toEqual({ min: 1, max: 1 });
      // La nature de la pièce d'identité ne change rien aux autres pièces.
      expect(kycDocumentRule(1, 'IDENTITY_FRONT', type)).toEqual({ min: 1, max: 1 });
      expect(kycDocumentRule(1, 'SELFIE', type)).toEqual({ min: 1, max: 1 });
    }
    expect([...KYC_TWO_SIDED_IDENTITY_DOCUMENTS, 'PASSPORT'].sort()).toEqual(
      [...KYC_IDENTITY_DOCUMENT_TYPES].sort(),
    );
    // Le catalogue lui-même n'est pas modifié par la règle du verso.
    expect(KYC_DOCUMENT_RULES[1].IDENTITY_BACK).toEqual({ min: 0, max: 1 });
  });

  it('formats et taille des pièces : JPEG, PNG ou PDF, 5 Mio ; un autoportrait est une image', () => {
    expect(KYC_DOCUMENT_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'application/pdf']);
    expect(KYC_SELFIE_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png']);
    expect(KYC_DOCUMENT_MAX_BYTES).toBe(5_242_880);
    expect(kycDocumentUploadQuerySchema.parse({ kind: 'SELFIE' })).toEqual({ kind: 'SELFIE' });
    for (const query of [
      {},
      { kind: 'selfie' },
      { kind: 'PASSPORT' },
      { kind: 'SELFIE', caseId: UUID },
      { kind: ['SELFIE', 'IDENTITY_FRONT'] },
    ]) {
      expect(kycDocumentUploadQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('déclaration d’identité : normalisée, complète, sans champ inconnu', () => {
    expect(
      kycIdentityDeclarationSchema.parse({
        ...identity,
        givenName: '  Jean ',
        additionalName: undefined,
        placeOfBirth: ' Lubumbashi ',
        document: { ...identity.document, number: ' op-123 456.7 ', expiresOn: undefined },
      }),
    ).toEqual({
      ...identity,
      additionalName: null,
      document: { ...identity.document, expiresOn: null },
    });

    for (const body of [
      {},
      { ...identity, givenName: '' },
      { ...identity, familyName: 'Mukendi <script>' },
      { ...identity, dateOfBirth: '17/05/1990' },
      { ...identity, dateOfBirth: '1990-02-30' },
      { ...identity, placeOfBirth: 'x'.repeat(101) },
      { ...identity, placeOfBirth: 'Lubum\u0007bashi' },
      { ...identity, nationality: 'cd' },
      { ...identity, nationality: 'COD' },
      { ...identity, document: undefined },
      { ...identity, document: { ...identity.document, type: 'RESIDENCE_PERMIT' } },
      { ...identity, document: { ...identity.document, number: 'A1' } },
      { ...identity, document: { ...identity.document, number: 'OP12;34' } },
      { ...identity, document: { ...identity.document, issuingCountry: 'Congo' } },
      { ...identity, document: { ...identity.document, issuedOn: '2024-13-01' } },
      { ...identity, document: { ...identity.document, issuedAt: '   ' } },
      { ...identity, document: { ...identity.document, expiresOn: 'never' } },
      { ...identity, document: { ...identity.document, numberMasked: '•••4567' } },
      { ...identity, level: 1 },
      { ...identity, status: 'APPROVED' },
      { ...identity, userId: UUID },
    ]) {
      expect(kycIdentityDeclarationSchema.safeParse(body).success).toBe(false);
    }
    expect(KYC_IDENTITY_DOCUMENT_TYPES).toEqual([
      'NATIONAL_ID_CARD',
      'VOTER_CARD',
      'PASSPORT',
      'DRIVING_LICENCE',
    ]);
  });

  it('déclaration d’adresse : normalisée, complète, sans champ inconnu', () => {
    expect(
      kycAddressDeclarationSchema.parse({ ...address, addressLine1: ' 12 avenue Kasa-Vubu ' }),
    ).toEqual({ ...address, addressLine2: null, region: null, postalCode: null });
    expect(
      kycAddressDeclarationSchema.parse({ ...address, region: 'Kinshasa', postalCode: '0001' }),
    ).toMatchObject({ region: 'Kinshasa', postalCode: '0001' });

    for (const body of [
      {},
      { ...address, addressLine1: '' },
      { ...address, addressLine1: 'x'.repeat(201) },
      { ...address, city: null },
      { ...address, postalCode: 'x'.repeat(21) },
      { ...address, country: 'rdc' },
      { ...address, proof: undefined },
      { ...address, proof: { type: 'SELFIE', issuedOn: '2026-10-20' } },
      { ...address, proof: { type: 'UTILITY_BILL', issuedOn: '20/10/2026' } },
      { ...address, proof: { type: 'UTILITY_BILL' } },
      { ...address, proof: { ...address.proof, verified: true } },
      { ...address, addressVerified: true },
    ]) {
      expect(kycAddressDeclarationSchema.safeParse(body).success).toBe(false);
    }
  });

  it('déclaration d’origine des fonds : une à plusieurs sources distinctes, une explication réelle', () => {
    expect(kycFundsDeclarationSchema.parse(funds)).toEqual({ ...funds, employerName: null });
    expect(
      kycFundsDeclarationSchema.parse({ ...funds, sources: [...KYC_FUNDS_SOURCES] }).sources,
    ).toHaveLength(KYC_FUNDS_SOURCES.length);
    expect(KYC_FUNDS_EXPLANATION_MIN_LENGTH).toBe(20);
    expect(
      kycFundsDeclarationSchema.safeParse({ ...funds, explanation: 'x'.repeat(20) }).success,
    ).toBe(true);

    for (const body of [
      {},
      { ...funds, sources: [] },
      { ...funds, sources: ['EMPLOYMENT', 'EMPLOYMENT'] },
      { ...funds, sources: ['LOTTERY'] },
      { ...funds, sources: 'EMPLOYMENT' },
      { ...funds, occupation: '' },
      { ...funds, occupation: 'x'.repeat(101) },
      { ...funds, employerName: 'x'.repeat(201) },
      { ...funds, explanation: 'x'.repeat(19) },
      // Les espaces ne comptent pas.
      { ...funds, explanation: `${'x'.repeat(10)}${' '.repeat(20)}` },
      { ...funds, explanation: 'x'.repeat(1001) },
      { ...funds, amount: '10000' },
    ]) {
      expect(kycFundsDeclarationSchema.safeParse(body).success).toBe(false);
    }
  });

  it('la file d’examen : dossiers en attente par défaut, pages bornées, curseur opaque', () => {
    expect(adminKycCaseListQuerySchema.parse({})).toEqual({ status: 'SUBMITTED', limit: 20 });
    expect(
      adminKycCaseListQuerySchema.parse({
        status: 'REJECTED',
        level: '2',
        userId: UUID,
        limit: '100',
        after: 'MjAyNi0xMS0xMlQxMDowMDowMC4wMDBafDAxOTVmM2Ey',
      }),
    ).toEqual({
      status: 'REJECTED',
      level: 2,
      userId: UUID,
      limit: 100,
      after: 'MjAyNi0xMS0xMlQxMDowMDowMC4wMDBafDAxOTVmM2Ey',
    });
    for (const query of [
      { status: 'DRAFT' },
      { status: 'submitted' },
      { level: '0' },
      { level: '4' },
      { level: '1.5' },
      { level: 'one' },
      { userId: 'abc' },
      { limit: '0' },
      { limit: '101' },
      { limit: '2.5' },
      { after: '' },
      { after: 'a b' },
      { after: 'a/b+c=' },
      { after: 'x'.repeat(201) },
      { email: 'jean@example.cd' },
      { before: UUID },
    ]) {
      expect(adminKycCaseListQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(KYC_CURSOR_PATTERN.test('abc-DEF_123')).toBe(true);
  });

  it('une acceptation se passe de note et même de corps', () => {
    expect(approveKycCaseRequestSchema.parse(undefined)).toEqual({});
    expect(approveKycCaseRequestSchema.parse({})).toEqual({});
    expect(approveKycCaseRequestSchema.parse({ note: '  Conforme à la pièce ' })).toEqual({
      note: 'Conforme à la pièce',
    });
    for (const body of [
      { note: '' },
      { note: '   ' },
      { note: 'x'.repeat(501) },
      { note: 42 },
      { reasons: ['OTHER'] },
      { level: 2 },
    ]) {
      expect(approveKycCaseRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('un refus donne un à cinq motifs distincts et une note interne ; un retrait est motivé', () => {
    expect(
      rejectKycCaseRequestSchema.parse({
        reasons: ['DOCUMENT_UNREADABLE', 'SELFIE_MISMATCH'],
        note: `  ${NOTE} `,
      }),
    ).toEqual({ reasons: ['DOCUMENT_UNREADABLE', 'SELFIE_MISMATCH'], note: NOTE });
    expect(KYC_REJECTION_REASONS_MAX).toBe(5);
    expect(
      rejectKycCaseRequestSchema.safeParse({
        reasons: KYC_REJECTION_REASONS.slice(0, 5),
        note: NOTE,
      }).success,
    ).toBe(true);
    for (const body of [
      {},
      { reasons: ['OTHER'] },
      { note: NOTE },
      { reasons: [], note: NOTE },
      { reasons: KYC_REJECTION_REASONS.slice(0, 6), note: NOTE },
      { reasons: ['OTHER', 'OTHER'], note: NOTE },
      { reasons: ['FRAUD'], note: NOTE },
      { reasons: 'OTHER', note: NOTE },
      // Neuf caractères : un de moins que le minimum.
      { reasons: ['OTHER'], note: 'trop bref' },
      { reasons: ['OTHER'], note: 'x'.repeat(501) },
      { reasons: ['OTHER'], note: NOTE, notifyUser: false },
    ]) {
      expect(rejectKycCaseRequestSchema.safeParse(body).success).toBe(false);
    }

    expect(revokeKycCaseRequestSchema.parse({ reason: ` ${NOTE} ` })).toEqual({ reason: NOTE });
    for (const body of [
      {},
      { reason: '' },
      { reason: 'trop bref' },
      { reason: 'x'.repeat(501) },
      { note: NOTE },
      { reason: NOTE, reasons: ['OTHER'] },
    ]) {
      expect(revokeKycCaseRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('le dossier rendu au titulaire ne porte que le numéro masqué de sa pièce', () => {
    const document = {
      type: 'PASSPORT',
      issuingCountry: 'CD',
      issuedOn: '2024-01-10',
      issuedAt: 'Kinshasa',
      expiresOn: null,
    };
    const { document: _declared, ...names } = identity;
    const parsed = kycIdentitySchema.parse({
      ...names,
      document: { ...document, numberMasked: '•••••4567', number: 'OP1234567' },
    });
    // Un numéro complet glissé dans la réponse ne franchit pas le contrat.
    expect(parsed.document).toEqual({ ...document, numberMasked: '•••••4567' });
    expect(kycIdentitySchema.safeParse({ ...names, document }).success).toBe(false);
  });

  it('délais : justificatif de trois mois au plus, brouillon effacé après trente jours', () => {
    expect(KYC_ADDRESS_PROOF_MAX_AGE_DAYS).toBe(92);
    expect(KYC_DRAFT_RETENTION_DAYS).toBe(30);
  });
});
