import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  accountClosureSchema,
  adminAccountClosureSchema,
  adminAssetListSchema,
  adminAssetSchema,
  adminLedgerAccountListSchema,
  adminLedgerEntrySchema,
  adminLedgerPostingListSchema,
  adminUserDetailSchema,
  dataExportSchema,
  problemDetailsSchema,
  trialBalanceSchema,
  walletListSchema,
  walletMovementListSchema,
} from '@mgx/contracts';
import { type Asset, defineAsset, Money } from '@mgx/shared';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { LedgerService } from '../../src/modules/ledger/application/ledger.service.js';
import type {
  JournalEntryDraft,
  PostedEntry,
} from '../../src/modules/ledger/domain/journal-entry.js';
import { platformAccount, userAccount } from '../../src/modules/ledger/domain/ledger-account.js';
import { HolderClosedError } from '../../src/modules/ledger/domain/ledger-errors.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import {
  bearer,
  createAdmin,
  enableSecondFactor,
  from,
  type Http,
  login,
  newClientIp,
  newEmail,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
  withOwner,
} from '../support/identity.js';
import { ledgerSize, registerAssetInSql } from '../support/ledger-sql.js';
import { RequestCrossing, RequestCrossingModule } from '../support/request-crossing.module.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';
import { withConnection } from '../support/test-database.js';

const REASON = 'Ouverture du service dans cet actif, décision du 13 novembre';
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const USD = defineAsset('USD', 2);
const BTC = defineAsset('BTC', 8);
const ETH = defineAsset('ETH', 18);
const XAF = defineAsset('XAF', 0);

/** Les six routes de consultation ou d'enregistrement du back-office. */
const BACK_OFFICE_ROUTES = [
  ['get', '/admin/ledger/assets'],
  ['post', '/admin/ledger/assets'],
  ['get', '/admin/ledger/accounts'],
  ['get', `/admin/ledger/accounts/${UNKNOWN_ID}/postings`],
  ['get', `/admin/ledger/entries/${UNKNOWN_ID}`],
  ['get', '/admin/ledger/trial-balance'],
] as const;

/** Curseur tel que l'API l'encode : pour en forger. */
const cursorOf = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

interface Member extends RegisteredUser {
  readonly id: string;
  readonly accessToken: string;
}

/**
 * Aucune route ne déplace de fonds : les écritures de ces scénarios sont passées par le service
 * du grand livre, comme le feront les opérations des lots suivants. Tout le reste passe par
 * HTTP. Les scénarios s'enchaînent — un actif enregistré, une écriture passée le sont pour
 * toujours — et chaque bloc part de l'état laissé par le précédent.
 */
describe('Grand livre et portefeuilles — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let crossing: RequestCrossing;
  /** Administrateur (rôle super_admin, second facteur activé), créé par l'outil d'amorçage. */
  let root: Member;
  /** Nombre d'écritures passées par ces scénarios. */
  let posted = 0;

  beforeAll(async () => {
    testApp = await createTestApp({
      imports: [RequestCrossingModule],
      env: { TRUST_PROXY_HOPS: '1' },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    ledger = testApp.app.get(LedgerService);
    crossing = testApp.app.get(RequestCrossing);
    await openFeature(testApp, 'registration');
    root = await admin();
  });

  afterAll(async () => {
    await testApp.close();
  });

  const get = (accessToken: string, path: string, ip = newClientIp()) =>
    http.get(`/api/v1${path}`).set(bearer(accessToken)).set(from(ip));
  const post = (
    accessToken: string,
    path: string,
    body?: Record<string, unknown>,
    ip = newClientIp(),
  ) => http.post(`/api/v1${path}`).set(bearer(accessToken)).set(from(ip)).send(body);
  const codeOf = (response: { body: unknown }) => problemDetailsSchema.parse(response.body).code;
  const detailOf = (response: { body: unknown }) =>
    problemDetailsSchema.parse(response.body).detail;
  const pathsOf = (response: { body: unknown }) =>
    problemDetailsSchema.parse(response.body).errors?.map((error) => error.path);

  async function admin(options: { secondFactor?: boolean } = {}): Promise<Member> {
    const created = await createAdmin(testApp, options);
    const session = await login(http, created);
    return { ...created, accessToken: session.tokens.accessToken };
  }

  /** Utilisateur final connecté. */
  async function customer(): Promise<Member> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
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

  const asOwner = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);
  const asApp = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(testApp.database.appUrl, work);

  const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    code: 'USD',
    name: 'US dollar',
    kind: 'FIAT',
    scale: 2,
    reason: REASON,
    ...overrides,
  });
  const register = (author: Member, body: Record<string, unknown>, ip = newClientIp()) =>
    post(author.accessToken, '/admin/ledger/assets', body, ip);

  const auditBy = (actorId: string, action: string) =>
    prisma.auditLog.findMany({ where: { actorId, action }, orderBy: { id: 'asc' } });
  const registeredCodes = async (): Promise<string[]> =>
    (await prisma.asset.findMany({ select: { code: true }, orderBy: { code: 'asc' } })).map(
      ({ code }) => code,
    );

  // --- Écritures, passées par le service ---

  const custody = platformAccount('platform_custody');
  const fees = platformAccount('platform_fees');

  async function postEntry(draft: Omit<JournalEntryDraft, 'idempotencyKey'>): Promise<PostedEntry> {
    const entry = await ledger.post({ ...draft, idempotencyKey: `e2e:${randomUUID()}` });
    posted += 1;
    return entry;
  }

  /** Des fonds arrivent de l'extérieur : la conservation augmente, le portefeuille aussi. */
  const deposit = (member: Member, amount: string, asset: Asset = USD): Promise<PostedEntry> =>
    postEntry({
      kind: 'test.deposit',
      actor: { type: 'SYSTEM' },
      postings: [
        { account: custody, side: 'DEBIT', amount: Money.parse(amount, asset) },
        { account: userAccount(member.id), side: 'CREDIT', amount: Money.parse(amount, asset) },
      ],
    });

  /** Des fonds repartent vers l'extérieur. */
  const withdrawal = (member: Member, amount: string, asset: Asset = USD): Promise<PostedEntry> =>
    postEntry({
      kind: 'test.withdrawal',
      actor: { type: 'SYSTEM' },
      postings: [
        { account: userAccount(member.id), side: 'DEBIT', amount: Money.parse(amount, asset) },
        { account: custody, side: 'CREDIT', amount: Money.parse(amount, asset) },
      ],
    });

  /** D'un titulaire à l'autre : l'expéditeur paie `fee` en plus du montant reçu. */
  function transfer(
    sender: Member,
    receiver: Member,
    amount: string,
    fee: string | null = null,
    extra: Pick<JournalEntryDraft, 'requestId' | 'metadata'> = {},
  ): Promise<PostedEntry> {
    const received = Money.parse(amount, USD);
    const charged = fee === null ? null : Money.parse(fee, USD);
    return postEntry({
      kind: 'test.transfer',
      actor: { type: 'USER', id: sender.id },
      ...extra,
      postings: [
        {
          account: userAccount(sender.id),
          side: 'DEBIT',
          amount: charged === null ? received : received.plus(charged),
        },
        { account: userAccount(receiver.id), side: 'CREDIT', amount: received },
        ...(charged === null ? [] : [{ account: fees, side: 'CREDIT' as const, amount: charged }]),
      ],
    });
  }

  // --- Lectures du titulaire ---

  const walletsOf = async (member: Member): Promise<Record<string, string>> => {
    const response = await get(member.accessToken, '/me/wallets').expect(200);
    const { wallets } = walletListSchema.parse(response.body);
    // Le schéma publié décrit toute la réponse : aucune clé n'en sort.
    expect(response.body).toEqual({ wallets });
    return Object.fromEntries(wallets.map(({ asset, available }) => [asset.code, available]));
  };
  const movementsOf = async (member: Member, assetCode: string, query = '') => {
    const response = await get(
      member.accessToken,
      `/me/wallets/${assetCode}/movements${query}`,
    ).expect(200);
    const page = walletMovementListSchema.parse(response.body);
    expect(response.body).toEqual(page);
    return page;
  };

  // --- Lectures du back-office ---

  const accountsFor = async (reader: Member, query = '') => {
    const response = await get(reader.accessToken, `/admin/ledger/accounts${query}`).expect(200);
    const page = adminLedgerAccountListSchema.parse(response.body);
    expect(response.body).toEqual(page);
    return page;
  };
  const postingsFor = async (reader: Member, accountId: string, query = '') => {
    const response = await get(
      reader.accessToken,
      `/admin/ledger/accounts/${accountId}/postings${query}`,
    ).expect(200);
    const page = adminLedgerPostingListSchema.parse(response.body);
    expect(response.body).toEqual(page);
    return page;
  };
  const trialBalanceFor = async (reader: Member) => {
    const response = await get(reader.accessToken, '/admin/ledger/trial-balance').expect(200);
    const balance = trialBalanceSchema.parse(response.body);
    expect(response.body).toEqual(balance);
    return balance;
  };

  // ---------------------------------------------------------------------------------------------
  describe('tant qu’aucun actif n’est enregistré', () => {
    it('le titulaire n’a aucun portefeuille, et le back-office lit un grand livre vide', async () => {
      const member = await customer();
      expect(await walletsOf(member)).toEqual({});
      const missing = await get(member.accessToken, '/me/wallets/USD/movements').expect(404);
      expect(codeOf(missing)).toBe('NOT_FOUND');
      expect(detailOf(missing)).toBe('Wallet not found.');

      const assets = await get(root.accessToken, '/admin/ledger/assets').expect(200);
      expect(assets.body).toEqual({ assets: [] });
      expect(await accountsFor(root)).toEqual({ accounts: [], nextCursor: null });
      const balance = await trialBalanceFor(root);
      expect(balance).toEqual({ generatedAt: expect.any(String), balanced: true, assets: [] });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('qui a accès', () => {
    it('les portefeuilles exigent une session', async () => {
      for (const path of ['/me/wallets', '/me/wallets/USD/movements']) {
        const anonymous = await http.get(`/api/v1${path}`).set(from(newClientIp())).expect(401);
        expect(codeOf(anonymous)).toBe('UNAUTHENTICATED');
      }
    });

    it('le back-office exige un compte du personnel, la validation en deux étapes et la permission', async () => {
      const send = (accessToken: string | null, [method, path]: readonly [string, string]) => {
        const sent =
          method === 'post'
            ? http.post(`/api/v1${path}`).send(registration())
            : http.get(`/api/v1${path}`);
        return (accessToken === null ? sent : sent.set(bearer(accessToken))).set(
          from(newClientIp()),
        );
      };

      for (const route of BACK_OFFICE_ROUTES) {
        expect({ route, code: codeOf(await send(null, route).expect(401)) }).toEqual({
          route,
          code: 'UNAUTHENTICATED',
        });
      }

      // Un administrateur sans second facteur : la permission ne suffit pas.
      const unprotected = await admin({ secondFactor: false });
      for (const route of BACK_OFFICE_ROUTES) {
        expect({
          route,
          code: codeOf(await send(unprotected.accessToken, route).expect(403)),
        }).toEqual({ route, code: 'MFA_ENROLLMENT_REQUIRED' });
      }

      // Un titulaire, un agent du support, un agent de conformité : aucun ne détient la permission.
      const others = [await customer(), await staff('support'), await staff('compliance')];
      for (const member of others) {
        for (const route of BACK_OFFICE_ROUTES) {
          expect({
            route,
            code: codeOf(await send(member.accessToken, route).expect(403)),
          }).toEqual({ route, code: 'FORBIDDEN' });
        }
      }
      // Chaque refus est inscrit au journal, comme tout refus du back-office.
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'authorization.denied',
            actorId: { in: others.map(({ id }) => id) },
          },
        }),
      ).toBe(18);
      expect(await registeredCodes()).toEqual([]);
    });

    it('une permission par action : consulter n’autorise pas à enregistrer un actif', async () => {
      // Un rôle sur mesure, créé comme le ferait une migration (rôle propriétaire).
      await withOwner(testApp, async (owner) => {
        const role = await owner.role.create({
          data: {
            key: 'ledger_auditor',
            name: 'ledger_auditor',
            description: 'Rôle de test : consultation du grand livre, sans plus.',
          },
        });
        await owner.rolePermission.create({
          data: { roleId: role.id, permissionKey: 'ledger.read' },
        });
      });
      const auditor = await staff('ledger_auditor');

      await get(auditor.accessToken, '/admin/ledger/assets').expect(200);
      await get(auditor.accessToken, '/admin/ledger/accounts').expect(200);
      await get(auditor.accessToken, '/admin/ledger/trial-balance').expect(200);
      // La permission est acquise : la réponse dit seulement que rien ne porte cet identifiant.
      await get(auditor.accessToken, `/admin/ledger/accounts/${UNKNOWN_ID}/postings`).expect(404);
      await get(auditor.accessToken, `/admin/ledger/entries/${UNKNOWN_ID}`).expect(404);

      expect(codeOf(await register(auditor, registration()).expect(403))).toBe('FORBIDDEN');
      expect(await registeredCodes()).toEqual([]);
      // Le refus vient du contrôle d'accès de la route, qui l'inscrit au journal avec la
      // permission manquante — la base, qui vérifie la même permission, n'a pas eu à refuser.
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
          resourceId: 'POST /api/v1/admin/ledger/assets',
          outcome: 'DENIED',
          metadata: { missingPermissions: ['ledger.manage_assets'] },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('enregistrer un actif', () => {
    it.each([
      ['code absent', { code: undefined }, 'code'],
      ['code en minuscules', { code: 'usd' }, 'code'],
      ['code d’une seule lettre', { code: 'U' }, 'code'],
      ['code qui commence par un chiffre', { code: '1INCH' }, 'code'],
      ['code qui n’est pas un texte', { code: 840 }, 'code'],
      ['libellé absent', { name: undefined }, 'name'],
      ['libellé vide', { name: '   ' }, 'name'],
      ['libellé de 65 caractères', { name: 'n'.repeat(65) }, 'name'],
      ['libellé avec un saut de ligne', { name: 'US\ndollar' }, 'name'],
      ['nature absente', { kind: undefined }, 'kind'],
      ['nature inconnue', { kind: 'STABLECOIN' }, 'kind'],
      ['nombre de décimales absent', { scale: undefined }, 'scale'],
      ['nombre de décimales négatif', { scale: -1 }, 'scale'],
      ['19 décimales', { scale: 19 }, 'scale'],
      ['nombre de décimales fractionnaire', { scale: 2.5 }, 'scale'],
      ['nombre de décimales en toutes lettres', { scale: '2' }, 'scale'],
      ['justification absente', { reason: undefined }, 'reason'],
      ['justification trop brève', { reason: 'ok' }, 'reason'],
      ['champ inconnu', { decimals: 2 }, ''],
    ])('refuse : %s', async (_label, overrides, path) => {
      const refused = await register(root, registration(overrides)).expect(400);
      expect(codeOf(refused)).toBe('VALIDATION_FAILED');
      expect(pathsOf(refused)).toEqual([path]);
      expect(await registeredCodes()).toEqual([]);
    });

    it('l’actif est enregistré ; la trace porte son auteur et sa justification', async () => {
      const ip = newClientIp();
      // La date d'enregistrement est lue à l'horloge de la base, pas à celle de l'application.
      const before = Date.now();
      const response = await register(
        root,
        registration({ name: '  US dollar ', reason: `  ${REASON}  ` }),
        ip,
      ).expect(201);
      const asset = adminAssetSchema.parse(response.body);
      expect(response.body).toEqual(asset);
      expect(asset).toEqual({
        code: 'USD',
        // Sans les espaces qui l'entouraient.
        name: 'US dollar',
        kind: 'FIAT',
        scale: 2,
        registeredAt: expect.any(String),
        registeredBy: root.id,
      });
      expect(Date.parse(asset.registeredAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(asset.registeredAt)).toBeLessThanOrEqual(Date.now() + 1000);

      const [entry, ...others] = await auditBy(root.id, 'asset.registered');
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        actorType: 'USER',
        resourceType: 'asset',
        resourceId: 'USD',
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(entry?.metadata).toEqual({
        name: 'US dollar',
        kind: 'FIAT',
        scale: 2,
        reason: REASON,
      });

      const listed = await get(root.accessToken, '/admin/ledger/assets').expect(200);
      expect(adminAssetListSchema.parse(listed.body)).toEqual({ assets: [asset] });
      // Enregistrer un actif n'ouvre aucun compte et ne passe aucune écriture.
      expect(await accountsFor(root)).toEqual({ accounts: [], nextCursor: null });
      expect(await asApp(ledgerSize)).toEqual({ entries: 0, postings: 0 });
    });

    it('un code déjà enregistré est refusé, quelle que soit la définition présentée', async () => {
      const stored = await prisma.asset.findUniqueOrThrow({ where: { code: 'USD' } });
      for (const overrides of [{}, { name: 'Dollar', kind: 'CRYPTO', scale: 6 }]) {
        const refused = await register(root, registration(overrides)).expect(409);
        expect(codeOf(refused)).toBe('CONFLICT');
        expect(detailOf(refused)).toBe('Asset USD is already registered.');
      }
      expect(await prisma.asset.findUniqueOrThrow({ where: { code: 'USD' } })).toEqual(stored);
      expect(await auditBy(root.id, 'asset.registered')).toHaveLength(1);
    });

    it('un actif enregistré ne se modifie ni ne se retire : aucune route ne le permet', async () => {
      for (const method of ['put', 'patch', 'delete'] as const) {
        for (const path of ['/api/v1/admin/ledger/assets', '/api/v1/admin/ledger/assets/USD']) {
          const response = await http[method](path)
            .set(bearer(root.accessToken))
            .set(from(newClientIp()))
            .send(registration({ scale: 6 }));
          expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
        }
      }
      expect(await prisma.asset.findUniqueOrThrow({ where: { code: 'USD' } })).toMatchObject({
        name: 'US dollar',
        kind: 'FIAT',
        scale: 2,
      });
    });

    it('deux enregistrements simultanés du même code : un seul aboutit, l’autre est refusé proprement', async () => {
      const other = await admin();
      const responses = await Promise.all([
        register(root, registration({ code: 'EUR', name: 'Euro (root)' })),
        register(other, registration({ code: 'EUR', name: 'Euro (other)', scale: 4 })),
      ]);
      expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
      const refused = responses.find(({ status }) => status === 409);
      expect(detailOf(refused!)).toBe('Asset EUR is already registered.');

      // L'actif conservé est, en entier, celui de la requête qui a abouti.
      const winner = adminAssetSchema.parse(responses.find(({ status }) => status === 201)!.body);
      expect([
        { name: 'Euro (root)', scale: 2, registeredBy: root.id },
        { name: 'Euro (other)', scale: 4, registeredBy: other.id },
      ]).toContainEqual({
        name: winner.name,
        scale: winner.scale,
        registeredBy: winner.registeredBy,
      });
      expect(await prisma.asset.findUniqueOrThrow({ where: { code: 'EUR' } })).toMatchObject({
        name: winner.name,
        scale: winner.scale,
        registeredBy: winner.registeredBy,
      });
      expect(await prisma.auditLog.count({ where: { action: 'asset.registered' } })).toBe(2);
    });

    it('la base vérifie elle-même la permission : retirée pendant la requête, l’actif n’est pas enregistré', async () => {
      const former = await admin();
      // La requête a passé les contrôles d'accès ; le rôle est retiré avant sa transaction.
      let crossed = false;
      crossing.arm(former.id, 'FIRST_TRANSACTION', async () => {
        crossed = true;
        await withOwner(testApp, (owner) =>
          owner.userRole.deleteMany({ where: { userId: former.id } }),
        );
      });
      const refused = await register(former, registration({ code: 'GBP', name: 'Pound' }));
      crossing.disarm();

      expect(crossed).toBe(true);
      expect(refused.status).toBe(403);
      expect(codeOf(refused)).toBe('FORBIDDEN');
      expect(detailOf(refused)).toBe('You do not have permission to perform this action.');
      expect(await registeredCodes()).toEqual(['EUR', 'USD']);
      expect(await auditBy(former.id, 'asset.registered')).toEqual([]);
    });

    it('de 0 à 18 décimales ; la liste suit l’ordre des codes et dit qui a enregistré quoi', async () => {
      for (const body of [
        registration({ code: 'XAF', name: 'CFA franc (BEAC)', scale: 0 }),
        registration({ code: 'ETH', name: 'Ether', kind: 'CRYPTO', scale: 18 }),
        registration({ code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 }),
      ]) {
        await register(root, body).expect(201);
      }
      // Hors de l'API, par un outil d'exploitation : sans auteur.
      await asOwner((owner) => registerAssetInSql(owner, 'CDF', 2));

      const ip = newClientIp();
      const response = await get(root.accessToken, '/admin/ledger/assets', ip).expect(200);
      const { assets } = adminAssetListSchema.parse(response.body);
      expect(response.body).toEqual({ assets });
      expect(
        assets.map(({ code, kind, scale, registeredBy }) => ({ code, kind, scale, registeredBy })),
      ).toEqual([
        { code: 'BTC', kind: 'CRYPTO', scale: 8, registeredBy: root.id },
        { code: 'CDF', kind: 'FIAT', scale: 2, registeredBy: null },
        { code: 'ETH', kind: 'CRYPTO', scale: 18, registeredBy: root.id },
        { code: 'EUR', kind: 'FIAT', scale: expect.any(Number), registeredBy: expect.any(String) },
        { code: 'USD', kind: 'FIAT', scale: 2, registeredBy: root.id },
        { code: 'XAF', kind: 'FIAT', scale: 0, registeredBy: root.id },
      ]);

      const consultations = await auditBy(root.id, 'asset.listed_by_admin');
      expect(consultations.at(-1)).toMatchObject({
        resourceType: 'asset',
        resourceId: null,
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(consultations.at(-1)?.metadata).toEqual({ results: 6 });
    });

    it('chaque titulaire dispose aussitôt d’un portefeuille vide dans chaque actif, écrit avec ses décimales', async () => {
      const member = await customer();
      const eur = await prisma.asset.findUniqueOrThrow({ where: { code: 'EUR' } });
      const response = await get(member.accessToken, '/me/wallets').expect(200);
      expect(response.body).toEqual({
        wallets: [
          {
            asset: { code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 },
            available: '0.00000000',
          },
          { asset: { code: 'CDF', name: 'Asset CDF', kind: 'FIAT', scale: 2 }, available: '0.00' },
          {
            asset: { code: 'ETH', name: 'Ether', kind: 'CRYPTO', scale: 18 },
            available: '0.000000000000000000',
          },
          {
            asset: { code: 'EUR', name: eur.name, kind: 'FIAT', scale: eur.scale },
            available: eur.scale === 2 ? '0.00' : '0.0000',
          },
          { asset: { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 }, available: '0.00' },
          {
            asset: { code: 'XAF', name: 'CFA franc (BEAC)', kind: 'FIAT', scale: 0 },
            available: '0',
          },
        ],
      });
      // Ni l'auteur de l'enregistrement ni sa date ne sont montrés au titulaire.
      expect(JSON.stringify(response.body)).not.toMatch(/registered/i);

      const empty = await movementsOf(member, 'USD');
      expect(empty).toEqual({
        wallet: {
          asset: { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 },
          available: '0.00',
        },
        movements: [],
        nextCursor: null,
      });
      // Lire un portefeuille n'ouvre aucun compte au grand livre.
      expect(await prisma.ledgerAccount.count()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('portefeuilles du titulaire', () => {
    let alice: Member;
    let bob: Member;
    let carol: Member;
    let first: PostedEntry;
    let sent: PostedEntry;
    let bitcoin: PostedEntry;
    let second: PostedEntry;

    beforeAll(async () => {
      alice = await customer();
      bob = await customer();
      carol = await customer();
      first = await deposit(alice, '100.00');
      // Alice envoie 30,25 à Bob et paie 0,75 de frais.
      sent = await transfer(alice, bob, '30.25', '0.75', {
        requestId: 'req-e2e-transfer-0001',
        metadata: { transferId: 'tr_0001', attempt: 1 },
      });
      bitcoin = await deposit(alice, '0.5', BTC);
      second = await deposit(alice, '12.00');
    });

    it('un solde par actif, en chaîne décimale au nombre de décimales de l’actif', async () => {
      expect(await walletsOf(alice)).toMatchObject({
        BTC: '0.50000000',
        CDF: '0.00',
        ETH: '0.000000000000000000',
        USD: '81.00',
        XAF: '0',
      });
      expect(await walletsOf(bob)).toMatchObject({ BTC: '0.00000000', USD: '30.25' });
      expect(await walletsOf(carol)).toMatchObject({ BTC: '0.00000000', USD: '0.00' });
      expect(Object.keys(await walletsOf(alice))).toEqual([
        'BTC',
        'CDF',
        'ETH',
        'EUR',
        'USD',
        'XAF',
      ]);
    });

    it('les mouvements : du plus récent au plus ancien, chacun avec le solde qu’il a laissé', async () => {
      const usd = { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 };
      expect(await movementsOf(alice, 'USD')).toEqual({
        wallet: { asset: usd, available: '81.00' },
        movements: [
          {
            id: second.postings[1]!.id,
            entryId: second.id,
            kind: 'test.deposit',
            side: 'CREDIT',
            amount: '12.00',
            balanceAfter: '81.00',
            postedAt: second.postedAt.toISOString(),
          },
          {
            id: sent.postings[0]!.id,
            entryId: sent.id,
            kind: 'test.transfer',
            side: 'DEBIT',
            // Ce qu'elle a envoyé et les frais : une seule ligne sur son compte.
            amount: '31.00',
            balanceAfter: '69.00',
            postedAt: sent.postedAt.toISOString(),
          },
          {
            id: first.postings[1]!.id,
            entryId: first.id,
            kind: 'test.deposit',
            side: 'CREDIT',
            amount: '100.00',
            balanceAfter: '100.00',
            postedAt: first.postedAt.toISOString(),
          },
        ],
        nextCursor: null,
      });
      expect(await movementsOf(alice, 'BTC')).toEqual({
        wallet: {
          asset: { code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 },
          available: '0.50000000',
        },
        movements: [
          {
            id: bitcoin.postings[1]!.id,
            entryId: bitcoin.id,
            kind: 'test.deposit',
            side: 'CREDIT',
            amount: '0.50000000',
            balanceAfter: '0.50000000',
            postedAt: bitcoin.postedAt.toISOString(),
          },
        ],
        nextCursor: null,
      });
      // Bob : la même écriture, vue de son côté.
      expect(await movementsOf(bob, 'USD')).toEqual({
        wallet: { asset: usd, available: '30.25' },
        movements: [
          {
            id: sent.postings[1]!.id,
            entryId: sent.id,
            kind: 'test.transfer',
            side: 'CREDIT',
            amount: '30.25',
            balanceAfter: '30.25',
            postedAt: sent.postedAt.toISOString(),
          },
        ],
        nextCursor: null,
      });
    });

    it('un mouvement ne dit rien de l’autre partie, des frais perçus, ni des références internes', async () => {
      const response = await get(bob.accessToken, '/me/wallets/USD/movements').expect(200);
      const text = JSON.stringify(response.body);
      for (const hidden of [
        alice.id,
        alice.email,
        sent.postings[0]!.id,
        sent.postings[2]!.id,
        sent.postings[0]!.accountId,
        sent.postings[1]!.accountId,
        'req-e2e-transfer-0001',
        'tr_0001',
        'e2e:',
      ]) {
        expect(text).not.toContain(hidden);
      }
      expect(text).not.toMatch(/idempotency|metadata|actor|accountId|sequence|platform_/i);
      // Un seul montant y figure : celui qu'il a reçu — ni les frais, ni ce qu'Alice a payé.
      const page = walletMovementListSchema.parse(response.body);
      expect([
        page.wallet.available,
        ...page.movements.flatMap(({ amount, balanceAfter }) => [amount, balanceAfter]),
      ]).toEqual(['30.25', '30.25', '30.25']);
      // Chaque mouvement porte exactement ce que le contrat publie.
      expect(Object.keys((response.body as { movements: object[] }).movements[0]!).sort()).toEqual([
        'amount',
        'balanceAfter',
        'entryId',
        'id',
        'kind',
        'postedAt',
        'side',
      ]);
    });

    it('chacun ne lit que les siens : aucune route, aucun paramètre ne désigne un autre compte', async () => {
      expect(await movementsOf(carol, 'USD')).toMatchObject({ movements: [], nextCursor: null });
      expect(await movementsOf(carol, 'BTC')).toMatchObject({ movements: [], nextCursor: null });

      for (const query of [`?userId=${alice.id}`, `?accountId=${first.postings[1]!.accountId}`]) {
        const refused = await get(carol.accessToken, `/me/wallets/USD/movements${query}`).expect(
          400,
        );
        expect(codeOf(refused)).toBe('VALIDATION_FAILED');
        // `GET /me/wallets` n'a pas de paramètre : il l'ignore, et rend ceux de l'appelant.
        const own = await get(carol.accessToken, `/me/wallets${query}`).expect(200);
        expect(walletListSchema.parse(own.body).wallets.map(({ available }) => available)).toEqual([
          '0.00000000',
          '0.00',
          '0.000000000000000000',
          expect.any(String),
          '0.00',
          '0',
        ]);
      }
      // Le curseur d'Alice, présenté par Carol, ne lit que le portefeuille de Carol.
      const { nextCursor } = await movementsOf(alice, 'USD', '?limit=1');
      expect(nextCursor).not.toBeNull();
      expect(await movementsOf(carol, 'USD', `?after=${nextCursor ?? ''}`)).toMatchObject({
        wallet: { available: '0.00' },
        movements: [],
        nextCursor: null,
      });
    });

    it('la pagination parcourt tous les mouvements, une fois chacun, sans en inventer', async () => {
      for (let index = 0; index < 5; index += 1) {
        await deposit(bob, '1.00');
      }
      const all = await movementsOf(bob, 'USD', '?limit=100');
      expect(all.movements.map(({ balanceAfter }) => balanceAfter)).toEqual([
        '35.25',
        '34.25',
        '33.25',
        '32.25',
        '31.25',
        '30.25',
      ]);
      expect(all.nextCursor).toBeNull();
      // Par défaut : vingt par page.
      expect(await movementsOf(bob, 'USD')).toEqual(all);

      const pages: string[][] = [];
      let after: string | null = null;
      do {
        const page = await movementsOf(
          bob,
          'USD',
          after === null ? '?limit=2' : `?limit=2&after=${after}`,
        );
        // Le solde du portefeuille est celui du moment, sur chaque page.
        expect(page.wallet.available).toBe('35.25');
        pages.push(page.movements.map(({ id }) => id));
        after = page.nextCursor;
      } while (after !== null);
      expect(pages.map(({ length }) => length)).toEqual([2, 2, 2]);
      expect(pages.flat()).toEqual(all.movements.map(({ id }) => id));

      // Une page exactement pleine est la dernière ; une de moins annonce la suite.
      expect((await movementsOf(bob, 'USD', '?limit=6')).nextCursor).toBeNull();
      const five = await movementsOf(bob, 'USD', '?limit=5');
      expect(five.movements).toHaveLength(5);
      const rest = await movementsOf(bob, 'USD', `?limit=5&after=${five.nextCursor ?? ''}`);
      expect(rest.movements.map(({ balanceAfter }) => balanceAfter)).toEqual(['30.25']);
      expect(rest.nextCursor).toBeNull();
      // Un curseur au-delà du premier mouvement : plus rien, sans erreur.
      expect(await movementsOf(bob, 'USD', `?after=${cursorOf('1')}`)).toMatchObject({
        movements: [],
        nextCursor: null,
      });
      // Un mouvement passé pendant la lecture ne décale pas les pages suivantes.
      const start = await movementsOf(alice, 'USD', '?limit=1');
      const late = await deposit(alice, '0.50');
      const next = await movementsOf(alice, 'USD', `?limit=1&after=${start.nextCursor ?? ''}`);
      expect(next.movements.map(({ id }) => id)).toEqual([sent.postings[0]!.id]);
      expect(next.wallet.available).toBe('81.50');
      expect((await movementsOf(alice, 'USD', '?limit=1')).movements[0]?.id).toBe(
        late.postings[1]!.id,
      );
    });

    it.each([
      ['limite nulle', '?limit=0', 'limit'],
      ['limite au-delà de 100', '?limit=101', 'limit'],
      ['limite fractionnaire', '?limit=1.5', 'limit'],
      ['limite en toutes lettres', '?limit=ten', 'limit'],
      ['curseur vide', '?after=', 'after'],
      ['curseur hors alphabet', '?after=%2A%2A%2A', 'after'],
      ['curseur de 129 caractères', `?after=${'A'.repeat(129)}`, 'after'],
      ['curseur qui ne désigne pas un rang', `?after=${cursorOf('abc')}`, 'after'],
      ['curseur de rang nul', `?after=${cursorOf('0')}`, 'after'],
      ['curseur de rang négatif', `?after=${cursorOf('-1')}`, 'after'],
      ['curseur de rang fractionnaire', `?after=${cursorOf('1.5')}`, 'after'],
      ['curseur d’une autre liste', `?after=${cursorOf(UNKNOWN_ID)}`, 'after'],
      ['rang au-delà de 64 bits', `?after=${cursorOf('9'.repeat(19))}`, 'after'],
    ])('refuse : %s', async (_label, query, path) => {
      const refused = await get(bob.accessToken, `/me/wallets/USD/movements${query}`).expect(400);
      expect(codeOf(refused)).toBe('VALIDATION_FAILED');
      expect(pathsOf(refused)).toEqual([path]);
    });

    it('un actif que la plateforme ne tient pas : 404 ; un code mal formé : 400', async () => {
      const unknown = await get(alice.accessToken, '/me/wallets/JPY/movements').expect(404);
      expect(codeOf(unknown)).toBe('NOT_FOUND');
      expect(detailOf(unknown)).toBe('Wallet not found.');
      for (const code of ['usd', 'U', '1INCH', UNKNOWN_ID, 'USD%20']) {
        const malformed = await get(alice.accessToken, `/me/wallets/${code}/movements`).expect(400);
        expect(codeOf(malformed)).toBe('VALIDATION_FAILED');
      }
    });

    it('un montant au-delà de 2^53, ou à 18 décimales, est rendu au chiffre près', async () => {
      const dave = await customer();
      // 2^53 + 1 : le premier entier qu'un nombre JSON ne sait plus écrire.
      await deposit(dave, '9007199254740993', XAF);
      await deposit(dave, '2', XAF);
      await deposit(dave, '1234567890.123456789012345678', ETH);
      await withdrawal(dave, '0.000000000000000001', ETH);

      const response = await get(dave.accessToken, '/me/wallets').expect(200);
      const wallets = walletListSchema.parse(response.body).wallets;
      expect(wallets.find(({ asset }) => asset.code === 'XAF')?.available).toBe('9007199254740995');
      expect(wallets.find(({ asset }) => asset.code === 'ETH')?.available).toBe(
        '1234567890.123456789012345677',
      );
      // Dans le texte même de la réponse : entre guillemets, jamais un nombre JSON.
      expect(response.text).toContain('"available":"9007199254740995"');
      expect(response.text).toContain('"available":"1234567890.123456789012345677"');

      const xaf = await movementsOf(dave, 'XAF');
      expect(xaf.movements.map(({ amount, balanceAfter }) => [amount, balanceAfter])).toEqual([
        ['2', '9007199254740995'],
        ['9007199254740993', '9007199254740993'],
      ]);
      const eth = await movementsOf(dave, 'ETH');
      expect(
        eth.movements.map(({ side, amount, balanceAfter }) => [side, amount, balanceAfter]),
      ).toEqual([
        ['DEBIT', '0.000000000000000001', '1234567890.123456789012345677'],
        ['CREDIT', '1234567890.123456789012345678', '1234567890.123456789012345678'],
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('consultation par le back-office', () => {
    let alice: string;
    let bob: string;
    let transferId: string;

    const usd = { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 };

    beforeAll(async () => {
      // Les titulaires et l'écriture du bloc précédent, retrouvés par le grand livre lui-même.
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { kind: 'test.transfer' } });
      transferId = entry.id;
      alice = entry.actorId!;
      const credited = await prisma.ledgerPosting.findFirstOrThrow({
        where: { entryId: entry.id, lineNumber: 2 },
        include: { account: true },
      });
      bob = credited.account.userId!;
    });

    it('les comptes : du plus ancien au plus récent, filtrés par titulaire, actif ou type', async () => {
      const ip = newClientIp();
      const response = await get(
        root.accessToken,
        `/admin/ledger/accounts?userId=${alice}`,
        ip,
      ).expect(200);
      const ofAlice = adminLedgerAccountListSchema.parse(response.body);
      expect(response.body).toEqual(ofAlice);
      expect(ofAlice).toEqual({
        accounts: [
          {
            id: expect.stringMatching(UUID),
            type: 'user_available',
            owner: 'USER',
            userId: alice,
            asset: usd,
            normalSide: 'CREDIT',
            balance: '81.50',
            postingCount: 4,
            createdAt: expect.any(String),
          },
          {
            id: expect.stringMatching(UUID),
            type: 'user_available',
            owner: 'USER',
            userId: alice,
            asset: { code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 },
            normalSide: 'CREDIT',
            balance: '0.50000000',
            postingCount: 1,
            createdAt: expect.any(String),
          },
        ],
        nextCursor: null,
      });
      const [entry] = (await auditBy(root.id, 'ledger_account.listed_by_admin')).slice(-1);
      expect(entry).toMatchObject({
        resourceType: 'ledger_account',
        resourceId: null,
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(entry?.metadata).toEqual({ userId: alice, limit: 20, results: 2 });

      // Les comptes en dollars, dans l'ordre de leur ouverture : la première écriture a ouvert
      // la conservation et le compte d'Alice ; la deuxième, les frais et le compte de Bob.
      const inUsd = await accountsFor(root, '?assetCode=USD');
      expect(
        inUsd.accounts.map(({ type, owner, userId, normalSide, balance, postingCount }) => ({
          type,
          owner,
          userId,
          normalSide,
          balance,
          postingCount,
        })),
      ).toEqual([
        {
          type: 'platform_custody',
          owner: 'PLATFORM',
          userId: null,
          normalSide: 'DEBIT',
          balance: '117.50',
          postingCount: 8,
        },
        {
          type: 'user_available',
          owner: 'USER',
          userId: alice,
          normalSide: 'CREDIT',
          balance: '81.50',
          postingCount: 4,
        },
        {
          type: 'platform_fees',
          owner: 'PLATFORM',
          userId: null,
          normalSide: 'CREDIT',
          balance: '0.75',
          postingCount: 1,
        },
        {
          type: 'user_available',
          owner: 'USER',
          userId: bob,
          normalSide: 'CREDIT',
          balance: '35.25',
          postingCount: 6,
        },
      ]);
      expect(inUsd.nextCursor).toBeNull();

      const custodies = await accountsFor(root, '?type=platform_custody');
      expect(custodies.accounts.map(({ asset, balance }) => [asset.code, balance])).toEqual([
        ['USD', '117.50'],
        ['BTC', '0.50000000'],
        ['XAF', '9007199254740995'],
        ['ETH', '1234567890.123456789012345677'],
      ]);
      const feesInUsd = await accountsFor(root, '?type=platform_fees&assetCode=USD');
      expect(feesInUsd.accounts.map(({ id }) => id)).toEqual([inUsd.accounts[2]!.id]);
      expect(await accountsFor(root, `?userId=${bob}&assetCode=BTC`)).toEqual({
        accounts: [],
        nextCursor: null,
      });
      expect(await accountsFor(root, `?userId=${UNKNOWN_ID}`)).toEqual({
        accounts: [],
        nextCursor: null,
      });
      const filtered = (await auditBy(root.id, 'ledger_account.listed_by_admin')).at(-3);
      expect(filtered?.metadata).toEqual({
        type: 'platform_fees',
        assetCode: 'USD',
        limit: 20,
        results: 1,
      });
    });

    it('les comptes se parcourent page après page, sans en répéter ni en omettre', async () => {
      const all = await accountsFor(root, '?limit=100');
      // Dollars : 4 comptes ; bitcoin, franc CFA, ether : la conservation et un titulaire.
      expect(all.accounts).toHaveLength(10);
      expect(all.nextCursor).toBeNull();
      const ids = all.accounts.map(({ id }) => id);
      expect(ids).toEqual([...ids].sort());

      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const page = await accountsFor(
          root,
          after === null ? '?limit=3' : `?limit=3&after=${after}`,
        );
        seen.push(...page.accounts.map(({ id }) => id));
        after = page.nextCursor;
        pages += 1;
      } while (after !== null);
      expect(pages).toBe(4);
      expect(seen).toEqual(ids);
      // Une page exactement pleine est la dernière.
      expect((await accountsFor(root, '?limit=10')).nextCursor).toBeNull();
      // Le filtre s'applique à chaque page.
      const firstInUsd = await accountsFor(root, '?assetCode=USD&limit=3');
      const lastInUsd = await accountsFor(
        root,
        `?assetCode=USD&limit=3&after=${firstInUsd.nextCursor ?? ''}`,
      );
      expect(lastInUsd.accounts.map(({ userId }) => userId)).toEqual([bob]);
      expect(lastInUsd.nextCursor).toBeNull();
    });

    it.each([
      ['titulaire qui n’est pas un identifiant', '?userId=alice', 'userId'],
      ['code d’actif mal formé', '?assetCode=usd', 'assetCode'],
      ['type de compte inconnu', '?type=user_locked', 'type'],
      ['limite au-delà de 100', '?limit=101', 'limit'],
      ['curseur d’une autre liste', `?after=${cursorOf('3')}`, 'after'],
      ['curseur hors alphabet', '?after=%2A', 'after'],
      ['paramètre inconnu', '?email=alice%40example.cd', ''],
    ])('la liste des comptes refuse : %s', async (_label, query, path) => {
      const before = await prisma.auditLog.count({
        where: { action: 'ledger_account.listed_by_admin' },
      });
      const refused = await get(root.accessToken, `/admin/ledger/accounts${query}`).expect(400);
      expect(codeOf(refused)).toBe('VALIDATION_FAILED');
      expect(pathsOf(refused)).toEqual([path]);
      // Rien n'a été consulté : rien n'est inscrit comme tel.
      expect(
        await prisma.auditLog.count({ where: { action: 'ledger_account.listed_by_admin' } }),
      ).toBe(before);
    });

    it('un compte et ses lignes : de la plus récente à la plus ancienne, numérotées sans trou', async () => {
      const [account] = (await accountsFor(root, `?userId=${alice}&assetCode=USD`)).accounts;
      const ip = newClientIp();
      const response = await get(
        root.accessToken,
        `/admin/ledger/accounts/${account!.id}/postings`,
        ip,
      ).expect(200);
      const statement = adminLedgerPostingListSchema.parse(response.body);
      expect(response.body).toEqual(statement);
      expect(statement.account).toEqual(account);
      expect(
        statement.postings.map(
          ({ kind, side, amount, balanceAfter, accountSequence, lineNumber }) => ({
            kind,
            side,
            amount,
            balanceAfter,
            accountSequence,
            lineNumber,
          }),
        ),
      ).toEqual([
        {
          kind: 'test.deposit',
          side: 'CREDIT',
          amount: '0.50',
          balanceAfter: '81.50',
          accountSequence: 4,
          lineNumber: 2,
        },
        {
          kind: 'test.deposit',
          side: 'CREDIT',
          amount: '12.00',
          balanceAfter: '81.00',
          accountSequence: 3,
          lineNumber: 2,
        },
        {
          kind: 'test.transfer',
          side: 'DEBIT',
          amount: '31.00',
          balanceAfter: '69.00',
          accountSequence: 2,
          lineNumber: 1,
        },
        {
          kind: 'test.deposit',
          side: 'CREDIT',
          amount: '100.00',
          balanceAfter: '100.00',
          accountSequence: 1,
          lineNumber: 2,
        },
      ]);
      expect(statement.postings[2]?.entryId).toBe(transferId);
      expect(statement.nextCursor).toBeNull();

      const [entry] = (await auditBy(root.id, 'ledger_account.viewed_by_admin')).slice(-1);
      expect(entry).toMatchObject({
        resourceType: 'ledger_account',
        resourceId: account!.id,
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(entry?.metadata).toEqual({
        userId: alice,
        type: 'user_available',
        assetCode: 'USD',
        limit: 20,
        results: 4,
      });

      // Page après page.
      const head = await postingsFor(root, account!.id, '?limit=3');
      expect(head.postings.map(({ accountSequence }) => accountSequence)).toEqual([4, 3, 2]);
      const tail = await postingsFor(root, account!.id, `?limit=3&after=${head.nextCursor ?? ''}`);
      expect(tail.postings.map(({ accountSequence }) => accountSequence)).toEqual([1]);
      expect(tail.nextCursor).toBeNull();
      expect(tail.account).toEqual(account);
      expect((await postingsFor(root, account!.id, '?limit=4')).nextCursor).toBeNull();
    });

    it('un compte de la plateforme : son solde s’exprime dans son sens normal, sans titulaire', async () => {
      const [custodyInUsd] = (await accountsFor(root, '?type=platform_custody&assetCode=USD'))
        .accounts;
      const statement = await postingsFor(root, custodyInUsd!.id, '?limit=2');
      expect(statement.account).toMatchObject({
        owner: 'PLATFORM',
        userId: null,
        normalSide: 'DEBIT',
        balance: '117.50',
        postingCount: 8,
      });
      // Un dépôt débite la conservation : son solde augmente.
      expect(
        statement.postings.map(({ side, amount, balanceAfter, accountSequence }) => ({
          side,
          amount,
          balanceAfter,
          accountSequence,
        })),
      ).toEqual([
        { side: 'DEBIT', amount: '0.50', balanceAfter: '117.50', accountSequence: 8 },
        { side: 'DEBIT', amount: '1.00', balanceAfter: '117.00', accountSequence: 7 },
      ]);
      const [entry] = (await auditBy(root.id, 'ledger_account.viewed_by_admin')).slice(-1);
      // Aucun titulaire à citer.
      expect(entry?.metadata).toEqual({
        type: 'platform_custody',
        assetCode: 'USD',
        limit: 2,
        results: 2,
      });
    });

    it('une écriture complète : son auteur, sa clé, ses références et toutes ses lignes', async () => {
      const ip = newClientIp();
      const response = await get(
        root.accessToken,
        `/admin/ledger/entries/${transferId}`,
        ip,
      ).expect(200);
      const entry = adminLedgerEntrySchema.parse(response.body);
      expect(response.body).toEqual(entry);
      const line = (
        lineNumber: number,
        account: Record<string, unknown>,
        side: string,
        amount: string,
        balanceAfter: string,
        accountSequence: number,
      ) => ({
        id: expect.stringMatching(UUID),
        lineNumber,
        account: { id: expect.stringMatching(UUID), ...account },
        asset: usd,
        side,
        amount,
        balanceAfter,
        accountSequence,
      });
      expect(entry).toEqual({
        id: transferId,
        kind: 'test.transfer',
        idempotencyKey: expect.stringMatching(/^e2e:[0-9a-f-]{36}$/),
        actor: { type: 'USER', id: alice },
        requestId: 'req-e2e-transfer-0001',
        metadata: { transferId: 'tr_0001', attempt: 1 },
        postedAt: expect.any(String),
        postings: [
          line(
            1,
            { type: 'user_available', owner: 'USER', userId: alice },
            'DEBIT',
            '31.00',
            '69.00',
            2,
          ),
          line(
            2,
            { type: 'user_available', owner: 'USER', userId: bob },
            'CREDIT',
            '30.25',
            '30.25',
            1,
          ),
          line(
            3,
            { type: 'platform_fees', owner: 'PLATFORM', userId: null },
            'CREDIT',
            '0.75',
            '0.75',
            1,
          ),
        ],
      });

      const [viewed] = (await auditBy(root.id, 'ledger_entry.viewed_by_admin')).slice(-1);
      expect(viewed).toMatchObject({
        resourceType: 'ledger_entry',
        resourceId: transferId,
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(viewed?.metadata).toEqual({ kind: 'test.transfer', postings: 3 });

      // Une écriture passée par la plateforme elle-même : sans auteur désigné ni référence.
      const deposited = await prisma.ledgerEntry.findFirstOrThrow({
        where: { kind: 'test.deposit' },
        orderBy: { id: 'asc' },
      });
      const system = adminLedgerEntrySchema.parse(
        (await get(root.accessToken, `/admin/ledger/entries/${deposited.id}`).expect(200)).body,
      );
      expect(system).toMatchObject({
        actor: { type: 'SYSTEM', id: null },
        requestId: null,
        metadata: {},
      });
      expect(system.postings.map(({ side, amount }) => [side, amount])).toEqual([
        ['DEBIT', '100.00'],
        ['CREDIT', '100.00'],
      ]);
    });

    it('un identifiant inconnu : 404, et rien n’est inscrit comme consulté ; mal formé : 400', async () => {
      const viewed = () =>
        prisma.auditLog.count({
          where: {
            action: { in: ['ledger_account.viewed_by_admin', 'ledger_entry.viewed_by_admin'] },
          },
        });
      const before = await viewed();

      const account = await get(
        root.accessToken,
        `/admin/ledger/accounts/${UNKNOWN_ID}/postings`,
      ).expect(404);
      expect(codeOf(account)).toBe('NOT_FOUND');
      expect(detailOf(account)).toBe('Ledger account not found.');
      const entry = await get(root.accessToken, `/admin/ledger/entries/${UNKNOWN_ID}`).expect(404);
      expect(codeOf(entry)).toBe('NOT_FOUND');
      expect(detailOf(entry)).toBe('Ledger entry not found.');
      // L'identifiant d'une écriture n'est pas celui d'un compte, ni l'inverse.
      await get(root.accessToken, `/admin/ledger/accounts/${transferId}/postings`).expect(404);

      for (const path of [
        '/admin/ledger/accounts/not-an-id/postings',
        '/admin/ledger/entries/not-an-id',
        `/admin/ledger/accounts/${UNKNOWN_ID}/postings?after=${cursorOf(UNKNOWN_ID)}`,
        `/admin/ledger/accounts/${UNKNOWN_ID}/postings?limit=0`,
        // Les lignes d'un compte ne se filtrent pas : tout autre paramètre est refusé.
        `/admin/ledger/accounts/${UNKNOWN_ID}/postings?assetCode=USD`,
        `/admin/ledger/accounts/${UNKNOWN_ID}/postings?before=Mw`,
      ]) {
        expect(codeOf(await get(root.accessToken, path).expect(400))).toBe('VALIDATION_FAILED');
      }
      expect(await viewed()).toBe(before);
    });

    it('la balance : pour chaque actif, ce que la plateforme conserve égale ce qu’elle doit et ce qu’elle a gagné', async () => {
      const ip = newClientIp();
      const started = testClock.now().getTime();
      const response = await get(root.accessToken, '/admin/ledger/trial-balance', ip).expect(200);
      const balance = trialBalanceSchema.parse(response.body);
      expect(response.body).toEqual(balance);
      expect(Date.parse(balance.generatedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(balance.generatedAt)).toBeLessThanOrEqual(testClock.now().getTime());

      const eur = await prisma.asset.findUniqueOrThrow({ where: { code: 'EUR' } });
      const zeroIn = (scale: number): string => (scale === 0 ? '0' : `0.${'0'.repeat(scale)}`);
      const types = (
        scale: number,
        holders: [number, string],
        kept: [number, string],
        earned: [number, string] = [0, zeroIn(scale)],
      ) => [
        {
          type: 'user_available',
          owner: 'USER',
          normalSide: 'CREDIT',
          accounts: holders[0],
          balance: holders[1],
        },
        {
          type: 'platform_custody',
          owner: 'PLATFORM',
          normalSide: 'DEBIT',
          accounts: kept[0],
          balance: kept[1],
        },
        {
          type: 'platform_fees',
          owner: 'PLATFORM',
          normalSide: 'CREDIT',
          accounts: earned[0],
          balance: earned[1],
        },
      ];
      const unused = (asset: Record<string, unknown>, scale: number) => ({
        asset,
        debitBalance: zeroIn(scale),
        creditBalance: zeroIn(scale),
        balanced: true,
        accountTypes: types(scale, [0, zeroIn(scale)], [0, zeroIn(scale)]),
      });
      expect(balance).toEqual({
        generatedAt: expect.any(String),
        balanced: true,
        assets: [
          {
            asset: { code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 },
            debitBalance: '0.50000000',
            creditBalance: '0.50000000',
            balanced: true,
            accountTypes: types(8, [1, '0.50000000'], [1, '0.50000000']),
          },
          unused({ code: 'CDF', name: 'Asset CDF', kind: 'FIAT', scale: 2 }, 2),
          {
            asset: { code: 'ETH', name: 'Ether', kind: 'CRYPTO', scale: 18 },
            debitBalance: '1234567890.123456789012345677',
            creditBalance: '1234567890.123456789012345677',
            balanced: true,
            accountTypes: types(
              18,
              [1, '1234567890.123456789012345677'],
              [1, '1234567890.123456789012345677'],
            ),
          },
          unused({ code: 'EUR', name: eur.name, kind: 'FIAT', scale: eur.scale }, eur.scale),
          {
            asset: usd,
            debitBalance: '117.50',
            // 81,50 à Alice, 35,25 à Bob, 0,75 de frais.
            creditBalance: '117.50',
            balanced: true,
            accountTypes: types(2, [2, '116.75'], [1, '117.50'], [1, '0.75']),
          },
          {
            asset: { code: 'XAF', name: 'CFA franc (BEAC)', kind: 'FIAT', scale: 0 },
            debitBalance: '9007199254740995',
            creditBalance: '9007199254740995',
            balanced: true,
            accountTypes: types(0, [1, '9007199254740995'], [1, '9007199254740995']),
          },
        ],
      });

      const [entry] = (await auditBy(root.id, 'ledger.trial_balance_viewed')).slice(-1);
      expect(entry).toMatchObject({
        resourceType: 'ledger',
        resourceId: null,
        outcome: 'SUCCESS',
        ipAddress: ip,
        requestId: response.headers['x-request-id'],
      });
      expect(entry?.metadata).toEqual({ assets: 6, balanced: true });
    });

    it('consulter ne change rien au grand livre, et aucune route publiée n’y passe d’écriture', async () => {
      const before = await asApp(ledgerSize);
      expect(before.entries).toBe(posted);
      const [account] = (await accountsFor(root, `?userId=${alice}&assetCode=USD`)).accounts;
      await postingsFor(root, account!.id);
      await trialBalanceFor(root);
      await get(root.accessToken, `/admin/ledger/entries/${transferId}`).expect(200);
      expect(await asApp(ledgerSize)).toEqual(before);

      // Le contrat publié : des lectures, et l'enregistrement d'un actif — rien d'autre.
      const document = (await http.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, unknown>>;
      };
      const operations = Object.entries(document.paths)
        .filter(([path]) => path.includes('/ledger') || path.includes('/wallets'))
        .flatMap(([path, methods]) =>
          Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
        )
        .sort();
      expect(operations).toEqual([
        'GET /api/v1/admin/ledger/accounts',
        'GET /api/v1/admin/ledger/accounts/{accountId}/postings',
        'GET /api/v1/admin/ledger/assets',
        'GET /api/v1/admin/ledger/entries/{entryId}',
        'GET /api/v1/admin/ledger/trial-balance',
        'GET /api/v1/me/wallets',
        'GET /api/v1/me/wallets/{assetCode}/movements',
        'POST /api/v1/admin/ledger/assets',
      ]);
      for (const path of ['/me/wallets', '/me/wallets/USD/movements', '/admin/ledger/entries']) {
        const refused = await post(root.accessToken, path, { amount: '1.00' });
        expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      }
      expect(await asApp(ledgerSize)).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('pendant la maintenance', () => {
    it('les titulaires attendent ; le back-office consulte le grand livre et enregistre un actif', async () => {
      const member = await customer();
      const settings = testApp.app.get(SystemSettingsService);
      const context = { actor: { type: 'SYSTEM' } as const, reason: 'test: maintenance window' };
      await settings.set('maintenance.mode', { enabled: true, message: null }, context);
      try {
        for (const path of ['/me/wallets', '/me/wallets/USD/movements']) {
          expect(codeOf(await get(member.accessToken, path).expect(503))).toBe('MAINTENANCE');
        }
        await get(root.accessToken, '/admin/ledger/assets').expect(200);
        await get(root.accessToken, '/admin/ledger/accounts').expect(200);
        const [account] = (await accountsFor(root, '?limit=1')).accounts;
        await get(root.accessToken, `/admin/ledger/accounts/${account!.id}/postings`).expect(200);
        const entry = await prisma.ledgerEntry.findFirstOrThrow();
        await get(root.accessToken, `/admin/ledger/entries/${entry.id}`).expect(200);
        expect((await trialBalanceFor(root)).balanced).toBe(true);
        await register(
          root,
          registration({ code: 'USDT', name: 'Tether', kind: 'CRYPTO', scale: 6 }),
        ).expect(201);
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, context);
      }
      expect((await walletsOf(member))['USDT']).toBe('0.000000');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('copie des données et clôture du compte', () => {
    const exportOf = async (member: Member, ip = newClientIp()) => {
      const response = await post(
        member.accessToken,
        '/me/data-export',
        { currentPassword: member.password },
        ip,
      ).expect(200);
      const copy = dataExportSchema.parse(response.body);
      expect(response.body).toEqual(copy);
      return copy;
    };
    const closeOwn = (member: Member) =>
      post(member.accessToken, '/me/close', { currentPassword: member.password, confirm: true });
    const closeByStaff = (userId: string) =>
      post(root.accessToken, `/admin/users/${userId}/close`, {
        ground: 'PLATFORM_DECISION',
        reason: REASON,
        confirm: true,
      });
    const FUNDS_REMAINING =
      'The account cannot be closed: it still holds funds, which must be withdrawn or ' +
      'transferred first.';

    it('la copie contient les portefeuilles qui ont servi, avec leurs mouvements ; les autres n’y figurent pas', async () => {
      const holder = await customer();
      const other = await customer();
      const received = await deposit(holder, '40.00');
      const given = await transfer(holder, other, '15.50');
      const satoshis = await deposit(holder, '0.00000001', BTC);

      const copy = await exportOf(holder);
      expect(copy.formatVersion).toBe(3);
      expect(copy.wallets).toEqual([
        {
          asset: { code: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', scale: 8 },
          available: '0.00000001',
          movements: [
            {
              id: satoshis.postings[1]!.id,
              entryId: satoshis.id,
              kind: 'test.deposit',
              side: 'CREDIT',
              amount: '0.00000001',
              balanceAfter: '0.00000001',
              postedAt: satoshis.postedAt.toISOString(),
            },
          ],
          truncated: false,
        },
        {
          asset: { code: 'USD', name: 'US dollar', kind: 'FIAT', scale: 2 },
          available: '24.50',
          movements: [
            {
              id: given.postings[0]!.id,
              entryId: given.id,
              kind: 'test.transfer',
              side: 'DEBIT',
              amount: '15.50',
              balanceAfter: '24.50',
              postedAt: given.postedAt.toISOString(),
            },
            {
              id: received.postings[1]!.id,
              entryId: received.id,
              kind: 'test.deposit',
              side: 'CREDIT',
              amount: '40.00',
              balanceAfter: '40.00',
              postedAt: received.postedAt.toISOString(),
            },
          ],
          truncated: false,
        },
      ]);
      // Ce que montre aussi la lecture de ses portefeuilles.
      expect(copy.wallets[1]?.movements).toEqual((await movementsOf(holder, 'USD')).movements);
      // Rien de l'autre partie.
      const text = JSON.stringify(copy);
      expect(text).not.toContain(other.id);
      expect(text).not.toContain(other.email);

      const [entry] = await auditBy(holder.id, 'user.data_exported');
      expect(entry?.metadata).toMatchObject({ formatVersion: 3, wallets: 2 });

      // Un compte qui n'a jamais rien reçu : aucun portefeuille dans sa copie.
      const idle = await customer();
      expect((await exportOf(idle)).wallets).toEqual([]);
      const [idleEntry] = await auditBy(idle.id, 'user.data_exported');
      expect(idleEntry?.metadata).toMatchObject({ formatVersion: 3, wallets: 0 });
    });

    it('un compte qui détient des fonds ne se clôture pas — ni par son titulaire, ni par le personnel', async () => {
      const holder = await customer();
      // Un centime suffit.
      await deposit(holder, '0.01');

      const own = await closeOwn(holder).expect(409);
      expect(codeOf(own)).toBe('CONFLICT');
      expect(detailOf(own)).toBe(FUNDS_REMAINING);
      const byStaff = await closeByStaff(holder.id).expect(409);
      expect(codeOf(byStaff)).toBe('CONFLICT');
      expect(detailOf(byStaff)).toBe(FUNDS_REMAINING);

      // Rien n'a changé : le compte est ouvert, sa session aussi, ses fonds sont là.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: holder.id } })).status).toBe(
        'ACTIVE',
      );
      expect(await prisma.accountClosure.count({ where: { userId: holder.id } })).toBe(0);
      expect((await walletsOf(holder))['USD']).toBe('0.01');

      // Dans un autre actif aussi, quel qu'en soit le montant.
      const inBitcoin = await customer();
      await deposit(inBitcoin, '0.00000001', BTC);
      expect(detailOf(await closeOwn(inBitcoin).expect(409))).toBe(FUNDS_REMAINING);
    });

    it('vidé, le compte se clôture : ses écritures restent, et ce qui le rattache à une personne est conservé dix ans', async () => {
      const holder = await customer();
      const received = await deposit(holder, '20.00');
      await withdrawal(holder, '20.00');
      expect((await walletsOf(holder))['USD']).toBe('0.00');

      const response = await closeOwn(holder).expect(200);
      const closure = accountClosureSchema.parse(response.body);
      const closedAt = new Date(closure.closedAt);
      const tenYearsLater = new Date(closedAt);
      tenYearsLater.setUTCFullYear(closedAt.getUTCFullYear() + 10);
      expect(closure.legalRetentionUntil).toBe(tenYearsLater.toISOString());
      // Rien n'est effacé avant ce terme.
      expect(closure.erasureDueAt).toBe(tenYearsLater.toISOString());

      // La session est fermée ; le grand livre, lui, n'a rien perdu.
      await get(holder.accessToken, '/me/wallets').expect(401);
      const { accounts } = await accountsFor(root, `?userId=${holder.id}`);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ userId: holder.id, balance: '0.00', postingCount: 2 });
      const statement = await postingsFor(root, accounts[0]!.id);
      expect(statement.postings.map(({ kind, amount }) => [kind, amount])).toEqual([
        ['test.withdrawal', '20.00'],
        ['test.deposit', '20.00'],
      ]);
      expect(statement.postings[1]?.entryId).toBe(received.id);
      // L'adresse du titulaire reste attachée à la trace de la clôture.
      const detail = adminUserDetailSchema.parse(
        (await get(root.accessToken, `/admin/users/${holder.id}`).expect(200)).body,
      );
      expect(detail.closure).toMatchObject({
        formerEmail: holder.email,
        legalRetentionUntil: tenYearsLater.toISOString(),
        erasedAt: null,
      });

      // Plus rien ne s'écrit sur le compte d'un titulaire clôturé.
      await expect(
        ledger.post({
          idempotencyKey: `e2e:${randomUUID()}`,
          kind: 'test.deposit',
          actor: { type: 'SYSTEM' },
          postings: [
            { account: custody, side: 'DEBIT', amount: Money.parse('1.00', USD) },
            { account: userAccount(holder.id), side: 'CREDIT', amount: Money.parse('1.00', USD) },
          ],
        }),
      ).rejects.toBeInstanceOf(HolderClosedError);
    });

    it('le personnel clôture de même un compte vidé ; un compte sans aucune écriture n’impose aucune conservation', async () => {
      const emptied = await customer();
      await deposit(emptied, '5.00');
      await withdrawal(emptied, '5.00');
      const byStaff = adminAccountClosureSchema.parse(
        (await closeByStaff(emptied.id).expect(200)).body,
      );
      expect(byStaff).toMatchObject({ origin: 'STAFF', formerEmail: emptied.email });
      expect(Date.parse(byStaff.legalRetentionUntil ?? '')).toBeGreaterThan(
        Date.parse(byStaff.closedAt) + 3652 * DAY_MS,
      );
      expect(byStaff.erasureDueAt).toBe(byStaff.legalRetentionUntil);

      const idle = await customer();
      const closure = accountClosureSchema.parse((await closeOwn(idle).expect(200)).body);
      expect(closure.legalRetentionUntil).toBeNull();
      expect(Date.parse(closure.erasureDueAt) - Date.parse(closure.closedAt)).toBe(30 * DAY_MS);
    });
  });

  // En dernier : l'horloge de l'application ne revient pas en arrière.
  // ---------------------------------------------------------------------------------------------
  describe('trente jours plus tard', () => {
    it('seul le compte sans écriture est effacé ; la vérification périodique repasse tout le grand livre', async () => {
      const maintenance = testApp.app.get(AccountMaintenanceService);
      const kept = await customer();
      await deposit(kept, '3.00');
      await withdrawal(kept, '3.00');
      await post(kept.accessToken, '/me/close', {
        currentPassword: kept.password,
        confirm: true,
      }).expect(200);
      const forgotten = await customer();
      await post(forgotten.accessToken, '/me/close', {
        currentPassword: forgotten.password,
        confirm: true,
      }).expect(200);

      testClock.advance(31 * DAY_MS);
      const report = await maintenance.run();

      expect(report.failures).toBe(0);
      expect(
        await prisma.accountClosure.findUniqueOrThrow({ where: { userId: forgotten.id } }),
      ).toMatchObject({ email: null });
      const closure = await prisma.accountClosure.findUniqueOrThrow({ where: { userId: kept.id } });
      expect(closure).toMatchObject({ email: kept.email, erasedAt: null });
      expect(await prisma.ledgerPosting.count({ where: { account: { userId: kept.id } } })).toBe(2);

      // Toutes les écritures de ces scénarios, et aucune anomalie.
      expect(posted).toBe(25);
      expect(report.otherSteps['verify-ledger']).toBe(posted);
      expect(await prisma.ledgerEntry.count()).toBe(posted);
      expect(await prisma.auditLog.count({ where: { action: 'ledger.verification_failed' } })).toBe(
        0,
      );
      expect((await trialBalanceFor(root)).balanced).toBe(true);
    });
  });
});
