import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  adminTransferLimitListSchema,
  adminTransferLimitSchema,
  dataExportSchema,
  problemDetailsSchema,
  systemStatusSchema,
  type Transfer,
  transferAllowanceListSchema,
  transferListSchema,
  transferSchema,
  walletListSchema,
  walletMovementListSchema,
} from '@mgx/contracts';
import { type Asset, defineAsset, Money } from '@mgx/shared';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { LedgerService } from '../../src/modules/ledger/application/ledger.service.js';
import { platformAccount, userAccount } from '../../src/modules/ledger/domain/ledger-account.js';
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
  type RegisteredUser,
  registerVerifiedUser,
  withOwner,
  wrongTotpCode,
} from '../support/identity.js';
import { ledgerSize, registerAssetInSql } from '../support/ledger-sql.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { withConnection } from '../support/test-database.js';
import { freshKey, verifyUpTo } from '../support/transfers-sql.js';

const REASON = 'Ouverture des transferts dans cet actif, décision du 14 novembre';
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = 'https://app.mg-exchange.example';

const USD = defineAsset('USD', 2);
const BTC = defineAsset('BTC', 8);

/** Les deux routes du back-office. */
const BACK_OFFICE_ROUTES = [
  ['get', '/admin/transfer-limits'],
  ['put', '/admin/transfer-limits/USD/1'],
] as const;

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

/**
 * Tout passe par HTTP, sauf ce qu'aucune route ne fait encore : les fonds de départ sont
 * déposés par le grand livre, les niveaux de vérification accordés en SQL. Les blocs
 * s'enchaînent — la fonctionnalité est fermée, puis les plafonds sont fixés, puis elle est
 * ouverte — et chacun part de l'état laissé par le précédent.
 */
describe('Transferts entre titulaires — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  let ledger: LedgerService;
  /** Administrateur (rôle super_admin, second facteur activé), créé par l'outil d'amorçage. */
  let root: Member;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: { TRUST_PROXY_HOPS: '1', CORS_ALLOWED_ORIGINS: ORIGIN },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    ledger = testApp.app.get(LedgerService);
    await testApp.app
      .get(SystemSettingsService)
      .setFeatureEnabled('registration', true, { actor: { type: 'SYSTEM' }, reason: 'test setup' });
    root = await admin();
    await asOwner(async (db) => {
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const asOwner = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);
  const asApp = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(testApp.database.appUrl, work);

  const get = (accessToken: string, path: string, ip = newClientIp()) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(ip));
  const post = (
    accessToken: string,
    path: string,
    body?: Record<string, unknown>,
    ip = newClientIp(),
  ) => http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(ip)).send(body);
  const put = (
    accessToken: string,
    path: string,
    body?: Record<string, unknown>,
    ip = newClientIp(),
  ) => http.put(`/api/v1${path}`).set(bearer(accessToken)).set(from(ip)).send(body);
  const problemOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body);
  const codeOf = (response: { body: unknown }) => problemOf(response).code;
  const detailOf = (response: { body: unknown }) => problemOf(response).detail;
  const pathsOf = (response: { body: unknown }) =>
    problemOf(response).errors?.map((error) => error.path);

  // --- Comptes ---

  async function admin(options: { secondFactor?: boolean } = {}): Promise<Member> {
    const created = await createAdmin(testApp, options);
    const session = await login(http, created);
    return { ...created, accessToken: session.tokens.accessToken };
  }

  /** Utilisateur final connecté, sans niveau vérifié. */
  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
  }

  const deposit = (member: Member, amount: string, asset: Asset = USD): Promise<unknown> =>
    ledger.post({
      idempotencyKey: `e2e:${randomUUID()}`,
      kind: 'test.deposit',
      actor: { type: 'SYSTEM' },
      postings: [
        {
          account: platformAccount('platform_custody'),
          side: 'DEBIT',
          amount: Money.parse(amount, asset),
        },
        { account: userAccount(member.id), side: 'CREDIT', amount: Money.parse(amount, asset) },
      ],
    });

  /** Utilisateur final au niveau de vérification voulu, crédité de `funds` dollars. */
  async function holder(level: 0 | 1 | 2 | 3 = 1, funds: string | null = null): Promise<Member> {
    const member = await customer();
    if (level > 0) {
      await asApp((db) => verifyUpTo(db, member.id, level, root.id));
    }
    if (funds !== null) {
      await deposit(member, funds);
    }
    return member;
  }

  /** Membre du personnel : le rôle, le second facteur, connecté. */
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
    return { ...user, totpSecret, id: first.user.id, accessToken: session.tokens.accessToken };
  }

  // --- Transferts ---

  interface SendOptions {
    /** `null` : sans en-tête. */
    readonly key?: string | null;
    readonly ip?: string;
    readonly body?: Record<string, unknown>;
  }

  /** Demande un transfert en dollars de `sender` à `to` ; `options.body` remplace des champs. */
  function send(sender: Member, to: Member | string, amount: string, options: SendOptions = {}) {
    const sent = http
      .post('/api/v1/me/transfers')
      .set(bearer(sender.accessToken))
      .set(from(options.ip ?? newClientIp()));
    const key = options.key === undefined ? freshKey() : options.key;
    return (key === null ? sent : sent.set('Idempotency-Key', key)).send({
      recipientEmail: typeof to === 'string' ? to : to.email,
      assetCode: 'USD',
      amount,
      currentPassword: sender.password,
      ...options.body,
    });
  }

  /** Le même, abouti : rend le transfert, vérifié contre le schéma publié. */
  async function sent(
    sender: Member,
    to: Member,
    amount: string,
    options: SendOptions = {},
  ): Promise<Transfer> {
    const response = await send(sender, to, amount, options).expect(201);
    const transfer = transferSchema.parse(response.body);
    // Le schéma publié décrit toute la réponse : aucune clé n'en sort.
    expect(response.body).toEqual(transfer);
    return transfer;
  }

  const setLimit = (
    author: Member,
    assetCode: string,
    level: number | string,
    body: Record<string, unknown>,
    ip = newClientIp(),
  ) => put(author.accessToken, `/admin/transfer-limits/${assetCode}/${String(level)}`, body, ip);
  const ceilings = (perTransfer: string, daily: string, monthly: string) => ({
    perTransfer,
    daily,
    monthly,
    reason: REASON,
  });

  // --- Lectures ---

  const walletsOf = async (member: Member): Promise<Record<string, string>> => {
    const response = await get(member.accessToken, '/me/wallets').expect(200);
    const { wallets } = walletListSchema.parse(response.body);
    return Object.fromEntries(wallets.map(({ asset, available }) => [asset.code, available]));
  };
  const transfersOf = async (member: Member, query = '') => {
    const response = await get(member.accessToken, `/me/transfers${query}`).expect(200);
    const page = transferListSchema.parse(response.body);
    expect(response.body).toEqual(page);
    return page;
  };
  const allowancesOf = async (member: Member) => {
    const response = await get(member.accessToken, '/me/transfer-limits').expect(200);
    const list = transferAllowanceListSchema.parse(response.body);
    expect(response.body).toEqual(list);
    return list;
  };
  const usdAllowanceOf = async (member: Member) =>
    (await allowancesOf(member)).allowances.find(({ asset }) => asset.code === 'USD');
  const limitsFor = async (reader: Member) => {
    const response = await get(reader.accessToken, '/admin/transfer-limits').expect(200);
    const list = adminTransferLimitListSchema.parse(response.body);
    expect(response.body).toEqual(list);
    return list.limits;
  };
  const auditBy = (actorId: string, action: string) =>
    prisma.auditLog.findMany({ where: { actorId, action }, orderBy: { id: 'asc' } });
  const written = async () => ({
    ledger: await asApp(ledgerSize),
    transfers: await prisma.transfer.count(),
  });

  // ---------------------------------------------------------------------------------------------
  describe('tant que la fonctionnalité est fermée', () => {
    it('nul ne transfère ; consulter ses transferts et ses plafonds reste possible', async () => {
      const alice = await holder(1, '500.00');
      const bob = await holder(1);

      const status = await http.get('/api/v1/system/status').expect(200);
      expect(systemStatusSchema.parse(status.body).features.internalTransfers).toBe(false);

      const closed = await send(alice, bob, '25.00').expect(403);
      expect(codeOf(closed)).toBe('FEATURE_DISABLED');
      // Rien n'a été examiné : pas même le mot de passe.
      const wrong = await send(alice, bob, '25.00', {
        body: { currentPassword: 'not-the-password-1' },
      }).expect(403);
      expect(codeOf(wrong)).toBe('FEATURE_DISABLED');
      expect(await auditBy(alice.id, 'transfer.proof_failed')).toEqual([]);
      expect(await walletsOf(alice)).toEqual({ BTC: '0.00000000', USD: '500.00' });

      expect(await transfersOf(alice)).toEqual({ transfers: [], nextCursor: null });
      // Aucun plafond n'est livré avec le code : rien n'est fixé, rien ne partirait.
      expect(await allowancesOf(alice)).toEqual({
        enabled: false,
        level: 1,
        allowances: [
          {
            asset: { code: 'BTC', name: 'Asset BTC', kind: 'CRYPTO', scale: 8 },
            limit: null,
            used: { last24Hours: '0.00000000', last31Days: '0.00000000' },
            remaining: '0.00000000',
          },
          {
            asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
            limit: null,
            used: { last24Hours: '0.00', last31Days: '0.00' },
            remaining: '0.00',
          },
        ],
      });
      expect(await limitsFor(root)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('qui a accès', () => {
    it('les transferts et les plafonds du titulaire exigent une session', async () => {
      for (const [method, path] of [
        ['post', '/me/transfers'],
        ['get', '/me/transfers'],
        ['get', `/me/transfers/${UNKNOWN_ID}`],
        ['get', '/me/transfer-limits'],
      ] as const) {
        const anonymous = await http[method](`/api/v1${path}`).set(from(newClientIp())).expect(401);
        expect({ path, code: codeOf(anonymous) }).toEqual({ path, code: 'UNAUTHENTICATED' });
      }
    });

    it('le back-office exige un compte du personnel, la validation en deux étapes et la permission', async () => {
      const call = (accessToken: string | null, [method, path]: readonly [string, string]) => {
        const called =
          method === 'put'
            ? http.put(`/api/v1${path}`).send(ceilings('100', '250', '1000'))
            : http.get(`/api/v1${path}`);
        return (accessToken === null ? called : called.set(bearer(accessToken))).set(
          from(newClientIp()),
        );
      };

      for (const route of BACK_OFFICE_ROUTES) {
        expect({ route, code: codeOf(await call(null, route).expect(401)) }).toEqual({
          route,
          code: 'UNAUTHENTICATED',
        });
      }
      // Un administrateur sans second facteur : la permission ne suffit pas.
      const unprotected = await admin({ secondFactor: false });
      for (const route of BACK_OFFICE_ROUTES) {
        expect({
          route,
          code: codeOf(await call(unprotected.accessToken, route).expect(403)),
        }).toEqual({ route, code: 'MFA_ENROLLMENT_REQUIRED' });
      }
      // Un titulaire, un agent du support, un agent de conformité : aucun ne détient la permission.
      const others = [await customer(), await staff('support'), await staff('compliance')];
      for (const member of others) {
        for (const route of BACK_OFFICE_ROUTES) {
          expect({
            route,
            code: codeOf(await call(member.accessToken, route).expect(403)),
          }).toEqual({ route, code: 'FORBIDDEN' });
        }
      }
      expect(
        await prisma.auditLog.count({
          where: { action: 'authorization.denied', actorId: { in: others.map(({ id }) => id) } },
        }),
      ).toBe(6);
      expect(await prisma.transferLimit.count()).toBe(0);
    });

    it('une permission par action : consulter les plafonds n’autorise pas à les fixer', async () => {
      // Un rôle sur mesure, créé comme le ferait une migration (rôle propriétaire).
      await withOwner(testApp, async (owner) => {
        const role = await owner.role.create({
          data: {
            key: 'limits_auditor',
            name: 'limits_auditor',
            description: 'Rôle de test : consultation des plafonds, sans plus.',
          },
        });
        await owner.rolePermission.create({
          data: { roleId: role.id, permissionKey: 'transfer_limits.read' },
        });
      });
      const auditor = await staff('limits_auditor');

      expect(await limitsFor(auditor)).toEqual([]);
      const refused = await setLimit(auditor, 'USD', 1, ceilings('100', '250', '1000')).expect(403);
      expect(codeOf(refused)).toBe('FORBIDDEN');
      expect(await prisma.transferLimit.count()).toBe(0);
      expect(
        (await auditBy(auditor.id, 'authorization.denied')).map(
          ({ resourceType, resourceId, outcome, metadata }) => ({
            resourceType,
            resourceId,
            outcome,
            metadata,
          }),
        ),
      ).toEqual([
        {
          resourceType: 'route',
          resourceId: 'PUT /api/v1/admin/transfer-limits/USD/1',
          outcome: 'DENIED',
          metadata: { missingPermissions: ['transfer_limits.write'] },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('fixer les plafonds', () => {
    it.each([
      ['plafond par transfert absent', { perTransfer: undefined }, 'perTransfer'],
      ['plafond sur 24 heures absent', { daily: undefined }, 'daily'],
      ['plafond sur 31 jours absent', { monthly: undefined }, 'monthly'],
      ['un nombre JSON au lieu d’une chaîne', { perTransfer: 100 }, 'perTransfer'],
      ['un montant négatif', { daily: '-1' }, 'daily'],
      ['un exposant', { monthly: '1e6' }, 'monthly'],
      ['une virgule décimale', { perTransfer: '99,5' }, 'perTransfer'],
      ['des espaces', { perTransfer: ' 100' }, 'perTransfer'],
      ['une chaîne vide', { daily: '' }, 'daily'],
      ['plus de décimales que n’en a l’actif', { perTransfer: '99.999' }, 'perTransfer'],
      ['24 heures sous le plafond par transfert', { daily: '99.99' }, 'daily'],
      ['31 jours sous le plafond de 24 heures', { monthly: '249.99' }, 'monthly'],
      ['justification absente', { reason: undefined }, 'reason'],
      ['justification trop courte', { reason: 'ok' }, 'reason'],
      ['justification de 501 caractères', { reason: 'r'.repeat(501) }, 'reason'],
      ['un champ inconnu', { weekly: '500' }, ''],
    ])('refuse %s', async (_label, change, path) => {
      const refused = await setLimit(root, 'USD', 1, {
        ...ceilings('100', '250', '1000'),
        ...change,
      }).expect(400);
      expect(codeOf(refused)).toBe('VALIDATION_FAILED');
      expect(pathsOf(refused)).toEqual([path]);
      expect(await prisma.transferLimit.count()).toBe(0);
    });

    it('un niveau de 0 à 3, et un actif que la plateforme tient', async () => {
      for (const level of ['4', '-1', '1.5', 'one', '01', '%20']) {
        const refused = await setLimit(root, 'USD', level, ceilings('100', '250', '1000')).expect(
          400,
        );
        expect({ level, code: codeOf(refused), detail: problemOf(refused).errors }).toEqual({
          level,
          code: 'VALIDATION_FAILED',
          detail: [{ path: '', message: 'Must be a verification level: 0, 1, 2 or 3.' }],
        });
      }
      const lowercase = await setLimit(root, 'usd', 1, ceilings('100', '250', '1000')).expect(400);
      expect(problemOf(lowercase).errors).toEqual([
        { path: '', message: 'Must be an asset code such as "USD" or "BTC".' },
      ]);
      const unknown = await setLimit(root, 'EUR', 1, ceilings('100', '250', '1000')).expect(404);
      expect(codeOf(unknown)).toBe('NOT_FOUND');
      expect(detailOf(unknown)).toBe('Asset not found.');
      expect(await prisma.transferLimit.count()).toBe(0);
    });

    it('fixe les plafonds d’un niveau dans un actif, les remplace, et l’inscrit au journal', async () => {
      const ip = newClientIp();
      const response = await setLimit(root, 'USD', 1, ceilings('50', '250.5', '1000.00'), ip)
        .set('X-Request-Id', 'limits-request-0001')
        .expect(200);
      const set = adminTransferLimitSchema.parse(response.body);
      expect(response.body).toEqual(set);
      expect(set).toEqual({
        asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
        level: 1,
        perTransfer: '50.00',
        daily: '250.50',
        monthly: '1000.00',
        setBy: root.id,
        setAt: expect.any(String),
      });
      expect(await limitsFor(root)).toEqual([set]);

      // Remplacés : toujours une seule ligne pour ce niveau dans cet actif.
      const replaced = adminTransferLimitSchema.parse(
        (await setLimit(root, 'USD', 1, ceilings('100', '250', '1000')).expect(200)).body,
      );
      expect(replaced).toMatchObject({
        perTransfer: '100.00',
        daily: '250.00',
        monthly: '1000.00',
      });
      expect(new Date(replaced.setAt).getTime()).toBeGreaterThan(new Date(set.setAt).getTime());
      // Les autres niveaux : le 2, dix fois plus ; le 3, refermé ; le 0, rien.
      await setLimit(root, 'USD', 2, ceilings('1000', '2500', '10000')).expect(200);
      await setLimit(root, 'USD', 3, ceilings('0', '0', '0')).expect(200);
      expect(
        (await limitsFor(root)).map(({ asset, level, perTransfer, daily, monthly }) => ({
          asset: asset.code,
          level,
          perTransfer,
          daily,
          monthly,
        })),
      ).toEqual([
        { asset: 'USD', level: 1, perTransfer: '100.00', daily: '250.00', monthly: '1000.00' },
        { asset: 'USD', level: 2, perTransfer: '1000.00', daily: '2500.00', monthly: '10000.00' },
        { asset: 'USD', level: 3, perTransfer: '0.00', daily: '0.00', monthly: '0.00' },
      ]);

      const changes = await auditBy(root.id, 'transfer_limit.set');
      expect(changes).toHaveLength(4);
      expect(changes[0]).toMatchObject({
        actorType: 'USER',
        resourceType: 'transfer_limit',
        resourceId: 'USD:1',
        outcome: 'SUCCESS',
        requestId: 'limits-request-0001',
        ipAddress: ip,
        metadata: {
          assetCode: 'USD',
          level: 1,
          before: null,
          after: { perTransfer: '50.00', daily: '250.50', monthly: '1000.00' },
          reason: REASON,
        },
      });
      expect(changes[1]?.metadata).toMatchObject({
        before: { perTransfer: '50.00', daily: '250.50', monthly: '1000.00' },
        after: { perTransfer: '100.00', daily: '250.00', monthly: '1000.00' },
      });
      // Chaque consultation est inscrite, elle aussi.
      expect(
        (await auditBy(root.id, 'transfer_limit.listed_by_admin')).map(({ metadata }) => metadata),
      ).toEqual([{ results: 0 }, { results: 1 }, { results: 3 }]);
    });

    it('le titulaire lit les plafonds de son niveau — mais rien ne part tant que la fonctionnalité est fermée', async () => {
      const alice = await holder(1, '500.00');
      const bob = await holder(1);

      expect(await allowancesOf(alice)).toMatchObject({ enabled: false, level: 1 });
      expect(await usdAllowanceOf(alice)).toEqual({
        asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
        limit: { perTransfer: '100.00', daily: '250.00', monthly: '1000.00' },
        used: { last24Hours: '0.00', last31Days: '0.00' },
        remaining: '100.00',
      });
      expect(codeOf(await send(alice, bob, '25.00').expect(403))).toBe('FEATURE_DISABLED');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('la fonctionnalité ouverte', () => {
    let alice: Member;
    let bob: Member;

    beforeAll(async () => {
      // Ouverte par le back-office, comme elle le sera en service.
      await put(root.accessToken, '/admin/system-settings/features.internal_transfers', {
        value: true,
        reason: REASON,
      }).expect(200);
      alice = await holder(1, '500.00');
      bob = await holder(1);
    });

    it('l’état public de la plateforme le dit, et les plafonds du titulaire aussi', async () => {
      const status = await http.get('/api/v1/system/status').expect(200);
      expect(systemStatusSchema.parse(status.body).features.internalTransfers).toBe(true);
      expect((await allowancesOf(alice)).enabled).toBe(true);
    });

    describe('la clé d’idempotence', () => {
      it.each([
        ['absente', null],
        ['vide', ''],
        ['de 15 caractères', 'a'.repeat(15)],
        ['de 129 caractères', 'a'.repeat(129)],
        ['qui commence par un tiret', `-${'a'.repeat(20)}`],
        ['avec une espace', 'retry number one 0001'],
        ['avec une barre oblique', 'orders/42/retries/0001'],
        ['avec un caractère accentué', 'clé-de-la-requête-0001'],
      ])('refuse une clé %s', async (_label, key) => {
        const before = await written();
        const refused = await send(alice, bob, '25.00', { key }).expect(400);
        expect(codeOf(refused)).toBe('VALIDATION_FAILED');
        expect(problemOf(refused).errors).toEqual([
          {
            path: 'Idempotency-Key',
            message:
              'This header is required: 16 to 128 letters, digits, ".", "_", ":" or "-". ' +
              'Send the same value when retrying the same request.',
          },
        ]);
        expect(await written()).toEqual(before);
      });

      it('refuse un en-tête répété', async () => {
        const refused = await http
          .post('/api/v1/me/transfers')
          .set(bearer(alice.accessToken))
          .set(from(newClientIp()))
          .set('Idempotency-Key', [freshKey(), freshKey()] as unknown as string)
          .send({
            recipientEmail: bob.email,
            assetCode: 'USD',
            amount: '25.00',
            currentPassword: alice.password,
          })
          .expect(400);
        expect(pathsOf(refused)).toEqual(['Idempotency-Key']);
      });

      it.each([
        ['un UUID', '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d'],
        ['16 caractères', 'a'.repeat(16)],
        ['128 caractères', 'b'.repeat(128)],
        ['des points, des tirets bas, des deux-points', 'order_42:retry.3-final'],
      ])('admet %s', async (_label, key) => {
        const sender = await holder(1, '10.00');
        const transfer = await sent(sender, bob, '1.00', { key });
        expect(
          (await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } })).idempotencyKey,
        ).toBe(key);
      });
    });

    describe('la requête', () => {
      it.each([
        ['adresse du destinataire absente', { recipientEmail: undefined }, 'recipientEmail'],
        ['adresse mal formée', { recipientEmail: 'bob-at-example.cd' }, 'recipientEmail'],
        ['adresse qui n’est pas un texte', { recipientEmail: 42 }, 'recipientEmail'],
        ['actif absent', { assetCode: undefined }, 'assetCode'],
        ['actif en minuscules', { assetCode: 'usd' }, 'assetCode'],
        ['montant absent', { amount: undefined }, 'amount'],
        ['un nombre JSON au lieu d’une chaîne', { amount: 25 }, 'amount'],
        ['montant négatif', { amount: '-25.00' }, 'amount'],
        ['montant nul', { amount: '0.00' }, 'amount'],
        ['un exposant', { amount: '2.5e1' }, 'amount'],
        ['une virgule décimale', { amount: '25,00' }, 'amount'],
        ['un signe plus', { amount: '+25.00' }, 'amount'],
        ['des zéros de tête', { amount: '025.00' }, 'amount'],
        ['mot de passe absent', { currentPassword: undefined }, 'currentPassword'],
        [
          'un code et un code de secours ensemble',
          { code: '123456', recoveryCode: 'ABCDE-FGHIJ' },
          'code',
        ],
        ['un champ inconnu', { memo: 'pour le loyer' }, ''],
        [
          'l’identifiant du destinataire à la place de son adresse',
          { recipientId: UNKNOWN_ID },
          '',
        ],
      ])('refuse %s', async (_label, change, path) => {
        const before = await written();
        const refused = await send(alice, bob, '25.00', { body: change }).expect(400);
        expect(codeOf(refused)).toBe('VALIDATION_FAILED');
        expect(pathsOf(refused)).toContain(path);
        expect(await written()).toEqual(before);
      });

      it('un actif que la plateforme tient, un montant à sa précision', async () => {
        const unknown = await send(alice, bob, '25.00', { body: { assetCode: 'EUR' } }).expect(400);
        expect(problemOf(unknown).errors).toEqual([
          { path: 'assetCode', message: 'The platform does not keep this asset.' },
        ]);
        const precise = await send(alice, bob, '25.001').expect(400);
        expect(problemOf(precise).errors).toEqual([
          { path: 'amount', message: 'Must have at most 2 decimal places: the precision of USD.' },
        ]);
      });
    });

    describe('un transfert', () => {
      let alice: Member;
      let bob: Member;
      let key: string;
      let transfer: Transfer;

      beforeAll(async () => {
        alice = await holder(1, '500.00');
        bob = await holder(1);
      });

      it('répond 201 avec le transfert ; les deux portefeuilles ont bougé', async () => {
        key = freshKey();
        const response = await send(alice, bob, '25.5', { key }).expect(201);

        transfer = transferSchema.parse(response.body);
        expect(response.body).toEqual({
          id: expect.stringMatching(UUID),
          direction: 'SENT',
          asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
          amount: '25.50',
          counterparty: { email: bob.email },
          entryId: expect.stringMatching(UUID),
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        });
        expect(response.headers['idempotent-replayed']).toBeUndefined();
        expect(response.headers['content-type']).toMatch(/^application\/json/);

        expect((await walletsOf(alice))['USD']).toBe('474.50');
        expect((await walletsOf(bob))['USD']).toBe('25.50');
      });

      it('le mouvement de chaque portefeuille porte l’écriture du transfert', async () => {
        const movementsOf = async (member: Member) =>
          walletMovementListSchema.parse(
            (await get(member.accessToken, '/me/wallets/USD/movements').expect(200)).body,
          ).movements;

        expect((await movementsOf(alice))[0]).toMatchObject({
          entryId: transfer.entryId,
          kind: 'transfer.internal',
          side: 'DEBIT',
          amount: '25.50',
          balanceAfter: '474.50',
        });
        expect(await movementsOf(bob)).toEqual([
          {
            id: expect.stringMatching(UUID),
            entryId: transfer.entryId,
            kind: 'transfer.internal',
            side: 'CREDIT',
            amount: '25.50',
            balanceAfter: '25.50',
            postedAt: expect.any(String),
          },
        ]);
      });

      it('la même requête sous la même clé : 201, le même transfert, l’en-tête Idempotent-Replayed — et rien de plus', async () => {
        const before = await written();
        // « 25.5 » ou « 25.50 », l'adresse en capitales : la même requête.
        for (const body of [{}, { amount: '25.50' }, { recipientEmail: bob.email.toUpperCase() }]) {
          const replayed = await send(alice, bob, '25.5', { key, body }).expect(201);
          expect(replayed.body).toEqual(transfer);
          expect(replayed.headers['idempotent-replayed']).toBe('true');
        }
        expect(await written()).toEqual(before);
        expect((await walletsOf(alice))['USD']).toBe('474.50');
        expect((await walletsOf(bob))['USD']).toBe('25.50');
      });

      it('une autre requête sous la même clé : 422', async () => {
        const reused = await send(alice, bob, '25.51', { key }).expect(422);
        expect(codeOf(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(detailOf(reused)).toBe(
          'This idempotency key was already used for a different transfer.',
        );
        expect(reused.headers['idempotent-replayed']).toBeUndefined();
      });

      it('chaque partie le retrouve dans ses transferts ; pour un tiers, il n’existe pas', async () => {
        const one = async (member: Member) =>
          transferSchema.parse(
            (await get(member.accessToken, `/me/transfers/${transfer.id}`).expect(200)).body,
          );
        expect(await one(alice)).toEqual(transfer);
        expect(await one(bob)).toEqual({
          ...transfer,
          direction: 'RECEIVED',
          counterparty: { email: alice.email },
        });
        expect((await transfersOf(alice)).transfers[0]).toEqual(transfer);
        expect((await transfersOf(bob)).transfers[0]).toMatchObject({
          id: transfer.id,
          direction: 'RECEIVED',
        });

        const carol = await holder(1);
        for (const id of [transfer.id, UNKNOWN_ID]) {
          const missing = await get(carol.accessToken, `/me/transfers/${id}`).expect(404);
          expect(codeOf(missing)).toBe('NOT_FOUND');
          expect(detailOf(missing)).toBe('Transfer not found.');
        }
        const malformed = await get(alice.accessToken, '/me/transfers/not-an-id').expect(400);
        expect(codeOf(malformed)).toBe('VALIDATION_FAILED');
      });

      it('les deux parties sont prévenues par e-mail', async () => {
        const toSender = await nextMessageOf(testApp, alice.email, 'transfer_sent');
        const toRecipient = await nextMessageOf(testApp, bob.email, 'transfer_received');
        await backgroundWorkDone(testApp);

        expect(toSender.text).toContain('Montant : 25.50 USD');
        expect(toSender.text).toContain(`Destinataire : ${bob.email}`);
        expect(toRecipient.text).toContain('Montant : 25.50 USD');
        expect(toRecipient.text).toContain(`Expéditeur : ${alice.email}`);
        // Une fois chacun : rejouer la requête n'a prévenu personne de plus.
        for (const member of [alice, bob]) {
          expect(
            mailbox(testApp)
              .messagesFor(member.email)
              .filter(({ template }) => template.startsWith('transfer_')),
          ).toHaveLength(1);
        }
      });

      it('l’historique de sécurité de l’émetteur le mentionne, avec l’adresse d’où il a été demandé', async () => {
        const ip = newClientIp();
        const carol = await holder(1, '100.00');
        await sent(carol, bob, '10.00', { ip });
        await send(carol, bob, '10.00', {
          ip,
          body: { currentPassword: 'not-the-password-1' },
        }).expect(401);
        await send(carol, bob, '100.01', { ip }).expect(422);

        const activity = activityListSchema.parse(
          (await get(carol.accessToken, '/me/activity?limit=3').expect(200)).body,
        );
        expect(
          activity.entries.map(({ type, outcome, ipAddress }) => ({ type, outcome, ipAddress })),
        ).toEqual([
          { type: 'TRANSFER_REFUSED', outcome: 'DENIED', ipAddress: ip },
          { type: 'TRANSFER_FAILED', outcome: 'FAILURE', ipAddress: ip },
          { type: 'TRANSFER_SENT', outcome: 'SUCCESS', ipAddress: ip },
        ]);
        // Recevoir n'est pas un événement de sécurité : l'historique de Bob n'en dit rien.
        const received = activityListSchema.parse(
          (await get(bob.accessToken, '/me/activity?limit=100').expect(200)).body,
        );
        expect(received.entries.map(({ type }) => type)).not.toContain('TRANSFER_SENT');
      });
    });

    describe('preuve du titulaire', () => {
      it('un mot de passe erroné : 401, rien ne part', async () => {
        const sender = await holder(1, '100.00');
        const before = await written();
        const wrong = await send(sender, bob, '25.00', {
          body: { currentPassword: 'not-the-password-1' },
        }).expect(401);
        expect(codeOf(wrong)).toBe('INVALID_CREDENTIALS');
        expect(await written()).toEqual(before);
        expect(
          (await auditBy(sender.id, 'transfer.proof_failed')).map(({ outcome }) => outcome),
        ).toEqual(['FAILURE']);
      });

      it('sur un compte protégé : le code de l’application, ou un code de secours', async () => {
        const unprotected = await holder(1, '100.00');
        const totpSecret = await enableSecondFactor(testApp, unprotected);
        // Activer la validation en deux étapes ferme les autres sessions : nouvelle connexion.
        const session = await login(http, { ...unprotected, totpSecret });
        const sender = { ...unprotected, totpSecret, accessToken: session.tokens.accessToken };

        const missing = await send(sender, bob, '10.00').expect(422);
        expect(codeOf(missing)).toBe('UNPROCESSABLE_ENTITY');
        const wrong = await send(sender, bob, '10.00', {
          body: { code: wrongTotpCode(totpSecret) },
        }).expect(400);
        expect(codeOf(wrong)).toBe('INVALID_OR_EXPIRED_CODE');
        expect((await walletsOf(sender))['USD']).toBe('100.00');

        await sent(sender, bob, '10.00', { body: { code: nextTotpCode(totpSecret) } });
        expect((await walletsOf(sender))['USD']).toBe('90.00');
      });
    });

    describe('refus', () => {
      it('niveau sans plafond, ou refermé : 403', async () => {
        for (const level of [0, 3] as const) {
          const sender = await holder(level, '100.00');
          const refused = await send(sender, bob, '1.00').expect(403);
          expect({ level, code: codeOf(refused), detail: detailOf(refused) }).toEqual({
            level,
            code: 'TRANSFER_NOT_PERMITTED',
            detail: 'Transfers in this asset are not open to your verification level.',
          });
        }
      });

      it('plafonds dépassés : 422, et le message dit lequel', async () => {
        const sender = await holder(1, '500.00');
        const over = await send(sender, bob, '100.01').expect(422);
        expect(codeOf(over)).toBe('TRANSFER_LIMIT_EXCEEDED');
        expect(detailOf(over)).toBe(
          'The amount exceeds the limit per transfer of your verification level.',
        );

        await sent(sender, bob, '100.00');
        await sent(sender, bob, '100.00');
        expect(await usdAllowanceOf(sender)).toMatchObject({
          used: { last24Hours: '200.00', last31Days: '200.00' },
          remaining: '50.00',
        });
        const daily = await send(sender, bob, '50.01').expect(422);
        expect(codeOf(daily)).toBe('TRANSFER_LIMIT_EXCEEDED');
        expect(detailOf(daily)).toBe(
          'The amount exceeds what your verification level may still send over 24 hours.',
        );
        await sent(sender, bob, '50.00');
        expect((await usdAllowanceOf(sender))?.remaining).toBe('0.00');
      });

      it('fonds insuffisants : 422', async () => {
        const sender = await holder(1, '30.00');
        const refused = await send(sender, bob, '30.01').expect(422);
        expect(codeOf(refused)).toBe('INSUFFICIENT_FUNDS');
        expect(detailOf(refused)).toBe('Your wallet does not hold this amount.');
        await sent(sender, bob, '30.00');
        expect((await walletsOf(sender))['USD']).toBe('0.00');
      });

      it('destinataire inconnu, sans niveau ouvert, ou soi-même : 422, sans dire pourquoi', async () => {
        const sender = await holder(1, '100.00');
        const unverified = await holder(0);

        for (const recipient of ['nobody@example.cd', unverified.email]) {
          const refused = await send(sender, recipient, '10.00').expect(422);
          expect({ code: codeOf(refused), detail: detailOf(refused) }).toEqual({
            code: 'RECIPIENT_UNAVAILABLE',
            detail: 'This recipient cannot receive transfers.',
          });
        }
        const own = await send(sender, sender, '10.00').expect(422);
        expect(codeOf(own)).toBe('UNPROCESSABLE_ENTITY');
        expect(detailOf(own)).toBe('You cannot transfer funds to your own account.');
        expect((await walletsOf(sender))['USD']).toBe('100.00');
      });
    });

    describe('consulter ses transferts', () => {
      it('page par page, du plus récent au plus ancien', async () => {
        const sender = await holder(2, '500.00');
        const recipient = await holder(2, '500.00');
        for (const amount of ['1.00', '2.00', '3.00']) {
          await sent(sender, recipient, amount);
        }
        await sent(recipient, sender, '4.00');
        await sent(sender, recipient, '5.00');

        const first = await transfersOf(sender, '?limit=2');
        expect(first.transfers.map(({ amount, direction }) => `${direction} ${amount}`)).toEqual([
          'SENT 5.00',
          'RECEIVED 4.00',
        ]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await transfersOf(sender, `?limit=2&after=${first.nextCursor ?? ''}`);
        expect(second.transfers.map(({ amount }) => amount)).toEqual(['3.00', '2.00']);
        const third = await transfersOf(sender, `?limit=2&after=${second.nextCursor ?? ''}`);
        expect(third).toMatchObject({ transfers: [{ amount: '1.00' }], nextCursor: null });
        // Vingt par défaut.
        expect((await transfersOf(sender)).transfers).toHaveLength(5);
      });

      it.each([
        ['une taille de page nulle', '?limit=0', 'limit'],
        ['une taille de page de 101', '?limit=101', 'limit'],
        ['une taille de page fractionnaire', '?limit=2.5', 'limit'],
        ['un curseur forgé', '?after=not-a-cursor', 'after'],
        ['un paramètre inconnu', '?direction=SENT', ''],
      ])('refuse %s', async (_label, query, path) => {
        const refused = await get(alice.accessToken, `/me/transfers${query}`).expect(400);
        expect(codeOf(refused)).toBe('VALIDATION_FAILED');
        expect(pathsOf(refused)).toEqual([path]);
      });
    });

    describe('navigateurs', () => {
      it('l’en-tête de la clé peut être envoyé, et celui de la réponse rejouée peut être lu', async () => {
        const preflight = await http
          .options('/api/v1/me/transfers')
          .set('Origin', ORIGIN)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key')
          .expect(204);
        expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
        expect(preflight.headers['access-control-allow-headers']?.split(',')).toContain(
          'Idempotency-Key',
        );

        const sender = await holder(1, '50.00');
        const key = freshKey();
        await sent(sender, bob, '5.00', { key });
        const replayed = await send(sender, bob, '5.00', { key }).set('Origin', ORIGIN).expect(201);
        expect(replayed.headers['idempotent-replayed']).toBe('true');
        expect(replayed.headers['access-control-expose-headers']?.split(',')).toContain(
          'Idempotent-Replayed',
        );
      });
    });

    describe('bornes', () => {
      it('soixante demandes par minute et par adresse', async () => {
        const sender = await holder(1, '50.00');
        const ip = newClientIp();
        // Des demandes sans clé : refusées, mais comptées.
        for (let attempt = 1; attempt <= 60; attempt += 1) {
          await send(sender, bob, '1.00', { key: null, ip }).expect(400);
        }
        const blocked = await send(sender, bob, '1.00', { ip }).expect(429);
        expect(codeOf(blocked)).toBe('RATE_LIMITED');
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
        expect((await walletsOf(sender))['USD']).toBe('50.00');
        // D'une autre adresse, le même compte transfère.
        await sent(sender, bob, '1.00');
      });
    });

    describe('pendant la maintenance', () => {
      it('les titulaires attendent ; le back-office règle les plafonds', async () => {
        const sender = await holder(1, '50.00');
        const settings = testApp.app.get(SystemSettingsService);
        const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: maintenance window' };
        await settings.set('maintenance.mode', { enabled: true, message: null }, context);
        try {
          expect(codeOf(await send(sender, bob, '1.00').expect(503))).toBe('MAINTENANCE');
          for (const path of [
            '/me/transfers',
            `/me/transfers/${UNKNOWN_ID}`,
            '/me/transfer-limits',
          ]) {
            expect(codeOf(await get(sender.accessToken, path).expect(503))).toBe('MAINTENANCE');
          }
          expect(await limitsFor(root)).toHaveLength(3);
          await setLimit(root, 'BTC', 2, ceilings('0.5', '1', '2')).expect(200);
        } finally {
          await settings.set('maintenance.mode', { enabled: false, message: null }, context);
        }
        expect((await walletsOf(sender))['USD']).toBe('50.00');
        expect(await limitsFor(root)).toHaveLength(4);
      });
    });

    describe('refermer', () => {
      it('des plafonds ramenés à zéro referment le niveau, en envoi comme en réception', async () => {
        const second = await holder(2, '100.00');
        const peer = await holder(2);
        const first = await holder(1, '100.00');
        await sent(second, peer, '10.00');

        await setLimit(root, 'USD', 2, ceilings('0', '0', '0')).expect(200);
        try {
          expect(codeOf(await send(second, peer, '10.00').expect(403))).toBe(
            'TRANSFER_NOT_PERMITTED',
          );
          expect(codeOf(await send(first, peer, '10.00').expect(422))).toBe(
            'RECIPIENT_UNAVAILABLE',
          );
          expect(await usdAllowanceOf(second)).toMatchObject({
            limit: { perTransfer: '0.00', daily: '0.00', monthly: '0.00' },
            remaining: '0.00',
          });
        } finally {
          await setLimit(root, 'USD', 2, ceilings('1000', '2500', '10000')).expect(200);
        }
        await sent(second, peer, '10.00');
      });

      it('la fonctionnalité refermée, les transferts faits restent consultables', async () => {
        const sender = await holder(1, '50.00');
        const made = await sent(sender, bob, '5.00');

        await put(root.accessToken, '/admin/system-settings/features.internal_transfers', {
          value: false,
          reason: REASON,
        }).expect(200);
        try {
          expect(codeOf(await send(sender, bob, '5.00').expect(403))).toBe('FEATURE_DISABLED');
          expect((await transfersOf(sender)).transfers).toEqual([made]);
          await get(sender.accessToken, `/me/transfers/${made.id}`).expect(200);
          expect((await allowancesOf(sender)).enabled).toBe(false);
        } finally {
          await put(root.accessToken, '/admin/system-settings/features.internal_transfers', {
            value: true,
            reason: REASON,
          }).expect(200);
        }
      });
    });

    describe('copie des données et clôture du compte', () => {
      it('la copie des données contient les transferts, envoyés et reçus', async () => {
        // Des comptes sans niveau vérifié : le niveau 0 est ouvert en bitcoins, comme peut le
        // décider la plateforme.
        await setLimit(root, 'BTC', 0, ceilings('0.01', '0.01', '0.01')).expect(200);
        const sender = await customer();
        const recipient = await customer();
        await deposit(sender, '0.5', BTC);
        await deposit(recipient, '0.5', BTC);
        const bitcoins = { body: { assetCode: 'BTC' } };
        const made = await sent(sender, recipient, '0.005', bitcoins);
        const back = await sent(recipient, sender, '0.00000002', bitcoins);
        expect(made).toMatchObject({ amount: '0.00500000', asset: { code: 'BTC', scale: 8 } });

        const response = await post(sender.accessToken, '/me/data-export', {
          currentPassword: sender.password,
        }).expect(200);
        const copy = dataExportSchema.parse(response.body);
        expect(response.body).toEqual(copy);
        expect(copy.formatVersion).toBe(4);
        expect(copy.transfers).toEqual({
          items: [
            { ...back, direction: 'RECEIVED', counterparty: { email: recipient.email } },
            made,
          ],
          truncated: false,
        });
        const [exported] = await auditBy(sender.id, 'user.data_exported');
        expect(exported?.metadata).toMatchObject({ transfers: 2 });

        // Un compte qui n'a jamais transféré : la section est là, vide.
        const idle = await customer();
        const empty = dataExportSchema.parse(
          (
            await post(idle.accessToken, '/me/data-export', {
              currentPassword: idle.password,
            }).expect(200)
          ).body,
        );
        expect(empty.transfers).toEqual({ items: [], truncated: false });
      });

      it('des fonds retiennent la clôture ; une fois envoyés, le compte se clôt, et l’autre partie garde ses transferts', async () => {
        const leaving = await holder(1, '60.00');
        const staying = await holder(1);
        const closeOwn = () =>
          post(leaving.accessToken, '/me/close', {
            currentPassword: leaving.password,
            confirm: true,
          });

        const blocked = await closeOwn().expect(409);
        expect(codeOf(blocked)).toBe('CONFLICT');
        expect(detailOf(blocked)).toBe(
          'The account cannot be closed: it still holds funds, which must be withdrawn or transferred first.',
        );
        const made = await sent(leaving, staying, '60.00');
        await closeOwn().expect(200);

        // L'adresse du compte clôturé ne sort plus : ni dans le transfert, ni dans les messages.
        expect(
          transferSchema.parse(
            (await get(staying.accessToken, `/me/transfers/${made.id}`).expect(200)).body,
          ),
        ).toEqual({ ...made, direction: 'RECEIVED', counterparty: { email: null } });
        // Cette adresse ne reçoit plus rien : pour un émetteur, elle n'a pas de compte.
        const refused = await send(staying, leaving.email, '10.00').expect(422);
        expect(codeOf(refused)).toBe('RECIPIENT_UNAVAILABLE');
        expect((await walletsOf(staying))['USD']).toBe('60.00');
      });
    });
  });
});
