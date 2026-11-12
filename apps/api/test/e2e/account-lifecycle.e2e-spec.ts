import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  accountClosureSchema,
  activityListSchema,
  adminAccountClosureSchema,
  adminKycCaseListSchema,
  adminUserDetailSchema,
  adminUserLookupResultSchema,
  CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS,
  currentUserSchema,
  DATA_EXPORTS_PER_DAY,
  dataExportSchema,
  type KycCase,
  kycCaseSchema,
  problemDetailsSchema,
  recoveryCodesSchema,
  totpEnrollmentSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { ActivityService } from '../../src/modules/identity/application/activity.service.js';
import { PendingLoginStore } from '../../src/modules/identity/application/pending-login.store.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../../src/modules/identity/domain/identity-events.js';
import { OutboxService } from '../../src/modules/outbox/application/outbox.service.js';
import { moveErasureTerm } from '../support/account-closure.js';
import {
  backgroundWorkDone,
  bearer,
  codeIn,
  createAdmin,
  enableSecondFactor,
  from,
  type Http,
  login,
  mailbox,
  newClientIp,
  newEmail,
  nextMessageOf,
  nextTotpCode,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
  TEST_DEVICE_ID,
  withOwner,
  wrongTotpCode,
} from '../support/identity.js';
import {
  createKycStorage,
  identityDeclaration,
  jpeg,
  type KycTestStorage,
  newDocumentNumber,
  png,
  type TestFile,
} from '../support/kyc.js';
import { LateWriteGate, LateWriteModule } from '../support/late-write.module.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';
import { withConnection } from '../support/test-database.js';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const REASON = 'Demande reçue par courrier, dossier support 2026-0457';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

describe('Clôture du compte, effacement et copie des données — bout en bout', () => {
  let storage: KycTestStorage;
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  let maintenance: AccountMaintenanceService;
  /** Agents partagés par les tests : conformité (deux), support et administrateur. */
  let claire: Member;
  let david: Member;
  let support: Member;
  let root: Member;

  const get = (accessToken: string, path: string) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp()));
  const post = (accessToken: string, path: string, body?: Record<string, unknown>) =>
    http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const put = (accessToken: string, path: string, body: Record<string, unknown>) =>
    http.put(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const codeOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body).code;
  const detailOf = (response: { body: unknown }) =>
    problemDetailsSchema.parse(response.body).detail;

  /** Utilisateur final connecté. */
  async function customer(overrides: Partial<RegisteredUser> = {}): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, overrides);
    const session = await login(http, user);
    return {
      ...user,
      id: session.user.id,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
    };
  }

  /** Utilisateur final dont le second facteur est activé par l'API, avec ses codes de secours. */
  async function protectedCustomer(): Promise<Member & { recoveryCodes: readonly string[] }> {
    const member = await customer();
    const enrollment = totpEnrollmentSchema.parse(
      (
        await post(member.accessToken, '/me/mfa/totp/enroll', {
          currentPassword: member.password,
        }).expect(200)
      ).body,
    );
    const { recoveryCodes } = recoveryCodesSchema.parse(
      (
        await post(member.accessToken, '/me/mfa/totp/confirm', {
          code: nextTotpCode(enrollment.secret),
        }).expect(200)
      ).body,
    );
    return { ...member, totpSecret: enrollment.secret, recoveryCodes };
  }

  /** Membre du personnel : un rôle, le second facteur activé, connecté. */
  async function staff(roleKey: string): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, { email: newEmail(roleKey) });
    const first = await login(http, user);
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
      await owner.userRole.create({ data: { userId: first.user.id, roleId: role.id } });
    });
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return {
      ...user,
      totpSecret,
      id: first.user.id,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
    };
  }

  const caseOf = (response: { body: unknown }): KycCase => kycCaseSchema.parse(response.body);
  const upload = (member: Member, caseId: string, kind: string, file: TestFile) =>
    http
      .post(`/api/v1/me/verification/cases/${caseId}/documents?kind=${kind}`)
      .set(bearer(member.accessToken))
      .set(from(newClientIp()))
      .set('Content-Type', file.contentType)
      .send(file.content);

  /** Dossier de niveau 1 en préparation, avec ses deux pièces obligatoires. */
  async function identityDraft(member: Member, number = newDocumentNumber()): Promise<KycCase> {
    const draft = caseOf(
      await put(
        member.accessToken,
        '/me/verification/identity',
        identityDeclaration({ document: { number } }),
      ).expect(200),
    );
    await upload(member, draft.id, 'IDENTITY_FRONT', jpeg(`front:${draft.id}`)).expect(201);
    return caseOf(await upload(member, draft.id, 'SELFIE', png(`selfie:${draft.id}`)).expect(201));
  }

  async function submittedIdentity(member: Member, number?: string): Promise<KycCase> {
    const draft = await identityDraft(member, number);
    return caseOf(
      await post(member.accessToken, `/me/verification/cases/${draft.id}/submit`).expect(200),
    );
  }

  const approve = (reviewer: Member, caseId: string) =>
    post(reviewer.accessToken, `/admin/kyc/cases/${caseId}/approve`);
  const reject = (reviewer: Member, caseId: string) =>
    post(reviewer.accessToken, `/admin/kyc/cases/${caseId}/reject`, {
      reasons: ['DOCUMENT_UNREADABLE'],
      note: 'Photo de la pièce illisible, voir ticket conformité 2026-0311',
    });

  /** Utilisateur final dont l'identité (niveau 1) est vérifiée. */
  async function verifiedCustomer(number?: string): Promise<Member & { caseId: string }> {
    const member = await customer();
    const submitted = await submittedIdentity(member, number);
    await approve(claire, submitted.id).expect(200);
    return { ...member, caseId: submitted.id };
  }

  const closeOwn = (member: Member, body: Record<string, unknown> = {}) =>
    post(member.accessToken, '/me/close', {
      currentPassword: member.password,
      confirm: true,
      ...body,
    });
  const exportData = (member: Member, body: Record<string, unknown> = {}) =>
    post(member.accessToken, '/me/data-export', { currentPassword: member.password, ...body });
  const closeByStaff = (agent: Member, userId: string, body: Record<string, unknown> = {}) =>
    post(agent.accessToken, `/admin/users/${userId}/close`, {
      ground: 'PLATFORM_DECISION',
      reason: REASON,
      confirm: true,
      ...body,
    });

  const accountRow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const closureRow = (userId: string) => prisma.accountClosure.findUnique({ where: { userId } });
  const auditEntries = (action: string, resourceId: string) =>
    prisma.auditLog.findMany({ where: { action, resourceId }, orderBy: { id: 'asc' } });
  const storedFilesOf = async (caseId: string) =>
    (await prisma.kycDocument.findMany({ where: { caseId }, select: { storageKey: true } }))
      .map(({ storageKey }) => storageKey)
      .sort();
  const asOwner = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);
  const detailFor = async (agent: Member, userId: string) =>
    adminUserDetailSchema.parse(
      (await get(agent.accessToken, `/admin/users/${userId}`).expect(200)).body,
    );

  let nextSubscriber = 20_000_000;
  /** Numéro mobile congolais (+243 8x) jamais utilisé par un autre test. */
  const newPhone = (): string => {
    nextSubscriber += 1;
    return `+2438${String(nextSubscriber)}`;
  };

  /** Vérifie `phone` pour `member` ; `received` : rang du SMS attendu pour ce numéro. */
  async function verifyPhone(member: Member, phone: string, received = 1): Promise<void> {
    await post(member.accessToken, '/me/phone/verification', { phone }).expect(202);
    const sms = await nextMessageOf(testApp, phone, 'phone_verification_code', received);
    await post(member.accessToken, '/me/phone/verify', { code: codeIn(sms) }).expect(204);
  }

  /**
   * Tables de la base dont au moins une ligne contient `needle`, où que ce soit : chaque ligne
   * est relue en entier, colonnes JSON comprises.
   */
  async function tablesHolding(needle: string): Promise<string[]> {
    return asOwner(async (owner) => {
      const tables = await owner.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      const holding: string[] = [];
      for (const { name } of tables.rows) {
        const found = await owner.query(
          `SELECT 1 FROM "${name}" AS t
           WHERE strpos(lower(to_jsonb(t)::text), lower($1)) > 0 LIMIT 1`,
          [needle],
        );
        if ((found.rowCount ?? 0) > 0) {
          holding.push(name);
        }
      }
      return holding;
    });
  }

  beforeAll(async () => {
    storage = createKycStorage();
    testApp = await createTestApp({
      imports: [LateWriteModule],
      env: { TRUST_PROXY_HOPS: '1', ...storage.env },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    maintenance = testApp.app.get(AccountMaintenanceService);
    await openFeature(testApp, 'registration');
    await openFeature(testApp, 'kyc');
    claire = await staff('compliance');
    david = await staff('compliance');
    support = await staff('support');
    const admin = await createAdmin(testApp);
    const session = await login(http, admin);
    root = {
      ...admin,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
    };
  });

  afterAll(async () => {
    await testApp.close();
    storage.remove();
  });

  describe('copie des données', () => {
    it('exige une session, puis le mot de passe : une session ouverte ne suffit pas', async () => {
      const member = await customer();

      await http
        .post('/api/v1/me/data-export')
        .send({ currentPassword: member.password })
        .expect(401);
      const missing = await post(member.accessToken, '/me/data-export', {}).expect(400);
      expect(codeOf(missing)).toBe('VALIDATION_FAILED');
      const unknownField = await exportData(member, { format: 'csv' }).expect(400);
      expect(codeOf(unknownField)).toBe('VALIDATION_FAILED');

      const wrong = await exportData(member, { currentPassword: 'not-the-password-1' }).expect(401);
      expect(codeOf(wrong)).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.account).toBeUndefined();

      // L'échec est inscrit au journal, et visible du titulaire dans son historique.
      const [failure] = await auditEntries('user.data_export_failed', member.id);
      expect(failure).toMatchObject({ actorId: member.id, outcome: 'FAILURE' });
      expect(failure?.metadata).toEqual({ reason: 'WRONG_PASSWORD' });
      expect(await auditEntries('user.data_exported', member.id)).toEqual([]);
      const activity = activityListSchema.parse(
        (await get(member.accessToken, '/me/activity').expect(200)).body,
      );
      expect(activity.entries[0]).toMatchObject({ type: 'DATA_EXPORT_FAILED', outcome: 'FAILURE' });
      // Aucun message : rien n'a été remis.
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(member.email)
          .filter(({ template }) => template === 'data_exported'),
      ).toEqual([]);
    });

    it('rassemble ce que la plateforme détient sur le compte — sans secret, sans fichier, sans numéro de pièce', async () => {
      const number = newDocumentNumber();
      const member = await verifiedCustomer(number);
      // Le nom et le prénom sont ceux du dossier vérifié ; le reste du profil est déclaré.
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .set(from(newClientIp()))
        .send({ city: 'Kinshasa', region: 'Kinshasa', timeZone: 'Africa/Kinshasa' })
        .expect(200);
      const ip = newClientIp();

      const response = await http
        .post('/api/v1/me/data-export')
        .set(bearer(member.accessToken))
        .set(from(ip))
        .send({ currentPassword: member.password })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="mg-exchange-data.json"',
      );
      // Un document personnel ne se met pas en cache.
      expect(response.headers['cache-control']).toMatch(/no-store/);
      const copy = dataExportSchema.parse(response.body);
      // Le schéma publié décrit tout le document : aucune clé n'en sort.
      expect(response.body).toEqual(copy);

      expect(copy.formatVersion).toBe(1);
      expect(copy.account).toMatchObject({
        id: member.id,
        email: member.email,
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        countryCode: 'CD',
        accountType: 'INDIVIDUAL',
        status: 'ACTIVE',
        roles: [],
      });
      // Le profil déclaré ; l'identité vérifiée est dans le dossier, plus bas.
      expect(copy.profile).toMatchObject({
        givenName: null,
        familyName: null,
        city: 'Kinshasa',
        region: 'Kinshasa',
        timeZone: 'Africa/Kinshasa',
        dateOfBirth: null,
      });
      expect(copy.security).toMatchObject({
        secondFactorEnabled: false,
        secondFactorEnabledAt: null,
        recoveryCodesRemaining: 0,
      });
      expect(copy.sessions).toHaveLength(1);
      expect(copy.sessions[0]).toMatchObject({ revokedAt: null });
      // L'historique : du plus récent au plus ancien, sans la copie en cours de constitution.
      expect(copy.activity.entries.map(({ type }) => type)).toEqual([
        'PROFILE_UPDATED',
        'IDENTITY_VERIFICATION_APPROVED',
        'IDENTITY_VERIFICATION_SUBMITTED',
        'SIGN_IN',
        'EMAIL_VERIFIED',
        'ACCOUNT_CREATED',
      ]);
      expect(copy.activity.truncated).toBe(false);
      const dates = copy.activity.entries.map(({ occurredAt }) => occurredAt);
      expect(dates).toEqual([...dates].sort().reverse());

      // La vérification d'identité : le dossier et la description de ses pièces.
      expect(copy.verification.level).toBe(1);
      expect(copy.verification.cases).toHaveLength(1);
      expect(copy.verification.cases[0]).toMatchObject({
        id: member.caseId,
        level: 1,
        status: 'APPROVED',
      });
      expect(copy.verification.cases[0]?.identity?.document.numberMasked).toBe(
        `••••${number.slice(-3)}`,
      );
      expect(copy.verification.cases[0]?.documents.map(({ kind }) => kind).sort()).toEqual([
        'IDENTITY_FRONT',
        'SELFIE',
      ]);

      // Ce qui n'y figure jamais.
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(number);
      expect(text).not.toContain(member.password);
      for (const storageKey of await storedFilesOf(member.caseId)) {
        expect(text).not.toContain(storageKey);
      }
      expect(text).not.toMatch(
        /passwordHash|argon2|storageKey|wrappedKey|sha256|tokenHash|secret/i,
      );

      // Inscrite au journal — avec ce qu'elle contenait, pas son contenu.
      const [entry] = await auditEntries('user.data_exported', member.id);
      expect(entry).toMatchObject({ actorId: member.id, outcome: 'SUCCESS', ipAddress: ip });
      expect(entry?.metadata).toEqual({
        formatVersion: 1,
        sessions: 1,
        activityEntries: copy.activity.entries.length,
        verificationCases: 1,
      });

      // Signalée au titulaire : si ce n'était pas lui, il le sait.
      const notice = await nextMessageOf(testApp, member.email, 'data_exported');
      expect(notice.subject).toBe('MG-Exchange — une copie de vos données a été remise');
      expect(notice.text).toContain(`Adresse IP : ${ip}`);
      expect(notice.text).not.toContain(number);

      // La copie suivante contient la précédente dans son historique.
      const second = dataExportSchema.parse((await exportData(member).expect(200)).body);
      expect(second.activity.entries[0]).toMatchObject({
        type: 'DATA_EXPORTED',
        outcome: 'SUCCESS',
      });
    });

    it('avec la validation en deux étapes, le second facteur est exigé — code ou code de secours, une seule fois', async () => {
      const member = await protectedCustomer();

      const without = await exportData(member).expect(422);
      expect(codeOf(without)).toBe('UNPROCESSABLE_ENTITY');
      const wrong = await exportData(member, { code: wrongTotpCode(member.totpSecret!) }).expect(
        400,
      );
      expect(codeOf(wrong)).toBe('INVALID_OR_EXPIRED_CODE');
      const both = await exportData(member, {
        code: nextTotpCode(member.totpSecret!),
        recoveryCode: member.recoveryCodes[0],
      }).expect(400);
      expect(codeOf(both)).toBe('VALIDATION_FAILED');
      expect(await auditEntries('user.data_exported', member.id)).toEqual([]);

      const code = nextTotpCode(member.totpSecret!);
      const copy = dataExportSchema.parse((await exportData(member, { code }).expect(200)).body);
      expect(copy.security).toMatchObject({
        secondFactorEnabled: true,
        recoveryCodesRemaining: 10,
      });
      // Le même code ne sert pas deux fois.
      expect(codeOf(await exportData(member, { code }).expect(400))).toBe(
        'INVALID_OR_EXPIRED_CODE',
      );

      // Un code de secours est accepté, et consommé.
      const recoveryCode = member.recoveryCodes[0];
      const byRecovery = dataExportSchema.parse(
        (await exportData(member, { recoveryCode }).expect(200)).body,
      );
      expect(byRecovery.security.recoveryCodesRemaining).toBe(9);
      expect(codeOf(await exportData(member, { recoveryCode }).expect(400))).toBe(
        'INVALID_OR_EXPIRED_CODE',
      );
      expect(await auditEntries('user.data_exported', member.id)).toHaveLength(2);
    });

    it('la copie d’un membre du personnel dit les rôles qu’il détient', async () => {
      const agent = await staff('support');
      const copy = dataExportSchema.parse(
        (await exportData(agent, { code: nextTotpCode(agent.totpSecret!) }).expect(200)).body,
      );
      expect(copy.account.roles).toEqual(['support']);
      expect(copy.security.secondFactorEnabled).toBe(true);
      expect(copy.security.secondFactorEnabledAt).not.toBeNull();
      // Deux sessions : celle d'avant l'attribution du rôle, et celle-ci.
      expect(copy.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('l’historique d’une copie est borné aux événements les plus récents, et dit s’il en manque', async () => {
      const member = await customer();
      const activity = testApp.app.get(ActivityService);
      // Compte neuf : création, vérification de l'adresse, connexion.
      const all = await activity.collect(member.id, 10);
      expect(all.entries.map(({ type }) => type)).toEqual([
        'SIGN_IN',
        'EMAIL_VERIFIED',
        'ACCOUNT_CREATED',
      ]);
      expect(all.truncated).toBe(false);
      expect(await activity.collect(member.id, 3)).toEqual(all);
      // La borne retient les plus récents.
      expect(await activity.collect(member.id, 2)).toEqual({
        entries: all.entries.slice(0, 2),
        truncated: true,
      });
      expect(await activity.collect(member.id, 1)).toEqual({
        entries: all.entries.slice(0, 1),
        truncated: true,
      });

      // Un long historique se lit en plusieurs fois, sans rien perdre ni répéter.
      await prisma.auditLog.createMany({
        data: Array.from({ length: 1200 }, () => ({
          actorType: 'USER' as const,
          actorId: member.id,
          action: 'session.opened',
          resourceType: 'user',
          resourceId: member.id,
          outcome: 'SUCCESS' as const,
        })),
      });
      const long = await activity.collect(member.id, 1203);
      expect(long.entries).toHaveLength(1203);
      expect(long.truncated).toBe(false);
      expect(new Set(long.entries.map(({ id }) => id)).size).toBe(1203);
      expect(long.entries.at(-1)).toEqual(all.entries.at(-1));
      const bounded = await activity.collect(member.id, 1100);
      expect(bounded.entries).toEqual(long.entries.slice(0, 1100));
      expect(bounded.truncated).toBe(true);
      // Autres actions du journal et événements d'autres comptes n'y entrent pas.
      expect(
        (await activity.collect(claire.id, 5000)).entries.every(
          ({ id }) => !long.entries.some((entry) => entry.id === id),
        ),
      ).toBe(true);
    });

    it(`au plus ${String(DATA_EXPORTS_PER_DAY)} copies par vingt-quatre heures et par compte ; un essai refusé n’en consomme pas`, async () => {
      // La borne est écrite ici en toutes lettres : la relever est une décision, pas un réglage.
      expect(DATA_EXPORTS_PER_DAY).toBe(3);
      const member = await customer();
      const other = await customer();

      await exportData(member, { currentPassword: 'not-the-password-1' }).expect(401);
      for (let index = 0; index < DATA_EXPORTS_PER_DAY; index += 1) {
        await exportData(member).expect(200);
      }
      const refused = await exportData(member).expect(429);
      expect(codeOf(refused)).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(23 * 3600);
      expect(await auditEntries('user.data_exported', member.id)).toHaveLength(
        DATA_EXPORTS_PER_DAY,
      );

      // La limite est propre à chaque compte.
      await exportData(other).expect(200);
    });
  });

  describe('clôture par le titulaire', () => {
    it('exige une session, la confirmation et le mot de passe — sans quoi rien ne change', async () => {
      const member = await customer();

      await http
        .post('/api/v1/me/close')
        .send({ currentPassword: member.password, confirm: true })
        .expect(401);
      for (const body of [
        { currentPassword: member.password },
        { currentPassword: member.password, confirm: false },
        { currentPassword: member.password, confirm: 'true' },
        { confirm: true },
        { currentPassword: member.password, confirm: true, reason: 'I am leaving' },
      ]) {
        const response = await post(member.accessToken, '/me/close', body).expect(400);
        expect(codeOf(response)).toBe('VALIDATION_FAILED');
      }
      const wrong = await closeOwn(member, { currentPassword: 'not-the-password-1' }).expect(401);
      expect(codeOf(wrong)).toBe('INVALID_CREDENTIALS');

      expect((await accountRow(member.id)).status).toBe('ACTIVE');
      expect(await closureRow(member.id)).toBeNull();
      const [failure] = await auditEntries('user.closure_failed', member.id);
      expect(failure).toMatchObject({ actorId: member.id, outcome: 'FAILURE' });
      const activity = activityListSchema.parse(
        (await get(member.accessToken, '/me/activity').expect(200)).body,
      );
      expect(activity.entries[0]).toMatchObject({ type: 'ACCOUNT_CLOSURE_FAILED' });
    });

    it('la clôture est immédiate : plus de session, plus de connexion, plus rien du compte — sauf la trace', async () => {
      const member = await customer();
      const elsewhere = await login(http, member, { deviceId: 'test-device-0000-second' });
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .set(from(newClientIp()))
        .send({ givenName: 'Jean', city: 'Goma' })
        .expect(200);
      const before = testClock.now().getTime();
      const ip = newClientIp();

      const response = await http
        .post('/api/v1/me/close')
        .set(bearer(member.accessToken))
        .set(from(ip))
        .send({ currentPassword: member.password, confirm: true })
        .expect(200);
      const closure = accountClosureSchema.parse(response.body);
      expect(response.body).toEqual(closure);

      // Rien n'est conservé au titre de la loi ; l'adresse l'est trente jours.
      const closedAt = Date.parse(closure.closedAt);
      expect(closedAt).toBeGreaterThanOrEqual(before);
      expect(closedAt).toBeLessThanOrEqual(testClock.now().getTime());
      expect(closure.legalRetentionUntil).toBeNull();
      expect(Date.parse(closure.erasureDueAt)).toBe(
        closedAt + CLOSED_ACCOUNT_IDENTIFIERS_RETENTION_DAYS * DAY_MS,
      );

      // Toutes les sessions sont mortes, sur tous les appareils.
      for (const accessToken of [member.accessToken, elsewhere.tokens.accessToken]) {
        expect(codeOf(await get(accessToken, '/me').expect(401))).toBe('UNAUTHENTICATED');
      }
      for (const refreshToken of [member.refreshToken, elsewhere.tokens.refreshToken]) {
        await http
          .post('/api/v1/auth/refresh')
          .set(from(newClientIp()))
          .send({ refreshToken })
          .expect(401);
      }
      // L'adresse ne désigne plus aucun compte : même réponse que pour une adresse inconnue.
      const signIn = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: member.email, password: member.password, deviceId: TEST_DEVICE_ID })
        .expect(401);
      expect(codeOf(signIn)).toBe('INVALID_CREDENTIALS');
      // … et l'adresse factice du compte clôturé n'ouvre rien non plus.
      const tombstone = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({
          email: `closed-${member.id}@closed.invalid`,
          password: member.password,
          deviceId: TEST_DEVICE_ID,
        })
        .expect(401);
      expect(codeOf(tombstone)).toBe('INVALID_CREDENTIALS');

      // En base : une ligne sans identifiant, et plus rien de ce que le compte portait.
      expect(await accountRow(member.id)).toMatchObject({
        status: 'CLOSED',
        email: `closed-${member.id}@closed.invalid`,
        emailVerifiedAt: null,
        phone: null,
        phoneVerifiedAt: null,
      });
      const where = { where: { userId: member.id } };
      expect([
        await prisma.userCredential.count(where),
        await prisma.userSession.count(where),
        await prisma.userProfile.count(where),
        await prisma.verificationChallenge.count(where),
        await prisma.userTotpCredential.count(where),
        await prisma.userRecoveryCode.count(where),
      ]).toEqual([0, 0, 0, 0, 0, 0]);
      // La trace garde l'adresse, jusqu'à l'échéance d'effacement.
      expect(await closureRow(member.id)).toMatchObject({
        origin: 'HOLDER',
        closedBy: member.id,
        email: member.email,
        phone: null,
        legalRetentionUntil: null,
        erasedAt: null,
      });

      const [entry] = await auditEntries('user.closed', member.id);
      expect(entry).toMatchObject({ actorId: member.id, outcome: 'SUCCESS', ipAddress: ip });
      expect(entry?.metadata).toEqual({
        origin: 'HOLDER',
        closedSessions: 2,
        legalRetentionUntil: null,
        erasureDueAt: closure.erasureDueAt,
      });

      // Le titulaire est prévenu à l'adresse que portait le compte.
      const notice = await nextMessageOf(testApp, member.email, 'account_closed');
      expect(notice.subject).toBe('MG-Exchange — votre compte a été clôturé');
      expect(notice.text).toContain('à votre demande');
      expect(notice.text).toContain(`à partir du ${closure.erasureDueAt.slice(0, 10)}`);
      expect(notice.text).toContain("Si vous n'êtes pas à l'origine de cette clôture");

      // Mot de passe oublié : même réponse que pour une adresse inconnue, et aucun message.
      await http
        .post('/api/v1/auth/password/forgot')
        .set(from(newClientIp()))
        .send({ email: member.email })
        .expect(202);
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(member.email)
          .map(({ template }) => template)
          .filter((template) => template === 'password_reset_code'),
      ).toEqual([]);
    });

    it('la clôture est acquise même si le nettoyage qui la suit échoue : pas d’erreur pour un effet définitif', async () => {
      const member = await customer();
      const store = testApp.app.get(PendingLoginStore);
      const failing = jest
        .spyOn(store, 'invalidateAllForUser')
        .mockRejectedValueOnce(new Error('Redis is unreachable'));
      try {
        const closed = accountClosureSchema.parse((await closeOwn(member).expect(200)).body);
        expect(closed.closedAt).toEqual(expect.any(String));
        expect(failing).toHaveBeenCalledWith(member.id);
      } finally {
        failing.mockRestore();
      }
      expect((await accountRow(member.id)).status).toBe('CLOSED');
      await get(member.accessToken, '/me').expect(401);
      await backgroundWorkDone(testApp);
    });

    it('l’adresse est libre aussitôt : un nouveau compte la prend, sans rien hériter de l’ancien', async () => {
      const first = await customer();
      await closeOwn(first).expect(200);
      const received = mailbox(testApp).messagesFor(first.email).length;

      const second = await customer({ email: first.email, password: 'kasai-river-crossing-44' });
      expect(second.id).not.toBe(first.id);
      expect(mailbox(testApp).messagesFor(first.email).length).toBeGreaterThan(received);

      const me = currentUserSchema.parse((await get(second.accessToken, '/me').expect(200)).body);
      expect(me).toMatchObject({ id: second.id, email: first.email, status: 'ACTIVE' });
      // L'historique du nouveau compte commence avec lui.
      const activity = activityListSchema.parse(
        (await get(second.accessToken, '/me/activity?limit=100').expect(200)).body,
      );
      expect(activity.entries.map(({ type }) => type)).not.toContain('ACCOUNT_CLOSED');
      const copy = dataExportSchema.parse((await exportData(second).expect(200)).body);
      expect(copy.account.id).toBe(second.id);
      expect(copy.sessions).toHaveLength(1);
      // L'ancien mot de passe n'ouvre pas le nouveau compte.
      await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: first.email, password: first.password, deviceId: TEST_DEVICE_ID })
        .expect(401);

      // Le nouveau compte se clôt à son tour : deux traces portent la même adresse.
      await closeOwn(second).expect(200);
      expect(
        await prisma.accountClosure.count({ where: { email: first.email, erasedAt: null } }),
      ).toBe(2);
    });

    it('le numéro vérifié suit la même règle : la trace le garde, il est libre aussitôt, le personnel retrouve qui l’a porté', async () => {
      const member = await customer();
      const phone = newPhone();
      await verifyPhone(member, phone);
      expect((await accountRow(member.id)).phone).toBe(phone);

      await closeOwn(member).expect(200);
      expect(await accountRow(member.id)).toMatchObject({ phone: null, phoneVerifiedAt: null });
      expect(await closureRow(member.id)).toMatchObject({ email: member.email, phone });
      expect((await detailFor(support, member.id)).closure).toMatchObject({
        formerEmail: member.email,
        formerPhone: phone,
      });

      // Libre aussitôt : un autre compte vérifie le même numéro.
      const next = await customer();
      await verifyPhone(next, phone, 2);
      expect(await accountRow(next.id)).toMatchObject({ phone, status: 'ACTIVE' });

      // La recherche par numéro rend le compte qui le porte, puis celui qui l'a porté.
      const found = adminUserLookupResultSchema.parse(
        (await post(support.accessToken, '/admin/users/search', { phone }).expect(200)).body,
      );
      expect(found.users.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: next.id, status: 'ACTIVE' },
        { id: member.id, status: 'CLOSED' },
      ]);
      await backgroundWorkDone(testApp);
    });

    it('avec la validation en deux étapes, le second facteur est exigé ; une connexion à mi-chemin n’aboutit plus', async () => {
      const member = await protectedCustomer();
      // Une connexion commencée ailleurs : mot de passe accepté, seconde étape en attente.
      const pending = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: member.email, password: member.password, deviceId: TEST_DEVICE_ID })
        .expect(200);
      expect(pending.body.status).toBe('MFA_REQUIRED');

      expect(codeOf(await closeOwn(member).expect(422))).toBe('UNPROCESSABLE_ENTITY');
      expect(
        codeOf(await closeOwn(member, { code: wrongTotpCode(member.totpSecret!) }).expect(400)),
      ).toBe('INVALID_OR_EXPIRED_CODE');
      // Un code ou un code de secours — pas les deux.
      expect(
        codeOf(
          await closeOwn(member, {
            code: nextTotpCode(member.totpSecret!),
            recoveryCode: member.recoveryCodes[0],
          }).expect(400),
        ),
      ).toBe('VALIDATION_FAILED');
      expect((await accountRow(member.id)).status).toBe('ACTIVE');
      const failures = await auditEntries('user.closure_failed', member.id);
      expect(failures.map(({ outcome }) => outcome)).toEqual(['FAILURE']);

      await closeOwn(member, { code: nextTotpCode(member.totpSecret!) }).expect(200);
      expect((await accountRow(member.id)).status).toBe('CLOSED');
      expect(await prisma.userTotpCredential.count({ where: { userId: member.id } })).toBe(0);
      expect(await prisma.userRecoveryCode.count({ where: { userId: member.id } })).toBe(0);

      // La connexion restée en attente a été annulée par la clôture elle-même : elle ne tient
      // pas au seul refus qu'un compte clôturé essuierait de toute façon à la seconde étape.
      expect(
        await testApp.app.get(PendingLoginStore).registerAttempt(pending.body.mfaToken, 5),
      ).toBeNull();
      // La seconde étape est refusée.
      const completed = await http
        .post('/api/v1/auth/mfa/verify')
        .set(from(newClientIp()))
        .send({ mfaToken: pending.body.mfaToken, code: nextTotpCode(member.totpSecret!) });
      expect(completed.status).toBe(401);
      expect(await prisma.userSession.count({ where: { userId: member.id } })).toBe(0);
    });

    it('un compte qui détient un rôle ne se clôt pas : le rôle lui est d’abord retiré', async () => {
      const agent = await staff('support');

      const refused = await closeOwn(agent, { code: nextTotpCode(agent.totpSecret!) }).expect(409);
      expect(codeOf(refused)).toBe('CONFLICT');
      expect(detailOf(refused)).toContain('back-office role');
      expect((await accountRow(agent.id)).status).toBe('ACTIVE');
      expect(await auditEntries('user.closed', agent.id)).toEqual([]);
      // Sa session est intacte.
      await get(agent.accessToken, '/me').expect(200);

      await withOwner(testApp, (owner) =>
        owner.userRole.deleteMany({ where: { userId: agent.id } }),
      );
      await closeOwn(agent, { code: nextTotpCode(agent.totpSecret!) }).expect(200);
      expect((await accountRow(agent.id)).status).toBe('CLOSED');
    });

    it.each([
      ['une ligne ajoutée au compte (profil)', 'profile'],
      ['un code demandé pour le compte', 'challenge'],
      ['le compte lui-même, modifié', 'account'],
    ] as const)(
      'une requête encore en cours au moment de la clôture n’écrit plus rien — %s',
      async (_label, target) => {
        const member = await customer();
        const gate = testApp.app.get(LateWriteGate);
        const atTheGate = gate.close();

        // La requête est authentifiée — sa session existe encore — puis attend.
        const inFlight = post(member.accessToken, `/probe-private/late-write/${target}`).then(
          (response) => response,
        );
        await atTheGate;
        await closeOwn(member).expect(200);
        gate.open();

        const response = await inFlight;
        expect(response.status).toBe(409);
        expect(problemDetailsSchema.parse(response.body)).toMatchObject({
          code: 'CONFLICT',
          detail: 'This account is closed.',
        });
        // Rien de la base ne transparaît, et rien n'a été écrit.
        expect(JSON.stringify(response.body)).not.toMatch(/MGX|users|trigger|closed-/i);
        expect(await prisma.userProfile.count({ where: { userId: member.id } })).toBe(0);
        expect(await prisma.verificationChallenge.count({ where: { userId: member.id } })).toBe(0);
        expect(await accountRow(member.id)).toMatchObject({ status: 'CLOSED', locale: 'fr' });
      },
    );

    it('une attribution de rôle demandée avant la clôture ne s’applique plus', async () => {
      const member = await customer();
      const second = await createAdmin(testApp);
      const secondSession = await login(http, second);
      const requested = await post(root.accessToken, '/admin/role-changes', {
        userId: member.id,
        roleKey: 'support',
        action: 'GRANT',
        reason: REASON,
      }).expect(201);

      // Une demande en attente n'est pas un rôle : elle n'empêche pas la clôture.
      await closeOwn(member).expect(200);

      const approval = await post(
        secondSession.tokens.accessToken,
        `/admin/role-changes/${String(requested.body.id)}/approve`,
      ).expect(409);
      expect(codeOf(approval)).toBe('CONFLICT');
      expect(await prisma.userRole.count({ where: { userId: member.id } })).toBe(0);
    });

    it('nul ne s’inscrit dans le domaine réservé aux comptes clôturés', async () => {
      for (const email of ['someone@closed.invalid', `closed-${UNKNOWN_ID}@Closed.Invalid`]) {
        const response = await http
          .post('/api/v1/auth/register')
          .set(from(newClientIp()))
          .send({
            email,
            password: 'kasai-river-crossing-44',
            countryCode: 'CD',
            acceptTerms: true,
          })
          .expect(400);
        expect(problemDetailsSchema.parse(response.body)).toMatchObject({
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'email', message: 'This email address cannot be used.' }],
        });
      }
      expect(
        await prisma.user.count({
          where: { email: { endsWith: '@closed.invalid' }, status: { not: 'CLOSED' } },
        }),
      ).toBe(0);
    });
  });

  describe('clôture et vérification d’identité', () => {
    it('un dossier examiné est conservé dix ans ; ce qui n’a jamais été examiné est effacé avec ses fichiers', async () => {
      const number = newDocumentNumber();
      const member = await verifiedCustomer(number);
      // Un second dossier d'identité, en préparation : jamais déposé, donc jamais examiné.
      const draft = await identityDraft(member);
      const keptFiles = await storedFilesOf(member.caseId);
      const draftFiles = await storedFilesOf(draft.id);
      expect(keptFiles).toHaveLength(2);
      expect(draftFiles).toHaveLength(2);
      expect(storage.files()).toEqual(expect.arrayContaining([...keptFiles, ...draftFiles]));

      const closure = accountClosureSchema.parse((await closeOwn(member).expect(200)).body);

      // Dix ans, jour pour jour, à compter de la clôture ; l'effacement suit ce terme.
      const closedAt = new Date(closure.closedAt);
      const term = new Date(closedAt);
      term.setUTCFullYear(term.getUTCFullYear() + 10);
      expect(closure.legalRetentionUntil).toBe(term.toISOString());
      expect(closure.erasureDueAt).toBe(term.toISOString());

      // Le dossier accepté a pris fin avec le compte ; ses pièces sont conservées.
      const kept = await prisma.kycCase.findUniqueOrThrow({ where: { id: member.caseId } });
      expect(kept).toMatchObject({ status: 'ACCOUNT_CLOSED', revokedBy: null });
      expect(kept.endedAt?.toISOString()).toBe(closure.closedAt);
      expect(await storedFilesOf(member.caseId)).toEqual(keptFiles);
      // Le dossier en préparation a disparu, et ses fichiers aussi.
      expect(await prisma.kycCase.count({ where: { id: draft.id } })).toBe(0);
      expect(storage.files()).toEqual(expect.arrayContaining(keptFiles));
      for (const file of draftFiles) {
        expect(storage.files()).not.toContain(file);
      }

      const [entry] = await auditEntries('user.closed', member.id);
      expect(entry?.metadata).toMatchObject({
        origin: 'HOLDER',
        legalRetentionUntil: term.toISOString(),
        erasureDueAt: term.toISOString(),
      });
      const notice = await nextMessageOf(testApp, member.email, 'account_closed');
      expect(notice.text).toContain(`jusqu'au ${term.toISOString().slice(0, 10)}`);

      // La conformité retrouve le dossier, et peut encore en ouvrir les pièces.
      const queue = adminKycCaseListSchema.parse(
        (
          await get(
            claire.accessToken,
            `/admin/kyc/cases?status=ACCOUNT_CLOSED&userId=${member.id}`,
          ).expect(200)
        ).body,
      );
      expect(queue.cases.map(({ id }) => id)).toEqual([member.caseId]);
      const document = await prisma.kycDocument.findFirstOrThrow({
        where: { caseId: member.caseId, kind: 'IDENTITY_FRONT' },
      });
      const file = await get(
        claire.accessToken,
        `/admin/kyc/cases/${member.caseId}/documents/${document.id}`,
      ).expect(200);
      expect(Buffer.from(file.body as Buffer).equals(jpeg(`front:${member.caseId}`).content)).toBe(
        true,
      );
      // Clos, le dossier ne se retire plus.
      await post(claire.accessToken, `/admin/kyc/cases/${member.caseId}/revoke`, {
        reason: 'Pièce reconnue fausse après la clôture du compte',
      }).expect(409);
    });

    it('la pièce d’identité d’un compte clôturé peut de nouveau vérifier un compte', async () => {
      const number = newDocumentNumber();
      const first = await verifiedCustomer(number);
      const second = await customer();
      const pending = await submittedIdentity(second, number);

      // Tant que le premier compte est vérifié avec cette pièce, le second ne peut pas l'être.
      const refused = await approve(claire, pending.id).expect(409);
      expect(codeOf(refused)).toBe('CONFLICT');

      await closeOwn(first).expect(200);
      await approve(claire, pending.id).expect(200);
      const me = currentUserSchema.parse((await get(second.accessToken, '/me').expect(200)).body);
      expect(me.verificationLevel).toBe(1);
    });

    it('le titulaire peut clore un compte dont un dossier attend l’examen : le dossier est effacé, sans rien conserver', async () => {
      const member = await customer();
      const pending = await submittedIdentity(member);
      const files = await storedFilesOf(pending.id);

      const closure = accountClosureSchema.parse((await closeOwn(member).expect(200)).body);
      expect(closure.legalRetentionUntil).toBeNull();
      expect(await prisma.kycCase.count({ where: { userId: member.id } })).toBe(0);
      for (const file of files) {
        expect(storage.files()).not.toContain(file);
      }
      // Il a quitté la file d'examen.
      const queue = adminKycCaseListSchema.parse(
        (await get(claire.accessToken, `/admin/kyc/cases?userId=${member.id}`).expect(200)).body,
      );
      expect(queue.cases).toEqual([]);
      await approve(claire, pending.id).expect(404);
    });
  });

  describe('clôture par le personnel', () => {
    it('est réservée à qui détient users.close — jamais sur son propre compte, jamais sans confirmation', async () => {
      const target = await customer();

      await http
        .post(`/api/v1/admin/users/${target.id}/close`)
        .send({ ground: 'PLATFORM_DECISION', reason: REASON, confirm: true })
        .expect(401);
      expect(codeOf(await closeByStaff(target, target.id).expect(403))).toBe('FORBIDDEN');
      // Le support suspend ; il ne clôt pas.
      expect(codeOf(await closeByStaff(support, target.id).expect(403))).toBe('FORBIDDEN');

      for (const body of [
        { confirm: false },
        { confirm: undefined },
        { ground: 'OTHER' },
        { ground: undefined },
        { reason: 'trop bref' },
        { reason: undefined },
        { notifyUser: false },
      ]) {
        const response = await closeByStaff(claire, target.id, body).expect(400);
        expect({ body, code: codeOf(response) }).toEqual({ body, code: 'VALIDATION_FAILED' });
      }
      expect(codeOf(await closeByStaff(claire, UNKNOWN_ID).expect(404))).toBe('NOT_FOUND');
      await closeByStaff(claire, 'not-an-id').expect(400);

      // Son propre compte : refusé, et consigné.
      expect(codeOf(await closeByStaff(claire, claire.id).expect(403))).toBe('FORBIDDEN');
      const [denial] = await auditEntries('user.closure_denied', claire.id);
      expect(denial).toMatchObject({ actorId: claire.id, outcome: 'DENIED' });
      expect(denial?.metadata).toEqual({ reason: 'OWN_ACCOUNT' });

      expect((await accountRow(target.id)).status).toBe('ACTIVE');
      expect((await accountRow(claire.id)).status).toBe('ACTIVE');
      expect(await auditEntries('user.closed', target.id)).toEqual([]);
      await get(target.accessToken, '/me').expect(200);
    });

    it('la conformité clôt un compte : le titulaire est prévenu, jamais du motif ; le journal garde tout', async () => {
      const target = await customer();
      const ip = newClientIp();

      const response = await http
        .post(`/api/v1/admin/users/${target.id}/close`)
        .set(bearer(claire.accessToken))
        .set(from(ip))
        .send({ ground: 'PLATFORM_DECISION', reason: `  ${REASON}  `, confirm: true })
        .expect(200);
      const closure = adminAccountClosureSchema.parse(response.body);
      expect(response.body).toEqual(closure);
      expect(closure).toMatchObject({
        origin: 'STAFF',
        closedBy: claire.id,
        formerEmail: target.email,
        formerPhone: null,
        legalRetentionUntil: null,
        erasedAt: null,
      });

      expect((await accountRow(target.id)).status).toBe('CLOSED');
      expect(codeOf(await get(target.accessToken, '/me').expect(401))).toBe('UNAUTHENTICATED');
      const [entry] = await auditEntries('user.closed', target.id);
      expect(entry).toMatchObject({ actorId: claire.id, outcome: 'SUCCESS', ipAddress: ip });
      expect(entry?.metadata).toEqual({
        origin: 'STAFF',
        ground: 'PLATFORM_DECISION',
        reason: REASON,
        closedSessions: 1,
        legalRetentionUntil: null,
        erasureDueAt: closure.erasureDueAt,
      });

      const notice = await nextMessageOf(testApp, target.email, 'account_closed');
      expect(notice.text).toContain('Pour en connaître la raison, contactez le support.');
      expect(notice.text).not.toContain('à votre demande');
      expect(notice.text).not.toContain(REASON);
      expect(notice.text).not.toContain('2026-0457');

      // Déjà clôturé : une seconde clôture est refusée, et ne change rien.
      const again = await closeByStaff(david, target.id).expect(409);
      expect(detailOf(again)).toBe('The account is already closed.');
      expect(await auditEntries('user.closed', target.id)).toHaveLength(1);
    });

    it('à la demande du titulaire, d’un compte suspendu ; pas d’un compte jamais vérifié ni d’un membre du personnel', async () => {
      const suspended = await customer();
      await post(support.accessToken, `/admin/users/${suspended.id}/suspend`, {
        reason: REASON,
      }).expect(200);
      const closure = adminAccountClosureSchema.parse(
        (await closeByStaff(david, suspended.id, { ground: 'HOLDER_REQUEST' }).expect(200)).body,
      );
      expect(closure).toMatchObject({ origin: 'STAFF', closedBy: david.id });
      const [entry] = await auditEntries('user.closed', suspended.id);
      expect(entry?.metadata).toMatchObject({ ground: 'HOLDER_REQUEST' });
      const notice = await nextMessageOf(testApp, suspended.email, 'account_closed');
      expect(notice.text).toContain('contactez le support');

      // Une inscription jamais vérifiée n'est pas un compte : elle disparaît d'elle-même.
      const pendingEmail = newEmail('pending');
      await http
        .post('/api/v1/auth/register')
        .set(from(newClientIp()))
        .send({
          email: pendingEmail,
          password: 'kasai-river-crossing-44',
          countryCode: 'CD',
          acceptTerms: true,
        })
        .expect(202);
      const pending = await prisma.user.findUniqueOrThrow({ where: { email: pendingEmail } });
      const refused = await closeByStaff(claire, pending.id).expect(409);
      expect(detailOf(refused)).toBe('Only an active or suspended account can be closed.');

      // Un membre du personnel : ses rôles lui sont d'abord retirés.
      const colleague = await closeByStaff(claire, support.id).expect(409);
      expect(detailOf(colleague)).toContain('back-office role');
      expect((await accountRow(support.id)).status).toBe('ACTIVE');
    });

    it('n’est pas prononcée tant qu’un dossier attend l’examen : la décision d’abord, pour qu’elle soit conservée', async () => {
      const target = await customer();
      const pending = await submittedIdentity(target);

      const refused = await closeByStaff(claire, target.id).expect(409);
      expect(codeOf(refused)).toBe('CONFLICT');
      expect(detailOf(refused)).toContain('awaits review');
      expect((await accountRow(target.id)).status).toBe('ACTIVE');
      expect(await prisma.kycCase.count({ where: { id: pending.id, status: 'SUBMITTED' } })).toBe(
        1,
      );

      await reject(david, pending.id).expect(200);
      const closure = adminAccountClosureSchema.parse(
        (await closeByStaff(claire, target.id).expect(200)).body,
      );
      // Le dossier refusé est une décision : il est conservé dix ans, avec ses pièces.
      expect(closure.legalRetentionUntil).not.toBeNull();
      expect(closure.erasureDueAt).toBe(closure.legalRetentionUntil);
      expect(await prisma.kycCase.count({ where: { id: pending.id, status: 'REJECTED' } })).toBe(1);
      expect(await storedFilesOf(pending.id)).toHaveLength(2);
    });

    it('pendant la maintenance, le titulaire ne clôt ni ne copie rien ; le back-office, lui, clôt toujours', async () => {
      const member = await customer();
      await put(root.accessToken, '/admin/system-settings/maintenance.mode', {
        value: { enabled: true, message: 'Back at 14:00 UTC.' },
        reason: 'Planned database upgrade',
      }).expect(200);
      try {
        expect(codeOf(await closeOwn(member).expect(503))).toBe('MAINTENANCE');
        expect(codeOf(await exportData(member).expect(503))).toBe('MAINTENANCE');
        expect((await accountRow(member.id)).status).toBe('ACTIVE');
        expect(await auditEntries('user.data_exported', member.id)).toHaveLength(0);

        // Un compte compromis doit pouvoir être fermé à tout moment.
        await closeByStaff(claire, member.id).expect(200);
        expect((await accountRow(member.id)).status).toBe('CLOSED');
      } finally {
        await put(root.accessToken, '/admin/system-settings/maintenance.mode', {
          value: { enabled: false, message: null },
          reason: 'Upgrade completed successfully',
        }).expect(200);
      }
      await backgroundWorkDone(testApp);
    });

    it('la fiche d’un compte clôturé dit par qui, quand, et ce qu’il portait ; son ancienne adresse le retrouve', async () => {
      const target = await customer();
      await closeByStaff(claire, target.id).expect(200);
      const successor = await customer({
        email: target.email,
        password: 'kasai-river-crossing-44',
      });

      const detail = await detailFor(support, target.id);
      expect(detail).toMatchObject({
        id: target.id,
        status: 'CLOSED',
        email: `closed-${target.id}@closed.invalid`,
        phone: null,
        activeSessions: 0,
        closure: {
          origin: 'STAFF',
          closedBy: claire.id,
          formerEmail: target.email,
          formerPhone: null,
          erasedAt: null,
        },
      });
      expect((await detailFor(support, successor.id)).closure).toBeNull();

      // La recherche par adresse rend le compte qui la porte, puis ceux qui l'ont portée.
      const found = adminUserLookupResultSchema.parse(
        (
          await post(support.accessToken, '/admin/users/search', { email: target.email }).expect(
            200,
          )
        ).body,
      );
      expect(found.users.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: successor.id, status: 'ACTIVE' },
        { id: target.id, status: 'CLOSED' },
      ]);

      // Plus rien ne s'applique à un compte clôturé — pas même de la part d'un administrateur.
      const outcomes: Record<string, string> = {};
      for (const [path, body] of [
        ['suspend', { reason: REASON }],
        ['reactivate', { reason: REASON }],
        ['mfa/reset', { reason: REASON }],
        ['sessions/revoke', { reason: REASON }],
        ['close', { ground: 'PLATFORM_DECISION', reason: REASON, confirm: true }],
      ] as const) {
        const response = await post(root.accessToken, `/admin/users/${target.id}/${path}`, body);
        outcomes[path] = `${String(response.status)} ${String(response.body.code ?? 'OK')}`;
      }
      const roleChange = await post(root.accessToken, '/admin/role-changes', {
        userId: target.id,
        roleKey: 'support',
        action: 'GRANT',
        reason: REASON,
      });
      outcomes['role-changes'] =
        `${String(roleChange.status)} ${String(roleChange.body.code ?? 'OK')}`;
      expect(outcomes).toEqual({
        suspend: '409 CONFLICT',
        reactivate: '409 CONFLICT',
        'mfa/reset': '409 CONFLICT',
        close: '409 CONFLICT',
        'role-changes': '409 CONFLICT',
        // Sans effet : un compte clôturé n'a plus de session.
        'sessions/revoke': '200 OK',
      });
      expect(await prisma.userSession.count({ where: { userId: target.id } })).toBe(0);
      expect(await prisma.userRole.count({ where: { userId: target.id } })).toBe(0);
      expect((await accountRow(target.id)).status).toBe('CLOSED');
    });
  });

  describe('effacement à l’échéance', () => {
    it('trente jours après la clôture, l’adresse que gardait la trace est effacée — pas avant', async () => {
      const member = await customer();
      await closeOwn(member).expect(200);

      // La veille de l'échéance : rien.
      await asOwner((owner) => moveErasureTerm(owner, member.id, '1 day'));
      const early = await maintenance.run();
      expect(early.failures).toBe(0);
      expect(early.otherSteps['erase-closed-accounts']).toBe(0);
      expect(await closureRow(member.id)).toMatchObject({ email: member.email, erasedAt: null });

      // Le lendemain : l'adresse est effacée, la trace reste.
      await asOwner((owner) => moveErasureTerm(owner, member.id, '-1 day'));
      const due = await closureRow(member.id);
      const report = await maintenance.run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['erase-closed-accounts']).toBe(1);
      const erased = await closureRow(member.id);
      expect(erased).toMatchObject({ email: null, phone: null, origin: 'HOLDER' });
      expect(erased?.erasedAt).toBeInstanceOf(Date);

      const [entry] = await auditEntries('user.data_erased', member.id);
      expect(entry).toMatchObject({ actorType: 'SYSTEM', actorId: null, outcome: 'SUCCESS' });
      expect(entry?.metadata).toEqual({
        closedAt: due?.closedAt.toISOString(),
        legalRetentionUntil: null,
        erasureDueAt: due?.erasureDueAt.toISOString(),
      });

      // La fiche le dit ; l'ancienne adresse ne retrouve plus le compte.
      const detail = await detailFor(support, member.id);
      expect(detail.closure).toMatchObject({ formerEmail: null, formerPhone: null });
      expect(detail.closure?.erasedAt).not.toBeNull();
      const found = adminUserLookupResultSchema.parse(
        (
          await post(support.accessToken, '/admin/users/search', { email: member.email }).expect(
            200,
          )
        ).body,
      );
      expect(found.users).toEqual([]);

      // Rien ne s'efface deux fois.
      expect((await maintenance.run()).otherSteps['erase-closed-accounts']).toBe(0);
      expect(await auditEntries('user.data_erased', member.id)).toHaveLength(1);
      // Le journal d'audit, lui, n'est pas touché.
      expect(await auditEntries('user.closed', member.id)).toHaveLength(1);
    });

    it('un message de sécurité resté en attente n’est plus envoyé — ni à l’ancienne adresse, ni à l’adresse factice', async () => {
      const member = await customer();
      await closeOwn(member).expect(200);
      await nextMessageOf(testApp, member.email, 'account_closed');
      await backgroundWorkDone(testApp);
      const sender = mailbox(testApp);
      const before = sender.messagesFor(member.email).length;

      // Des événements nés avant la clôture, traités après elle : un changement de mot de
      // passe à signaler, et un second avis de clôture (un rejeu de la file).
      const outbox = testApp.app.get(OutboxService);
      for (const notice of ['PASSWORD_CHANGED', 'ACCOUNT_CLOSED'] as const) {
        await outbox.append(prisma, {
          aggregateType: 'user',
          aggregateId: member.id,
          eventType: SECURITY_NOTICE_REQUESTED_EVENT,
          payload: { userId: member.id, notice, details: {} },
          metadata: { requestId: 'test-late-notice' },
        });
      }
      await backgroundWorkDone(testApp);

      // Seul l'avis de clôture part encore, à l'adresse que garde la trace.
      const received = sender.messagesFor(member.email);
      expect(received.slice(0, received.length - before).map(({ template }) => template)).toEqual([
        'account_closed',
      ]);
      expect(sender.messagesFor(`closed-${member.id}@closed.invalid`)).toEqual([]);

      // L'adresse effacée, plus rien ne part : il n'y a plus d'adresse à laquelle écrire.
      await asOwner((owner) => moveErasureTerm(owner, member.id, '-1 day'));
      await maintenance.run();
      await outbox.append(prisma, {
        aggregateType: 'user',
        aggregateId: member.id,
        eventType: SECURITY_NOTICE_REQUESTED_EVENT,
        payload: { userId: member.id, notice: 'ACCOUNT_CLOSED', details: {} },
        metadata: { requestId: 'test-late-notice' },
      });
      await backgroundWorkDone(testApp);
      expect(sender.messagesFor(member.email)).toHaveLength(received.length);
      expect(sender.messagesFor(`closed-${member.id}@closed.invalid`)).toEqual([]);
      expect(await prisma.outboxEvent.count({ where: { status: { not: 'PUBLISHED' } } })).toBe(0);
    });

    it('au terme des dix ans, les dossiers conservés et leurs fichiers sont effacés, puis la trace', async () => {
      const member = await verifiedCustomer();
      const rejectedCase = await (async () => {
        // Un second compte fournit un dossier refusé : lui aussi est une décision conservée.
        const other = await customer();
        const pending = await submittedIdentity(other);
        await reject(david, pending.id).expect(200);
        await closeOwn(other).expect(200);
        return { userId: other.id, caseId: pending.id, files: await storedFilesOf(pending.id) };
      })();
      const files = await storedFilesOf(member.caseId);
      await closeOwn(member).expect(200);
      const untouched = await verifiedCustomer();
      await closeOwn(untouched).expect(200);
      const untouchedFiles = await storedFilesOf(untouched.caseId);

      await asOwner(async (owner) => {
        await moveErasureTerm(owner, member.id, '-1 day');
        await moveErasureTerm(owner, rejectedCase.userId, '-1 day');
      });
      const report = await maintenance.run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['erase-closed-accounts']).toBe(2);

      for (const { userId, stored } of [
        { userId: member.id, stored: files },
        { userId: rejectedCase.userId, stored: rejectedCase.files },
      ]) {
        expect(await prisma.kycCase.count({ where: { userId } })).toBe(0);
        expect(await prisma.kycDocument.count({ where: { case: { userId } } })).toBe(0);
        for (const file of stored) {
          expect(storage.files()).not.toContain(file);
        }
        expect(await closureRow(userId)).toMatchObject({ email: null, phone: null });
        expect(await auditEntries('user.data_erased', userId)).toHaveLength(1);
      }
      // Le compte dont le terme n'est pas échu garde tout.
      expect(await prisma.kycCase.count({ where: { userId: untouched.id } })).toBe(1);
      expect(storage.files()).toEqual(expect.arrayContaining(untouchedFiles));
      expect(await closureRow(untouched.id)).toMatchObject({
        email: untouched.email,
        erasedAt: null,
      });

      // La conformité ne retrouve plus les dossiers effacés.
      await get(claire.accessToken, `/admin/kyc/cases/${member.caseId}`).expect(404);
    });
  });

  describe('ce qui reste après l’effacement', () => {
    it('la base entière ne porte plus ni l’adresse, ni le numéro, ni l’identité, ni l’adresse postale du compte', async () => {
      const member = await customer({ email: newEmail('effacement') });
      const phone = newPhone();
      await verifyPhone(member, phone);
      // Tout ce qui laisse une trace : un profil, un dossier examiné, des recherches du
      // personnel, un échec de connexion, un mot de passe oublié, une copie des données.
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(member.accessToken))
        .set(from(newClientIp()))
        .send({ addressLine1: '7 avenue des Jacarandas', city: 'Kolwezi' })
        .expect(200);
      const documentNumber = newDocumentNumber();
      const draft = caseOf(
        await put(
          member.accessToken,
          '/me/verification/identity',
          identityDeclaration({
            givenName: 'Zéphyrine',
            familyName: 'Ilunga-Mwamba',
            placeOfBirth: 'Likasi',
            document: { number: documentNumber },
          }),
        ).expect(200),
      );
      await upload(member, draft.id, 'IDENTITY_FRONT', jpeg(`front:${draft.id}`)).expect(201);
      await upload(member, draft.id, 'SELFIE', png(`selfie:${draft.id}`)).expect(201);
      await post(member.accessToken, `/me/verification/cases/${draft.id}/submit`).expect(200);
      await approve(claire, draft.id).expect(200);
      const files = await storedFilesOf(draft.id);
      await post(support.accessToken, '/admin/users/search', { email: member.email }).expect(200);
      await post(support.accessToken, '/admin/users/search', { phone }).expect(200);
      await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: member.email, password: 'not-the-password-1' })
        .expect(401);
      await http
        .post('/api/v1/auth/password/forgot')
        .set(from(newClientIp()))
        .send({ email: member.email })
        .expect(202);
      await exportData(member).expect(200);
      await backgroundWorkDone(testApp);

      // Compte ouvert : la recherche trouve bien ce qui s'y trouve. Le numéro de la pièce,
      // chiffré, n'apparaît nulle part en clair ; ni le journal d'audit ni les événements ne
      // portent l'adresse ou le numéro du compte.
      expect(await tablesHolding(member.email)).toEqual(['users', 'verification_challenges']);
      expect(await tablesHolding(phone)).toEqual(['users', 'verification_challenges']);
      expect(await tablesHolding('Jacarandas')).toEqual(['user_profiles']);
      expect(await tablesHolding('Ilunga-Mwamba')).toEqual(['kyc_cases']);
      expect(await tablesHolding(documentNumber)).toEqual([]);

      await closeOwn(member).expect(200);
      await backgroundWorkDone(testApp);

      // Jusqu'à l'échéance, la trace et le dossier conservé les portent encore — et eux seuls.
      expect(await tablesHolding(member.email)).toEqual(['account_closures']);
      expect(await tablesHolding(phone)).toEqual(['account_closures']);
      expect(await tablesHolding('Ilunga-Mwamba')).toEqual(['kyc_cases']);
      expect(await tablesHolding('Jacarandas')).toEqual([]);

      // L'échéance passe ; les événements déjà traités vieillissent d'autant.
      await asOwner(async (owner) => {
        await moveErasureTerm(owner, member.id, '-1 day');
        await owner.query(
          `UPDATE outbox_events SET published_at = published_at - interval '31 days'
           WHERE status = 'PUBLISHED'`,
        );
      });
      const report = await maintenance.run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['erase-closed-accounts']).toBe(1);
      // La purge des événements est bornée par passage : jusqu'à ce qu'il n'en reste pas.
      for (let pass = 0; pass < 20; pass += 1) {
        if ((await maintenance.run()).otherSteps['purge-published-events'] === 0) {
          break;
        }
      }

      for (const needle of [
        member.email,
        phone,
        'Ilunga-Mwamba',
        'Zéphyrine',
        'Likasi',
        'Jacarandas',
        documentNumber,
      ]) {
        expect({ needle, tables: await tablesHolding(needle) }).toEqual({ needle, tables: [] });
      }
      for (const file of files) {
        expect(storage.files()).not.toContain(file);
      }
      // Il reste la ligne sans identifiant, la trace de la clôture et le journal d'audit, qui
      // ne désignent le compte que par son identifiant technique.
      expect(await tablesHolding(member.id)).toEqual(['account_closures', 'audit_logs', 'users']);
    });
  });

  // En dernier : l'horloge de l'application ne revient pas en arrière.
  describe('une horloge applicative en avance ne suffit pas', () => {
    it('la base relit le terme légal à sa propre horloge : rien n’est effacé, et l’étape le signale', async () => {
      const retained = await verifiedCustomer();
      const files = await storedFilesOf(retained.caseId);
      const closure = accountClosureSchema.parse((await closeOwn(retained).expect(200)).body);
      const simple = await customer();
      await closeOwn(simple).expect(200);

      // Dix ans et un mois « passent » pour l'application seule.
      testClock.advance(Date.parse(closure.erasureDueAt) - testClock.now().getTime() + 31 * DAY_MS);
      const report = await maintenance.run();

      // Le compte sans conservation légale est effacé : son échéance ne dépend que de l'application.
      expect(await closureRow(simple.id)).toMatchObject({ email: null });
      // Celui dont la loi impose la conservation ne l'est pas — ni ses dossiers, ni ses fichiers,
      // ni l'adresse que garde sa trace — et l'étape est comptée en échec.
      expect(report.failures).toBeGreaterThanOrEqual(1);
      expect(await prisma.kycCase.count({ where: { userId: retained.id } })).toBe(1);
      expect(await storedFilesOf(retained.caseId)).toEqual(files);
      expect(storage.files()).toEqual(expect.arrayContaining(files));
      expect(await closureRow(retained.id)).toMatchObject({
        email: retained.email,
        erasedAt: null,
      });
      expect(await auditEntries('user.data_erased', retained.id)).toEqual([]);
      // Ce qui a pu l'être figure tout de même au compte rendu.
      expect(report.otherSteps['erase-closed-accounts']).toBeGreaterThanOrEqual(1);
    });
  });
});
