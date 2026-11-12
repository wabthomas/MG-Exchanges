import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  adminUserDetailSchema,
  adminUserListSchema,
  adminUserLookupResultSchema,
  adminUserSummarySchema,
  currentUserSchema,
  mfaRequiredLoginSchema,
  PERMISSION_KEYS,
  problemDetailsSchema,
  roleChangeListSchema,
  roleChangeSchema,
  roleListSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { issueSessionToken } from '../../src/modules/identity/infrastructure/session-tokens.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import {
  backgroundWorkDone,
  bearer,
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
  PASSWORD,
  type RegisteredUser,
  registerVerifiedUser,
  TEST_DEVICE_ID,
  withOwner,
  wrongTotpCode,
} from '../support/identity.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';

const REASON = 'Signalement du service conformité, dossier 2026-0142';
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const HOUR_MS = 60 * 60 * 1000;

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

describe('Back-office des comptes — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  /** Administrateurs partagés par les tests ; ceux qu'un test modifie sont créés pour lui. */
  let alice: Member;
  let bruno: Member;
  let support: Member;

  const get = (accessToken: string, path: string) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp()));
  const post = (accessToken: string, path: string, body?: Record<string, unknown>) =>
    http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const codeOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body).code;

  async function admin(): Promise<Member> {
    const created = await createAdmin(testApp);
    const session = await login(http, created);
    return { ...created, accessToken: session.tokens.accessToken };
  }

  /** Utilisateur final connecté. */
  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
  }

  /** Utilisateur final protégé par un second facteur, connecté. */
  async function protectedCustomer(): Promise<Member & { totpSecret: string }> {
    const user = await registerVerifiedUser(http, testApp);
    const first = await login(http, user);
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  /** Attribue un rôle comme le ferait une migration (rôle propriétaire) : préparation de test. */
  async function grantAsOwner(userId: string, roleKey: string): Promise<void> {
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
      await owner.userRole.create({ data: { userId, roleId: role.id } });
    });
  }

  /** Agent du support : rôle `support`, second facteur activé, connecté. */
  async function supportAgent(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp, { email: newEmail('support') });
    const first = await login(http, user);
    await grantAsOwner(first.user.id, 'support');
    const totpSecret = await enableSecondFactor(testApp, {
      id: first.user.id,
      password: user.password,
    });
    const session = await login(http, { ...user, totpSecret });
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  const rolesOf = async (userId: string): Promise<string[]> =>
    (
      await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { key: true } } },
      })
    )
      .map(({ role }) => role.key)
      .sort();

  const requestRoleChange = (
    author: Member,
    target: { id: string },
    change: { roleKey?: string; action?: string; reason?: string } = {},
  ) =>
    post(author.accessToken, '/admin/role-changes', {
      userId: target.id,
      roleKey: change.roleKey ?? 'support',
      action: change.action ?? 'GRANT',
      reason: change.reason ?? REASON,
    });

  async function pendingRoleChange(
    author: Member,
    target: { id: string },
    change: { roleKey?: string; action?: string } = {},
  ): Promise<string> {
    const response = await requestRoleChange(author, target, change).expect(201);
    return roleChangeSchema.parse(response.body).id;
  }

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    await openFeature(testApp, 'registration');
    alice = await admin();
    bruno = await admin();
    support = await supportAgent();
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe('accès', () => {
    it('chaque route exige sa permission : un client n’en a aucune, le support n’a que les siennes', async () => {
      const user = await customer();
      const target = await customer();
      const pending = await pendingRoleChange(alice, target);

      const routes: readonly (readonly ['get' | 'post', string, boolean])[] = [
        ['get', '/admin/users', true],
        ['post', '/admin/users/search', true],
        ['get', `/admin/users/${target.id}`, true],
        ['post', `/admin/users/${target.id}/suspend`, true],
        ['post', `/admin/users/${target.id}/reactivate`, true],
        ['post', `/admin/users/${target.id}/sessions/revoke`, true],
        ['post', `/admin/users/${target.id}/mfa/reset`, false],
        ['get', '/admin/roles', false],
        ['get', '/admin/role-changes', false],
        ['post', '/admin/role-changes', false],
        ['get', `/admin/role-changes/${pending}`, false],
        ['post', `/admin/role-changes/${pending}/approve`, false],
        ['post', `/admin/role-changes/${pending}/reject`, false],
        ['post', `/admin/role-changes/${pending}/cancel`, false],
      ];
      for (const [method, path, openToSupport] of routes) {
        const send = (member: Member) =>
          method === 'get'
            ? get(member.accessToken, path)
            : post(member.accessToken, path, { reason: REASON });

        const refused = await send(user);
        expect({ path, status: refused.status, code: refused.body.code }).toEqual({
          path,
          status: 403,
          code: 'FORBIDDEN',
        });
        await http[method](`/api/v1${path}`).send({ reason: REASON }).expect(401);

        const agent = await send(support);
        if (openToSupport) {
          expect({ path, allowed: agent.status !== 403 && agent.status !== 401 }).toEqual({
            path,
            allowed: true,
          });
        } else {
          expect({ path, status: agent.status, code: agent.body.code }).toEqual({
            path,
            status: 403,
            code: 'FORBIDDEN',
          });
        }
      }

      // Rien n'a été fait au nom du client, et la demande de rôle est restée en attente.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
        'ACTIVE',
      );
      expect(
        roleChangeSchema.parse(
          (await get(alice.accessToken, `/admin/role-changes/${pending}`).expect(200)).body,
        ).status,
      ).toBe('PENDING');
      const denials = await prisma.auditLog.count({
        where: { actorId: user.id, action: 'authorization.denied' },
      });
      expect(denials).toBe(routes.length);
    });

    it('le rôle support détient exactement trois permissions ; super_admin les détient toutes', async () => {
      const agent = currentUserSchema.parse(
        (await get(support.accessToken, '/me').expect(200)).body,
      );
      expect(agent.roles).toEqual(['support']);
      expect(agent.permissions).toEqual(['users.read', 'users.revoke_sessions', 'users.suspend']);

      const roles = roleListSchema.parse(
        (await get(alice.accessToken, '/admin/roles').expect(200)).body,
      );
      expect(roles.roles.map((role) => role.key)).toEqual(['compliance', 'super_admin', 'support']);
      const [compliance, superAdmin, supportRole] = roles.roles;
      // La conformité examine les dossiers de vérification ; elle n'agit pas sur les comptes.
      expect(compliance).toMatchObject({
        isSystem: true,
        permissions: ['kyc.read', 'kyc.review', 'kyc.revoke', 'users.read'],
        holders: 0,
      });
      expect(superAdmin).toMatchObject({
        isSystem: true,
        permissions: [...PERMISSION_KEYS].sort(),
      });
      expect(superAdmin?.holders).toBeGreaterThanOrEqual(2);
      expect(supportRole).toMatchObject({
        isSystem: true,
        permissions: ['users.read', 'users.revoke_sessions', 'users.suspend'],
      });
      expect(supportRole?.holders).toBeGreaterThanOrEqual(1);
    });

    it('un membre du personnel sans second facteur n’entre pas dans le back-office', async () => {
      const user = await customer();
      await grantAsOwner(user.id, 'support');

      const refused = await get(user.accessToken, '/admin/users').expect(403);
      expect(codeOf(refused)).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('le back-office reste accessible pendant la maintenance', async () => {
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: maintenance window' };
      await settings.set('maintenance.mode', { enabled: true, message: null }, context);
      try {
        await get(alice.accessToken, '/me/profile').expect(503);
        await get(alice.accessToken, '/admin/users?limit=1').expect(200);
        await get(alice.accessToken, '/admin/roles').expect(200);
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
      }
    });
  });

  describe('recherche et consultation', () => {
    it('un compte se retrouve par un identifiant complet — adresse, numéro ou identifiant —, jamais par fragment', async () => {
      const user = await customer();
      const phone = '+243899000111';
      await prisma.user.update({
        where: { id: user.id },
        data: { phone, phoneVerifiedAt: new Date() },
      });
      const search = (body: Record<string, unknown>) =>
        post(support.accessToken, '/admin/users/search', body);
      const find = async (body: Record<string, unknown>) =>
        adminUserLookupResultSchema.parse((await search(body).expect(200)).body);

      for (const body of [
        { email: user.email },
        { email: `  ${user.email.toUpperCase()} ` },
        { phone },
        { id: user.id },
      ]) {
        const found = await find(body);
        expect(Object.keys(found)).toEqual(['users']);
        expect(found.users).toHaveLength(1);
        expect(found.users[0]).toMatchObject({
          id: user.id,
          email: user.email,
          emailVerified: true,
          phone,
          phoneVerified: true,
          countryCode: 'CD',
          accountType: 'INDIVIDUAL',
          status: 'ACTIVE',
          roles: [],
          secondFactorEnabled: false,
        });
      }

      // Chaque recherche est journalisée : le critère et le résultat, jamais l'identifiant saisi.
      const searches = await prisma.auditLog.findMany({
        where: { actorId: support.id, action: 'user.searched_by_admin', resourceId: user.id },
        orderBy: { id: 'asc' },
      });
      const digest = expect.stringMatching(/^[0-9a-f]{16}$/);
      expect(searches.map((entry) => entry.metadata)).toEqual([
        { criterion: 'EMAIL', identifierDigest: digest, results: 1 },
        { criterion: 'EMAIL', identifierDigest: digest, results: 1 },
        { criterion: 'PHONE', identifierDigest: digest, results: 1 },
        { criterion: 'ID', results: 1 },
      ]);
      expect(JSON.stringify(searches)).not.toContain(user.email);
      expect(JSON.stringify(searches)).not.toContain(phone);

      // Identifiant exact d'un autre compte : rien — et la recherche infructueuse est tracée aussi.
      expect((await find({ email: newEmail('nobody') })).users).toEqual([]);
      const miss = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: support.id, action: 'user.searched_by_admin' },
        orderBy: { id: 'desc' },
      });
      expect(miss).toMatchObject({
        resourceId: null,
        metadata: { criterion: 'EMAIL', results: 0 },
      });
      expect((await find({ phone: '+243899000112' })).users).toEqual([]);
      expect((await find({ id: UNKNOWN_ID })).users).toEqual([]);

      const [local, domain] = user.email.split('@');
      for (const body of [
        {},
        { email: local },
        { email: `@${domain ?? ''}` },
        { email: '%@example.cd' },
        { phone: '24389900' },
        { phone: '+2438990001%' },
        { id: user.id.slice(0, 8) },
        { email: user.email, id: user.id },
        { email: user.email, phone },
        { q: local },
        { email: user.email, status: 'ACTIVE' },
        { email: user.email, limit: 100 },
      ]) {
        const response = await search(body).expect(400);
        expect({ body, code: codeOf(response) }).toEqual({ body, code: 'VALIDATION_FAILED' });
      }

      // Un identifiant n'a pas sa place dans une URL : la liste ne filtre que par statut.
      for (const query of [
        `email=${encodeURIComponent(user.email)}`,
        `phone=${encodeURIComponent(phone)}`,
        `id=${user.id}`,
        `q=${local ?? ''}`,
      ]) {
        const response = await get(support.accessToken, `/admin/users?${query}`).expect(400);
        expect({ query, code: codeOf(response) }).toEqual({ query, code: 'VALIDATION_FAILED' });
      }
    });

    it('un numéro déclaré mais jamais vérifié peut désigner plusieurs comptes : la recherche les montre tous', async () => {
      const [first, second] = [await customer(), await customer()];
      const phone = '+243899000222';
      await prisma.user.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { phone },
      });

      const found = adminUserLookupResultSchema.parse(
        (await post(support.accessToken, '/admin/users/search', { phone }).expect(200)).body,
      );
      expect(found.users.map((user) => user.id).sort()).toEqual([first.id, second.id].sort());
      expect(found.users.every((user) => !user.phoneVerified)).toBe(true);
      // Plusieurs résultats : l'entrée du journal ne désigne aucun compte en particulier.
      const trace = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: support.id, action: 'user.searched_by_admin' },
        orderBy: { id: 'desc' },
      });
      expect(trace).toMatchObject({
        resourceId: null,
        metadata: { criterion: 'PHONE', results: 2 },
      });
    });

    it('la liste se parcourt du compte le plus récent au plus ancien, éventuellement par statut', async () => {
      const created = [await customer(), await customer(), await customer()];
      const suspended = created[1];
      if (suspended === undefined) {
        throw new Error('Missing account.');
      }
      await post(alice.accessToken, `/admin/users/${suspended.id}/suspend`, {
        reason: REASON,
      }).expect(200);

      const first = adminUserListSchema.parse(
        (await get(support.accessToken, '/admin/users?limit=2').expect(200)).body,
      );
      expect(first.users.map((user) => user.id)).toEqual([created[2]?.id, created[1]?.id]);
      expect(first.nextCursor).toBe(created[1]?.id);
      const second = adminUserListSchema.parse(
        (
          await get(
            support.accessToken,
            `/admin/users?limit=2&before=${first.nextCursor ?? ''}`,
          ).expect(200)
        ).body,
      );
      expect(second.users[0]?.id).toBe(created[0]?.id);

      const onlySuspended = adminUserListSchema.parse(
        (await get(support.accessToken, '/admin/users?status=SUSPENDED&limit=100').expect(200))
          .body,
      );
      expect(onlySuspended.users.map((user) => user.id)).toContain(suspended.id);
      expect(onlySuspended.users.every((user) => user.status === 'SUSPENDED')).toBe(true);

      // Un parcours de la liste laisse une trace à chaque page.
      const browsing = await prisma.auditLog.findMany({
        where: { actorId: support.id, action: 'user.listed_by_admin' },
        orderBy: { id: 'desc' },
        take: 3,
      });
      expect(browsing.map((entry) => [entry.resourceId, entry.metadata])).toEqual([
        [null, { status: 'SUSPENDED', limit: 100, results: onlySuspended.users.length }],
        [null, { before: first.nextCursor, limit: 2, results: second.users.length }],
        [null, { limit: 2, results: 2 }],
      ]);

      for (const query of ['status=DELETED', 'limit=0', 'limit=101', 'before=abc']) {
        const response = await get(support.accessToken, `/admin/users?${query}`).expect(400);
        expect({ query, code: codeOf(response) }).toEqual({ query, code: 'VALIDATION_FAILED' });
      }

      // Tous les comptes, une seule fois chacun, quel que soit le découpage en pages.
      const total = await prisma.user.count();
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? 'limit=7' : `limit=7&before=${cursor}`;
        const page = adminUserListSchema.parse(
          (await get(support.accessToken, `/admin/users?${query}`).expect(200)).body,
        );
        seen.push(...page.users.map((user) => user.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('la fiche d’un compte montre le profil déclaré et l’état de sa sécurité, sans aucun secret ; la consultation est journalisée', async () => {
      const user = await protectedCustomer();
      await http
        .patch('/api/v1/me/profile')
        .set(bearer(user.accessToken))
        .send({ givenName: 'Jean', familyName: 'Mukendi', dateOfBirth: '1990-05-17', city: 'Goma' })
        .expect(200);
      await login(http, user);

      const response = await get(support.accessToken, `/admin/users/${user.id}`).expect(200);
      const detail = adminUserDetailSchema.parse(response.body);
      expect(detail).toMatchObject({
        id: user.id,
        email: user.email,
        status: 'ACTIVE',
        roles: [],
        locale: 'fr',
        secondFactorEnabled: true,
        profile: {
          givenName: 'Jean',
          familyName: 'Mukendi',
          additionalName: null,
          dateOfBirth: '1990-05-17',
          placeOfBirth: null,
          nationality: null,
          city: 'Goma',
          timeZone: null,
        },
        // Rien n'a été vérifié : ce profil est seulement déclaré.
        verification: { level: 0, identityVerified: false, addressVerified: false },
        secondFactor: { enabled: true, recoveryCodesRemaining: 10 },
        activeSessions: 2,
      });
      expect(detail.secondFactor.enabledAt).not.toBeNull();
      // Ni empreinte de mot de passe, ni secret du second facteur, ni jeton.
      expect(JSON.stringify(response.body)).not.toMatch(
        /password|hash|secret|token|ciphertext|argon/i,
      );
      expect(JSON.stringify(response.body)).not.toContain(user.totpSecret);

      const views = await prisma.auditLog.findMany({
        where: { action: 'user.viewed_by_admin', resourceId: user.id },
      });
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        actorType: 'USER',
        actorId: support.id,
        outcome: 'SUCCESS',
      });

      expect(codeOf(await get(support.accessToken, `/admin/users/${UNKNOWN_ID}`).expect(404))).toBe(
        'NOT_FOUND',
      );
      expect(codeOf(await get(support.accessToken, '/admin/users/not-a-uuid').expect(400))).toBe(
        'VALIDATION_FAILED',
      );
      // La consultation par le support n'apparaît pas dans l'historique du titulaire.
      const activity = activityListSchema.parse(
        (await get(user.accessToken, '/me/activity?limit=100').expect(200)).body,
      );
      expect(activity.entries.map((entry) => entry.id)).not.toContain(views[0]?.id);
      expect(activity.entries.length).toBeGreaterThan(3);
    });
  });

  describe('suspension', () => {
    it('suspendre ferme les sessions, interdit la connexion et prévient le titulaire sans lui dire pourquoi', async () => {
      const user = await customer();
      const second = await login(http, user);

      const response = await post(support.accessToken, `/admin/users/${user.id}/suspend`, {
        reason: `  ${REASON}  `,
      }).expect(200);
      expect(adminUserSummarySchema.parse(response.body)).toMatchObject({
        id: user.id,
        status: 'SUSPENDED',
      });

      await get(user.accessToken, '/me').expect(401);
      await http
        .post('/api/v1/auth/refresh')
        .set(from(newClientIp()))
        .send({ refreshToken: second.tokens.refreshToken })
        .expect(401);
      const refused = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: user.email, password: user.password })
        .expect(403);
      expect(codeOf(refused)).toBe('ACCOUNT_DISABLED');

      const sessions = await prisma.userSession.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.revocationReason === 'ACCOUNT_DISABLED')).toBe(
        true,
      );

      const notice = await nextMessageOf(testApp, user.email, 'account_suspended');
      expect(notice.text).toMatch(/contactez le support/);
      expect(`${notice.subject}${notice.text}`).not.toMatch(/conformité|2026-0142/);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.suspended', resourceId: user.id },
      });
      expect(audit).toMatchObject({
        actorType: 'USER',
        actorId: support.id,
        outcome: 'SUCCESS',
        metadata: { reason: REASON, revokedSessions: 2, userNotified: true },
      });

      // Un compte suspendu ne se rouvre pas par « mot de passe oublié ».
      await http
        .post('/api/v1/auth/password/forgot')
        .set(from(newClientIp()))
        .send({ email: user.email })
        .expect(202);
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(user.email)
          .filter((message) => message.template === 'password_reset_code'),
      ).toHaveLength(0);

      const again = await post(support.accessToken, `/admin/users/${user.id}/suspend`, {
        reason: REASON,
      }).expect(409);
      expect(codeOf(again)).toBe('CONFLICT');
      expect(again.body.detail).toMatch(/already suspended/);
    });

    it('réactiver rend l’accès au titulaire, qui voit ces deux décisions dans son historique sans l’adresse du support', async () => {
      const user = await customer();
      await post(support.accessToken, `/admin/users/${user.id}/suspend`, { reason: REASON }).expect(
        200,
      );

      const response = await post(support.accessToken, `/admin/users/${user.id}/reactivate`, {
        reason: 'Vérifications terminées, compte en règle',
      }).expect(200);
      expect(adminUserSummarySchema.parse(response.body).status).toBe('ACTIVE');
      const notice = await nextMessageOf(testApp, user.email, 'account_reactivated');
      expect(notice.text).toMatch(/vous pouvez de nouveau vous connecter/);

      // Les sessions fermées le restent ; le mot de passe n'a pas changé.
      await get(user.accessToken, '/me').expect(401);
      const session = await login(http, user);
      const activity = activityListSchema.parse(
        (await get(session.tokens.accessToken, '/me/activity').expect(200)).body,
      );
      const decisions = activity.entries.filter((entry) => entry.type.startsWith('ACCOUNT_'));
      expect(decisions.map((entry) => [entry.type, entry.ipAddress, entry.userAgent])).toEqual([
        ['ACCOUNT_REACTIVATED', null, null],
        ['ACCOUNT_SUSPENDED', null, null],
        ['ACCOUNT_CREATED', expect.any(String), null],
      ]);
      const stored = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.suspended', resourceId: user.id },
      });
      expect(stored.ipAddress).not.toBeNull();

      // Ces décisions concernent le compte du client : elles n'apparaissent pas dans
      // l'historique de l'agent qui les a prises, dont le compte n'a été ni suspendu ni réactivé.
      const ownActivity = activityListSchema.parse(
        (await get(support.accessToken, '/me/activity?limit=100').expect(200)).body,
      );
      expect(ownActivity.entries.map((entry) => entry.type)).not.toContain('ACCOUNT_SUSPENDED');
      expect(ownActivity.entries.map((entry) => entry.type)).not.toContain('ACCOUNT_REACTIVATED');
      expect(ownActivity.entries.map((entry) => entry.type)).toContain('SIGN_IN');

      const again = await post(support.accessToken, `/admin/users/${user.id}/reactivate`, {
        reason: REASON,
      }).expect(409);
      expect(codeOf(again)).toBe('CONFLICT');
    });

    it('réactiver ne ranime aucune session — pas même celle qu’une connexion aurait ouverte à l’instant de la suspension', async () => {
      const user = await customer();
      await post(support.accessToken, `/admin/users/${user.id}/suspend`, { reason: REASON }).expect(
        200,
      );

      // Une connexion dont le mot de passe a été vérifié juste avant la suspension inscrit sa
      // session juste après : la suspension ne l'a pas fermée.
      const access = issueSessionToken('access');
      const refresh = issueSessionToken('refresh');
      const now = Date.now();
      const stray = await prisma.userSession.create({
        data: {
          userId: user.id,
          idleExpiresAt: new Date(now + 14 * 24 * HOUR_MS),
          expiresAt: new Date(now + 60 * 24 * HOUR_MS),
          tokens: {
            create: {
              accessTokenHash: access.hash,
              refreshTokenHash: refresh.hash,
              accessExpiresAt: new Date(now + 10 * 60_000),
            },
          },
        },
      });
      // Tant que le compte est suspendu, elle ne sert à rien…
      await get(access.token, '/me').expect(401);

      await post(support.accessToken, `/admin/users/${user.id}/reactivate`, {
        reason: REASON,
      }).expect(200);

      // …et la réactivation la ferme au lieu de la rendre utilisable.
      await get(access.token, '/me').expect(401);
      await http
        .post('/api/v1/auth/refresh')
        .set(from(newClientIp()))
        .send({ refreshToken: refresh.token })
        .expect(401);
      const closed = await prisma.userSession.findUniqueOrThrow({ where: { id: stray.id } });
      expect(closed.revocationReason).toBe('ACCOUNT_DISABLED');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.reactivated', resourceId: user.id },
      });
      expect(audit.metadata).toMatchObject({ revokedSessions: 1 });
      await login(http, user);
    });

    it('`notifyUser: false` suspend sans prévenir le titulaire, et le journal le dit', async () => {
      const user = await customer();
      await post(support.accessToken, `/admin/users/${user.id}/suspend`, {
        reason: REASON,
        notifyUser: false,
      }).expect(200);

      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(user.email)
          .filter((message) => message.template === 'account_suspended'),
      ).toHaveLength(0);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.suspended', resourceId: user.id },
      });
      expect(audit.metadata).toMatchObject({ userNotified: false });
    });

    it('une connexion restée en attente du second facteur ne survit pas à la suspension', async () => {
      const user = await protectedCustomer();
      const first = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: user.email, password: user.password, deviceId: TEST_DEVICE_ID })
        .expect(200);
      const { mfaToken } = mfaRequiredLoginSchema.parse(first.body);

      await post(support.accessToken, `/admin/users/${user.id}/suspend`, { reason: REASON }).expect(
        200,
      );
      await post(support.accessToken, `/admin/users/${user.id}/reactivate`, {
        reason: REASON,
      }).expect(200);

      await http
        .post('/api/v1/auth/mfa/verify')
        .set(from(newClientIp()))
        .send({ mfaToken, code: nextTotpCode(user.totpSecret) })
        .expect(401);
      await login(http, user);
    });

    it('toute action est justifiée ; seul un compte actif se suspend', async () => {
      const user = await customer();
      for (const body of [
        undefined,
        {},
        { reason: 'neuf car.' },
        { reason: '          ' },
        { reason: 'x'.repeat(501) },
        { reason: REASON, notifyUser: 'no' },
        { reason: REASON, until: '2027-01-01' },
      ]) {
        for (const action of ['suspend', 'reactivate', 'sessions/revoke', 'mfa/reset']) {
          if (action !== 'suspend' && body !== undefined && 'notifyUser' in body) {
            continue;
          }
          const response = await post(
            alice.accessToken,
            `/admin/users/${user.id}/${action}`,
            body,
          ).expect(400);
          expect({ action, body, code: response.body.code }).toEqual({
            action,
            body,
            code: 'VALIDATION_FAILED',
          });
        }
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe(
        'ACTIVE',
      );
      await get(user.accessToken, '/me').expect(200);

      for (const action of ['suspend', 'reactivate', 'sessions/revoke', 'mfa/reset']) {
        expect(
          codeOf(
            await post(alice.accessToken, `/admin/users/${UNKNOWN_ID}/${action}`, {
              reason: REASON,
            }).expect(404),
          ),
        ).toBe('NOT_FOUND');
      }

      // Une inscription dont l'adresse n'est pas vérifiée n'est pas encore un compte.
      const email = newEmail('pending');
      await http
        .post('/api/v1/auth/register')
        .set(from(newClientIp()))
        .send({ email, password: PASSWORD, countryCode: 'CD', acceptTerms: true })
        .expect(202);
      const pending = await prisma.user.findUniqueOrThrow({ where: { email } });
      const refused = await post(alice.accessToken, `/admin/users/${pending.id}/suspend`, {
        reason: REASON,
      }).expect(409);
      expect(refused.body.detail).toMatch(/registration that has not been verified/);
      expect(
        codeOf(
          await post(alice.accessToken, `/admin/users/${user.id}/reactivate`, {
            reason: REASON,
          }).expect(409),
        ),
      ).toBe('CONFLICT');
    });
  });

  describe('sessions et second facteur', () => {
    it('fermer les sessions déconnecte le compte partout, sans le suspendre', async () => {
      const user = await customer();
      await login(http, user);
      await login(http, user);

      const response = await post(support.accessToken, `/admin/users/${user.id}/sessions/revoke`, {
        reason: REASON,
      }).expect(200);
      expect(response.body).toEqual({ revokedSessions: 3 });
      await get(user.accessToken, '/me').expect(401);
      const sessions = await prisma.userSession.findMany({ where: { userId: user.id } });
      expect(sessions.map((session) => session.revocationReason)).toEqual([
        'ADMIN_REVOKED',
        'ADMIN_REVOKED',
        'ADMIN_REVOKED',
      ]);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.sessions_revoked_by_admin', resourceId: user.id },
      });
      expect(audit).toMatchObject({
        actorId: support.id,
        metadata: { reason: REASON, revokedSessions: 3 },
      });

      const session = await login(http, user);
      const activity = activityListSchema.parse(
        (await get(session.tokens.accessToken, '/me/activity?limit=3').expect(200)).body,
      );
      expect(activity.entries[1]).toMatchObject({
        type: 'SESSIONS_CLOSED_BY_SUPPORT',
        ipAddress: null,
        userAgent: null,
      });

      // Sans session ouverte, l'action reste possible et tracée.
      const none = await customer();
      await post(support.accessToken, `/admin/users/${none.id}/sessions/revoke`, {
        reason: REASON,
      }).expect(200);
      const empty = await post(support.accessToken, `/admin/users/${none.id}/sessions/revoke`, {
        reason: REASON,
      }).expect(200);
      expect(empty.body).toEqual({ revokedSessions: 0 });
    });

    it('retirer le second facteur : réservé, tracé, signalé au titulaire, et toutes les sessions sont fermées', async () => {
      const user = await protectedCustomer();
      const pendingLogin = mfaRequiredLoginSchema.parse(
        (
          await http
            .post('/api/v1/auth/login')
            .set(from(newClientIp()))
            .send({ email: user.email, password: user.password, deviceId: TEST_DEVICE_ID })
            .expect(200)
        ).body,
      );

      // Le support n'en a pas la permission.
      expect(
        codeOf(
          await post(support.accessToken, `/admin/users/${user.id}/mfa/reset`, {
            reason: REASON,
          }).expect(403),
        ),
      ).toBe('FORBIDDEN');
      expect(await prisma.userTotpCredential.count({ where: { userId: user.id } })).toBe(1);

      await post(alice.accessToken, `/admin/users/${user.id}/mfa/reset`, { reason: REASON }).expect(
        204,
      );

      expect(await prisma.userTotpCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.userRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
      await get(user.accessToken, '/me').expect(401);
      const sessions = await prisma.userSession.findMany({
        where: { userId: user.id, revocationReason: 'SECOND_FACTOR_CHANGED' },
      });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      await http
        .post('/api/v1/auth/mfa/verify')
        .set(from(newClientIp()))
        .send({ mfaToken: pendingLogin.mfaToken, code: nextTotpCode(user.totpSecret) })
        .expect(401);

      const notice = await nextMessageOf(testApp, user.email, 'two_factor_disabled');
      expect(notice.subject).toContain('retirée');
      expect(notice.text).toMatch(/demande adressée au support/);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'mfa.reset_by_admin', resourceId: user.id },
      });
      expect(audit).toMatchObject({
        actorId: alice.id,
        metadata: { reason: REASON, method: 'TOTP' },
      });

      // Le mot de passe suffit de nouveau ; le titulaire voit l'intervention dans son historique.
      const session = await login(http, { email: user.email, password: user.password });
      expect(session.user.secondFactorEnabled).toBe(false);
      const activity = activityListSchema.parse(
        (await get(session.tokens.accessToken, '/me/activity?limit=2').expect(200)).body,
      );
      expect(activity.entries[1]).toMatchObject({
        type: 'TWO_FACTOR_RESET_BY_SUPPORT',
        ipAddress: null,
      });

      const absent = await post(alice.accessToken, `/admin/users/${user.id}/mfa/reset`, {
        reason: REASON,
      }).expect(409);
      expect(codeOf(absent)).toBe('CONFLICT');
    });

    it('le retrait lève le blocage dû aux codes erronés : il concernait un second facteur qui n’existe plus', async () => {
      const user = await protectedCustomer();
      for (let failure = 0; failure < 5; failure += 1) {
        const pending = mfaRequiredLoginSchema.parse(
          (
            await http
              .post('/api/v1/auth/login')
              .set(from(newClientIp()))
              .send({ email: user.email, password: user.password, deviceId: TEST_DEVICE_ID })
              .expect(200)
          ).body,
        );
        await http
          .post('/api/v1/auth/mfa/verify')
          .set(from(newClientIp()))
          .send({ mfaToken: pending.mfaToken, code: wrongTotpCode(user.totpSecret) })
          .expect(400);
      }

      await post(alice.accessToken, `/admin/users/${user.id}/mfa/reset`, { reason: REASON }).expect(
        204,
      );
      const session = await login(http, { email: user.email, password: user.password });

      // Le titulaire peut aussitôt réactiver la validation en deux étapes.
      const totpSecret = await enableSecondFactor(testApp, {
        id: user.id,
        password: user.password,
      });
      await get(session.tokens.accessToken, '/me').expect(401);
      await login(http, { ...user, totpSecret });
    });
  });

  describe('garde-fous', () => {
    it('nul n’agit sur son propre compte par le back-office', async () => {
      const self = await admin();
      for (const action of ['suspend', 'reactivate', 'sessions/revoke', 'mfa/reset']) {
        const response = await post(self.accessToken, `/admin/users/${self.id}/${action}`, {
          reason: REASON,
        }).expect(403);
        expect(codeOf(response)).toBe('FORBIDDEN');
        expect(response.body.detail).toMatch(/own account/);
      }
      await get(self.accessToken, `/admin/users/${self.id}`).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: self.id } })).status).toBe(
        'ACTIVE',
      );
      expect(await prisma.userTotpCredential.count({ where: { userId: self.id } })).toBe(1);

      const denials = await prisma.auditLog.findMany({
        where: { actorId: self.id, outcome: 'DENIED' },
        orderBy: { id: 'asc' },
      });
      expect(denials.map((entry) => [entry.action, entry.resourceId, entry.metadata])).toEqual([
        ['user.suspension_denied', self.id, { reason: 'OWN_ACCOUNT' }],
        ['user.reactivation_denied', self.id, { reason: 'OWN_ACCOUNT' }],
        ['user.session_revocation_denied', self.id, { reason: 'OWN_ACCOUNT' }],
        ['mfa.reset_denied', self.id, { reason: 'OWN_ACCOUNT' }],
      ]);
    });

    it('le support n’agit pas sur les comptes du personnel ; un administrateur le peut', async () => {
      const [colleague, target] = [await supportAgent(), await admin()];

      for (const staff of [target, colleague]) {
        for (const action of ['suspend', 'sessions/revoke']) {
          const response = await post(support.accessToken, `/admin/users/${staff.id}/${action}`, {
            reason: REASON,
          }).expect(403);
          expect(codeOf(response)).toBe('FORBIDDEN');
          expect(response.body.detail).toMatch(/staff account/);
        }
        await get(staff.accessToken, '/admin/users?limit=1').expect(200);
        // Consulter la fiche reste permis : c'est agir qui ne l'est pas.
        const detail = adminUserDetailSchema.parse(
          (await get(support.accessToken, `/admin/users/${staff.id}`).expect(200)).body,
        );
        expect(detail.roles.length).toBe(1);
      }
      const denial = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: support.id, action: 'user.suspension_denied', resourceId: target.id },
      });
      expect(denial).toMatchObject({ outcome: 'DENIED', metadata: { reason: 'STAFF_ACCOUNT' } });

      await post(alice.accessToken, `/admin/users/${colleague.id}/sessions/revoke`, {
        reason: REASON,
      }).expect(200);
      await get(colleague.accessToken, '/admin/users?limit=1').expect(401);
      await post(alice.accessToken, `/admin/users/${target.id}/suspend`, { reason: REASON }).expect(
        200,
      );
      await get(target.accessToken, '/admin/users?limit=1').expect(401);
      await post(alice.accessToken, `/admin/users/${target.id}/mfa/reset`, {
        reason: REASON,
      }).expect(204);
    });
  });

  describe('rôles : double validation', () => {
    it('un rôle s’attribue en deux temps : la demande d’un administrateur, puis l’approbation d’un second', async () => {
      const user = await customer();

      const created = await requestRoleChange(alice, user).expect(201);
      const pending = roleChangeSchema.parse(created.body);
      expect(pending).toMatchObject({
        user: { id: user.id, email: user.email },
        role: { key: 'support', name: 'Customer support' },
        action: 'GRANT',
        reason: REASON,
        status: 'PENDING',
        requestedBy: { id: alice.id, email: alice.email },
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      });
      const ttlMs = new Date(pending.expiresAt).getTime() - new Date(pending.requestedAt).getTime();
      expect(ttlMs).toBe(72 * HOUR_MS);

      // Tant que personne d'autre n'a approuvé, rien n'a changé.
      expect(await rolesOf(user.id)).toEqual([]);
      await get(user.accessToken, '/admin/users').expect(403);
      const own = await post(
        alice.accessToken,
        `/admin/role-changes/${pending.id}/approve`,
        {},
      ).expect(403);
      expect(codeOf(own)).toBe('FORBIDDEN');
      expect(own.body.detail).toMatch(/second administrator/);
      expect(await rolesOf(user.id)).toEqual([]);

      const approved = roleChangeSchema.parse(
        (
          await post(bruno.accessToken, `/admin/role-changes/${pending.id}/approve`, {
            note: '  Vu avec la direction  ',
          }).expect(200)
        ).body,
      );
      expect(approved).toMatchObject({
        status: 'APPROVED',
        decidedBy: { id: bruno.id, email: bruno.email },
        decisionNote: 'Vu avec la direction',
      });
      expect(approved.decidedAt).not.toBeNull();

      // Le rôle est effectif à la requête suivante, avec la même session…
      expect(await rolesOf(user.id)).toEqual(['support']);
      const account = currentUserSchema.parse(
        (await get(user.accessToken, '/me').expect(200)).body,
      );
      expect(account).toMatchObject({
        roles: ['support'],
        permissions: ['users.read', 'users.revoke_sessions', 'users.suspend'],
      });
      // …mais le back-office exige la validation en deux étapes.
      expect(codeOf(await get(user.accessToken, '/admin/users').expect(403))).toBe(
        'MFA_ENROLLMENT_REQUIRED',
      );
      const totpSecret = await enableSecondFactor(testApp, {
        id: user.id,
        password: user.password,
      });
      const session = await login(http, { ...user, totpSecret });
      await get(session.tokens.accessToken, '/admin/users?limit=1').expect(200);

      const grant = await prisma.userRole.findFirstOrThrow({ where: { userId: user.id } });
      expect(grant.grantedBy).toBe(alice.id);
      const audit = await prisma.auditLog.findMany({
        where: {
          OR: [
            { resourceId: pending.id },
            { resourceId: user.id, action: { startsWith: 'user.role_' } },
          ],
        },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => [entry.action, entry.actorId, entry.outcome])).toEqual([
        ['role_change.requested', alice.id, 'SUCCESS'],
        ['role_change.approved', bruno.id, 'SUCCESS'],
        ['user.role_granted', bruno.id, 'SUCCESS'],
      ]);
      expect(audit[0]?.metadata).toEqual({
        userId: user.id,
        role: 'support',
        change: 'GRANT',
        reason: REASON,
      });
      expect(audit[2]?.metadata).toEqual({
        role: 'support',
        requestId: pending.id,
        requestedBy: alice.id,
      });

      // Une demande décidée ne se décide pas deux fois.
      for (const decision of ['approve', 'reject', 'cancel']) {
        const author = decision === 'cancel' ? alice : bruno;
        const again = await post(
          author.accessToken,
          `/admin/role-changes/${pending.id}/${decision}`,
          { note: 'Une seconde décision' },
        ).expect(409);
        expect(codeOf(again)).toBe('CONFLICT');
      }
    });

    it('un retrait approuvé prend effet immédiatement ; le corps de l’approbation est facultatif', async () => {
      const agent = await supportAgent();
      await get(agent.accessToken, '/admin/users?limit=1').expect(200);

      const id = await pendingRoleChange(alice, agent, { action: 'REVOKE' });
      await get(agent.accessToken, '/admin/users?limit=1').expect(200);
      const approved = roleChangeSchema.parse(
        (await post(bruno.accessToken, `/admin/role-changes/${id}/approve`).expect(200)).body,
      );
      expect(approved).toMatchObject({ status: 'APPROVED', action: 'REVOKE', decisionNote: null });

      expect(await rolesOf(agent.id)).toEqual([]);
      expect(codeOf(await get(agent.accessToken, '/admin/users?limit=1').expect(403))).toBe(
        'FORBIDDEN',
      );
      const revoked = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.role_revoked', resourceId: agent.id },
      });
      expect(revoked.actorId).toBe(bruno.id);
    });

    it('un refus est motivé et vient d’un second administrateur ; seul l’auteur retire sa demande', async () => {
      const user = await customer();
      const first = await pendingRoleChange(alice, user);

      expect(
        codeOf(
          await post(alice.accessToken, `/admin/role-changes/${first}/reject`, {
            note: 'Je change d’avis finalement',
          }).expect(403),
        ),
      ).toBe('FORBIDDEN');
      for (const body of [
        undefined,
        {},
        { note: 'non' },
        { reason: 'Motif placé dans le mauvais champ' },
      ]) {
        expect(
          codeOf(
            await post(bruno.accessToken, `/admin/role-changes/${first}/reject`, body).expect(400),
          ),
        ).toBe('VALIDATION_FAILED');
      }
      const rejected = roleChangeSchema.parse(
        (
          await post(bruno.accessToken, `/admin/role-changes/${first}/reject`, {
            note: 'Formation du support non terminée',
          }).expect(200)
        ).body,
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        decidedBy: { id: bruno.id },
        decisionNote: 'Formation du support non terminée',
      });
      expect(await rolesOf(user.id)).toEqual([]);

      // Refusée, la demande ne bloque pas la suivante.
      const second = await pendingRoleChange(alice, user);
      expect(
        codeOf(await post(bruno.accessToken, `/admin/role-changes/${second}/cancel`).expect(403)),
      ).toBe('FORBIDDEN');
      const cancelled = roleChangeSchema.parse(
        (await post(alice.accessToken, `/admin/role-changes/${second}/cancel`).expect(200)).body,
      );
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        decidedBy: { id: alice.id },
        decisionNote: null,
      });
      expect(await rolesOf(user.id)).toEqual([]);

      const audit = await prisma.auditLog.findMany({
        where: {
          resourceId: { in: [first, second] },
          action: { in: ['role_change.rejected', 'role_change.cancelled'] },
        },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => [entry.action, entry.actorId])).toEqual([
        ['role_change.rejected', bruno.id],
        ['role_change.cancelled', alice.id],
      ]);
      expect(audit[0]?.metadata).toMatchObject({
        note: 'Formation du support non terminée',
        role: 'support',
        change: 'GRANT',
      });
    });

    it('nul ne prend part à un changement de ses propres rôles — ni pour le demander, ni pour le décider', async () => {
      const [target, third] = [await admin(), await admin()];

      const own = await requestRoleChange(target, target, { roleKey: 'support' }).expect(403);
      expect(own.body.detail).toMatch(/your own roles/);
      expect(await prisma.roleChangeRequest.count({ where: { userId: target.id } })).toBe(0);

      const id = await pendingRoleChange(alice, target, {
        roleKey: 'super_admin',
        action: 'REVOKE',
      });
      for (const decision of ['approve', 'reject']) {
        const response = await post(target.accessToken, `/admin/role-changes/${id}/${decision}`, {
          note: 'Je garde mon rôle, merci',
        }).expect(403);
        expect(response.body.detail).toMatch(/your own roles/);
      }
      expect(await rolesOf(target.id)).toEqual(['super_admin']);

      await post(third.accessToken, `/admin/role-changes/${id}/approve`, {}).expect(200);
      expect(await rolesOf(target.id)).toEqual([]);
      expect(codeOf(await get(target.accessToken, '/admin/roles').expect(403))).toBe('FORBIDDEN');
    });

    it('une demande n’est créée que si elle a un sens', async () => {
      const user = await customer();
      const agent = await supportAgent();

      for (const [body, status, code] of [
        [
          { userId: UNKNOWN_ID, roleKey: 'support', action: 'GRANT', reason: REASON },
          422,
          'UNPROCESSABLE_ENTITY',
        ],
        [
          { userId: user.id, roleKey: 'auditor', action: 'GRANT', reason: REASON },
          422,
          'UNPROCESSABLE_ENTITY',
        ],
        [
          { userId: agent.id, roleKey: 'support', action: 'GRANT', reason: REASON },
          409,
          'CONFLICT',
        ],
        [
          { userId: user.id, roleKey: 'support', action: 'REVOKE', reason: REASON },
          409,
          'CONFLICT',
        ],
        [
          { userId: user.id, roleKey: 'support', action: 'GRANT', reason: 'court' },
          400,
          'VALIDATION_FAILED',
        ],
        [
          { userId: user.id, roleKey: 'support', action: 'TRANSFER', reason: REASON },
          400,
          'VALIDATION_FAILED',
        ],
        [
          { userId: user.id, roleKey: 'Support Agent', action: 'GRANT', reason: REASON },
          400,
          'VALIDATION_FAILED',
        ],
        [
          { userId: 'me', roleKey: 'support', action: 'GRANT', reason: REASON },
          400,
          'VALIDATION_FAILED',
        ],
        [
          {
            userId: user.id,
            roleKey: 'support',
            action: 'GRANT',
            reason: REASON,
            status: 'APPROVED',
          },
          400,
          'VALIDATION_FAILED',
        ],
        [{ userId: user.id, roleKey: 'support', action: 'GRANT' }, 400, 'VALIDATION_FAILED'],
      ] as const) {
        const response = await post(alice.accessToken, '/admin/role-changes', body);
        expect({ body, status: response.status, code: response.body.code }).toEqual({
          body,
          status,
          code,
        });
      }
      expect(
        await prisma.roleChangeRequest.count({ where: { userId: { in: [user.id, agent.id] } } }),
      ).toBe(0);

      // Une seule demande en attente par compte et par rôle, quel qu'en soit l'auteur.
      await pendingRoleChange(alice, user);
      const duplicate = await requestRoleChange(bruno, user).expect(409);
      expect(duplicate.body.detail).toMatch(/already awaiting approval/);
      await pendingRoleChange(bruno, user, { roleKey: 'super_admin' });

      // Un rôle ne s'attribue qu'à un compte actif.
      const suspended = await customer();
      await post(alice.accessToken, `/admin/users/${suspended.id}/suspend`, {
        reason: REASON,
      }).expect(200);
      expect(codeOf(await requestRoleChange(alice, suspended).expect(409))).toBe('CONFLICT');
    });

    it('la base refuse l’approbation lorsque l’auteur de la demande ou l’intéressé n’y a plus droit', async () => {
      const [author, user, other] = [await admin(), await customer(), await customer()];
      const byFormerAdmin = await pendingRoleChange(author, user);
      const forSuspended = await pendingRoleChange(alice, other);

      // L'auteur de la première demande est suspendu ; l'intéressé de la seconde aussi.
      await post(alice.accessToken, `/admin/users/${author.id}/suspend`, { reason: REASON }).expect(
        200,
      );
      await post(alice.accessToken, `/admin/users/${other.id}/suspend`, { reason: REASON }).expect(
        200,
      );

      for (const id of [byFormerAdmin, forSuspended]) {
        const refused = await post(
          bruno.accessToken,
          `/admin/role-changes/${id}/approve`,
          {},
        ).expect(409);
        expect(codeOf(refused)).toBe('CONFLICT');
        expect(refused.body.detail).toMatch(/can no longer be approved/);
        // La demande reste en attente : elle pourra être refusée, ou échoir.
        expect(
          roleChangeSchema.parse(
            (await get(bruno.accessToken, `/admin/role-changes/${id}`).expect(200)).body,
          ).status,
        ).toBe('PENDING');
      }
      expect(await rolesOf(user.id)).toEqual([]);
      expect(await rolesOf(other.id)).toEqual([]);
      const refusals = await prisma.auditLog.findMany({
        where: {
          action: 'role_change.approval_refused',
          resourceId: { in: [byFormerAdmin, forSuspended] },
        },
      });
      expect(refusals).toHaveLength(2);
      expect(
        refusals.every((entry) => entry.outcome === 'DENIED' && entry.actorId === bruno.id),
      ).toBe(true);

      await post(bruno.accessToken, `/admin/role-changes/${byFormerAdmin}/reject`, {
        note: 'Auteur de la demande suspendu',
      }).expect(200);
    });

    it('des décisions simultanées sur une même demande : une seule l’emporte, et le journal n’en retient qu’une', async () => {
      const user = await customer();
      const id = await pendingRoleChange(alice, user);

      // Six approbations au même instant.
      const approvals = await Promise.all(
        Array.from({ length: 6 }, () =>
          post(bruno.accessToken, `/admin/role-changes/${id}/approve`, {}).then(
            (response) => response,
          ),
        ),
      );
      expect(approvals.map((response) => response.status).sort()).toEqual([
        200, 409, 409, 409, 409, 409,
      ]);
      expect(
        approvals.filter((response) => response.status === 409).map((response) => codeOf(response)),
      ).toEqual(Array.from({ length: 5 }, () => 'CONFLICT'));
      expect(await rolesOf(user.id)).toEqual(['support']);
      expect(
        await prisma.auditLog.count({
          where: { action: 'role_change.approved', resourceId: id },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { action: 'user.role_granted', resourceId: user.id },
        }),
      ).toBe(1);
      // Les perdantes n'ont rien écrit : ni refus de la base, ni seconde décision.
      expect(
        await prisma.auditLog.count({
          where: { action: 'role_change.approval_refused', resourceId: id },
        }),
      ).toBe(0);

      // L'approbation d'un second administrateur et le retrait par l'auteur, au même instant.
      for (let round = 0; round < 4; round++) {
        const other = await customer();
        const contested = await pendingRoleChange(alice, other);
        const [approval, cancellation] = await Promise.all([
          post(bruno.accessToken, `/admin/role-changes/${contested}/approve`, {}).then(
            (response) => response,
          ),
          post(alice.accessToken, `/admin/role-changes/${contested}/cancel`).then(
            (response) => response,
          ),
        ]);
        expect([approval.status, cancellation.status].sort()).toEqual([200, 409]);
        const approved = approval.status === 200;
        expect(
          roleChangeSchema.parse(
            (await get(bruno.accessToken, `/admin/role-changes/${contested}`).expect(200)).body,
          ).status,
        ).toBe(approved ? 'APPROVED' : 'CANCELLED');
        expect(await rolesOf(other.id)).toEqual(approved ? ['support'] : []);
        expect(
          await prisma.auditLog.count({
            where: {
              action: { in: ['role_change.approved', 'role_change.cancelled'] },
              resourceId: contested,
            },
          }),
        ).toBe(1);
      }
    });

    it('les demandes se listent de la plus récente à la plus ancienne, par statut et par pages', async () => {
      const user = await customer();
      const rejected = await pendingRoleChange(alice, user);
      await post(bruno.accessToken, `/admin/role-changes/${rejected}/reject`, {
        note: 'Demande faite par erreur',
      }).expect(200);
      const pending = await pendingRoleChange(alice, user);
      const list = async (query: string) =>
        roleChangeListSchema.parse(
          (await get(bruno.accessToken, `/admin/role-changes${query}`).expect(200)).body,
        );

      const recent = await list('?limit=2');
      expect(recent.roleChanges.map((change) => change.id)).toEqual([pending, rejected]);
      expect(recent.nextCursor === null || recent.nextCursor === rejected).toBe(true);
      const older = await list(`?limit=2&before=${pending}`);
      expect(older.roleChanges[0]?.id).toBe(rejected);

      const onlyPending = await list('?status=PENDING&limit=100');
      expect(onlyPending.roleChanges.map((change) => change.id)).toContain(pending);
      expect(onlyPending.roleChanges.every((change) => change.status === 'PENDING')).toBe(true);
      expect(
        (await list('?status=REJECTED&limit=100')).roleChanges.map((change) => change.id),
      ).toContain(rejected);

      for (const query of [
        '?status=DONE',
        '?limit=0',
        '?limit=101',
        '?before=abc',
        '?userId=' + user.id,
      ]) {
        expect(
          codeOf(await get(bruno.accessToken, `/admin/role-changes${query}`).expect(400)),
        ).toBe('VALIDATION_FAILED');
      }
      expect(
        codeOf(await get(bruno.accessToken, `/admin/role-changes/${UNKNOWN_ID}`).expect(404)),
      ).toBe('NOT_FOUND');
      expect(
        codeOf(
          await post(bruno.accessToken, `/admin/role-changes/${UNKNOWN_ID}/approve`, {}).expect(
            404,
          ),
        ),
      ).toBe('NOT_FOUND');
    });

    // Dernier test du fichier : il avance l'horloge de trois jours.
    it('une demande restée sans décision échoit après 72 heures', async () => {
      const user = await customer();
      const id = await pendingRoleChange(alice, user);

      testClock.advance(72 * HOUR_MS - 60_000);
      expect(
        roleChangeSchema.parse(
          (await get(bruno.accessToken, `/admin/role-changes/${id}`).expect(200)).body,
        ).status,
      ).toBe('PENDING');

      testClock.advance(60_000);
      const late = await post(bruno.accessToken, `/admin/role-changes/${id}/approve`, {}).expect(
        409,
      );
      expect(late.body.detail).toMatch(/no longer pending \(expired\)/);
      const expired = roleChangeSchema.parse(
        (await get(bruno.accessToken, `/admin/role-changes/${id}`).expect(200)).body,
      );
      expect(expired).toMatchObject({ status: 'EXPIRED', decidedBy: null, decisionNote: null });
      expect(expired.decidedAt).not.toBeNull();
      expect(await rolesOf(user.id)).toEqual([]);
      expect(
        codeOf(await post(alice.accessToken, `/admin/role-changes/${id}/cancel`).expect(409)),
      ).toBe('CONFLICT');

      // Échue, elle ne bloque pas une nouvelle demande, qui s'approuve normalement.
      const renewed = await pendingRoleChange(alice, user);
      await post(bruno.accessToken, `/admin/role-changes/${renewed}/approve`, {}).expect(200);
      expect(await rolesOf(user.id)).toEqual(['support']);
    });
  });
});
