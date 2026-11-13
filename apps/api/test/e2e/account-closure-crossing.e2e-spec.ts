import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  type KycCase,
  kycCaseSchema,
  recoveryCodesSchema,
  sessionListSchema,
  totpEnrollmentSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  backgroundWorkDone,
  bearer,
  codeIn,
  enableSecondFactor,
  from,
  type Http,
  login,
  newClientIp,
  newEmail,
  nextMessageOf,
  nextTotpCode,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
  withOwner,
} from '../support/identity.js';
import {
  addressDeclaration,
  createKycStorage,
  identityDeclaration,
  jpeg,
  type KycTestStorage,
  png,
  type TestFile,
} from '../support/kyc.js';
import {
  type CrossingMoment,
  RequestCrossing,
  RequestCrossingModule,
} from '../support/request-crossing.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
  /** Codes de secours, si le second facteur est activé. */
  readonly recoveryCodes?: readonly string[];
}

type Sent = PromiseLike<{ status: number; body: unknown }>;

interface Scenario {
  readonly route: string;
  /**
   * Réponse attendue selon le moment où la clôture croise la requête : `[avant tout traitement,
   * à sa première transaction]`. `null` : la route n'ouvre aucune transaction — elle ne fait
   * que lire, ou écrit en une instruction —, le croisement n'a donc pas lieu.
   */
  readonly expected: readonly [number, number | null];
  /** Compte utilisé : ordinaire, protégé par un second facteur, ou à l'identité vérifiée. */
  readonly account?: 'PROTECTED' | 'VERIFIED';
  /**
   * Seule action que le journal d'audit inscrit encore comme réussie après la clôture, aux
   * mêmes deux moments. Trois cas : la copie des données, rassemblée avant la clôture et
   * remise ; et deux actions devenues sans effet, que leur service inscrit sans regarder ce
   * qu'elles ont changé — fermer les autres sessions (aucune), désactiver un second facteur
   * que la clôture venait de retirer.
   */
  readonly recorded?: readonly [string | null, string | null];
  /** Prépare le compte, puis rend la requête à envoyer. */
  readonly prepare: (member: Member) => Promise<() => Sent>;
}

/**
 * Chaque route ouverte au titulaire d'un compte, croisée par la clôture de ce compte à deux
 * moments : une fois la requête authentifiée, avant tout traitement ; puis à l'ouverture de sa
 * première transaction — toutes ses lectures ont vu un compte ouvert, toutes ses écritures
 * trouvent un compte clôturé.
 *
 * Ce qui est établi pour chacune : jamais d'erreur serveur ; le compte reste clôturé et ne porte
 * plus rien ; aucun fichier ne reste sur le volume des pièces ; le journal d'audit n'inscrit
 * aucune action réussie après la clôture, hors celles nommées ici.
 */
const MOMENTS: readonly CrossingMoment[] = ['BEFORE_HANDLING', 'FIRST_TRANSACTION'];
const NEW_PASSWORD = 'a-brand-new-password-9';

describe('Requêtes qui croisent la clôture de leur compte — bout en bout', () => {
  let storage: KycTestStorage;
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  let crossing: RequestCrossing;
  let officer: Member;

  const get = (member: Member, path: string) =>
    http.get(`/api/v1${path}`).set(bearer(member.accessToken)).set(from(newClientIp()));
  const post = (member: Member, path: string, body?: Record<string, unknown>) =>
    http.post(`/api/v1${path}`).set(bearer(member.accessToken)).set(from(newClientIp())).send(body);
  const put = (member: Member, path: string, body: Record<string, unknown>) =>
    http.put(`/api/v1${path}`).set(bearer(member.accessToken)).set(from(newClientIp())).send(body);
  const patch = (member: Member, path: string, body: Record<string, unknown>) =>
    http
      .patch(`/api/v1${path}`)
      .set(bearer(member.accessToken))
      .set(from(newClientIp()))
      .send(body);
  const del = (member: Member, path: string) =>
    http.delete(`/api/v1${path}`).set(bearer(member.accessToken)).set(from(newClientIp()));
  const upload = (member: Member, caseId: string, kind: string, file: TestFile) =>
    http
      .post(`/api/v1/me/verification/cases/${caseId}/documents?kind=${kind}`)
      .set(bearer(member.accessToken))
      .set(from(newClientIp()))
      .set('Content-Type', file.contentType)
      .send(file.content);
  const caseOf = (response: { body: unknown }): KycCase => kycCaseSchema.parse(response.body);

  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
  }

  async function protectedCustomer(): Promise<Member> {
    const member = await customer();
    const enrollment = totpEnrollmentSchema.parse(
      (await post(member, '/me/mfa/totp/enroll', { currentPassword: member.password }).expect(200))
        .body,
    );
    const { recoveryCodes } = recoveryCodesSchema.parse(
      (
        await post(member, '/me/mfa/totp/confirm', {
          code: nextTotpCode(enrollment.secret),
        }).expect(200)
      ).body,
    );
    return { ...member, totpSecret: enrollment.secret, recoveryCodes };
  }

  /** Agent de conformité : le rôle, le second facteur, connecté. */
  async function complianceOfficer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, { email: newEmail('compliance') });
    const first = await login(http, user);
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: 'compliance' } });
      await owner.userRole.create({ data: { userId: first.user.id, roleId: role.id } });
    });
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  /** Dossier de niveau 1 en préparation ; avec ses deux pièces obligatoires si `complete`. */
  async function identityDraft(member: Member, complete = true): Promise<KycCase> {
    const draft = caseOf(
      await put(member, '/me/verification/identity', identityDeclaration()).expect(200),
    );
    if (!complete) {
      return draft;
    }
    await upload(member, draft.id, 'IDENTITY_FRONT', jpeg(`front:${draft.id}`)).expect(201);
    return caseOf(await upload(member, draft.id, 'SELFIE', png(`selfie:${draft.id}`)).expect(201));
  }

  /** Compte dont l'identité (niveau 1) est vérifiée : un dossier que la clôture conserve. */
  async function verifiedCustomer(): Promise<Member> {
    const member = await customer();
    const draft = await identityDraft(member);
    await post(member, `/me/verification/cases/${draft.id}/submit`).expect(200);
    await post(officer, `/admin/kyc/cases/${draft.id}/approve`).expect(200);
    return member;
  }

  let nextSubscriber = 30_000_000;
  const newPhone = (): string => {
    nextSubscriber += 1;
    return `+2438${String(nextSubscriber)}`;
  };

  const closeOwn = (member: Member) =>
    post(member, '/me/close', {
      currentPassword: member.password,
      confirm: true,
      // Un code de secours : celui de l'application sert à la requête qui croise la clôture.
      ...(member.recoveryCodes === undefined ? {} : { recoveryCode: member.recoveryCodes[0] }),
    });

  /** Ce qu'un compte clôturé ne doit plus porter. */
  const leftovers = async (userId: string) => {
    const where = { where: { userId } };
    return {
      credentials: await prisma.userCredential.count(where),
      totp: await prisma.userTotpCredential.count(where),
      recoveryCodes: await prisma.userRecoveryCode.count(where),
      challenges: await prisma.verificationChallenge.count(where),
      profiles: await prisma.userProfile.count(where),
      sessions: await prisma.userSession.count(where),
      unexaminedCases: await prisma.kycCase.count({
        where: { userId, status: { in: ['DRAFT', 'SUBMITTED'] } },
      }),
    };
  };
  const NOTHING = {
    credentials: 0,
    totp: 0,
    recoveryCodes: 0,
    challenges: 0,
    profiles: 0,
    sessions: 0,
    unexaminedCases: 0,
  };

  const scenarios: readonly Scenario[] = [
    { route: 'GET /me', expected: [200, null], prepare: async (m) => () => get(m, '/me') },
    {
      route: 'GET /me/profile',
      expected: [200, null],
      prepare: async (m) => () => get(m, '/me/profile'),
    },
    {
      route: 'GET /me/activity',
      expected: [200, null],
      prepare: async (m) => () => get(m, '/me/activity'),
    },
    {
      route: 'GET /me/sessions',
      expected: [200, null],
      prepare: async (m) => () => get(m, '/me/sessions'),
    },
    { route: 'GET /me/mfa', expected: [200, null], prepare: async (m) => () => get(m, '/me/mfa') },
    {
      route: 'GET /me/verification',
      expected: [200, null],
      prepare: async (m) => () => get(m, '/me/verification'),
    },
    {
      route: 'POST /auth/logout',
      expected: [204, 204],
      prepare: async (m) => () => post(m, '/auth/logout'),
    },
    {
      route: 'POST /auth/password/change',
      expected: [401, 409],
      prepare: async (m) => () =>
        post(m, '/auth/password/change', {
          currentPassword: m.password,
          newPassword: NEW_PASSWORD,
        }),
    },
    {
      route: 'POST /me/close',
      expected: [401, 409],
      prepare: async (m) => () =>
        post(m, '/me/close', { currentPassword: m.password, confirm: true }),
    },
    {
      route: 'POST /me/data-export',
      expected: [401, 200],
      recorded: [null, 'user.data_exported'],
      prepare: async (m) => () => post(m, '/me/data-export', { currentPassword: m.password }),
    },
    {
      route: 'PATCH /me/profile',
      expected: [409, 409],
      prepare: async (m) => () =>
        patch(m, '/me/profile', {
          givenName: 'Aline',
          familyName: 'Kabongo',
          city: 'Goma',
          locale: 'en',
        }),
    },
    {
      route: 'POST /me/sessions/revoke-others',
      expected: [200, 200],
      recorded: ['session.others_revoked', 'session.others_revoked'],
      prepare: async (m) => {
        await login(http, m);
        return () => post(m, '/me/sessions/revoke-others');
      },
    },
    {
      route: 'DELETE /me/sessions/{sessionId}',
      expected: [404, 404],
      prepare: async (m) => {
        await login(http, m);
        const { sessions } = sessionListSchema.parse(
          (await get(m, '/me/sessions').expect(200)).body,
        );
        const other = sessions.find(({ current }) => !current);
        return () => del(m, `/me/sessions/${String(other?.id)}`);
      },
    },
    {
      route: 'POST /me/mfa/totp/enroll',
      expected: [401, null],
      prepare: async (m) => () => post(m, '/me/mfa/totp/enroll', { currentPassword: m.password }),
    },
    {
      route: 'POST /me/mfa/totp/confirm',
      expected: [409, 409],
      prepare: async (m) => {
        const { secret } = totpEnrollmentSchema.parse(
          (await post(m, '/me/mfa/totp/enroll', { currentPassword: m.password }).expect(200)).body,
        );
        return () => post(m, '/me/mfa/totp/confirm', { code: nextTotpCode(secret) });
      },
    },
    {
      route: 'POST /me/mfa/totp/disable',
      expected: [401, 204],
      recorded: [null, 'mfa.disabled'],
      account: 'PROTECTED',
      prepare: async (m) => () =>
        post(m, '/me/mfa/totp/disable', {
          currentPassword: m.password,
          code: nextTotpCode(String(m.totpSecret)),
        }),
    },
    {
      route: 'POST /me/mfa/recovery-codes',
      expected: [401, 409],
      account: 'PROTECTED',
      prepare: async (m) => () =>
        post(m, '/me/mfa/recovery-codes', {
          currentPassword: m.password,
          code: nextTotpCode(String(m.totpSecret)),
        }),
    },
    {
      route: 'POST /me/phone/verification',
      expected: [409, 409],
      prepare: async (m) => () => post(m, '/me/phone/verification', { phone: newPhone() }),
    },
    {
      route: 'POST /me/phone/verification (un code déjà en cours)',
      expected: [409, 409],
      prepare: async (m) => {
        const phone = newPhone();
        await post(m, '/me/phone/verification', { phone }).expect(202);
        return () => post(m, '/me/phone/verification', { phone });
      },
    },
    {
      route: 'POST /me/phone/verify',
      expected: [400, 400],
      prepare: async (m) => {
        const phone = newPhone();
        await post(m, '/me/phone/verification', { phone }).expect(202);
        const sms = await nextMessageOf(testApp, phone, 'phone_verification_code', 1);
        return () => post(m, '/me/phone/verify', { code: codeIn(sms) });
      },
    },
    {
      route: 'PUT /me/verification/identity',
      expected: [409, 409],
      prepare: async (m) => () => put(m, '/me/verification/identity', identityDeclaration()),
    },
    {
      route: 'PUT /me/verification/identity (un dossier déjà en préparation)',
      expected: [409, 409],
      prepare: async (m) => {
        await identityDraft(m, false);
        return () => put(m, '/me/verification/identity', identityDeclaration());
      },
    },
    {
      route: 'PUT /me/verification/address',
      expected: [409, 409],
      account: 'VERIFIED',
      prepare: async (m) => () => put(m, '/me/verification/address', addressDeclaration()),
    },
    {
      route: 'GET /me/verification/cases/{caseId}',
      expected: [404, null],
      prepare: async (m) => {
        const draft = await identityDraft(m, false);
        return () => get(m, `/me/verification/cases/${draft.id}`);
      },
    },
    {
      route: 'POST /me/verification/cases/{caseId}/documents',
      expected: [404, 404],
      prepare: async (m) => {
        const draft = await identityDraft(m, false);
        return () => upload(m, draft.id, 'IDENTITY_FRONT', jpeg(`late:${draft.id}`));
      },
    },
    {
      route: 'DELETE /me/verification/cases/{caseId}/documents/{documentId}',
      expected: [404, 404],
      prepare: async (m) => {
        const draft = await identityDraft(m);
        return () =>
          del(m, `/me/verification/cases/${draft.id}/documents/${String(draft.documents[0]?.id)}`);
      },
    },
    {
      route: 'POST /me/verification/cases/{caseId}/submit',
      expected: [404, 409],
      prepare: async (m) => {
        const draft = await identityDraft(m);
        return () => post(m, `/me/verification/cases/${draft.id}/submit`);
      },
    },
    {
      route: 'DELETE /me/verification/cases/{caseId}',
      expected: [404, 404],
      prepare: async (m) => {
        const draft = await identityDraft(m);
        return () => del(m, `/me/verification/cases/${draft.id}`);
      },
    },
  ];

  beforeAll(async () => {
    storage = createKycStorage();
    testApp = await createTestApp({
      imports: [RequestCrossingModule],
      env: { TRUST_PROXY_HOPS: '1', ...storage.env },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    crossing = testApp.app.get(RequestCrossing);
    await openFeature(testApp, 'registration');
    await openFeature(testApp, 'kyc');
    officer = await complianceOfficer();
  });

  afterAll(async () => {
    await testApp.close();
    storage.remove();
  });

  describe.each(MOMENTS)('compte clôturé — %s', (moment) => {
    it.each(scenarios)('$route', async ({ route, expected, account, recorded, prepare }) => {
      const member =
        account === 'PROTECTED'
          ? await protectedCustomer()
          : account === 'VERIFIED'
            ? await verifiedCustomer()
            : await customer();
      const filesBefore = storage.files();
      const send = await prepare(member);
      await backgroundWorkDone(testApp);

      let crossed = false;
      crossing.arm(member.id, moment, async () => {
        crossed = true;
        await closeOwn(member).expect(200);
      });
      const response = await send();
      crossing.disarm();
      await backgroundWorkDone(testApp);

      const [beforeHandling, atFirstTransaction] = expected;
      const status = moment === 'BEFORE_HANDLING' ? beforeHandling : atFirstTransaction;
      expect({ route, crossed }).toEqual({ route, crossed: status !== null });
      expect(response.status).toBeLessThan(500);
      if (status === null) {
        // Aucune transaction : la clôture n'a pas eu lieu, la requête aboutit normalement.
        expect(response.status).toBeLessThan(300);
        return;
      }
      expect({ route, status: response.status }).toEqual({ route, status });

      // Le compte reste clôturé, et ne porte plus rien — fichiers compris.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
        'CLOSED',
      );
      expect(await leftovers(member.id)).toEqual(NOTHING);
      expect(storage.files()).toEqual(filesBefore);

      // Rien n'est inscrit comme réussi après la clôture, hors l'action nommée par le scénario.
      const entries = await prisma.auditLog.findMany({
        where: { OR: [{ actorId: member.id }, { resourceId: member.id }] },
        orderBy: { id: 'asc' },
      });
      const closure = entries.findIndex(({ action }) => action === 'user.closed');
      expect(closure).toBeGreaterThanOrEqual(0);
      const succeededAfter = entries
        .slice(closure + 1)
        .filter(({ outcome }) => outcome === 'SUCCESS')
        .map(({ action }) => action);
      const stillRecorded = recorded?.[moment === 'BEFORE_HANDLING' ? 0 : 1] ?? null;
      expect(succeededAfter).toEqual(stillRecorded === null ? [] : [stillRecorded]);
    });
  });
});
