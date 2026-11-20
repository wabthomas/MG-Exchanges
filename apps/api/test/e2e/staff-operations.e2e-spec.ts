import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  adminLedgerEntrySchema,
  dataExportSchema,
  type LedgerAdjustment,
  ledgerAdjustmentListSchema,
  ledgerAdjustmentSchema,
  problemDetailsSchema,
  systemStatusSchema,
  transferSchema,
  type WalletFreeze,
  walletFreezeListSchema,
  walletFreezeSchema,
  walletListSchema,
  walletMovementListSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
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
import { freshKey, setLimitInSql, verifyUpTo } from '../support/transfers-sql.js';

const REASON = 'Dépôt en espèces constaté au guichet, reçu n° 2026-11-0042';
const FREEZE_REASON = 'Signalement du service conformité, dossier 2026-118';
const LIFT_REASON = 'Vérification terminée, rien à signaler';
const NOTE = 'Pièce justificative absente du dossier';
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const USD_VIEW = { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 };

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

/** Une route du back-office : sa méthode, son chemin, le corps qu'elle attend. */
type Route = readonly [method: 'get' | 'post', path: string, body?: Record<string, unknown>];

/**
 * Tout passe par HTTP : les fonds entrent par un ajustement, demandé par un administrateur et
 * approuvé par un autre. Seuls les niveaux de vérification et les plafonds de transfert sont
 * posés en SQL. Les blocs s'enchaînent — la fonctionnalité est fermée, puis ouverte — et
 * chacun part de l'état laissé par le précédent.
 */
describe('Opérations du personnel — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  /** Deux administrateurs (rôle super_admin, second facteur activé) : l'un demande, l'autre décide. */
  let root: Member;
  let second: Member;
  let compliance: Member;
  let support: Member;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    const settings = testApp.app.get(SystemSettingsService);
    const context = { actor: { type: 'SYSTEM' } as const, reason: 'test setup' };
    await settings.setFeatureEnabled('registration', true, context);
    await settings.setFeatureEnabled('internalTransfers', true, context);
    root = await admin();
    second = await admin();
    compliance = await staff('compliance');
    support = await staff('support');
    await asOwner(async (db) => {
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
      // Transferts en dollars ouverts au niveau 1 : 100 par transfert, 250 par jour, 1 000 par mois.
      await setLimitInSql(db, 'USD', 1, [10_000, 25_000, 100_000]);
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

  /** Titulaire connecté ; vérifié au niveau 1, sauf mention contraire. */
  async function customer(options: { verified?: boolean } = {}): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    if (options.verified !== false) {
      await asApp((db) => verifyUpTo(db, session.user.id, 1, root.id));
    }
    return { ...user, id: session.user.id, accessToken: session.tokens.accessToken };
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

  // --- Ajustements ---

  const adjustmentBody = (
    holder: Member | string,
    direction: 'CREDIT' | 'DEBIT',
    amount: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    userId: typeof holder === 'string' ? holder : holder.id,
    assetCode: 'USD',
    direction,
    amount,
    reason: REASON,
    ...overrides,
  });

  /** Demande un ajustement en dollars au nom de `author`. */
  const requestAdjustment = (
    author: Member,
    holder: Member | string,
    direction: 'CREDIT' | 'DEBIT',
    amount: string,
    overrides: Record<string, unknown> = {},
  ) =>
    post(
      author.accessToken,
      '/admin/ledger/adjustments',
      adjustmentBody(holder, direction, amount, overrides),
    );

  /** Le même, abouti : rend la demande, vérifiée contre le schéma publié. */
  async function requested(
    holder: Member,
    direction: 'CREDIT' | 'DEBIT',
    amount: string,
    author: Member = root,
  ): Promise<LedgerAdjustment> {
    const response = await requestAdjustment(author, holder, direction, amount).expect(201);
    const adjustment = ledgerAdjustmentSchema.parse(response.body);
    // Le schéma publié décrit toute la réponse : aucune clé n'en sort.
    expect(response.body).toEqual(adjustment);
    return adjustment;
  }

  /** Ce que l'approbateur présente : son mot de passe et un code neuf de son application. */
  const proofOf = (approver: Member): Record<string, unknown> => ({
    currentPassword: approver.password,
    code: nextTotpCode(approver.totpSecret!),
  });

  const approve = (
    approver: Member,
    id: string,
    body: Record<string, unknown> = proofOf(approver),
  ) => post(approver.accessToken, `/admin/ledger/adjustments/${id}/approve`, body);

  /** Un ajustement demandé par `root` et approuvé par `second`. */
  async function adjusted(
    holder: Member,
    direction: 'CREDIT' | 'DEBIT',
    amount: string,
  ): Promise<LedgerAdjustment> {
    const { id } = await requested(holder, direction, amount);
    const response = await approve(second, id).expect(200);
    const adjustment = ledgerAdjustmentSchema.parse(response.body);
    expect(response.body).toEqual(adjustment);
    return adjustment;
  }

  /** Titulaire vérifié, crédité de `funds` dollars par un ajustement. */
  async function holder(funds: string | null = null): Promise<Member> {
    const member = await customer();
    if (funds !== null) {
      await adjusted(member, 'CREDIT', funds);
    }
    return member;
  }

  // --- Gels ---

  const freezeWallet = (author: Member, target: Member | string, assetCode = 'USD') =>
    post(author.accessToken, '/admin/ledger/wallet-freezes', {
      userId: typeof target === 'string' ? target : target.id,
      assetCode,
      reason: FREEZE_REASON,
    });
  async function frozen(target: Member, author: Member = compliance): Promise<WalletFreeze> {
    const response = await freezeWallet(author, target).expect(201);
    const freeze = walletFreezeSchema.parse(response.body);
    expect(response.body).toEqual(freeze);
    return freeze;
  }
  const liftFreeze = (
    author: Member,
    id: string,
    body: Record<string, unknown> = { reason: LIFT_REASON },
  ) => post(author.accessToken, `/admin/ledger/wallet-freezes/${id}/lift`, body);

  // --- Transferts et lectures ---

  const send = (sender: Member, to: Member, amount: string) =>
    http
      .post('/api/v1/me/transfers')
      .set(bearer(sender.accessToken))
      .set(from(newClientIp()))
      .set('Idempotency-Key', freshKey())
      .send({
        recipientEmail: to.email,
        assetCode: 'USD',
        amount,
        currentPassword: sender.password,
      });
  const walletsOf = async (member: Member) => {
    const response = await get(member.accessToken, '/me/wallets').expect(200);
    const list = walletListSchema.parse(response.body);
    expect(response.body).toEqual(list);
    return Object.fromEntries(
      list.wallets.map(({ asset, available, frozen: state }) => [
        asset.code,
        { available, frozen: state },
      ]),
    );
  };
  const movementsOf = async (member: Member, assetCode = 'USD') => {
    const response = await get(member.accessToken, `/me/wallets/${assetCode}/movements`).expect(
      200,
    );
    return walletMovementListSchema.parse(response.body);
  };
  const activityOf = async (member: Member) => {
    const response = await get(member.accessToken, '/me/activity?limit=50').expect(200);
    return activityListSchema.parse(response.body).entries.map(({ type }) => type);
  };
  const auditBy = (actorId: string, action: string) =>
    prisma.auditLog.findMany({ where: { actorId, action }, orderBy: { id: 'asc' } });
  const openAdjustments = (author: Member = root) =>
    http
      .put('/api/v1/admin/system-settings/features.manual_adjustments')
      .set(bearer(author.accessToken))
      .set(from(newClientIp()))
      .send({ value: true, reason: 'Ouverture des ajustements manuels, décision du 14 novembre' });
  const written = async () => ({
    ledger: await asApp(ledgerSize),
    adjustments: await prisma.ledgerAdjustment.count(),
    freezes: await prisma.walletFreeze.count(),
  });

  /** Les neuf routes de ce lot, avec un corps recevable. */
  const routesFor = (holderId: string, adjustmentId: string, freezeId: string): Route[] => [
    ['get', '/admin/ledger/adjustments'],
    ['post', '/admin/ledger/adjustments', adjustmentBody(holderId, 'CREDIT', '10.00')],
    ['get', `/admin/ledger/adjustments/${adjustmentId}`],
    [
      'post',
      `/admin/ledger/adjustments/${adjustmentId}/approve`,
      { currentPassword: 'un-mot-de-passe-quelconque', code: '000000' },
    ],
    ['post', `/admin/ledger/adjustments/${adjustmentId}/reject`, { note: NOTE }],
    ['post', `/admin/ledger/adjustments/${adjustmentId}/cancel`],
    ['get', '/admin/ledger/wallet-freezes'],
    [
      'post',
      '/admin/ledger/wallet-freezes',
      { userId: holderId, assetCode: 'USD', reason: FREEZE_REASON },
    ],
    ['post', `/admin/ledger/wallet-freezes/${freezeId}/lift`, { reason: LIFT_REASON }],
  ];
  const call = (accessToken: string | null, [method, path, body]: Route) => {
    const called =
      method === 'post' ? http.post(`/api/v1${path}`).send(body) : http.get(`/api/v1${path}`);
    return (accessToken === null ? called : called.set(bearer(accessToken))).set(
      from(newClientIp()),
    );
  };

  // ---------------------------------------------------------------------------------------------
  describe('tant que les ajustements manuels sont fermés', () => {
    it('nul n’en demande ni n’en approuve — pas même un administrateur ; les gels, eux, se posent', async () => {
      const alice = await customer();
      const status = await http.get('/api/v1/system/status').expect(200);
      expect(systemStatusSchema.parse(status.body).features.manualAdjustments).toBe(false);
      const before = await written();

      const closed = await requestAdjustment(root, alice, 'CREDIT', '10.00').expect(403);
      expect(codeOf(closed)).toBe('FEATURE_DISABLED');
      // Une demande déposée avant la fermeture ne s'approuve pas davantage ; rien n'est examiné,
      // pas même le mot de passe.
      const approval = await approve(second, UNKNOWN_ID, {
        currentPassword: 'pas-le-bon-mot-de-passe',
        code: '000000',
      }).expect(403);
      expect(codeOf(approval)).toBe('FEATURE_DISABLED');
      expect(await auditBy(second.id, 'ledger_adjustment.approval_proof_failed')).toEqual([]);
      expect(await written()).toEqual(before);

      // Consulter reste possible : la liste est vide.
      const list = await get(root.accessToken, '/admin/ledger/adjustments').expect(200);
      expect(list.body).toEqual({ adjustments: [], nextCursor: null });
      // Geler ne dépend pas de cette ouverture : on gèle à tout moment.
      const freeze = await frozen(alice);
      await liftFreeze(second, freeze.id).expect(200);
    });

    it('ouvrir les ajustements : une décision d’administrateur, justifiée et tracée', async () => {
      const refused = await openAdjustments(compliance).expect(403);
      expect(codeOf(refused)).toBe('FORBIDDEN');
      await openAdjustments().expect(200);
      const status = await http.get('/api/v1/system/status').expect(200);
      expect(systemStatusSchema.parse(status.body).features.manualAdjustments).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('qui a accès', () => {
    it('chaque route exige une session, un compte du personnel et la validation en deux étapes', async () => {
      const alice = await customer();
      const pending = await requested(alice, 'CREDIT', '11.00');
      const freeze = await frozen(alice);
      const routes = routesFor(alice.id, pending.id, freeze.id);
      expect(routes).toHaveLength(9);
      const before = await written();

      for (const route of routes) {
        expect({ route, code: codeOf(await call(null, route).expect(401)) }).toEqual({
          route,
          code: 'UNAUTHENTICATED',
        });
      }
      // Un administrateur sans second facteur : la permission ne suffit pas.
      const unprotected = await admin({ secondFactor: false });
      for (const route of routes) {
        expect({
          route,
          code: codeOf(await call(unprotected.accessToken, route).expect(403)),
        }).toEqual({ route, code: 'MFA_ENROLLMENT_REQUIRED' });
      }
      // Un titulaire, un agent du support : aucune de ces permissions.
      for (const member of [await customer(), support]) {
        for (const route of routes) {
          expect({
            route,
            code: codeOf(await call(member.accessToken, route).expect(403)),
          }).toEqual({ route, code: 'FORBIDDEN' });
        }
      }
      // Chaque refus vient du contrôle d'accès de la route, qui l'inscrit au journal avec la
      // permission manquante : la base, qui vérifie les mêmes, n'a pas eu à refuser. L'agent du
      // support détient « users.read » : aucune de ces routes ne s'en contente.
      const required = [
        'adjustments.read',
        'adjustments.request',
        'adjustments.read',
        'adjustments.approve',
        'adjustments.approve',
        'adjustments.request',
        'wallet_freezes.read',
        'wallet_freezes.create',
        'wallet_freezes.lift',
      ];
      expect(
        (await auditBy(support.id, 'authorization.denied'))
          .slice(-routes.length)
          .map(({ resourceId, metadata }) => ({ resourceId, metadata })),
      ).toEqual(
        routes.map(([method, path], index) => ({
          resourceId: `${method.toUpperCase()} /api/v1${path}`,
          metadata: { missingPermissions: [required[index]] },
        })),
      );
      expect(await written()).toEqual(before);
      expect(
        (await prisma.ledgerAdjustment.findUniqueOrThrow({ where: { id: pending.id } })).status,
      ).toBe('PENDING');
      await liftFreeze(second, freeze.id).expect(200);
    });

    it('la conformité gèle et consulte les gels ; elle ne lève pas un gel, et ne touche à aucun ajustement', async () => {
      const alice = await customer();
      const pending = await requested(alice, 'CREDIT', '12.00');
      const freeze = await frozen(alice, root);
      const [list, create, view, approval, rejection, cancellation, freezes, , lifting] = routesFor(
        alice.id,
        pending.id,
        freeze.id,
      );

      for (const route of [list, create, view, approval, rejection, cancellation, lifting]) {
        expect({
          route,
          code: codeOf(await call(compliance.accessToken, route!).expect(403)),
        }).toEqual({ route, code: 'FORBIDDEN' });
      }
      await call(compliance.accessToken, freezes!).expect(200);
      const denied = await auditBy(compliance.id, 'authorization.denied');
      expect(
        denied.slice(-7).map(({ resourceId, metadata }) => ({ resourceId, metadata })),
      ).toEqual([
        {
          resourceId: 'GET /api/v1/admin/ledger/adjustments',
          metadata: { missingPermissions: ['adjustments.read'] },
        },
        {
          resourceId: 'POST /api/v1/admin/ledger/adjustments',
          metadata: { missingPermissions: ['adjustments.request'] },
        },
        {
          resourceId: `GET /api/v1/admin/ledger/adjustments/${pending.id}`,
          metadata: { missingPermissions: ['adjustments.read'] },
        },
        {
          resourceId: `POST /api/v1/admin/ledger/adjustments/${pending.id}/approve`,
          metadata: { missingPermissions: ['adjustments.approve'] },
        },
        {
          resourceId: `POST /api/v1/admin/ledger/adjustments/${pending.id}/reject`,
          metadata: { missingPermissions: ['adjustments.approve'] },
        },
        {
          resourceId: `POST /api/v1/admin/ledger/adjustments/${pending.id}/cancel`,
          metadata: { missingPermissions: ['adjustments.request'] },
        },
        {
          resourceId: `POST /api/v1/admin/ledger/wallet-freezes/${freeze.id}/lift`,
          metadata: { missingPermissions: ['wallet_freezes.lift'] },
        },
      ]);
      await liftFreeze(second, freeze.id).expect(200);
    });

    it('une permission par action : demander n’autorise pas à approuver, ni l’inverse', async () => {
      // Deux rôles sur mesure, créés comme le ferait une migration (rôle propriétaire).
      await withOwner(testApp, async (owner) => {
        for (const [key, permissions] of [
          ['adjustment_clerk', ['adjustments.read', 'adjustments.request']],
          ['adjustment_approver', ['adjustments.read', 'adjustments.approve']],
        ] as const) {
          const role = await owner.role.create({
            data: { key, name: key, description: 'Rôle de test : une partie des ajustements.' },
          });
          await owner.rolePermission.createMany({
            data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
          });
        }
      });
      const clerk = await staff('adjustment_clerk');
      const approver = await staff('adjustment_approver');
      const alice = await customer();

      // Qui approuve ne demande pas.
      expect(codeOf(await requestAdjustment(approver, alice, 'CREDIT', '13.00').expect(403))).toBe(
        'FORBIDDEN',
      );
      const { id } = await requested(alice, 'CREDIT', '13.00', clerk);
      // Qui demande n'approuve ni ne refuse — pas même la demande d'un autre.
      expect(codeOf(await approve(clerk, id).expect(403))).toBe('FORBIDDEN');
      expect(
        codeOf(
          await post(clerk.accessToken, `/admin/ledger/adjustments/${id}/reject`, {
            note: NOTE,
          }).expect(403),
        ),
      ).toBe('FORBIDDEN');
      // Qui approuve ne retire pas la demande d'un autre : la permission lui manque.
      expect(
        codeOf(
          await post(approver.accessToken, `/admin/ledger/adjustments/${id}/cancel`).expect(403),
        ),
      ).toBe('FORBIDDEN');

      // Chacun dans son rôle : la demande de l'un, approuvée par l'autre.
      const approved = ledgerAdjustmentSchema.parse((await approve(approver, id).expect(200)).body);
      expect(approved).toMatchObject({
        status: 'APPROVED',
        requestedBy: { id: clerk.id, email: clerk.email },
        decidedBy: { id: approver.id, email: approver.email },
      });
      expect((await walletsOf(alice))['USD']).toEqual({ available: '13.00', frozen: false });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ce qu’une requête doit contenir', () => {
    it.each([
      ['titulaire absent', { userId: undefined }, 'userId'],
      ['titulaire qui n’est pas un identifiant', { userId: 'alice' }, 'userId'],
      ['actif en minuscules', { assetCode: 'usd' }, 'assetCode'],
      ['sens inconnu', { direction: 'IN' }, 'direction'],
      ['sens absent', { direction: undefined }, 'direction'],
      ['un nombre JSON au lieu d’une chaîne', { amount: 10 }, 'amount'],
      ['un montant nul', { amount: '0.00' }, 'amount'],
      ['un montant négatif', { amount: '-10.00' }, 'amount'],
      ['un exposant', { amount: '1e3' }, 'amount'],
      ['raison absente', { reason: undefined }, 'reason'],
      ['raison trop brève', { reason: 'ok' }, 'reason'],
      ['raison de 501 caractères', { reason: 'x'.repeat(501) }, 'reason'],
      ['une contrepartie choisie', { counterpart: 'platform_fees' }, ''],
      ['un approbateur désigné', { approvedBy: UNKNOWN_ID }, ''],
    ])('demande refusée : %s', async (_label, overrides, path) => {
      const before = await written();
      const response = await requestAdjustment(
        root,
        UNKNOWN_ID,
        'CREDIT',
        '10.00',
        overrides,
      ).expect(400);
      expect(codeOf(response)).toBe('VALIDATION_FAILED');
      expect(pathsOf(response)).toEqual([path]);
      expect(await written()).toEqual(before);
    });

    it('un montant plus précis que l’actif, un actif non tenu, un compte inconnu : rien n’est arrondi ni deviné', async () => {
      const alice = await customer();
      const precise = await requestAdjustment(root, alice, 'CREDIT', '10.005').expect(400);
      expect(pathsOf(precise)).toEqual(['amount']);
      expect(problemOf(precise).errors?.[0]?.message).toBe(
        'Must have at most 2 decimal places: the precision of USD.',
      );
      const asset = await requestAdjustment(root, alice, 'CREDIT', '10.00', {
        assetCode: 'EUR',
      }).expect(400);
      expect(pathsOf(asset)).toEqual(['assetCode']);
      const unknown = await requestAdjustment(root, UNKNOWN_ID, 'CREDIT', '10.00').expect(422);
      expect(detailOf(unknown)).toBe('Unknown account.');
      // Huit décimales en bitcoins : la précision est celle de l'actif.
      const satoshi = await requestAdjustment(root, alice, 'CREDIT', '0.00000001', {
        assetCode: 'BTC',
      }).expect(201);
      expect(ledgerAdjustmentSchema.parse(satoshi.body).amount).toBe('0.00000001');
    });

    it('approuver, refuser, geler, lever : chaque corps est vérifié avant tout', async () => {
      const alice = await customer();
      const { id } = await requested(alice, 'CREDIT', '14.00');
      const freeze = await frozen(alice);
      const before = await written();
      const invalid: [string, string, Record<string, unknown> | undefined, string[]][] = [
        [
          'approuver sans mot de passe',
          `/admin/ledger/adjustments/${id}/approve`,
          { code: '123456' },
          ['currentPassword'],
        ],
        ['approuver sans corps', `/admin/ledger/adjustments/${id}/approve`, undefined, ['']],
        [
          'approuver avec deux preuves du second facteur',
          `/admin/ledger/adjustments/${id}/approve`,
          { currentPassword: second.password, code: '123456', recoveryCode: 'ABCDE-FGHIJ' },
          ['code'],
        ],
        [
          'approuver en désignant une écriture',
          `/admin/ledger/adjustments/${id}/approve`,
          { currentPassword: second.password, code: '123456', entryId: UNKNOWN_ID },
          [''],
        ],
        ['refuser sans motif', `/admin/ledger/adjustments/${id}/reject`, {}, ['note']],
        ['refuser d’un mot', `/admin/ledger/adjustments/${id}/reject`, { note: 'non' }, ['note']],
        [
          'refuser un identifiant mal formé',
          `/admin/ledger/adjustments/pas-un-identifiant/reject`,
          { note: NOTE },
          [''],
        ],
        // Avant même la preuve de l'approbateur : rien n'est examiné, aucun code n'est consommé.
        [
          'approuver un identifiant mal formé',
          `/admin/ledger/adjustments/pas-un-identifiant/approve`,
          { currentPassword: second.password, code: '123456' },
          [''],
        ],
        [
          'retirer un identifiant mal formé',
          `/admin/ledger/adjustments/pas-un-identifiant/cancel`,
          undefined,
          [''],
        ],
        [
          'geler sans raison',
          '/admin/ledger/wallet-freezes',
          { userId: alice.id, assetCode: 'BTC' },
          ['reason'],
        ],
        [
          'geler sans actif',
          '/admin/ledger/wallet-freezes',
          { userId: alice.id, reason: FREEZE_REASON },
          ['assetCode'],
        ],
        [
          'geler pour une durée',
          '/admin/ledger/wallet-freezes',
          {
            userId: alice.id,
            assetCode: 'BTC',
            reason: FREEZE_REASON,
            until: '2026-12-01T00:00:00.000Z',
          },
          [''],
        ],
        ['lever sans raison', `/admin/ledger/wallet-freezes/${freeze.id}/lift`, {}, ['reason']],
        [
          'lever un identifiant mal formé',
          `/admin/ledger/wallet-freezes/x/lift`,
          { reason: LIFT_REASON },
          [''],
        ],
      ];
      for (const [label, path, body, paths] of invalid) {
        const response = await post(second.accessToken, path, body).expect(400);
        expect({ label, code: codeOf(response), paths: pathsOf(response) }).toEqual({
          label,
          code: 'VALIDATION_FAILED',
          paths,
        });
      }
      for (const query of [
        '/admin/ledger/adjustments/pas-un-identifiant',
        '/admin/ledger/adjustments?status=pending',
        '/admin/ledger/adjustments?userId=alice',
        '/admin/ledger/adjustments?limit=0',
        '/admin/ledger/adjustments?limit=101',
        '/admin/ledger/adjustments?direction=CREDIT',
        '/admin/ledger/adjustments?after=pas%20un%20curseur',
        '/admin/ledger/wallet-freezes?status=FROZEN',
        '/admin/ledger/wallet-freezes?active=true',
        '/admin/ledger/wallet-freezes?limit=101',
      ]) {
        const response = await get(second.accessToken, query).expect(400);
        expect({ query, code: codeOf(response) }).toEqual({ query, code: 'VALIDATION_FAILED' });
      }
      expect(await written()).toEqual(before);
      await liftFreeze(second, freeze.id).expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('créditer un portefeuille : une demande, puis l’approbation d’une seconde personne', () => {
    it('la demande ne déplace rien ; son auteur ne l’approuve pas ; un second, avec sa preuve, si', async () => {
      const alice = await customer();
      const before = await written();

      const pending = await requested(alice, 'CREDIT', '250.5');
      expect(pending).toEqual({
        id: expect.stringMatching(UUID),
        user: { id: alice.id, email: alice.email },
        asset: USD_VIEW,
        direction: 'CREDIT',
        amount: '250.50',
        reason: REASON,
        status: 'PENDING',
        requestedBy: { id: root.id, email: root.email },
        requestedAt: expect.stringMatching(ISO),
        expiresAt: expect.stringMatching(ISO),
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        entryId: null,
      });
      expect(Date.parse(pending.expiresAt) - Date.parse(pending.requestedAt)).toBe(
        72 * 60 * 60 * 1000,
      );
      expect(await written()).toEqual({ ...before, adjustments: before.adjustments + 1 });
      expect((await walletsOf(alice))['USD']).toEqual({ available: '0.00', frozen: false });

      // Son auteur ne l'approuve pas, même avec sa preuve.
      const own = await approve(root, pending.id).expect(403);
      expect(codeOf(own)).toBe('FORBIDDEN');
      expect(detailOf(own)).toMatch(/second member of staff/);

      // Un second, sans le bon mot de passe ou sans le bon code : rien n'est examiné.
      const wrongPassword = await approve(second, pending.id, {
        currentPassword: 'pas-le-bon-mot-de-passe',
        code: nextTotpCode(second.totpSecret!),
      }).expect(401);
      expect(codeOf(wrongPassword)).toBe('INVALID_CREDENTIALS');
      const noCode = await approve(second, pending.id, {
        currentPassword: second.password,
      }).expect(422);
      expect(codeOf(noCode)).toBe('UNPROCESSABLE_ENTITY');
      const wrongCode = await approve(second, pending.id, {
        currentPassword: second.password,
        code: wrongTotpCode(second.totpSecret!),
      }).expect(400);
      expect(codeOf(wrongCode)).toBe('INVALID_OR_EXPIRED_CODE');
      expect((await walletsOf(alice))['USD']).toEqual({ available: '0.00', frozen: false });

      const response = await approve(second, pending.id, {
        ...proofOf(second),
        note: '  Reçu vérifié  ',
      }).expect(200);
      const approved = ledgerAdjustmentSchema.parse(response.body);
      expect(response.body).toEqual(approved);
      expect(approved).toEqual({
        ...pending,
        status: 'APPROVED',
        decidedBy: { id: second.id, email: second.email },
        decidedAt: expect.stringMatching(ISO),
        // La note est débarrassée de ses espaces de bord.
        decisionNote: 'Reçu vérifié',
        entryId: expect.stringMatching(UUID),
      });
      expect(await written()).toEqual({
        ledger: { entries: before.ledger.entries + 1, postings: before.ledger.postings + 2 },
        adjustments: before.adjustments + 1,
        freezes: before.freezes,
      });

      // Le titulaire : son solde, le mouvement sous son type, son historique, un message.
      expect((await walletsOf(alice))['USD']).toEqual({ available: '250.50', frozen: false });
      const { movements } = await movementsOf(alice);
      expect(movements).toEqual([
        {
          id: expect.stringMatching(UUID),
          entryId: approved.entryId,
          kind: 'adjustment.credit',
          side: 'CREDIT',
          amount: '250.50',
          balanceAfter: '250.50',
          postedAt: expect.stringMatching(ISO),
        },
      ]);
      expect(await activityOf(alice)).toContain('WALLET_CREDITED');
      const message = await nextMessageOf(testApp, alice.email, 'wallet_adjusted');
      expect(message.text).toContain('Montant : 250.50 USD');
      // Ni la raison, ni la note ne lui sont montrées.
      expect(JSON.stringify([movements, message.text, message.subject])).not.toMatch(
        /guichet|Reçu vérifié/,
      );

      // Le back-office retrouve l'écriture, avec son auteur et ses références.
      const entry = adminLedgerEntrySchema.parse(
        (await get(root.accessToken, `/admin/ledger/entries/${approved.entryId!}`).expect(200))
          .body,
      );
      expect(entry).toMatchObject({
        kind: 'adjustment.credit',
        idempotencyKey: `adjustment:${pending.id}`,
        actor: { type: 'USER', id: second.id },
        metadata: { adjustmentId: pending.id, requestedBy: root.id },
      });
      expect(
        entry.postings.map(({ account, amount, side }) => ({ type: account.type, side, amount })),
      ).toEqual([
        { type: 'platform_custody', side: 'DEBIT', amount: '250.50' },
        { type: 'user_available', side: 'CREDIT', amount: '250.50' },
      ]);
      // La balance du grand livre reste équilibrée.
      const balance = await get(root.accessToken, '/admin/ledger/trial-balance').expect(200);
      expect(balance.body.balanced).toBe(true);
    });

    it('une demande approuvée ne s’approuve pas deux fois ; une demande inconnue n’existe pas', async () => {
      const alice = await customer();
      const approved = await adjusted(alice, 'CREDIT', '20.00');
      const again = await approve(second, approved.id).expect(409);
      expect(detailOf(again)).toBe('This adjustment is no longer pending (approved).');
      expect(codeOf(await approve(second, UNKNOWN_ID).expect(404))).toBe('NOT_FOUND');
      expect((await walletsOf(alice))['USD']).toEqual({ available: '20.00', frozen: false });
      // Une demande identique à une demande en attente est refusée ; une fois décidée, elle passe.
      const pending = await requested(alice, 'CREDIT', '20.00');
      const twin = await requestAdjustment(second, alice, 'CREDIT', '20.0').expect(409);
      expect(detailOf(twin)).toMatch(/identical adjustment/);
      const cancelled = await post(
        root.accessToken,
        `/admin/ledger/adjustments/${pending.id}/cancel`,
      ).expect(200);
      expect(ledgerAdjustmentSchema.parse(cancelled.body)).toMatchObject({
        status: 'CANCELLED',
        decidedBy: { id: root.id, email: root.email },
        entryId: null,
      });
      await requestAdjustment(second, alice, 'CREDIT', '20.00').expect(201);
    });

    it('refuser et retirer : le refus vient d’un second, avec son motif ; le retrait, de l’auteur', async () => {
      const alice = await customer();
      const first = await requested(alice, 'CREDIT', '30.00');
      const before = await written();

      const byAuthor = await post(
        root.accessToken,
        `/admin/ledger/adjustments/${first.id}/reject`,
        {
          note: NOTE,
        },
      ).expect(403);
      expect(detailOf(byAuthor)).toMatch(/second member of staff/);
      const rejection = await post(
        second.accessToken,
        `/admin/ledger/adjustments/${first.id}/reject`,
        { note: `  ${NOTE} ` },
      ).expect(200);
      expect(ledgerAdjustmentSchema.parse(rejection.body)).toMatchObject({
        status: 'REJECTED',
        decidedBy: { id: second.id, email: second.email },
        decisionNote: NOTE,
        entryId: null,
      });
      expect(
        codeOf(
          await post(second.accessToken, `/admin/ledger/adjustments/${first.id}/reject`, {
            note: NOTE,
          }).expect(409),
        ),
      ).toBe('CONFLICT');

      const other = await requested(alice, 'CREDIT', '31.00');
      const notAuthor = await post(
        second.accessToken,
        `/admin/ledger/adjustments/${other.id}/cancel`,
      ).expect(403);
      expect(detailOf(notAuthor)).toBe('Only the author of a request can cancel it.');
      await post(root.accessToken, `/admin/ledger/adjustments/${other.id}/cancel`).expect(200);
      for (const path of ['reject', 'cancel']) {
        expect(
          codeOf(
            await post(second.accessToken, `/admin/ledger/adjustments/${UNKNOWN_ID}/${path}`, {
              note: NOTE,
            }).expect(404),
          ),
        ).toBe('NOT_FOUND');
      }
      // Rien n'a bougé ; le titulaire n'a rien su.
      expect(await written()).toEqual({ ...before, adjustments: before.adjustments + 1 });
      expect((await walletsOf(alice))['USD']).toEqual({ available: '0.00', frozen: false });
      expect(await activityOf(alice)).not.toContain('WALLET_CREDITED');
    });

    it('nul ne prend part à l’ajustement de son propre portefeuille', async () => {
      const own = await requestAdjustment(root, root, 'CREDIT', '10.00').expect(403);
      expect(detailOf(own)).toBe('You cannot request an adjustment of your own wallet.');
      // Demandé par un autre, le titulaire ne l'approuve ni ne le refuse.
      const { id } = await requested(second, 'CREDIT', '15.00');
      expect(detailOf(await approve(second, id).expect(403))).toBe(
        'You cannot decide on an adjustment of your own wallet.',
      );
      expect(
        detailOf(
          await post(second.accessToken, `/admin/ledger/adjustments/${id}/reject`, {
            note: NOTE,
          }).expect(403),
        ),
      ).toBe('You cannot decide on an adjustment of your own wallet.');
      await post(root.accessToken, `/admin/ledger/adjustments/${id}/cancel`).expect(200);
    });

    it('les ajustements se consultent par statut et par titulaire, page par page', async () => {
      const alice = await customer();
      const made = [
        await requested(alice, 'CREDIT', '1.00'),
        await adjusted(alice, 'CREDIT', '2.00'),
        await requested(alice, 'CREDIT', '3.00'),
      ];
      const listOf = async (query: string) => {
        const response = await get(root.accessToken, `/admin/ledger/adjustments${query}`).expect(
          200,
        );
        const list = ledgerAdjustmentListSchema.parse(response.body);
        expect(response.body).toEqual(list);
        return list;
      };

      const all = await listOf(`?userId=${alice.id}`);
      expect(all.adjustments.map(({ id }) => id)).toEqual([made[2]!.id, made[1]!.id, made[0]!.id]);
      expect(all.nextCursor).toBeNull();
      expect((await listOf(`?userId=${alice.id}&status=APPROVED`)).adjustments).toEqual([made[1]]);
      expect(
        (await listOf(`?userId=${alice.id}&status=PENDING`)).adjustments.map(({ id }) => id),
      ).toEqual([made[2]!.id, made[0]!.id]);

      const pages: string[][] = [];
      let after: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof listOf>> = await listOf(
          `?userId=${alice.id}&limit=2${after === null ? '' : `&after=${after}`}`,
        );
        pages.push(page.adjustments.map(({ id }) => id));
        after = page.nextCursor;
        // Borné : un curseur ignoré rendrait sans fin la même page.
      } while (after !== null && pages.length < 5);
      expect(pages).toEqual([[made[2]!.id, made[1]!.id], [made[0]!.id]]);

      const one = await get(root.accessToken, `/admin/ledger/adjustments/${made[1]!.id}`).expect(
        200,
      );
      expect(one.body).toEqual(made[1]);
      expect(
        codeOf(await get(root.accessToken, `/admin/ledger/adjustments/${UNKNOWN_ID}`).expect(404)),
      ).toBe('NOT_FOUND');
      // Chaque consultation est inscrite au journal d'audit.
      expect((await auditBy(root.id, 'ledger_adjustment.viewed_by_admin')).at(-1)?.resourceId).toBe(
        made[1]!.id,
      );
      expect((await auditBy(root.id, 'ledger_adjustment.listed_by_admin')).length).toBeGreaterThan(
        4,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('avec de vrais soldes : transférer, geler, débiter, clôturer', () => {
    it('un portefeuille crédité transfère ; gelé, rien n’en part ni n’y arrive ; le gel levé, tout repart', async () => {
      const alice = await holder('200.00');
      const bob = await holder();

      // Les fonds entrés par un ajustement se transfèrent comme les autres.
      const sent = transferSchema.parse((await send(alice, bob, '25.00').expect(201)).body);
      expect(sent).toMatchObject({ direction: 'SENT', amount: '25.00' });
      expect((await walletsOf(alice))['USD']).toEqual({ available: '175.00', frozen: false });
      expect((await walletsOf(bob))['USD']).toEqual({ available: '25.00', frozen: false });

      const freeze = await frozen(alice);
      expect(freeze).toEqual({
        id: expect.stringMatching(UUID),
        userId: alice.id,
        asset: USD_VIEW,
        status: 'ACTIVE',
        reason: FREEZE_REASON,
        frozenBy: compliance.id,
        frozenAt: expect.stringMatching(ISO),
        liftedBy: null,
        liftedAt: null,
        liftReason: null,
      });
      // Le titulaire voit son portefeuille gelé — et celui-là seulement —, jamais pourquoi.
      const wallets = await get(alice.accessToken, '/me/wallets').expect(200);
      expect(wallets.body).toEqual({
        wallets: [
          {
            asset: { code: 'BTC', name: 'Asset BTC', kind: 'CRYPTO', scale: 8 },
            available: '0.00000000',
            frozen: false,
          },
          { asset: USD_VIEW, available: '175.00', frozen: true },
        ],
      });
      expect(JSON.stringify(wallets.body)).not.toMatch(/conformité|reason/);
      expect((await movementsOf(alice)).wallet).toEqual({
        asset: USD_VIEW,
        available: '175.00',
        frozen: true,
      });

      const out = await send(alice, bob, '10.00').expect(403);
      expect(codeOf(out)).toBe('WALLET_FROZEN');
      expect(detailOf(out)).toBe('Your wallet in this asset is frozen. Please contact support.');
      // Pour qui lui envoie, c'est le refus unique du destinataire.
      const into = await send(bob, alice, '5.00').expect(422);
      expect(codeOf(into)).toBe('RECIPIENT_UNAVAILABLE');
      expect((await walletsOf(alice))['USD']).toEqual({ available: '175.00', frozen: true });
      expect((await walletsOf(bob))['USD']).toEqual({ available: '25.00', frozen: false });
      expect(await activityOf(alice)).toEqual(
        expect.arrayContaining(['WALLET_FROZEN', 'TRANSFER_REFUSED']),
      );
      // Aucun message ne lui annonce le gel.
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(alice.email)
          .map(({ template }) => template)
          .filter((template) => !['transfer_sent', 'wallet_adjusted'].includes(template)),
      ).toEqual(['email_verification_code']);

      // Geler deux fois ; lever sans en avoir le droit.
      expect(detailOf(await freezeWallet(root, alice).expect(409))).toBe(
        'This wallet is already frozen.',
      );
      expect(codeOf(await liftFreeze(compliance, freeze.id).expect(403))).toBe('FORBIDDEN');

      const lifted = walletFreezeSchema.parse(
        (await liftFreeze(second, freeze.id).expect(200)).body,
      );
      expect(lifted).toEqual({
        ...freeze,
        status: 'LIFTED',
        liftedBy: second.id,
        liftedAt: expect.stringMatching(ISO),
        liftReason: LIFT_REASON,
      });
      expect(detailOf(await liftFreeze(second, freeze.id).expect(409))).toBe(
        'This freeze was already lifted.',
      );
      expect(codeOf(await liftFreeze(second, UNKNOWN_ID).expect(404))).toBe('NOT_FOUND');
      await send(alice, bob, '10.00').expect(201);
      await send(bob, alice, '5.00').expect(201);
      expect((await walletsOf(alice))['USD']).toEqual({ available: '170.00', frozen: false });
      expect(await activityOf(alice)).toContain('WALLET_UNFROZEN');
    });

    it('un portefeuille gelé s’ajuste encore ; des fonds ou un gel retiennent la clôture ; vidé et dégelé, le compte se clôt', async () => {
      const alice = await holder('80.00');
      const freeze = await frozen(alice);
      const close = () =>
        post(alice.accessToken, '/me/close', { currentPassword: alice.password, confirm: true });

      const blocked = await close().expect(409);
      expect(detailOf(blocked)).toBe(
        'The account cannot be closed: it still holds funds, which must be withdrawn or ' +
          'transferred first; one of its wallets is frozen, and the freeze must be lifted first.',
      );

      // Un débit au-delà du solde est refusé dès la demande ; à hauteur du solde, il passe —
      // sur un portefeuille gelé comme sur un autre.
      expect(codeOf(await requestAdjustment(root, alice, 'DEBIT', '80.01').expect(422))).toBe(
        'INSUFFICIENT_FUNDS',
      );
      const debited = await adjusted(alice, 'DEBIT', '80.00');
      expect(debited).toMatchObject({ direction: 'DEBIT', status: 'APPROVED', amount: '80.00' });
      expect((await walletsOf(alice))['USD']).toEqual({ available: '0.00', frozen: true });
      expect(
        (await movementsOf(alice)).movements.map(({ kind, side }) => ({ kind, side })),
      ).toEqual([
        { kind: 'adjustment.debit', side: 'DEBIT' },
        { kind: 'adjustment.credit', side: 'CREDIT' },
      ]);
      expect(await activityOf(alice)).toEqual(
        expect.arrayContaining(['WALLET_DEBITED', 'WALLET_CREDITED', 'WALLET_FROZEN']),
      );

      // Vidé, mais encore gelé : le gel retient la clôture, par le personnel aussi.
      expect(detailOf(await close().expect(409))).toBe(
        'The account cannot be closed: one of its wallets is frozen, and the freeze must be ' +
          'lifted first.',
      );
      const byStaff = await post(compliance.accessToken, `/admin/users/${alice.id}/close`, {
        ground: 'PLATFORM_DECISION',
        reason: 'Fin de la relation, décision du comité',
        confirm: true,
      }).expect(409);
      expect(detailOf(byStaff)).toMatch(/one of its wallets is frozen/);

      await liftFreeze(second, freeze.id).expect(200);
      await close().expect(200);
      // L'ajustement demeure ; le titulaire n'y a plus d'adresse.
      const kept = await get(root.accessToken, `/admin/ledger/adjustments/${debited.id}`).expect(
        200,
      );
      expect(ledgerAdjustmentSchema.parse(kept.body)).toMatchObject({
        status: 'APPROVED',
        user: { id: alice.id, email: null },
      });
      // Et plus rien ne se demande ni ne se gèle sur le compte clôturé.
      expect(detailOf(await requestAdjustment(root, alice, 'CREDIT', '1.00').expect(409))).toBe(
        'This account is closed: it has no wallet.',
      );
      expect(detailOf(await freezeWallet(compliance, alice).expect(409))).toBe(
        'This account is closed: it has no wallet.',
      );
    });

    it('un débit que le portefeuille ne couvre plus à l’approbation : refusé, et la demande reste en attente', async () => {
      const alice = await holder('50.00');
      const bob = await holder();
      const pending = await requested(alice, 'DEBIT', '50.00');
      await send(alice, bob, '0.01').expect(201);

      const refused = await approve(second, pending.id).expect(422);
      expect(codeOf(refused)).toBe('INSUFFICIENT_FUNDS');
      expect((await walletsOf(alice))['USD']).toEqual({ available: '49.99', frozen: false });
      const still = await get(root.accessToken, `/admin/ledger/adjustments/${pending.id}`).expect(
        200,
      );
      expect(ledgerAdjustmentSchema.parse(still.body).status).toBe('PENDING');
    });

    it('nul ne gèle son propre portefeuille, ni n’en lève le gel ; un compte inconnu ne se gèle pas', async () => {
      expect(detailOf(await freezeWallet(compliance, compliance).expect(403))).toBe(
        'You cannot freeze your own wallet.',
      );
      const freeze = await frozen(second, root);
      expect(detailOf(await liftFreeze(second, freeze.id).expect(403))).toBe(
        'You cannot lift the freeze of your own wallet.',
      );
      await liftFreeze(root, freeze.id).expect(200);
      expect(detailOf(await freezeWallet(compliance, UNKNOWN_ID).expect(422))).toBe(
        'Unknown account.',
      );
      expect(pathsOf(await freezeWallet(compliance, second, 'EUR').expect(400))).toEqual([
        'assetCode',
      ]);
    });

    it('les gels se consultent par titulaire et par état', async () => {
      const alice = await customer();
      const first = await frozen(alice);
      await liftFreeze(second, first.id).expect(200);
      const current = await frozen(alice, root);
      const listOf = async (query: string) => {
        const response = await get(
          compliance.accessToken,
          `/admin/ledger/wallet-freezes${query}`,
        ).expect(200);
        const list = walletFreezeListSchema.parse(response.body);
        expect(response.body).toEqual(list);
        return list;
      };
      expect(
        (await listOf(`?userId=${alice.id}`)).freezes.map(({ id, status }) => ({ id, status })),
      ).toEqual([
        { id: current.id, status: 'ACTIVE' },
        { id: first.id, status: 'LIFTED' },
      ]);
      expect((await listOf(`?userId=${alice.id}&status=ACTIVE`)).freezes).toEqual([current]);
      const paged = await listOf(`?userId=${alice.id}&limit=1`);
      expect(paged.freezes.map(({ id }) => id)).toEqual([current.id]);
      expect(paged.nextCursor).toEqual(expect.any(String));
      expect(
        (await listOf(`?userId=${alice.id}&limit=1&after=${paged.nextCursor ?? ''}`)).freezes.map(
          ({ id }) => id,
        ),
      ).toEqual([first.id]);
      expect(
        (await auditBy(compliance.id, 'wallet_freeze.listed_by_admin')).length,
      ).toBeGreaterThanOrEqual(4);
      await liftFreeze(second, current.id).expect(200);
    });

    it('la copie des données dit quel portefeuille est gelé, et l’historique ce que la plateforme y a fait', async () => {
      // Sans dossier de vérification : la copie ne dépend alors pas du stockage des pièces. Un
      // ajustement n'exige aucun niveau du titulaire.
      const alice = await customer({ verified: false });
      await adjusted(alice, 'CREDIT', '12.00');
      await frozen(alice);
      const response = await post(alice.accessToken, '/me/data-export', {
        currentPassword: alice.password,
      }).expect(200);
      const copy = dataExportSchema.parse(response.body);
      expect(response.body).toEqual(copy);
      expect(copy.formatVersion).toBe(5);
      expect(copy.wallets).toEqual([
        {
          asset: USD_VIEW,
          available: '12.00',
          frozen: true,
          movements: [
            expect.objectContaining({ kind: 'adjustment.credit', side: 'CREDIT', amount: '12.00' }),
          ],
          truncated: false,
        },
      ]);
      expect(copy.activity.entries.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['WALLET_FROZEN', 'WALLET_CREDITED']),
      );
      // Ni la raison de l'ajustement, ni celle du gel n'y figurent.
      expect(JSON.stringify(response.body)).not.toMatch(/guichet|conformité, dossier/);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('pendant la maintenance', () => {
    it('les titulaires attendent ; le personnel ajuste, gèle et lève encore', async () => {
      const alice = await holder('40.00');
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: maintenance window' };
      await settings.set('maintenance.mode', { enabled: true, message: null }, context);
      try {
        expect(codeOf(await get(alice.accessToken, '/me/wallets').expect(503))).toBe('MAINTENANCE');
        const credited = await adjusted(alice, 'CREDIT', '1.00');
        expect(credited.status).toBe('APPROVED');
        const freeze = await frozen(alice);
        await get(compliance.accessToken, '/admin/ledger/wallet-freezes').expect(200);
        await liftFreeze(second, freeze.id).expect(200);
        await get(root.accessToken, '/admin/ledger/adjustments').expect(200);
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
      }
      expect((await walletsOf(alice))['USD']).toEqual({ available: '41.00', frozen: false });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refermer les ajustements', () => {
    it('ce qui est en attente ne s’approuve plus, mais se refuse et se retire encore', async () => {
      const alice = await customer();
      const first = await requested(alice, 'CREDIT', '60.00');
      const other = await requested(alice, 'CREDIT', '61.00');
      await http
        .put('/api/v1/admin/system-settings/features.manual_adjustments')
        .set(bearer(root.accessToken))
        .set(from(newClientIp()))
        .send({ value: false, reason: 'Fermeture des ajustements manuels, le temps d’un contrôle' })
        .expect(200);
      try {
        expect(codeOf(await approve(second, first.id).expect(403))).toBe('FEATURE_DISABLED');
        expect(codeOf(await requestAdjustment(root, alice, 'CREDIT', '62.00').expect(403))).toBe(
          'FEATURE_DISABLED',
        );
        await post(second.accessToken, `/admin/ledger/adjustments/${first.id}/reject`, {
          note: NOTE,
        }).expect(200);
        await post(root.accessToken, `/admin/ledger/adjustments/${other.id}/cancel`).expect(200);
        await get(root.accessToken, `/admin/ledger/adjustments/${first.id}`).expect(200);
      } finally {
        await openAdjustments().expect(200);
      }
      expect((await walletsOf(alice))['USD']).toEqual({ available: '0.00', frozen: false });
    });
  });
});
