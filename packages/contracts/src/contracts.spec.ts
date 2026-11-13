import { describe, expect, it } from '@jest/globals';

import {
  acceptTermsRequestSchema,
  ACCOUNT_CLOSURE_BLOCKERS,
  ACCOUNT_CLOSURE_PERMISSION,
  ACTIVITY_TYPES,
  activityQuerySchema,
  ADMIN_KYC_CASE_STATUSES,
  adminKycCaseListQuerySchema,
  adminLedgerAccountListQuerySchema,
  adminLedgerPostingListQuerySchema,
  adminLedgerEntrySchema,
  adminUserListQuerySchema,
  adminUserLookupRequestSchema,
  approveKycCaseRequestSchema,
  approveRoleChangeRequestSchema,
  ASSET_KINDS,
  ASSET_NAME_MAX_LENGTH,
  ASSET_REGISTRATION_PERMISSION,
  ASSET_SCALE_MAX,
  createRoleChangeRequestSchema,
  DATA_EXPORT_FORMAT_VERSION,
  DATA_EXPORT_MOVEMENTS_MAX_ENTRIES,
  ERROR_CODE_VALUES,
  ERROR_CODES,
  exportedWalletSchema,
  FEATURE_KEYS,
  featureFlagsSchema,
  FINANCIAL_RECORDS_RETENTION_YEARS,
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
  LEDGER_ACCOUNT_TYPE_KEY_PATTERN,
  LEDGER_ACCOUNT_TYPE_KEYS,
  LEDGER_ACCOUNT_TYPES,
  LEDGER_ACTOR_TYPES,
  LEDGER_CURSOR_PATTERN,
  LEDGER_ENTRY_KIND_MAX_LENGTH,
  LEDGER_ENTRY_KIND_PATTERN,
  LEDGER_PAGE_MAX_SIZE,
  LEDGER_SIDES,
  loginRequestSchema,
  loginResponseSchema,
  mfaLoginRequestSchema,
  PERMISSION_KEY_PATTERN,
  PERMISSION_KEYS,
  permissionKeySchema,
  PERMISSIONS,
  problemDetailsSchema,
  publishTermsVersionRequestSchema,
  registerAssetRequestSchema,
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
  TERMS_BODY_MAX_LENGTH,
  TERMS_PUBLICATION_MAX_BYTES,
  TERMS_PUBLICATION_PERMISSION,
  TERMS_SUMMARY_MAX_LENGTH,
  termsLocaleQuerySchema,
  termsVersionNumberParamSchema,
  totpDisableRequestSchema,
  trialBalanceSchema,
  updateProfileRequestSchema,
  updateSystemSettingRequestSchema,
  verifyEmailRequestSchema,
  walletMovementListQuerySchema,
  walletMovementSchema,
  walletSchema,
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
  it('l’inscription exige le numéro de la version des conditions acceptée et refuse toute propriété inconnue', () => {
    const valid = {
      email: ' Jean@Example.com ',
      password: 'correct horse battery',
      countryCode: 'CD',
      acceptedTermsVersion: 3,
    };
    expect(registerRequestSchema.parse(valid)).toEqual({ ...valid, email: 'jean@example.com' });

    const { acceptedTermsVersion: _version, ...withoutVersion } = valid;
    expect(registerRequestSchema.safeParse(withoutVersion).success).toBe(false);
    // Une case cochée ne dit pas quel texte a été accepté : seul un numéro de version le dit.
    expect(registerRequestSchema.safeParse({ ...withoutVersion, acceptTerms: true }).success).toBe(
      false,
    );
    for (const version of [0, -1, 1.5, '3', true, null, 1_000_000_000]) {
      expect(
        registerRequestSchema.safeParse({ ...valid, acceptedTermsVersion: version }).success,
      ).toBe(false);
    }
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
    // La conformité examine les dossiers et clôt les comptes ; elle ne les suspend pas, ne
    // touche ni à leurs sessions ni à leur second facteur, et n'a aucune prise sur les rôles.
    expect([...SYSTEM_ROLES.compliance].sort()).toEqual([
      'kyc.read',
      'kyc.review',
      'kyc.revoke',
      'users.close',
      'users.read',
    ]);
    // Le support ne clôt pas un compte : la clôture est définitive.
    expect(SYSTEM_ROLES.support).not.toContain(ACCOUNT_CLOSURE_PERMISSION);
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
    // Publier les conditions d'utilisation engage la plateforme : super_admin seulement.
    expect(TERMS_PUBLICATION_PERMISSION).toBe('terms.publish');
    for (const key of SYSTEM_ROLE_KEYS) {
      const permissions: readonly string[] = SYSTEM_ROLES[key];
      expect(permissions.includes(TERMS_PUBLICATION_PERMISSION)).toBe(key === 'super_admin');
    }
    // Le grand livre — les opérations de tous les titulaires — n'est ouvert ni au support ni à
    // la conformité ; enregistrer un actif est définitif.
    expect(ASSET_REGISTRATION_PERMISSION).toBe('ledger.manage_assets');
    expect(PERMISSION_KEYS.filter((permission) => permission.startsWith('ledger.'))).toEqual([
      'ledger.read',
      'ledger.manage_assets',
    ]);
    for (const key of SYSTEM_ROLE_KEYS) {
      const permissions: readonly string[] = SYSTEM_ROLES[key];
      expect(permissions.some((permission) => permission.startsWith('ledger.'))).toBe(
        key === 'super_admin',
      );
    }
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

describe('contrats des conditions d’utilisation', () => {
  const REASON = 'Version validée par le conseil le 12 novembre';
  const fr = { summary: 'Première version.', body: '# Conditions\n\nArticle 1 — Objet.\n' };
  const publication = {
    number: 1,
    requiresAcceptance: true,
    reason: REASON,
    fr,
  };

  it('une publication désigne son numéro, sa règle et sa justification', () => {
    expect(publishTermsVersionRequestSchema.parse(publication)).toEqual(publication);
    const en = { summary: 'First version.', body: '# Terms\n\nArticle 1 — Purpose.\n' };
    expect(publishTermsVersionRequestSchema.parse({ ...publication, en })).toEqual({
      ...publication,
      en,
    });
    // La justification est débarrassée de ses espaces superflus ; le texte, jamais.
    expect(
      publishTermsVersionRequestSchema.parse({
        ...publication,
        reason: `  ${REASON} `,
        fr: { summary: ' Résumé \n', body: '\n  Texte.  \n\n' },
      }),
    ).toEqual({ ...publication, fr: { summary: ' Résumé \n', body: '\n  Texte.  \n\n' } });

    for (const field of ['number', 'requiresAcceptance', 'reason', 'fr']) {
      const { [field]: _omitted, ...incomplete } = publication as Record<string, unknown>;
      expect(publishTermsVersionRequestSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const override of [
      { number: 0 },
      { number: 1.5 },
      { number: '1' },
      { requiresAcceptance: 'true' },
      { requiresAcceptance: 1 },
      // L'annonce par e-mail n'existe pas : la demander est une erreur, pas un oubli silencieux.
      { notifyHolders: true },
      // Neuf caractères : un de moins que le minimum.
      { reason: 'trop bref' },
      { reason: 'x'.repeat(501) },
      { fr: { summary: 'Résumé.' } },
      { fr: { body: 'Texte.' } },
      { fr: { summary: '   ', body: 'Texte.' } },
      { fr: { summary: 'Résumé.', body: ' \n\t ' } },
      { fr: { summary: 'Résumé.', body: 'nul\u0000' } },
      { fr: { summary: 'sonnerie\u0007', body: 'Texte.' } },
      { fr: { summary: 'Résumé.', body: 'Texte.', title: 'Conditions' } },
      { en: { summary: 'Summary.' } },
      { en: null },
      // Une langue que la plateforme ne connaît pas.
      { sw: fr },
      { publishedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(
        publishTermsVersionRequestSchema.safeParse({ ...publication, ...override }).success,
      ).toBe(false);
    }
  });

  it('la première version exige toujours d’être acceptée ; les suivantes, au choix', () => {
    const informative = { ...publication, requiresAcceptance: false };
    const refused = publishTermsVersionRequestSchema.safeParse({ ...informative, number: 1 });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'requiresAcceptance',
    ]);
    expect(publishTermsVersionRequestSchema.safeParse({ ...publication, number: 1 }).success).toBe(
      true,
    );
    for (const number of [2, 3, 40]) {
      for (const requiresAcceptance of [true, false]) {
        expect(
          publishTermsVersionRequestSchema.safeParse({ ...publication, number, requiresAcceptance })
            .success,
        ).toBe(true);
      }
    }
  });

  it('le texte et son résumé sont bornés ; la requête entière aussi', () => {
    expect(TERMS_BODY_MAX_LENGTH).toBe(200_000);
    expect(TERMS_SUMMARY_MAX_LENGTH).toBe(1000);
    expect(TERMS_PUBLICATION_MAX_BYTES).toBe(1_048_576);

    const atLimit = { summary: 's'.repeat(1000), body: 'b'.repeat(200_000) };
    expect(
      publishTermsVersionRequestSchema.safeParse({ ...publication, fr: atLimit, en: atLimit })
        .success,
    ).toBe(true);
    for (const text of [
      { ...atLimit, summary: 's'.repeat(1001) },
      { ...atLimit, body: 'b'.repeat(200_001) },
    ]) {
      expect(publishTermsVersionRequestSchema.safeParse({ ...publication, fr: text }).success).toBe(
        false,
      );
      expect(publishTermsVersionRequestSchema.safeParse({ ...publication, en: text }).success).toBe(
        false,
      );
    }
    // Deux textes de la longueur maximale tiennent dans une requête. Ceux-ci sont sans
    // caractère accentué : un caractère y vaut un octet.
    const { reason: _reason, ...fixed } = publication;
    const largest = { ...fixed, reason: 'r'.repeat(500), fr: atLimit, en: atLimit };
    expect(JSON.stringify(largest).length).toBeLessThan(TERMS_PUBLICATION_MAX_BYTES / 2);
  });

  it('une acceptation désigne la version lue, par son numéro', () => {
    expect(acceptTermsRequestSchema.parse({ version: 2 })).toEqual({ version: 2 });
    for (const body of [
      {},
      { version: 0 },
      { version: '2' },
      { version: 2.5 },
      { version: 2, accept: true },
      { number: 2 },
    ]) {
      expect(acceptTermsRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('un numéro de version, dans une adresse, s’écrit en chiffres sans zéro de tête', () => {
    expect(termsVersionNumberParamSchema.parse('1')).toBe(1);
    expect(termsVersionNumberParamSchema.parse('42')).toBe(42);
    expect(termsVersionNumberParamSchema.parse('999999999')).toBe(999_999_999);
    for (const value of ['0', '01', '-1', '1.0', '1e3', ' 1', '1 ', 'current', '', '1000000000']) {
      expect(termsVersionNumberParamSchema.safeParse(value).success).toBe(false);
    }
  });

  it('la langue demandée est le français, sauf mention contraire', () => {
    expect(termsLocaleQuerySchema.parse({})).toEqual({ locale: 'fr' });
    expect(termsLocaleQuerySchema.parse({ locale: 'en' })).toEqual({ locale: 'en' });
    for (const query of [{ locale: 'sw' }, { locale: 'FR' }, { locale: 'fr', version: '1' }]) {
      expect(termsLocaleQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('contrats du grand livre', () => {
  const UUID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
  const REASON = 'Ouverture du service en dollars';
  const usd = { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 };

  it('le plan de comptes : à qui appartient chaque type, et quel sens augmente son solde', () => {
    expect(LEDGER_ACCOUNT_TYPES).toEqual({
      // Ce que la plateforme doit à un titulaire : un crédit l'augmente.
      user_available: { owner: 'USER', normalSide: 'CREDIT', description: expect.any(String) },
      // Ce qu'elle conserve pour eux hors du grand livre : un débit l'augmente.
      platform_custody: { owner: 'PLATFORM', normalSide: 'DEBIT', description: expect.any(String) },
      platform_fees: { owner: 'PLATFORM', normalSide: 'CREDIT', description: expect.any(String) },
    });
    expect(LEDGER_ACCOUNT_TYPE_KEYS).toEqual([
      'user_available',
      'platform_custody',
      'platform_fees',
    ]);
    for (const key of LEDGER_ACCOUNT_TYPE_KEYS) {
      expect(key).toMatch(LEDGER_ACCOUNT_TYPE_KEY_PATTERN);
      expect(key.length).toBeLessThanOrEqual(64);
      expect(LEDGER_ACCOUNT_TYPES[key].description.length).toBeGreaterThan(10);
      // Le préfixe dit à qui appartient le compte.
      expect(key.startsWith('user_')).toBe(LEDGER_ACCOUNT_TYPES[key].owner === 'USER');
      expect(key.startsWith('platform_')).toBe(LEDGER_ACCOUNT_TYPES[key].owner === 'PLATFORM');
    }
    expect(LEDGER_SIDES).toEqual(['DEBIT', 'CREDIT']);
    expect(LEDGER_ACTOR_TYPES).toEqual(['USER', 'SYSTEM', 'SERVICE']);
  });

  it('le type d’une écriture : des mots en minuscules séparés par des points, 64 caractères au plus', () => {
    for (const kind of [
      'transfer',
      'transfer.internal',
      'deposit.mobile_money.confirmed',
      'a1.b2',
    ]) {
      expect(kind).toMatch(LEDGER_ENTRY_KIND_PATTERN);
    }
    for (const kind of [
      '',
      'Transfer',
      'transfer.',
      '.transfer',
      'transfer..internal',
      '1transfer',
      'transfer.1',
      'transfer-internal',
      'transfer internal',
      'transfer.internal\n',
    ]) {
      expect(kind).not.toMatch(LEDGER_ENTRY_KIND_PATTERN);
    }
    expect(LEDGER_ENTRY_KIND_MAX_LENGTH).toBe(64);
  });

  it('enregistrer un actif : un code, un libellé, une nature, de 0 à 18 décimales — et une raison', () => {
    const request = { ...usd, reason: REASON };
    expect(registerAssetRequestSchema.parse(request)).toEqual(request);
    expect(
      registerAssetRequestSchema.parse({ ...request, name: '  US dollar ', reason: ` ${REASON} ` }),
    ).toEqual(request);
    expect(ASSET_KINDS).toEqual(['FIAT', 'CRYPTO']);
    expect(ASSET_SCALE_MAX).toBe(18);
    expect(ASSET_NAME_MAX_LENGTH).toBe(64);
    for (const scale of [0, 8, 18]) {
      expect(registerAssetRequestSchema.safeParse({ ...request, scale }).success).toBe(true);
    }
    expect(registerAssetRequestSchema.safeParse({ ...request, name: 'n'.repeat(64) }).success).toBe(
      true,
    );

    for (const invalid of [
      { ...request, code: 'usd' },
      { ...request, code: 'U' },
      { ...request, code: undefined },
      { ...request, name: '' },
      { ...request, name: '   ' },
      { ...request, name: 'n'.repeat(65) },
      { ...request, name: 'US\tdollar' },
      { ...request, kind: 'STABLECOIN' },
      { ...request, kind: 'fiat' },
      { ...request, scale: -1 },
      { ...request, scale: 19 },
      { ...request, scale: 2.5 },
      { ...request, scale: '2' },
      { ...request, scale: undefined },
      { ...request, reason: undefined },
      { ...request, reason: 'trop bref' },
      { ...request, reason: 'r'.repeat(501) },
      { ...request, decimals: 2 },
    ]) {
      expect(registerAssetRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('un montant est une chaîne décimale, jamais un nombre', () => {
    expect(walletSchema.parse({ asset: usd, available: '12.34' })).toEqual({
      asset: usd,
      available: '12.34',
    });
    for (const available of [12.34, 12, '12,34', '1e3', ' 12.34', '', null]) {
      expect(walletSchema.safeParse({ asset: usd, available }).success).toBe(false);
    }
    const movement = {
      id: UUID,
      entryId: UUID,
      kind: 'transfer.internal',
      side: 'DEBIT',
      amount: '10.00',
      balanceAfter: '2.34',
      postedAt: '2026-11-13T10:00:00.000Z',
    };
    expect(walletMovementSchema.parse(movement)).toEqual(movement);
    for (const invalid of [
      { ...movement, amount: 10 },
      { ...movement, balanceAfter: 2.34 },
      { ...movement, side: 'debit' },
      { ...movement, side: 'IN' },
      { ...movement, postedAt: '13/11/2026' },
      { ...movement, id: 'not-an-id' },
    ]) {
      expect(walletMovementSchema.safeParse(invalid).success).toBe(false);
    }
    // Un type d'écriture inconnu du client reste lisible : les types arrivent avec les opérations.
    expect(walletMovementSchema.safeParse({ ...movement, kind: 'something.new' }).success).toBe(
      true,
    );
  });

  it('les mouvements se lisent par pages de 1 à 100, vingt par défaut, avec un curseur opaque', () => {
    expect(walletMovementListQuerySchema.parse({})).toEqual({ limit: 20 });
    // Les paramètres d'une URL arrivent en texte.
    expect(walletMovementListQuerySchema.parse({ limit: '100', after: 'Mw' })).toEqual({
      limit: 100,
      after: 'Mw',
    });
    expect(LEDGER_PAGE_MAX_SIZE).toBe(100);
    expect(walletMovementListQuerySchema.safeParse({ limit: '1' }).success).toBe(true);
    for (const invalid of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { limit: 'ten' },
      { after: '' },
      { after: 'a+b' },
      { after: 'a/b' },
      { after: 'a=' },
      { after: 'A'.repeat(129) },
      { userId: UUID },
      { before: 'Mw' },
    ]) {
      expect(walletMovementListQuerySchema.safeParse(invalid).success).toBe(false);
    }
    expect('A'.repeat(128)).toMatch(LEDGER_CURSOR_PATTERN);
    expect('aZ09_-').toMatch(LEDGER_CURSOR_PATTERN);
    expect('Mw\n').not.toMatch(LEDGER_CURSOR_PATTERN);
  });

  it('la liste des comptes se filtre par titulaire, actif ou type — rien d’autre', () => {
    expect(adminLedgerAccountListQuerySchema.parse({})).toEqual({ limit: 20 });
    const query = { userId: UUID, assetCode: 'USD', type: 'user_available', limit: '50' };
    expect(adminLedgerAccountListQuerySchema.parse(query)).toEqual({ ...query, limit: 50 });
    for (const type of LEDGER_ACCOUNT_TYPE_KEYS) {
      expect(adminLedgerAccountListQuerySchema.safeParse({ type }).success).toBe(true);
    }
    for (const invalid of [
      { userId: 'alice' },
      { assetCode: 'usd' },
      { type: 'user_locked' },
      { type: 'USER_AVAILABLE' },
      { limit: '101' },
      { email: 'alice@example.cd' },
      { owner: 'USER' },
    ]) {
      expect(adminLedgerAccountListQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('les lignes d’un compte se lisent par pages, sans aucun filtre', () => {
    expect(adminLedgerPostingListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminLedgerPostingListQuerySchema.parse({ limit: '100', after: 'Mw' })).toEqual({
      limit: 100,
      after: 'Mw',
    });
    for (const invalid of [
      { limit: '0' },
      { limit: '101' },
      { after: '' },
      { after: 'a+b' },
      { assetCode: 'USD' },
      { userId: UUID },
      { before: 'Mw' },
    ]) {
      expect(adminLedgerPostingListQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('une écriture rendue au back-office porte son auteur, sa clé et ses lignes', () => {
    const entry = {
      id: UUID,
      kind: 'transfer.internal',
      idempotencyKey: 'transfer:0195f3a2',
      actor: { type: 'USER', id: UUID },
      requestId: 'req-1',
      metadata: { transferId: 'tr_1', attempt: 1, confirmed: true, note: null },
      postedAt: '2026-11-13T10:00:00.000Z',
      postings: [
        {
          id: UUID,
          lineNumber: 1,
          account: { id: UUID, type: 'user_available', owner: 'USER', userId: UUID },
          asset: usd,
          side: 'DEBIT',
          amount: '10.00',
          balanceAfter: '2.34',
          accountSequence: 7,
        },
      ],
    };
    expect(adminLedgerEntrySchema.parse(entry)).toEqual(entry);
    // La plateforme elle-même : sans identifiant d'auteur ni requête.
    expect(
      adminLedgerEntrySchema.safeParse({
        ...entry,
        actor: { type: 'SYSTEM', id: null },
        requestId: null,
        metadata: {},
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...entry, actor: { type: 'ADMIN', id: UUID } },
      { ...entry, postings: [{ ...entry.postings[0], amount: 10 }] },
      { ...entry, postings: [{ ...entry.postings[0], lineNumber: 0 }] },
      { ...entry, postings: [{ ...entry.postings[0], accountSequence: 0 }] },
      { ...entry, postings: [{ ...entry.postings[0], side: 'BOTH' }] },
    ]) {
      expect(adminLedgerEntrySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('la balance donne, par actif, un total pour chaque type du plan de comptes', () => {
    const balance = {
      generatedAt: '2026-11-13T10:00:00.000Z',
      balanced: true,
      assets: [
        {
          asset: usd,
          debitBalance: '117.50',
          creditBalance: '117.50',
          balanced: true,
          accountTypes: LEDGER_ACCOUNT_TYPE_KEYS.map((type) => ({
            type,
            owner: LEDGER_ACCOUNT_TYPES[type].owner,
            normalSide: LEDGER_ACCOUNT_TYPES[type].normalSide,
            accounts: 1,
            balance: '0.00',
          })),
        },
      ],
    };
    expect(trialBalanceSchema.parse(balance)).toEqual(balance);
    expect(trialBalanceSchema.safeParse({ ...balance, assets: [] }).success).toBe(true);
    expect(
      trialBalanceSchema.safeParse({
        ...balance,
        assets: [{ ...balance.assets[0], debitBalance: 117.5 }],
      }).success,
    ).toBe(false);
  });

  it('clôture et copie des données : des fonds s’opposent à la clôture, les écritures se gardent dix ans', () => {
    expect(ACCOUNT_CLOSURE_BLOCKERS).toEqual([
      'ROLE_HELD',
      'VERIFICATION_PENDING_REVIEW',
      'FUNDS_REMAINING',
    ]);
    expect(FINANCIAL_RECORDS_RETENTION_YEARS).toBe(10);
    // Le format de la copie change de version avec les portefeuilles.
    expect(DATA_EXPORT_FORMAT_VERSION).toBe(3);
    expect(DATA_EXPORT_MOVEMENTS_MAX_ENTRIES).toBe(2000);
    const wallet = { asset: usd, available: '2.34', movements: [], truncated: false };
    expect(exportedWalletSchema.parse(wallet)).toEqual(wallet);
    expect(exportedWalletSchema.safeParse({ asset: usd, available: '2.34' }).success).toBe(false);
  });
});
