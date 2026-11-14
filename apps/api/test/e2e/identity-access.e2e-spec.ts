import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  PERMISSION_KEYS,
  problemDetailsSchema,
  systemSettingListSchema,
  systemSettingViewSchema,
  systemStatusSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  bearer,
  createAdmin,
  from,
  type Http,
  login,
  newClientIp,
  newEmail,
  openFeature,
  PASSWORD,
  registerVerifiedUser,
  withOwner,
} from '../support/identity.js';
import { ProbeModule } from '../support/probe.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/** Opérations documentées accessibles sans authentification. Toute autre route exige un jeton. */
const PUBLIC_OPERATIONS = [
  'GET /health/live',
  'GET /health/ready',
  'GET /api/v1/system/status',
  // Les conditions d'utilisation se lisent avant de s'inscrire.
  'GET /api/v1/terms/current',
  'GET /api/v1/terms/versions',
  'GET /api/v1/terms/versions/{number}',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/email/verify',
  'POST /api/v1/auth/email/resend',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
].sort();

interface Operation {
  readonly id: string;
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly secured: boolean;
}

describe('Contrôle d’accès — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    testApp = await createTestApp({ imports: [ProbeModule], env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    await openFeature(testApp, 'registration');
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe('refus par défaut', () => {
    let operations: Operation[];

    beforeAll(async () => {
      const document = (await http.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, { security?: unknown[] }>>;
      };
      operations = Object.entries(document.paths)
        .filter(([path]) => !path.startsWith('/api/v1/probe'))
        .flatMap(([path, methods]) =>
          Object.entries(methods).map(([method, operation]) => ({
            id: `${method.toUpperCase()} ${path}`,
            method: method as Operation['method'],
            path: path
              .replace('{sessionId}', '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d')
              .replace('{key}', 'features.exchange')
              .replace('{number}', '1'),
            secured: (operation.security ?? []).length > 0,
          })),
        );
    });

    it('les seules routes publiques sont celles de la liste — en ouvrir une autre exige de la modifier', () => {
      expect(operations.length).toBeGreaterThan(PUBLIC_OPERATIONS.length);
      expect(
        operations
          .filter((operation) => !operation.secured)
          .map((operation) => operation.id)
          .sort(),
      ).toEqual(PUBLIC_OPERATIONS);
    });

    it('toute autre route répond 401 sans jeton, avant même de valider la requête', async () => {
      const secured = operations.filter((operation) => operation.secured);
      expect(secured.length).toBeGreaterThanOrEqual(8);

      for (const operation of secured) {
        const response = await http[operation.method](operation.path)
          .set(from(newClientIp()))
          .send({});
        expect({ route: operation.id, status: response.status, code: response.body.code }).toEqual({
          route: operation.id,
          status: 401,
          code: 'UNAUTHENTICATED',
        });
      }
    });

    it('les routes publiques ne demandent pas de jeton', async () => {
      for (const operation of operations.filter((candidate) => !candidate.secured)) {
        const response = await http[operation.method](operation.path)
          .set(from(newClientIp()))
          .send({});
        expect({ route: operation.id, authenticated: response.status !== 401 }).toEqual({
          route: operation.id,
          authenticated: true,
        });
      }
    });

    it('une route sans aucune annotation est protégée ; une session l’ouvre', async () => {
      await http.get('/api/v1/probe-private/whoami').expect(401);

      const user = await registerVerifiedUser(http, testApp);
      const session = await login(http, user);
      const response = await http
        .get('/api/v1/probe-private/whoami')
        .set(bearer(session.tokens.accessToken))
        .expect(200);
      expect(response.body).toEqual({
        userId: session.user.id,
        sessionId: session.sessionId,
      });
    });

    it('la boîte de réception de développement existe en test, pour une adresse valide', async () => {
      const response = await http
        .get('/api/v1/dev/mailbox?recipient=nobody@example.cd')
        .expect(200);
      expect(response.body).toEqual({ messages: [] });
      await http.get('/api/v1/dev/mailbox').expect(400);
    });
  });

  describe('permissions du back-office', () => {
    it('un utilisateur final n’a aucune permission : 403, et la tentative est tracée', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens, user: account } = await login(http, user);
      expect(account).toMatchObject({ roles: [], permissions: [] });

      for (const [method, path] of [
        ['get', '/api/v1/admin/system-settings'],
        ['put', '/api/v1/admin/system-settings/features.exchange'],
        ['get', '/api/v1/probe-private/settings-writer'],
      ] as const) {
        const response = await http[method](path)
          .set(bearer(tokens.accessToken))
          .send({ value: true, reason: 'Trying my luck here' })
          .expect(403);
        expect(problemDetailsSchema.parse(response.body).code).toBe('FORBIDDEN');
      }
      expect((await http.get('/api/v1/system/status').expect(200)).body.features.exchange).toBe(
        false,
      );

      const denials = await prisma.auditLog.findMany({
        where: { action: 'authorization.denied', actorId: account.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(denials.map((entry) => entry.resourceId)).toEqual([
        'GET /api/v1/admin/system-settings',
        'PUT /api/v1/admin/system-settings/features.exchange',
        'GET /api/v1/probe-private/settings-writer',
      ]);
      expect(denials[1]).toMatchObject({
        outcome: 'DENIED',
        metadata: { missingPermissions: ['system_settings.write'] },
      });
    });

    it('un administrateur créé par l’outil d’amorçage détient toutes les permissions', async () => {
      const admin = await createAdmin(testApp);
      const session = await login(http, admin);

      expect(session.user.roles).toEqual(['super_admin']);
      expect(session.user.permissions).toEqual([...PERMISSION_KEYS].sort());
      await http
        .get('/api/v1/probe-private/settings-writer')
        .set(bearer(session.tokens.accessToken))
        .expect(200);

      const bootstrap = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.administrator_created', resourceId: admin.id },
      });
      expect(bootstrap).toMatchObject({ actorType: 'SYSTEM', actorId: null, outcome: 'SUCCESS' });
    });

    it('le retrait d’un rôle prend effet à la requête suivante, sans attendre l’expiration du jeton', async () => {
      const admin = await createAdmin(testApp);
      const { tokens } = await login(http, admin);
      await http.get('/api/v1/admin/system-settings').set(bearer(tokens.accessToken)).expect(200);

      await withOwner(testApp, (owner) =>
        owner.userRole.deleteMany({ where: { userId: admin.id } }),
      );

      await http.get('/api/v1/admin/system-settings').set(bearer(tokens.accessToken)).expect(403);
      const me = await http.get('/api/v1/me').set(bearer(tokens.accessToken)).expect(200);
      expect(me.body).toMatchObject({ roles: [], permissions: [] });
    });
  });

  describe('administration des paramètres de la plateforme', () => {
    let adminToken: string;
    let adminId: string;

    beforeAll(async () => {
      const admin = await createAdmin(testApp);
      adminId = admin.id;
      adminToken = (await login(http, admin)).tokens.accessToken;
    });

    const put = (key: string, body: unknown, ip = newClientIp()) =>
      http
        .put(`/api/v1/admin/system-settings/${key}`)
        .set({ ...bearer(adminToken), ...from(ip) })
        .send(body as object);

    it('liste tous les paramètres avec leur valeur en vigueur', async () => {
      const response = await http
        .get('/api/v1/admin/system-settings')
        .set(bearer(adminToken))
        .expect(200);
      const { settings } = systemSettingListSchema.parse(response.body);

      expect(settings.map((setting) => setting.key)).toEqual([
        'maintenance.mode',
        'features.registration',
        'features.kyc',
        'features.internal_transfers',
        'features.fiat_deposits',
        'features.fiat_withdrawals',
        'features.crypto_deposits',
        'features.crypto_withdrawals',
        'features.exchange',
        'features.p2p',
      ]);
      const byKey = new Map(settings.map((setting) => [setting.key, setting]));
      expect(byKey.get('features.registration')).toMatchObject({
        value: true,
        isDefault: false,
        version: 1,
      });
      expect(byKey.get('features.p2p')).toEqual({
        key: 'features.p2p',
        value: false,
        isDefault: true,
        version: null,
        updatedAt: null,
      });
      expect(byKey.get('maintenance.mode')).toMatchObject({
        value: { enabled: false, message: null },
        isDefault: true,
      });
    });

    it('ouvre une fonctionnalité : effet immédiat, décision tracée avec son auteur et sa justification', async () => {
      const ip = newClientIp();
      const response = await put(
        'features.exchange',
        { value: true, reason: 'Authorisation received from the regulator' },
        ip,
      ).expect(200);
      expect(systemSettingViewSchema.parse(response.body)).toMatchObject({
        key: 'features.exchange',
        value: true,
        isDefault: false,
        version: 1,
      });

      const status = systemStatusSchema.parse(
        (await http.get('/api/v1/system/status').expect(200)).body,
      );
      expect(status.features.exchange).toBe(true);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'system_setting.updated', resourceId: 'features.exchange' },
      });
      expect(audit).toMatchObject({
        actorType: 'USER',
        actorId: adminId,
        ipAddress: ip,
        metadata: {
          previousValue: null,
          newValue: true,
          version: 1,
          reason: 'Authorisation received from the regulator',
        },
      });
      expect(audit.requestId).toBe(response.headers['x-request-id']);

      const closed = await put('features.exchange', {
        value: false,
        reason: 'Closing it again for the test',
      }).expect(200);
      expect(closed.body).toMatchObject({ value: false, version: 2 });
    });

    it.each([
      ['justification absente', 'features.p2p', { value: true }, 400, 'VALIDATION_FAILED'],
      [
        'justification trop courte',
        'features.p2p',
        { value: true, reason: 'ok' },
        400,
        'VALIDATION_FAILED',
      ],
      [
        'valeur absente',
        'features.p2p',
        { reason: 'No value was provided' },
        400,
        'VALIDATION_FAILED',
      ],
      [
        'valeur d’un autre type',
        'features.p2p',
        { value: 'yes', reason: 'A string is not a boolean' },
        400,
        'VALIDATION_FAILED',
      ],
      [
        'valeur inadaptée au paramètre',
        'features.p2p',
        { value: { enabled: true, message: null }, reason: 'Maintenance object on a feature' },
        422,
        'UNPROCESSABLE_ENTITY',
      ],
      [
        'paramètre inconnu',
        'features.unknown',
        { value: true, reason: 'This key does not exist' },
        404,
        'NOT_FOUND',
      ],
    ])('%s : refusé, rien n’est modifié', async (_label, key, body, status, code) => {
      const response = await put(key, body).expect(status);
      expect(response.body.code).toBe(code);
      expect(
        await prisma.systemSetting.count({
          where: { key: { in: ['features.p2p', 'features.unknown'] } },
        }),
      ).toBe(0);
    });

    it('pendant la maintenance : tout est fermé, sauf la connexion et l’administration qui permet d’en sortir', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const session = await login(http, user);

      await put('maintenance.mode', {
        value: { enabled: true, message: 'Back at 14:00 UTC.' },
        reason: 'Planned database upgrade',
      }).expect(200);

      const blocked = await http
        .get('/api/v1/me/sessions')
        .set(bearer(session.tokens.accessToken))
        .expect(503);
      expect(blocked.body).toMatchObject({ code: 'MAINTENANCE', detail: 'Back at 14:00 UTC.' });
      // Sans jeton aussi, la maintenance est annoncée avant toute autre vérification.
      await http.get('/api/v1/me/sessions').expect(503);
      await http
        .post('/api/v1/auth/register')
        .set(from(newClientIp()))
        .send({ email: newEmail(), password: PASSWORD, countryCode: 'CD', acceptedTermsVersion: 1 })
        .expect(503);

      // Restent ouverts : l'état de la plateforme, la connexion, le compte, l'administration.
      await http.get('/api/v1/system/status').expect(200);
      await login(http, user);
      await http.get('/api/v1/me').set(bearer(session.tokens.accessToken)).expect(200);
      await http.get('/api/v1/admin/system-settings').set(bearer(adminToken)).expect(200);
      await http
        .get('/api/v1/admin/system-settings')
        .set(bearer(session.tokens.accessToken))
        .expect(403);

      await put('maintenance.mode', {
        value: { enabled: false, message: null },
        reason: 'Upgrade completed successfully',
      }).expect(200);
      await http.get('/api/v1/me/sessions').set(bearer(session.tokens.accessToken)).expect(200);
    });
  });
});

describe('Identité selon l’environnement — bout en bout', () => {
  it('en production, sans prestataire d’envoi : pas de boîte de développement, et l’inscription est refusée d’emblée', async () => {
    const testApp = await createTestApp({
      env: { NODE_ENV: 'production', APP_ENV: 'production', TRUST_PROXY_HOPS: '1' },
    });
    try {
      const http = request(testApp.app.getHttpServer());
      expect(testApp.config.notifications.delivery).toBe('none');
      await openFeature(testApp, 'registration');

      const mailbox = await http.get('/api/v1/dev/mailbox?recipient=nobody@example.cd').expect(404);
      expect(mailbox.body.code).toBe('NOT_FOUND');

      const email = newEmail('prod');
      for (const [path, body] of [
        [
          '/api/v1/auth/register',
          { email, password: PASSWORD, countryCode: 'CD', acceptedTermsVersion: 1 },
        ],
        ['/api/v1/auth/email/resend', { email }],
        ['/api/v1/auth/password/forgot', { email }],
      ] as const) {
        const response = await http.post(path).set(from(newClientIp())).send(body).expect(503);
        expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
      }
      // Rien n'a été créé : aucun utilisateur n'attend un code qui ne partira jamais.
      const prisma = testApp.app.get(PrismaService);
      expect(await prisma.user.count()).toBe(0);
      expect(
        await prisma.outboxEvent.count({ where: { eventType: { startsWith: 'identity.' } } }),
      ).toBe(0);
    } finally {
      await testApp.close();
    }
  });
});
