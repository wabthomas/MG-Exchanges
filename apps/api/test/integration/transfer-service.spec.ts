import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { DATA_EXPORT_TRANSFERS_MAX_ENTRIES } from '@mgx/contracts';
import { type Asset, defineAsset, Money } from '@mgx/shared';
import type pg from 'pg';

import { AppError } from '../../src/common/errors/app-error.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { RedisRateLimiter } from '../../src/infrastructure/rate-limit/redis-rate-limiter.js';
import { AccountClosureService } from '../../src/modules/identity/application/account-closure.service.js';
import { PasswordHasher } from '../../src/modules/identity/application/password-hasher.js';
import { LedgerReader } from '../../src/modules/ledger/application/ledger-reader.js';
import { LedgerService } from '../../src/modules/ledger/application/ledger.service.js';
import { platformAccount, userAccount } from '../../src/modules/ledger/domain/ledger-account.js';
import { NotificationService } from '../../src/modules/notifications/application/notification.service.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import { TransferAccountData } from '../../src/modules/transfers/application/transfer-account-data.js';
import { TransferLimitsService } from '../../src/modules/transfers/application/transfer-limits.service.js';
import { TransferNoticeDispatcher } from '../../src/modules/transfers/application/transfer-notice.dispatcher.js';
import {
  RECIPIENT_REFUSALS_PER_ACCOUNT,
  TRANSFER_ATTEMPTS_PER_ACCOUNT,
} from '../../src/modules/transfers/application/transfer-quotas.js';
import { TransferRepository } from '../../src/modules/transfers/application/transfer.repository.js';
import {
  type TransferOutcome,
  TransferService,
} from '../../src/modules/transfers/application/transfer.service.js';
import { requestDigest } from '../../src/modules/transfers/domain/transfer-policy.js';
import {
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
} from '../support/account-closure.js';
import {
  backgroundWorkDone,
  createAdmin,
  enableSecondFactor,
  mailbox,
  nextMessageOf,
  nextTotpCode,
  PASSWORD,
  wrongTotpCode,
} from '../support/identity.js';
import { revoke } from '../support/kyc-sql.js';
import { ledgerSize, openLedgerAccount, registerAssetInSql } from '../support/ledger-sql.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';
import { untilBlocked, withConnection } from '../support/test-database.js';
import {
  backdateTransfer,
  freshKey,
  setLimitInSql,
  usageInSql,
  verifyUpTo,
  writeTransfer,
} from '../support/transfers-sql.js';

const USD = defineAsset('USD', 2);
const BTC = defineAsset('BTC', 8);
const SYSTEM = { type: 'SYSTEM' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const REASON = 'Ouverture des transferts dans cet actif, décision du 14 novembre';

const RECIPIENT_UNAVAILABLE = {
  code: 'RECIPIENT_UNAVAILABLE',
  message: 'This recipient cannot receive transfers.',
};
const NOT_PERMITTED = {
  code: 'TRANSFER_NOT_PERMITTED',
  message: 'Transfers in this asset are not open to your verification level.',
};
const OVER_PER_TRANSFER = {
  code: 'TRANSFER_LIMIT_EXCEEDED',
  message: 'The amount exceeds the limit per transfer of your verification level.',
};
const OVER_DAILY = {
  code: 'TRANSFER_LIMIT_EXCEEDED',
  message: 'The amount exceeds what your verification level may still send over 24 hours.',
};
const OVER_MONTHLY = {
  code: 'TRANSFER_LIMIT_EXCEEDED',
  message: 'The amount exceeds what your verification level may still send over 31 days.',
};
const INSUFFICIENT_FUNDS = {
  code: 'INSUFFICIENT_FUNDS',
  message: 'Your wallet does not hold this amount.',
};
const KEY_REUSED = {
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This idempotency key was already used for a different transfer.',
};

interface Member {
  readonly id: string;
  readonly email: string;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
  readonly retryAfterSeconds?: number;
}

/** Refus applicatif levé par `action` — ou échec du test si elle aboutit, ou échoue autrement. */
async function refusalOf(action: () => Promise<unknown>): Promise<Refusal> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    return {
      code: error.code,
      message: error.message,
      ...(error.errors === undefined ? {} : { errors: error.errors }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  throw new Error('Expected the action to be refused.');
}

/**
 * Les transferts sont demandés au service, comme le fait la route ; les fonds de départ sont
 * déposés par le grand livre, les niveaux de vérification accordés en SQL. Chaque scénario crée
 * ses comptes : aucun ne dépend d'un autre.
 */
describe('Transferts entre titulaires — service (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let transfers: TransferService;
  let limits: TransferLimitsService;
  let repository: TransferRepository;
  let ledger: LedgerService;
  let reader: LedgerReader;
  let limiter: RedisRateLimiter;
  let passwordHash: string;
  /** Administrateur (rôle super_admin) : accepte les dossiers de vérification, fixe les plafonds. */
  let root: Member;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { DATABASE_POOL_MAX: '10' } });
    prisma = testApp.app.get(PrismaService);
    transfers = testApp.app.get(TransferService);
    limits = testApp.app.get(TransferLimitsService);
    repository = testApp.app.get(TransferRepository);
    ledger = testApp.app.get(LedgerService);
    reader = testApp.app.get(LedgerReader);
    limiter = testApp.app.get(RedisRateLimiter);
    passwordHash = await testApp.app.get(PasswordHasher).hash(PASSWORD);
    root = await createAdmin(testApp, { secondFactor: false });
    await asOwner(async (db) => {
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
      // En dollars — niveau 1 : 100 par transfert, 250 sur 24 heures, 1 000 sur 31 jours ;
      // niveau 2 : dix fois plus ; niveau 3 : refermé ; niveau 0 : aucun plafond.
      await setLimitInSql(db, 'USD', 1, [10_000, 25_000, 100_000]);
      await setLimitInSql(db, 'USD', 2, [100_000, 250_000, 1_000_000]);
      await setLimitInSql(db, 'USD', 3, [0, 0, 0]);
      // En bitcoins — niveau 2 seulement : un bitcoin.
      await setLimitInSql(db, 'BTC', 2, [100_000_000, 100_000_000, 100_000_000]);
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);

  // --- Comptes ---

  const custody = platformAccount('platform_custody');

  const deposit = (userId: string, amount: string, asset: Asset = USD): Promise<unknown> =>
    ledger.post({
      idempotencyKey: `test:${randomUUID()}`,
      kind: 'test.deposit',
      actor: SYSTEM,
      postings: [
        { account: custody, side: 'DEBIT', amount: Money.parse(amount, asset) },
        { account: userAccount(userId), side: 'CREDIT', amount: Money.parse(amount, asset) },
      ],
    });

  let sequence = 0;
  /** Un titulaire actif, au niveau de vérification voulu, crédité de `funds` dollars. */
  async function member(level: 0 | 1 | 2 | 3 = 1, funds: string | null = null): Promise<Member> {
    sequence += 1;
    const email = `transfer-service${String(sequence)}@example.cd`;
    const { id } = await prisma.user.create({
      data: {
        email,
        countryCode: 'CD',
        status: 'ACTIVE',
        registeredAt: testClock.now(),
        emailVerifiedAt: testClock.now(),
        credential: { create: { passwordHash } },
      },
      select: { id: true },
    });
    if (level > 0) {
      await asApp((db) => verifyUpTo(db, id, level, root.id));
    }
    if (funds !== null) {
      await deposit(id, funds);
    }
    return { id, email };
  }

  // --- Transferts ---

  const clientOf = (requestId = `test-${randomUUID()}`) => ({
    requestId,
    ipAddress: '198.51.100.7',
    userAgent: 'jest',
  });

  interface SendOptions {
    readonly key?: string;
    readonly assetCode?: string;
    readonly password?: string;
    readonly code?: string;
    readonly requestId?: string;
  }

  function send(
    sender: Member,
    to: Member | string,
    amount: string,
    options: SendOptions = {},
  ): Promise<TransferOutcome> {
    return transfers.create(
      { userId: sender.id, sessionId: randomUUID() },
      {
        recipientEmail: typeof to === 'string' ? to : to.email,
        assetCode: options.assetCode ?? 'USD',
        amount,
        currentPassword: options.password ?? PASSWORD,
        ...(options.code === undefined ? {} : { code: options.code }),
      },
      options.key ?? freshKey(),
      clientOf(options.requestId),
    );
  }

  // --- État ---

  /** Fonds disponibles d'un titulaire, en unités minimales. */
  const balanceOf = (holder: Member, assetCode = 'USD'): Promise<bigint> =>
    reader.availableBalance(prisma, holder.id, assetCode);
  const sentBy = (holder: Member): Promise<number> =>
    prisma.transfer.count({ where: { senderId: holder.id } });
  const auditOf = async (holder: Member, action: string) =>
    (
      await prisma.auditLog.findMany({
        where: { actorId: holder.id, action },
        orderBy: { id: 'asc' },
      })
    ).map(({ resourceType, resourceId, outcome, metadata }) => ({
      resourceType,
      resourceId,
      outcome,
      metadata,
    }));
  const eventsOf = (transferId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateType: 'transfer', aggregateId: transferId },
      orderBy: { id: 'asc' },
    });
  /** Tout ce qu'un transfert écrit : de quoi affirmer qu'un refus n'a rien écrit. */
  const written = async () => ({
    ledger: await asApp(ledgerSize),
    transfers: await prisma.transfer.count(),
    events: await prisma.outboxEvent.count({ where: { aggregateType: 'transfer' } }),
    created: await prisma.auditLog.count({ where: { action: 'transfer.created' } }),
  });

  /** Clôt un compte en SQL, dans la transaction ouverte de `db` — sans la valider. */
  async function closeWithin(db: pg.Client, userId: string): Promise<void> {
    await insertClosureRecord(db, userId);
    await emptyAccount(db, userId);
    await markAccountClosed(db, userId);
    await closeVerificationCases(db, userId);
  }

  /** Clôt un compte comme le fait son titulaire. */
  const close = (holder: Member): Promise<unknown> =>
    testApp.app
      .get(AccountClosureService)
      .closeOwn(
        { userId: holder.id, sessionId: randomUUID() },
        { currentPassword: PASSWORD, confirm: true },
        clientOf(),
      );

  // ---------------------------------------------------------------------------------------------
  describe('un transfert abouti', () => {
    it('déplace le montant, et rend le transfert tel que le voit son émetteur', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);

      const outcome = await send(alice, bob, '25.5');

      expect(outcome).toEqual({
        replayed: false,
        transfer: {
          id: expect.stringMatching(UUID),
          direction: 'SENT',
          asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
          amount: '25.50',
          counterparty: { email: bob.email },
          entryId: expect.stringMatching(UUID),
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        },
      });
      expect(await balanceOf(alice)).toBe(47_450n);
      expect(await balanceOf(bob)).toBe(2_550n);
    });

    it('écrit ensemble le transfert, son écriture, le journal d’audit et les deux événements', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();
      const before = new Date();

      const { transfer } = await send(alice, bob, '25.50', { key, requestId: 'request-0001' });

      const row = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
      expect({ ...row, amount: row.amount.toString(), requestDigest: row.requestDigest }).toEqual({
        id: transfer.id,
        senderId: alice.id,
        recipientId: bob.id,
        assetCode: 'USD',
        amount: '2550',
        entryId: transfer.entryId,
        idempotencyKey: key,
        requestDigest: expect.anything(),
        senderLevel: 1,
        createdAt: new Date(transfer.createdAt),
      });
      expect(
        Buffer.from(row.requestDigest).equals(
          requestDigest({ recipientEmail: bob.email, assetCode: 'USD', units: 2_550n }),
        ),
      ).toBe(true);
      // L'heure du transfert est celle de la base, pas celle de l'application.
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({
        where: { id: transfer.entryId },
        include: {
          postings: { orderBy: { lineNumber: 'asc' }, include: { account: true } },
        },
      });
      expect({
        idempotencyKey: entry.idempotencyKey,
        kind: entry.kind,
        postingCount: entry.postingCount,
        actorType: entry.actorType,
        actorId: entry.actorId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      }).toEqual({
        idempotencyKey: `transfer:${transfer.id}`,
        kind: 'transfer.internal',
        postingCount: 2,
        actorType: 'USER',
        actorId: alice.id,
        requestId: 'request-0001',
        metadata: { transferId: transfer.id },
      });
      expect(
        entry.postings.map(({ lineNumber, side, amount, assetCode, balanceAfter, account }) => ({
          lineNumber,
          side,
          amount: amount.toString(),
          assetCode,
          balanceAfter: balanceAfter.toString(),
          type: account.typeKey,
          holder: account.userId,
        })),
      ).toEqual([
        {
          lineNumber: 1,
          side: 'DEBIT',
          amount: '2550',
          assetCode: 'USD',
          balanceAfter: '47450',
          type: 'user_available',
          holder: alice.id,
        },
        {
          lineNumber: 2,
          side: 'CREDIT',
          amount: '2550',
          assetCode: 'USD',
          balanceAfter: '2550',
          type: 'user_available',
          holder: bob.id,
        },
      ]);

      expect(await auditOf(alice, 'transfer.created')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: transfer.id,
          outcome: 'SUCCESS',
          metadata: {
            assetCode: 'USD',
            amount: '25.50',
            recipientId: bob.id,
            senderLevel: 1,
            entryId: transfer.entryId,
          },
        },
      ]);
      const [inscription] = await prisma.auditLog.findMany({
        where: { actorId: alice.id, action: 'transfer.created' },
      });
      expect(inscription).toMatchObject({
        actorType: 'USER',
        requestId: 'request-0001',
        ipAddress: '198.51.100.7',
        userAgent: 'jest',
      });

      const events = await eventsOf(transfer.id);
      expect(
        events.map(({ eventType, payload, metadata }) => ({ eventType, payload, metadata })),
      ).toEqual([
        {
          eventType: 'transfer.notice_requested',
          payload: { transferId: transfer.id, party: 'SENDER' },
          metadata: { requestId: 'request-0001' },
        },
        {
          eventType: 'transfer.notice_requested',
          payload: { transferId: transfer.id, party: 'RECIPIENT' },
          metadata: { requestId: 'request-0001' },
        },
      ]);
    });

    it('chacune des deux parties le retrouve, dans son sens ; pour tout autre compte, il n’existe pas', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const carol = await member(1);
      const { transfer } = await send(alice, bob, '40.00');

      expect(await transfers.find(alice.id, transfer.id)).toEqual(transfer);
      expect(await transfers.find(bob.id, transfer.id)).toEqual({
        ...transfer,
        direction: 'RECEIVED',
        counterparty: { email: alice.email },
      });
      const NOT_FOUND = { code: 'NOT_FOUND', message: 'Transfer not found.' };
      expect(await refusalOf(() => transfers.find(carol.id, transfer.id))).toEqual(NOT_FOUND);
      expect(await refusalOf(() => transfers.find(alice.id, UNKNOWN_ID))).toEqual(NOT_FOUND);
    });

    it('à l’unité près, dans un actif à huit décimales', async () => {
      const alice = await member(2);
      const bob = await member(2);
      await deposit(alice.id, '0.5', BTC);

      const { transfer } = await send(alice, bob, '0.00000001', { assetCode: 'BTC' });

      expect(transfer).toMatchObject({
        amount: '0.00000001',
        asset: { code: 'BTC', kind: 'CRYPTO', scale: 8 },
      });
      expect(await balanceOf(alice, 'BTC')).toBe(49_999_999n);
      expect(await balanceOf(bob, 'BTC')).toBe(1n);
      // Les plafonds du niveau 2 : un bitcoin, par transfert comme sur 24 heures.
      expect(await refusalOf(() => send(alice, bob, '1.00000001', { assetCode: 'BTC' }))).toEqual(
        OVER_PER_TRANSFER,
      );
      expect(await refusalOf(() => send(alice, bob, '1', { assetCode: 'BTC' }))).toEqual(
        OVER_DAILY,
      );
      // Ce que les plafonds admettent encore, à l'unité près — mais Alice ne le détient pas.
      expect(await refusalOf(() => send(alice, bob, '0.99999999', { assetCode: 'BTC' }))).toEqual(
        INSUFFICIENT_FUNDS,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('preuve du titulaire', () => {
    it('un mot de passe erroné est refusé avant tout examen de la requête, et inscrit au journal', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const before = await written();

      for (const options of [{}, { assetCode: 'XXX' }] as const) {
        expect(
          await refusalOf(() =>
            send(alice, bob, '25.00', { ...options, password: 'not-mine-1234' }),
          ),
        ).toEqual({ code: 'INVALID_CREDENTIALS', message: 'The current password is incorrect.' });
      }

      expect(await auditOf(alice, 'transfer.proof_failed')).toEqual([
        {
          resourceType: 'user',
          resourceId: alice.id,
          outcome: 'FAILURE',
          metadata: { reason: 'WRONG_PASSWORD' },
        },
        {
          resourceType: 'user',
          resourceId: alice.id,
          outcome: 'FAILURE',
          metadata: { reason: 'WRONG_PASSWORD' },
        },
      ]);
      expect(await written()).toEqual(before);
      expect(await balanceOf(alice)).toBe(50_000n);
      // Aucun essai de transfert n'a été compté : la preuve n'était pas faite.
      expect(
        (await limiter.consume(`transfer-attempts:${alice.id}`, TRANSFER_ATTEMPTS_PER_ACCOUNT))
          .remaining,
      ).toBe(29);
    });

    it('sur un compte protégé, le second facteur est exigé en plus du mot de passe', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const secret = await enableSecondFactor(testApp, { id: alice.id, password: PASSWORD });

      expect(await refusalOf(() => send(alice, bob, '25.00'))).toEqual({
        code: 'UNPROCESSABLE_ENTITY',
        message:
          'Two-step verification is enabled on this account: provide "code" or "recoveryCode".',
      });
      expect(
        (await refusalOf(() => send(alice, bob, '25.00', { code: wrongTotpCode(secret) }))).code,
      ).toBe('INVALID_OR_EXPIRED_CODE');
      expect(await balanceOf(alice)).toBe(50_000n);

      const { transfer } = await send(alice, bob, '25.00', { code: nextTotpCode(secret) });
      expect(transfer.amount).toBe('25.00');
      expect(await balanceOf(alice)).toBe(47_500n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ce qu’une requête doit être', () => {
    it('un actif que la plateforme tient', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      expect(await refusalOf(() => send(alice, bob, '25.00', { assetCode: 'EUR' }))).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        errors: [{ path: 'assetCode', message: 'The platform does not keep this asset.' }],
      });
    });

    it('un montant à la précision de l’actif, strictement positif, que le grand livre sait tenir', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const refusedAmount = async (amount: string, assetCode = 'USD') =>
        (await refusalOf(() => send(alice, bob, amount, { assetCode }))).errors;

      // Rien n'est arrondi : un millième de dollar n'existe pas.
      for (const amount of ['25.001', '0.009', '100.0000001']) {
        expect({ amount, errors: await refusedAmount(amount) }).toEqual({
          amount,
          errors: [
            {
              path: 'amount',
              message: 'Must have at most 2 decimal places: the precision of USD.',
            },
          ],
        });
      }
      expect(await refusedAmount('0.000000001', 'BTC')).toEqual([
        { path: 'amount', message: 'Must have at most 8 decimal places: the precision of BTC.' },
      ]);
      for (const amount of ['0', '0.00', '0.000']) {
        expect({ amount, errors: await refusedAmount(amount) }).toEqual({
          amount,
          errors: [{ path: 'amount', message: 'Must be greater than zero.' }],
        });
      }
      // 10^38 unités : une de plus que ce que tient une colonne du grand livre.
      expect(await refusedAmount(`1${'0'.repeat(36)}`)).toEqual([
        { path: 'amount', message: 'Exceeds what the ledger can hold.' },
      ]);
      // Juste en dessous, le montant est examiné comme un autre : il dépasse le plafond.
      expect(await refusalOf(() => send(alice, bob, `${'9'.repeat(36)}.99`))).toEqual(
        OVER_PER_TRANSFER,
      );
      expect(await balanceOf(alice)).toBe(50_000n);
    });

    it('un autre compte que le sien', async () => {
      const alice = await member(1, '500.00');
      expect(await refusalOf(() => send(alice, alice, '25.00'))).toEqual({
        code: 'UNPROCESSABLE_ENTITY',
        message: 'You cannot transfer funds to your own account.',
      });
      expect(await balanceOf(alice)).toBe(50_000n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('plafonds du niveau de vérification', () => {
    it('un niveau sans plafond dans l’actif, ou aux plafonds nuls, n’envoie rien', async () => {
      const bob = await member(1);
      const unverified = await member(0, '500.00');
      const top = await member(3, '500.00');
      const first = await member(1, '500.00');
      await deposit(first.id, '0.5', BTC);

      expect(await refusalOf(() => send(unverified, bob, '1.00'))).toEqual(NOT_PERMITTED);
      expect(await refusalOf(() => send(top, bob, '1.00'))).toEqual(NOT_PERMITTED);
      // Les plafonds valent actif par actif : ceux du dollar n'ouvrent pas le bitcoin.
      expect(await refusalOf(() => send(first, bob, '0.1', { assetCode: 'BTC' }))).toEqual(
        NOT_PERMITTED,
      );

      expect(await auditOf(unverified, 'transfer.refused')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: null,
          outcome: 'DENIED',
          metadata: { reason: 'LEVEL_NOT_OPEN', assetCode: 'USD', amount: '1.00' },
        },
      ]);
      expect(await auditOf(first, 'transfer.refused')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: null,
          outcome: 'DENIED',
          metadata: { reason: 'LEVEL_NOT_OPEN', assetCode: 'BTC', amount: '0.10000000' },
        },
      ]);
    });

    it('par transfert : le plafond est inclus', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);

      expect(await refusalOf(() => send(alice, bob, '100.01'))).toEqual(OVER_PER_TRANSFER);
      expect(await auditOf(alice, 'transfer.refused')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: null,
          outcome: 'DENIED',
          metadata: {
            reason: 'LIMIT_EXCEEDED',
            limit: 'PER_TRANSFER',
            assetCode: 'USD',
            amount: '100.01',
          },
        },
      ]);
      await send(alice, bob, '100.00');
      expect(await balanceOf(bob)).toBe(10_000n);
    });

    it('sur 24 heures : ce qui a été envoyé compte, et le plafond s’atteint exactement', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      await send(alice, bob, '100.00');
      await send(alice, bob, '100.00');

      expect(await refusalOf(() => send(alice, bob, '50.01'))).toEqual(OVER_DAILY);
      await send(alice, bob, '50.00');
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(OVER_DAILY);

      expect((await auditOf(alice, 'transfer.refused')).map(({ metadata }) => metadata)).toEqual([
        { reason: 'LIMIT_EXCEEDED', limit: 'DAILY', assetCode: 'USD', amount: '50.01' },
        { reason: 'LIMIT_EXCEEDED', limit: 'DAILY', assetCode: 'USD', amount: '0.01' },
      ]);
      expect(await balanceOf(alice)).toBe(25_000n);
      expect(await balanceOf(bob)).toBe(25_000n);
    });

    it('sur 24 heures glissantes : un envoi de plus de 24 heures ne compte plus', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const first = await send(alice, bob, '100.00');
      const second = await send(alice, bob, '100.00');
      await send(alice, bob, '50.00');
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(OVER_DAILY);

      await asOwner(async (owner) => {
        await backdateTransfer(owner, first.transfer.id, '24 hours 1 minute');
        await backdateTransfer(owner, second.transfer.id, '23 hours 59 minutes');
      });
      // Le premier est sorti de la fenêtre : 150 comptés, 100 de nouveau possibles.
      expect(await refusalOf(() => send(alice, bob, '100.01'))).toEqual(OVER_PER_TRANSFER);
      await send(alice, bob, '100.00');
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(OVER_DAILY);
    });

    it('sur 31 jours glissants : le plafond s’atteint exactement', async () => {
      const alice = await member(1, '2000.00');
      const bob = await member(1);
      // Neuf envois de 100, vieux de deux à dix jours : 900 sur 31 jours, rien sur 24 heures.
      const sent: string[] = [];
      for (let day = 2; day <= 10; day += 1) {
        const { transfer } = await send(alice, bob, '100.00');
        await asOwner((owner) => backdateTransfer(owner, transfer.id, `${String(day * 24)} hours`));
        sent.push(transfer.id);
      }
      await send(alice, bob, '99.99');

      // Les plafonds par transfert et sur 24 heures l'admettraient : c'est celui des 31 jours.
      expect(await refusalOf(() => send(alice, bob, '0.02'))).toEqual(OVER_MONTHLY);
      expect((await auditOf(alice, 'transfer.refused')).map(({ metadata }) => metadata)).toEqual([
        { reason: 'LIMIT_EXCEEDED', limit: 'MONTHLY', assetCode: 'USD', amount: '0.02' },
      ]);
      await send(alice, bob, '0.01');
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(OVER_MONTHLY);

      // Le plus ancien — dix jours — sort de la fenêtre : 100 de nouveau possibles.
      await asOwner((owner) => backdateTransfer(owner, sent[8]!, '504 hours 1 minute'));
      await send(alice, bob, '100.00');
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(OVER_MONTHLY);
    });

    it('seuls comptent les envois : ce qu’un compte reçoit n’entame pas ses plafonds', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1, '500.00');
      await send(alice, bob, '100.00');
      await send(alice, bob, '100.00');
      await send(alice, bob, '50.00');

      // Bob a reçu 250 : il peut encore en envoyer 250.
      await send(bob, alice, '100.00');
      await send(bob, alice, '100.00');
      await send(bob, alice, '50.00');
      expect(await refusalOf(() => send(bob, alice, '0.01'))).toEqual(OVER_DAILY);
    });

    it('les plafonds appliqués sont ceux du niveau de l’émetteur, pas ceux du destinataire', async () => {
      const second = await member(2, '5000.00');
      const first = await member(1);

      // Dix fois le plafond par transfert du destinataire.
      const { transfer } = await send(second, first, '1000.00');
      expect(
        (await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } })).senderLevel,
      ).toBe(2);
      expect(await refusalOf(() => send(second, first, '1000.01'))).toEqual(OVER_PER_TRANSFER);
      expect(await balanceOf(first)).toBe(100_000n);
      // Le destinataire, lui, n'envoie qu'à hauteur des siens.
      expect(await refusalOf(() => send(first, second, '100.01'))).toEqual(OVER_PER_TRANSFER);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('fonds', () => {
    it('le portefeuille ne passe jamais sous zéro', async () => {
      const alice = await member(1, '30.00');
      const bob = await member(1);

      expect(await refusalOf(() => send(alice, bob, '30.01'))).toEqual(INSUFFICIENT_FUNDS);
      expect(await auditOf(alice, 'transfer.refused')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: null,
          outcome: 'DENIED',
          metadata: { reason: 'INSUFFICIENT_FUNDS', assetCode: 'USD', amount: '30.01' },
        },
      ]);
      await send(alice, bob, '30.00');
      expect(await balanceOf(alice)).toBe(0n);
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(INSUFFICIENT_FUNDS);
    });

    it('des fonds partis entre l’examen et l’écriture : le grand livre refuse, sous le verrou du compte', async () => {
      const alice = await member(1, '30.00');
      const bob = await member(1);
      const before = await written();

      // L'examen préalable lit le solde sans verrou : il a pu changer depuis. Ici, il a lu
      // davantage que ce que le compte détient.
      const reading = jest.spyOn(reader, 'availableBalance').mockResolvedValueOnce(5_000n);
      try {
        expect(await refusalOf(() => send(alice, bob, '30.01'))).toEqual(INSUFFICIENT_FUNDS);
        expect(reading).toHaveBeenCalledTimes(1);
      } finally {
        reading.mockRestore();
      }
      expect(await written()).toEqual(before);
      expect(await balanceOf(alice)).toBe(3_000n);
      expect((await auditOf(alice, 'transfer.refused')).map(({ metadata }) => metadata)).toEqual([
        { reason: 'INSUFFICIENT_FUNDS', assetCode: 'USD', amount: '30.01' },
      ]);
    });

    it('un compte qui n’a jamais rien détenu dans l’actif n’envoie rien', async () => {
      const alice = await member(1);
      const bob = await member(1);
      expect(await refusalOf(() => send(alice, bob, '0.01'))).toEqual(INSUFFICIENT_FUNDS);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('destinataire', () => {
    it('adresse inconnue, compte suspendu, jamais vérifié, clôturé, niveau fermé : un seul et même refus', async () => {
      const alice = await member(1, '500.00');
      const suspended = await member(1);
      await prisma.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });
      const pending = await member(0);
      await prisma.user.update({
        where: { id: pending.id },
        data: { status: 'PENDING_VERIFICATION', emailVerifiedAt: null },
      });
      const closed = await member(1);
      const closedEmail = closed.email;
      await close(closed);
      const unverified = await member(0);
      const top = await member(3);
      const before = await written();

      const refusals = [];
      for (const recipient of [
        'nobody@example.cd',
        suspended,
        pending,
        // L'adresse que portait le compte clôturé ne désigne plus personne.
        closedEmail,
        unverified,
        top,
      ]) {
        refusals.push(await refusalOf(() => send(alice, recipient, '25.00')));
      }

      expect(refusals).toEqual(Array.from({ length: 6 }, () => RECIPIENT_UNAVAILABLE));
      expect(await written()).toEqual(before);
      expect(await balanceOf(alice)).toBe(50_000n);
      // Le journal dit, lui, quel compte était désigné — s'il y en avait un — jamais l'adresse.
      const recorded = await auditOf(alice, 'transfer.refused');
      expect(recorded.map(({ metadata }) => metadata)).toEqual(
        [null, suspended.id, pending.id, null, unverified.id, top.id].map((recipientId) => ({
          reason: 'RECIPIENT_UNAVAILABLE',
          assetCode: 'USD',
          amount: '25.00',
          recipientId,
        })),
      );
      expect(JSON.stringify(recorded)).not.toContain('@');
    });

    it('le destinataire est examiné en dernier : après les plafonds, après les fonds', async () => {
      const poor = await member(1, '10.00');
      const unverified = await member(0, '10.00');

      // Rien de ce qui précède le destinataire ne dit si l'adresse a un compte.
      for (const recipient of ['nobody@example.cd', (await member(1)).email]) {
        expect(await refusalOf(() => send(unverified, recipient, '1.00'))).toEqual(NOT_PERMITTED);
        expect(await refusalOf(() => send(poor, recipient, '100.01'))).toEqual(OVER_PER_TRANSFER);
        expect(await refusalOf(() => send(poor, recipient, '10.01'))).toEqual(INSUFFICIENT_FUNDS);
      }
      // Ce n'est qu'avec un transfert par ailleurs possible que le destinataire compte.
      expect(await refusalOf(() => send(poor, 'nobody@example.cd', '10.00'))).toEqual(
        RECIPIENT_UNAVAILABLE,
      );
      expect(await balanceOf(poor)).toBe(1_000n);
    });

    it('recevoir suppose un niveau ouvert dans l’actif, quels qu’en soient les plafonds', async () => {
      const second = await member(2);
      const first = await member(1);
      await deposit(second.id, '0.5', BTC);

      // En bitcoins, seul le niveau 2 est ouvert.
      expect(await refusalOf(() => send(second, first, '0.1', { assetCode: 'BTC' }))).toEqual(
        RECIPIENT_UNAVAILABLE,
      );
      const peer = await member(2);
      await send(second, peer, '0.1', { assetCode: 'BTC' });
      expect(await balanceOf(peer, 'BTC')).toBe(10_000_000n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('émetteur', () => {
    it('un compte suspendu n’envoie rien, même avec le bon mot de passe', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      await prisma.user.update({ where: { id: alice.id }, data: { status: 'SUSPENDED' } });
      const before = await written();

      expect(await refusalOf(() => send(alice, bob, '25.00'))).toEqual({
        code: 'ACCOUNT_DISABLED',
        message: 'This account is disabled. Please contact support.',
      });
      expect(await written()).toEqual(before);
      expect(await auditOf(alice, 'transfer.refused')).toEqual([
        {
          resourceType: 'transfer',
          resourceId: null,
          outcome: 'DENIED',
          metadata: {
            reason: 'SENDER_NOT_ACTIVE',
            accountStatus: 'SUSPENDED',
            assetCode: 'USD',
            amount: '25.00',
          },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('clé d’idempotence', () => {
    it('la même requête sous la même clé ne transfère rien de plus : le transfert d’origine est rendu', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();
      const first = await send(alice, bob, '25.50', { key });
      const after = await written();

      // « 25.5 », « 25.50 », « 25.500 » : le même montant, donc la même requête.
      for (const amount of ['25.50', '25.5', '25.500']) {
        expect({ amount, outcome: await send(alice, bob, amount, { key }) }).toEqual({
          amount,
          outcome: { replayed: true, transfer: first.transfer },
        });
      }
      expect(first.replayed).toBe(false);
      expect(await written()).toEqual(after);
      expect(await balanceOf(alice)).toBe(47_450n);
      expect(await balanceOf(bob)).toBe(2_550n);
      expect(await sentBy(alice)).toBe(1);
      // Une requête rejouée n'est pas un essai de plus : un seul a été compté.
      expect(
        (await limiter.consume(`transfer-attempts:${alice.id}`, TRANSFER_ATTEMPTS_PER_ACCOUNT))
          .remaining,
      ).toBe(28);
    });

    it('une autre requête sous une clé déjà employée est refusée', async () => {
      const alice = await member(2, '500.00');
      const bob = await member(2);
      const carol = await member(2);
      await deposit(alice.id, '0.5', BTC);
      const key = freshKey();
      await send(alice, bob, '25.50', { key });
      const after = await written();

      expect(await refusalOf(() => send(alice, bob, '25.51', { key }))).toEqual(KEY_REUSED);
      expect(await refusalOf(() => send(alice, carol, '25.50', { key }))).toEqual(KEY_REUSED);
      expect(await refusalOf(() => send(alice, bob, '25.50', { key, assetCode: 'BTC' }))).toEqual(
        KEY_REUSED,
      );
      expect(await written()).toEqual(after);
      expect(await balanceOf(alice)).toBe(47_450n);
    });

    it('une clé n’a de sens que pour le compte qui la présente', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1, '500.00');
      const key = freshKey();

      const fromAlice = await send(alice, bob, '10.00', { key });
      const fromBob = await send(bob, alice, '10.00', { key });

      expect(fromBob.replayed).toBe(false);
      expect(fromBob.transfer.id).not.toBe(fromAlice.transfer.id);
      expect(await sentBy(bob)).toBe(1);
    });

    it('une requête refusée ne retient pas sa clé', async () => {
      const alice = await member(1, '10.00');
      const bob = await member(1);
      const key = freshKey();

      expect(await refusalOf(() => send(alice, bob, '25.00', { key }))).toEqual(INSUFFICIENT_FUNDS);
      expect(await refusalOf(() => send(alice, 'nobody@example.cd', '5.00', { key }))).toEqual(
        RECIPIENT_UNAVAILABLE,
      );
      await deposit(alice.id, '100.00');
      // La même clé, et la requête d'abord refusée : elle aboutit — une fois.
      const outcome = await send(alice, bob, '25.00', { key });
      expect(outcome.replayed).toBe(false);
      expect((await send(alice, bob, '25.00', { key })).replayed).toBe(true);
      expect(await balanceOf(alice)).toBe(8_500n);
    });

    it('rejouer exige la preuve du titulaire, comme transférer', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();
      await send(alice, bob, '25.00', { key });

      expect(
        (await refusalOf(() => send(alice, bob, '25.00', { key, password: 'not-mine-1234' }))).code,
      ).toBe('INVALID_CREDENTIALS');
    });

    it('le transfert d’origine est rendu même si, depuis, il ne serait plus possible', async () => {
      const alice = await member(1, '100.00');
      const bob = await member(1);
      const key = freshKey();
      const first = await send(alice, bob, '100.00', { key });

      // Plus de fonds ; puis plus de destinataire.
      expect(await balanceOf(alice)).toBe(0n);
      expect(await send(alice, bob, '100.00', { key })).toEqual({
        replayed: true,
        transfer: first.transfer,
      });
      // Les fonds reçus repartent, et le destinataire clôt son compte.
      const carol = await member(1);
      await send(bob, carol, '100.00');
      await close(bob);
      expect(await send(alice, bob, '100.00', { key })).toEqual({
        replayed: true,
        transfer: { ...first.transfer, counterparty: { email: null } },
      });
      expect(await sentBy(alice)).toBe(1);
    });

    it('huit requêtes identiques envoyées ensemble : un seul transfert, que toutes rendent', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => send(alice, bob, '60.00', { key })),
      );

      expect(new Set(outcomes.map(({ transfer }) => transfer.id)).size).toBe(1);
      expect(outcomes.filter(({ replayed }) => !replayed)).toHaveLength(1);
      expect(await sentBy(alice)).toBe(1);
      expect(await balanceOf(alice)).toBe(44_000n);
      expect(await balanceOf(bob)).toBe(6_000n);
      expect(await auditOf(alice, 'transfer.created')).toHaveLength(1);
      expect(await eventsOf(outcomes[0]!.transfer.id)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('transferts simultanés', () => {
    const settled = async (sending: readonly Promise<TransferOutcome>[]) => {
      const results = await Promise.allSettled(sending);
      const refusals: Refusal[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          refusals.push(await refusalOf(() => Promise.reject(result.reason as Error)));
        }
      }
      return {
        done: results.filter(({ status }) => status === 'fulfilled').length,
        refusals,
      };
    };

    it('six transferts du même émetteur, envoyés ensemble : les plafonds ne sont pas dépassés', async () => {
      const alice = await member(1, '1000.00');
      const recipients = await Promise.all(Array.from({ length: 6 }, () => member(1)));

      // 6 × 100 : le plafond des 24 heures en admet 250.
      const { done, refusals } = await settled(
        recipients.map((recipient) => send(alice, recipient, '100.00')),
      );

      expect(done).toBe(2);
      expect(refusals).toEqual(Array.from({ length: 4 }, () => OVER_DAILY));
      expect(await balanceOf(alice)).toBe(80_000n);
      expect(await asApp((db) => usageInSql(db, alice.id))).toEqual({
        last24Hours: '20000',
        last31Days: '20000',
      });
      const received = await Promise.all(recipients.map((recipient) => balanceOf(recipient)));
      expect(received.filter((balance) => balance === 10_000n)).toHaveLength(2);
      expect(received.filter((balance) => balance === 0n)).toHaveLength(4);
    });

    it('quatre transferts du même émetteur, envoyés ensemble : jamais plus que ses fonds', async () => {
      const alice = await member(1, '150.00');
      const recipients = await Promise.all(Array.from({ length: 4 }, () => member(1)));

      const { done, refusals } = await settled(
        recipients.map((recipient) => send(alice, recipient, '100.00')),
      );

      expect(done).toBe(1);
      expect(refusals).toEqual(Array.from({ length: 3 }, () => INSUFFICIENT_FUNDS));
      expect(await balanceOf(alice)).toBe(5_000n);
    });

    it('des transferts croisés, de l’un à l’autre et de l’autre à l’un : tous aboutissent', async () => {
      const alice = await member(2, '1000.00');
      const bob = await member(2, '1000.00');

      const { done, refusals } = await settled(
        Array.from({ length: 5 }, (_, index) => [
          send(alice, bob, `${String(index + 1)}0.00`),
          send(bob, alice, `${String(index + 1)}.00`),
        ]).flat(),
      );

      expect({ done, refusals }).toEqual({ done: 10, refusals: [] });
      // Alice a envoyé 150 et reçu 15 ; Bob, l'inverse.
      expect(await balanceOf(alice)).toBe(86_500n);
      expect(await balanceOf(bob)).toBe(113_500n);
    });

    it('six émetteurs vers le même destinataire, ensemble : tout arrive', async () => {
      const senders = await Promise.all(Array.from({ length: 6 }, () => member(1, '100.00')));
      const bob = await member(1);

      const { done, refusals } = await settled(senders.map((sender) => send(sender, bob, '70.00')));

      expect({ done, refusals }).toEqual({ done: 6, refusals: [] });
      expect(await balanceOf(bob)).toBe(42_000n);
    });

    it('un transfert attend la clôture en cours de son destinataire, puis est refusé', async () => {
      const alice = await member(1, '500.00');
      const leaving = await member(1);
      const before = await written();

      await asApp(async (closing) => {
        await asApp(async (observer) => {
          await closing.query('BEGIN');
          await closing.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [leaving.id]);

          const pending = refusalOf(() => send(alice, leaving, '25.00'));
          await untilBlocked(observer);
          await closeWithin(closing, leaving.id);
          await closing.query('COMMIT');

          expect(await pending).toEqual(RECIPIENT_UNAVAILABLE);
        });
      });
      expect(await written()).toEqual(before);
      expect(await balanceOf(alice)).toBe(50_000n);
      expect((await auditOf(alice, 'transfer.refused')).map(({ metadata }) => metadata)).toEqual([
        {
          reason: 'RECIPIENT_UNAVAILABLE',
          assetCode: 'USD',
          amount: '25.00',
          recipientId: leaving.id,
        },
      ]);
    });

    it('un transfert attend la clôture en cours de son émetteur, puis est refusé', async () => {
      const leaving = await member(1);
      const bob = await member(1);
      const before = await written();

      await asApp(async (closing) => {
        await asApp(async (observer) => {
          await closing.query('BEGIN');
          await closing.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [leaving.id]);

          const pending = refusalOf(() => send(leaving, bob, '25.00'));
          await untilBlocked(observer);
          await closeWithin(closing, leaving.id);
          await closing.query('COMMIT');

          // La réponse de toute écriture qui croise la clôture de son compte.
          expect(await pending).toEqual({ code: 'CONFLICT', message: 'This account is closed.' });
        });
      });
      expect(await written()).toEqual(before);
      expect((await auditOf(leaving, 'transfer.refused')).map(({ metadata }) => metadata)).toEqual([
        {
          reason: 'SENDER_NOT_ACTIVE',
          accountStatus: 'CLOSED',
          assetCode: 'USD',
          amount: '25.00',
        },
      ]);
    });

    it('un niveau retiré pendant la requête : la base refuse, rien n’est écrit, la requête se renvoie', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const { id: caseId } = await prisma.kycCase.findFirstOrThrow({
        where: { userId: alice.id, level: 1, status: 'APPROVED' },
        select: { id: true },
      });
      const before = await written();
      const key = freshKey();

      // Les contrôles de l'application sont passés ; le niveau est retiré juste avant l'écriture.
      const newId = repository.newId.bind(repository);
      const crossing = jest.spyOn(repository, 'newId').mockImplementationOnce(async (db) => {
        await asApp((other) => revoke(other, caseId, root.id));
        return newId(db);
      });
      try {
        expect(await refusalOf(() => send(alice, bob, '25.00', { key }))).toEqual({
          code: 'CONFLICT',
          message:
            'The transfer could not be completed because the account changed meanwhile. Please try again.',
        });
      } finally {
        crossing.mockRestore();
      }

      expect(await written()).toEqual(before);
      expect(await balanceOf(alice)).toBe(50_000n);
      // Renvoyée — sous la même clé, que le refus n'a pas retenue — elle est examinée dans
      // l'état nouveau : le niveau 0 n'a pas de plafond.
      expect(await refusalOf(() => send(alice, bob, '25.00', { key }))).toEqual(NOT_PERMITTED);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('bornes', () => {
    it('trente essais par heure et par compte, aboutis ou refusés', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const attempts = `transfer-attempts:${alice.id}`;

      await send(alice, bob, '10.00');
      expect((await refusalOf(() => send(alice, bob, '100.01'))).code).toBe(
        'TRANSFER_LIMIT_EXCEEDED',
      );
      // Deux essais comptés ; les vingt-huit suivants sont pris ici, sans rien transférer.
      for (let taken = 3; taken <= 30; taken += 1) {
        expect(await limiter.consume(attempts, TRANSFER_ATTEMPTS_PER_ACCOUNT)).toMatchObject({
          blocked: false,
          remaining: 30 - taken,
        });
      }
      const before = await written();

      const refused = await refusalOf(() => send(alice, bob, '10.00'));
      expect(refused).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many transfers attempted. Please try again later.',
        retryAfterSeconds: expect.any(Number),
      });
      expect(refused.retryAfterSeconds).toBeGreaterThan(3500);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(await written()).toEqual(before);
      expect(TRANSFER_ATTEMPTS_PER_ACCOUNT).toEqual({ limit: 30, windowMs: 3_600_000 });
    });

    it('dix destinataires refusés en 24 heures suspendent les transferts du compte', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();
      const first = await send(alice, bob, '10.00', { key });
      // Les autres refus ne sont pas comptés ici.
      expect(await refusalOf(() => send(alice, bob, '100.01'))).toEqual(OVER_PER_TRANSFER);

      for (let refusal = 1; refusal <= 10; refusal += 1) {
        expect({
          refusal,
          outcome: await refusalOf(() =>
            send(alice, `nobody${String(refusal)}@example.cd`, '10.00'),
          ),
        }).toEqual({ refusal, outcome: RECIPIENT_UNAVAILABLE });
      }

      // Même vers un destinataire qui peut recevoir.
      const refused = await refusalOf(() => send(alice, bob, '10.00'));
      expect(refused).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many transfers attempted. Please try again later.',
        retryAfterSeconds: expect.any(Number),
      });
      expect(refused.retryAfterSeconds).toBeGreaterThan(86_000);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(86_400);
      expect(await balanceOf(alice)).toBe(49_000n);
      // Un transfert déjà fait se retrouve toujours sous sa clé.
      expect(await send(alice, bob, '10.00', { key })).toEqual({ ...first, replayed: true });
      // Un autre compte n'est pas concerné.
      await deposit(bob.id, '50.00');
      await send(bob, alice, '10.00');
      expect(RECIPIENT_REFUSALS_PER_ACCOUNT).toEqual({ limit: 9, windowMs: 86_400_000 });
    });

    it('neuf destinataires refusés ne suspendent rien', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      for (let refusal = 1; refusal <= 9; refusal += 1) {
        await refusalOf(() => send(alice, `nobody${String(refusal)}@example.cd`, '10.00'));
      }
      await send(alice, bob, '10.00');
      expect(await balanceOf(bob)).toBe(1_000n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('consulter ses transferts', () => {
    it('envoyés et reçus, du plus récent au plus ancien, page par page', async () => {
      const alice = await member(2, '1000.00');
      const bob = await member(2, '1000.00');
      const carol = await member(2, '1000.00');
      const made = [
        await send(alice, bob, '1.00'),
        await send(bob, alice, '2.00'),
        await send(carol, alice, '3.00'),
        await send(alice, carol, '4.00'),
        await send(bob, carol, '5.00'),
        await send(alice, bob, '6.00'),
        await send(carol, alice, '7.00'),
      ].map(({ transfer }) => transfer);

      const all = await transfers.list(alice.id, { limit: 20 });
      expect(
        all.transfers.map(({ amount, direction, counterparty }) => ({
          amount,
          direction,
          counterparty: counterparty.email,
        })),
      ).toEqual([
        { amount: '7.00', direction: 'RECEIVED', counterparty: carol.email },
        { amount: '6.00', direction: 'SENT', counterparty: bob.email },
        { amount: '4.00', direction: 'SENT', counterparty: carol.email },
        { amount: '3.00', direction: 'RECEIVED', counterparty: carol.email },
        { amount: '2.00', direction: 'RECEIVED', counterparty: bob.email },
        { amount: '1.00', direction: 'SENT', counterparty: bob.email },
      ]);
      expect(all.nextCursor).toBeNull();
      // Le transfert de Bob à Carol n'y figure pas ; les identifiants sont ceux des transferts.
      expect(all.transfers.map(({ id }) => id)).toEqual(
        [made[6], made[5], made[3], made[2], made[1], made[0]].map((transfer) => transfer!.id),
      );

      // Page par page : rien n'est rendu deux fois, rien n'est omis.
      const pages = [];
      let after: string | undefined;
      do {
        const page = await transfers.list(alice.id, { limit: 4, ...(after ? { after } : {}) });
        pages.push(page.transfers.map(({ amount }) => amount));
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
      expect(pages).toEqual([
        ['7.00', '6.00', '4.00', '3.00'],
        ['2.00', '1.00'],
      ]);
      // Une page exactement pleine n'annonce pas de suite.
      const exact = await transfers.list(alice.id, { limit: 6 });
      expect(exact.transfers).toHaveLength(6);
      expect(exact.nextCursor).toBeNull();
      const short = await transfers.list(alice.id, { limit: 5 });
      expect(short.transfers).toHaveLength(5);
      expect(short.nextCursor).toEqual(expect.any(String));

      // Un compte sans transfert.
      expect(await transfers.list((await member(1)).id, { limit: 20 })).toEqual({
        transfers: [],
        nextCursor: null,
      });
    });

    it('l’adresse de l’autre partie est celle que porte son compte aujourd’hui ; `null` s’il est clôturé', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const { transfer } = await send(alice, bob, '25.00');
      const carol = await member(1);
      await send(bob, carol, '25.00');

      await prisma.user.update({ where: { id: bob.id }, data: { email: 'bob-moved@example.cd' } });
      expect((await transfers.find(alice.id, transfer.id)).counterparty).toEqual({
        email: 'bob-moved@example.cd',
      });

      await close({ ...bob, email: 'bob-moved@example.cd' });
      expect((await transfers.find(alice.id, transfer.id)).counterparty).toEqual({ email: null });
      expect((await transfers.list(alice.id, { limit: 20 })).transfers).toEqual([
        { ...transfer, counterparty: { email: null } },
      ]);
      // L'adresse factice d'un compte clôturé ne sort jamais.
      expect(JSON.stringify(await transfers.list(carol.id, { limit: 20 }))).not.toContain(
        'closed.invalid',
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ce que le titulaire peut envoyer', () => {
    const settings = () => testApp.app.get(SystemSettingsService);

    it('actif par actif : les plafonds de son niveau, ce qu’il a envoyé, ce qu’ils admettent encore', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);

      expect(await limits.allowancesOf(alice.id)).toEqual({
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
            asset: { code: 'CDF', name: 'Asset CDF', kind: 'FIAT', scale: 2 },
            limit: null,
            used: { last24Hours: '0.00', last31Days: '0.00' },
            remaining: '0.00',
          },
          {
            asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
            limit: { perTransfer: '100.00', daily: '250.00', monthly: '1000.00' },
            used: { last24Hours: '0.00', last31Days: '0.00' },
            remaining: '100.00',
          },
        ],
      });

      const first = await send(alice, bob, '100.00');
      await send(alice, bob, '90.00');
      const usd = async (holder: Member) =>
        (await limits.allowancesOf(holder.id)).allowances.find(({ asset }) => asset.code === 'USD');
      expect(await usd(alice)).toMatchObject({
        used: { last24Hours: '190.00', last31Days: '190.00' },
        remaining: '60.00',
      });
      // Ce qui est annoncé est admis, et pas un centime de plus.
      expect(await refusalOf(() => send(alice, bob, '60.01'))).toEqual(OVER_DAILY);
      await send(alice, bob, '60.00');
      expect(await usd(alice)).toMatchObject({
        used: { last24Hours: '250.00', last31Days: '250.00' },
        remaining: '0.00',
      });
      // Ce que Bob a reçu n'entame rien.
      expect(await usd(bob)).toMatchObject({
        used: { last24Hours: '0.00', last31Days: '0.00' },
        remaining: '100.00',
      });

      await asOwner((owner) => backdateTransfer(owner, first.transfer.id, '25 hours'));
      expect(await usd(alice)).toMatchObject({
        used: { last24Hours: '150.00', last31Days: '250.00' },
        remaining: '100.00',
      });
    });

    it('le niveau du compte, et ses plafonds, quel qu’il soit', async () => {
      const levels = [];
      for (const level of [0, 1, 2, 3] as const) {
        const holder = await member(level);
        const { allowances, level: read } = await limits.allowancesOf(holder.id);
        levels.push({
          level: read,
          usd: allowances.find(({ asset }) => asset.code === 'USD')?.limit,
          btc: allowances.find(({ asset }) => asset.code === 'BTC')?.limit,
        });
      }
      expect(levels).toEqual([
        { level: 0, usd: null, btc: null },
        {
          level: 1,
          usd: { perTransfer: '100.00', daily: '250.00', monthly: '1000.00' },
          btc: null,
        },
        {
          level: 2,
          usd: { perTransfer: '1000.00', daily: '2500.00', monthly: '10000.00' },
          btc: { perTransfer: '1.00000000', daily: '1.00000000', monthly: '1.00000000' },
        },
        // Des plafonds nuls : fixés, mais le niveau est refermé.
        { level: 3, usd: { perTransfer: '0.00', daily: '0.00', monthly: '0.00' }, btc: null },
      ]);
    });

    it('dit si les transferts sont ouverts', async () => {
      const alice = await member(1);
      const context = { actor: SYSTEM, reason: 'test: opening transfers' };
      expect((await limits.allowancesOf(alice.id)).enabled).toBe(false);
      await settings().setFeatureEnabled('internalTransfers', true, context);
      try {
        expect((await limits.allowancesOf(alice.id)).enabled).toBe(true);
      } finally {
        await settings().setFeatureEnabled('internalTransfers', false, context);
      }
      expect((await limits.allowancesOf(alice.id)).enabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('fixer des plafonds', () => {
    const actor = (staff: Member) => ({ userId: staff.id, client: clientOf('request-limits') });
    const cdf = (level: number) =>
      prisma.transferLimit.findUnique({
        where: { assetCode_kycLevel: { assetCode: 'CDF', kycLevel: level } },
      });
    const changes = async () =>
      (
        await prisma.auditLog.findMany({
          where: { action: 'transfer_limit.set' },
          orderBy: { id: 'asc' },
        })
      ).map(({ actorId, resourceType, resourceId, outcome, requestId, metadata }) => ({
        actorId,
        resourceType,
        resourceId,
        outcome,
        requestId,
        metadata,
      }));

    it('fixe, puis remplace, les plafonds d’un niveau dans un actif — et l’inscrit au journal', async () => {
      const before = new Date();
      const set = await limits.set(
        'CDF',
        1,
        { perTransfer: '50000', daily: '100000.5', monthly: '2000000.00', reason: REASON },
        actor(root),
      );

      expect(set).toEqual({
        asset: { code: 'CDF', name: 'Asset CDF', kind: 'FIAT', scale: 2 },
        level: 1,
        perTransfer: '50000.00',
        daily: '100000.50',
        monthly: '2000000.00',
        setBy: root.id,
        setAt: expect.any(String),
      });
      expect(new Date(set.setAt).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      const stored = await cdf(1);
      expect({
        per: stored?.perTransferMax.toString(),
        daily: stored?.dailyMax.toString(),
        monthly: stored?.monthlyMax.toString(),
        setBy: stored?.setBy,
        setAt: stored?.setAt.toISOString(),
      }).toEqual({
        per: '5000000',
        daily: '10000050',
        monthly: '200000000',
        setBy: root.id,
        setAt: set.setAt,
      });

      // Un autre administrateur les remplace : c'est lui que les plafonds nomment désormais.
      const successor = await createAdmin(testApp, { secondFactor: false });
      const replaced = await limits.set(
        'CDF',
        1,
        { perTransfer: '0', daily: '0', monthly: '0', reason: `${REASON} (retrait)` },
        actor(successor),
      );
      expect(replaced).toMatchObject({
        perTransfer: '0.00',
        daily: '0.00',
        monthly: '0.00',
        setBy: successor.id,
      });
      expect(new Date(replaced.setAt).getTime()).toBeGreaterThan(new Date(set.setAt).getTime());
      expect((await cdf(1))?.setBy).toBe(successor.id);
      expect(await prisma.transferLimit.count({ where: { assetCode: 'CDF' } })).toBe(1);

      expect(await changes()).toEqual([
        {
          actorId: root.id,
          resourceType: 'transfer_limit',
          resourceId: 'CDF:1',
          outcome: 'SUCCESS',
          requestId: 'request-limits',
          metadata: {
            assetCode: 'CDF',
            level: 1,
            before: null,
            after: { perTransfer: '50000.00', daily: '100000.50', monthly: '2000000.00' },
            reason: REASON,
          },
        },
        {
          actorId: successor.id,
          resourceType: 'transfer_limit',
          resourceId: 'CDF:1',
          outcome: 'SUCCESS',
          requestId: 'request-limits',
          metadata: {
            assetCode: 'CDF',
            level: 1,
            before: { perTransfer: '50000.00', daily: '100000.50', monthly: '2000000.00' },
            after: { perTransfer: '0.00', daily: '0.00', monthly: '0.00' },
            reason: `${REASON} (retrait)`,
          },
        },
      ]);
    });

    it('des montants à la précision de l’actif, croissants, que le grand livre sait tenir', async () => {
      const before = await changes();
      const refused = async (ceilings: Record<'perTransfer' | 'daily' | 'monthly', string>) =>
        refusalOf(() => limits.set('CDF', 2, { ...ceilings, reason: REASON }, actor(root)));
      const VALID = { perTransfer: '100', daily: '200', monthly: '300' };

      for (const field of ['perTransfer', 'daily', 'monthly'] as const) {
        expect({ field, refusal: await refused({ ...VALID, [field]: '150.001' }) }).toEqual({
          field,
          refusal: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed.',
            errors: [
              {
                path: field,
                message: 'Must have at most 2 decimal places: the precision of CDF.',
              },
            ],
          },
        });
        expect((await refused({ ...VALID, [field]: `1${'0'.repeat(36)}` })).errors).toEqual([
          { path: field, message: 'Exceeds what the ledger can hold.' },
        ]);
        expect((await refused({ ...VALID, [field]: '-1' })).errors).toEqual([
          { path: field, message: 'Must not be negative.' },
        ]);
      }
      expect(
        (await refused({ perTransfer: '200.01', daily: '200', monthly: '300' })).errors,
      ).toEqual([{ path: 'daily', message: 'Must be at least the limit per transfer.' }]);
      expect(
        (await refused({ perTransfer: '100', daily: '300.01', monthly: '300' })).errors,
      ).toEqual([{ path: 'monthly', message: 'Must be at least the limit over 24 hours.' }]);

      expect(await cdf(2)).toBeNull();
      expect(await changes()).toEqual(before);

      // Égaux, ou au plus grand montant que tient le grand livre : admis.
      const largest = `${'9'.repeat(36)}.99`;
      expect(
        await limits.set(
          'CDF',
          2,
          { perTransfer: '200', daily: '200', monthly: largest, reason: REASON },
          actor(root),
        ),
      ).toMatchObject({ perTransfer: '200.00', daily: '200.00', monthly: largest });
    });

    it('pour un actif que la plateforme tient', async () => {
      expect(
        await refusalOf(() =>
          limits.set(
            'EUR',
            1,
            { perTransfer: '1', daily: '2', monthly: '3', reason: REASON },
            actor(root),
          ),
        ),
      ).toEqual({ code: 'NOT_FOUND', message: 'Asset not found.' });
    });

    it('la base vérifie elle-même le droit de les fixer : sans lui, rien n’est écrit', async () => {
      const holder = await member(1);
      const before = await changes();

      expect(
        await refusalOf(() =>
          limits.set(
            'CDF',
            3,
            { perTransfer: '1', daily: '2', monthly: '3', reason: REASON },
            actor(holder),
          ),
        ),
      ).toEqual({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action.',
      });
      expect(await cdf(3)).toBeNull();
      // L'inscription au journal a été annulée avec le reste.
      expect(await changes()).toEqual(before);
    });

    it('prennent effet aussitôt, en envoi comme en réception', async () => {
      const alice = await member(1);
      const bob = await member(1);
      const asset = defineAsset('CDF', 2);
      await deposit(alice.id, '900000', asset);
      const sendFrancs = (from: Member, to: Member, amount: string) =>
        send(from, to, amount, { assetCode: 'CDF' });
      const setFrancs = (perTransfer: string, daily: string, monthly: string) =>
        limits.set('CDF', 1, { perTransfer, daily, monthly, reason: REASON }, actor(root));

      await setFrancs('0', '0', '0');
      expect(await refusalOf(() => sendFrancs(alice, bob, '1000'))).toEqual(NOT_PERMITTED);

      await setFrancs('5000', '8000', '8000');
      await sendFrancs(alice, bob, '5000');
      expect(await refusalOf(() => sendFrancs(alice, bob, '3000.01'))).toEqual(OVER_DAILY);

      // Relevés : ce qui a été envoyé reste compté sous les nouveaux plafonds.
      await setFrancs('5000', '10000', '10000');
      await sendFrancs(alice, bob, '5000');
      expect(await refusalOf(() => sendFrancs(alice, bob, '0.01'))).toEqual(OVER_DAILY);

      // Abaissés sous ce qui a déjà été envoyé : plus rien ne part, sans qu'il y ait d'erreur.
      await setFrancs('1000', '2000', '2000');
      expect(await refusalOf(() => sendFrancs(alice, bob, '0.01'))).toEqual(OVER_DAILY);
      expect(
        (await limits.allowancesOf(alice.id)).allowances.find(
          ({ asset: { code } }) => code === 'CDF',
        ),
      ).toMatchObject({
        limit: { perTransfer: '1000.00', daily: '2000.00', monthly: '2000.00' },
        used: { last24Hours: '10000.00', last31Days: '10000.00' },
        remaining: '0.00',
      });

      // Refermés : le niveau ne reçoit plus non plus. Un compte de niveau 2, ouvert en francs
      // par le scénario précédent, ne peut plus rien envoyer à Bob.
      await setFrancs('0', '0', '0');
      const second = await member(2);
      await deposit(second.id, '1000', asset);
      expect(await refusalOf(() => sendFrancs(second, bob, '100'))).toEqual(RECIPIENT_UNAVAILABLE);
    });

    it('la liste : tous les plafonds fixés, par actif puis par niveau — et sa consultation est inscrite', async () => {
      const { limits: listed } = await limits.list(actor(root));

      expect(
        listed.map(({ asset, level, perTransfer, setBy }) => ({
          asset: asset.code,
          level,
          perTransfer,
          setBy,
        })),
      ).toEqual([
        { asset: 'BTC', level: 2, perTransfer: '1.00000000', setBy: null },
        { asset: 'CDF', level: 1, perTransfer: '0.00', setBy: root.id },
        { asset: 'CDF', level: 2, perTransfer: '200.00', setBy: root.id },
        { asset: 'USD', level: 1, perTransfer: '100.00', setBy: null },
        { asset: 'USD', level: 2, perTransfer: '1000.00', setBy: null },
        { asset: 'USD', level: 3, perTransfer: '0.00', setBy: null },
      ]);
      expect(listed[3]).toEqual({
        asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
        level: 1,
        perTransfer: '100.00',
        daily: '250.00',
        monthly: '1000.00',
        setBy: null,
        setAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(await auditOf(root, 'transfer_limit.listed_by_admin')).toEqual([
        {
          resourceType: 'transfer_limit',
          resourceId: null,
          outcome: 'SUCCESS',
          metadata: { results: 6 },
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('messages aux deux parties', () => {
    const dispatcher = () => testApp.app.get(TransferNoticeDispatcher);
    const envelope = (payload: Record<string, unknown>) => ({
      id: randomUUID(),
      aggregateType: 'transfer',
      aggregateId: String(payload['transferId']),
      eventType: 'transfer.notice_requested',
      payload,
      metadata: {},
      occurredAt: new Date().toISOString(),
    });
    const received = (holder: Member) =>
      mailbox(testApp)
        .messagesFor(holder.email)
        .filter(({ template }) => template.startsWith('transfer_'));

    it('l’émetteur et le destinataire sont prévenus, chacun dans sa langue', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      await prisma.user.update({ where: { id: bob.id }, data: { locale: 'en' } });

      const { transfer } = await send(alice, bob, '25.50');
      const toSender = await nextMessageOf(testApp, alice.email, 'transfer_sent');
      const toRecipient = await nextMessageOf(testApp, bob.email, 'transfer_received');
      await backgroundWorkDone(testApp);

      const date = `${transfer.createdAt.slice(0, 10)} ${transfer.createdAt.slice(11, 16)} UTC`;
      expect(toSender).toMatchObject({
        channel: 'EMAIL',
        locale: 'fr',
        subject: 'MG-Exchange — transfert envoyé',
      });
      expect(toSender.text).toContain('Montant : 25.50 USD');
      expect(toSender.text).toContain(`Destinataire : ${bob.email}`);
      expect(toSender.text).toContain(`Date : ${date}`);
      expect(toRecipient).toMatchObject({
        channel: 'EMAIL',
        locale: 'en',
        subject: 'MG-Exchange — transfer received',
      });
      expect(toRecipient.text).toContain('Amount: 25.50 USD');
      expect(toRecipient.text).toContain(`Sender: ${alice.email}`);
      expect(toRecipient.text).toContain(`Date: ${date}`);
      // Un message chacun, et pas celui de l'autre.
      expect(received(alice).map(({ template }) => template)).toEqual(['transfer_sent']);
      expect(received(bob).map(({ template }) => template)).toEqual(['transfer_received']);
      expect((await eventsOf(transfer.id)).map(({ status }) => status)).toEqual([
        'PUBLISHED',
        'PUBLISHED',
      ]);
    });

    it('un transfert refusé, ou rejoué, ne prévient personne', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const key = freshKey();
      await send(alice, bob, '25.00', { key });
      await nextMessageOf(testApp, bob.email, 'transfer_received');
      await backgroundWorkDone(testApp);

      await send(alice, bob, '25.00', { key });
      await refusalOf(() => send(alice, bob, '100.01'));
      await backgroundWorkDone(testApp);

      expect(received(alice)).toHaveLength(1);
      expect(received(bob)).toHaveLength(1);
    });

    it('une partie dont le compte a été clôturé depuis n’est plus prévenue ; l’autre l’est, sans son adresse', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const { transfer } = await send(alice, bob, '25.00');
      await nextMessageOf(testApp, alice.email, 'transfer_sent');
      await nextMessageOf(testApp, bob.email, 'transfer_received');
      await backgroundWorkDone(testApp);
      const carol = await member(1);
      await send(bob, carol, '25.00');
      await close(bob);
      await backgroundWorkDone(testApp);
      const before = { alice: received(alice).length, bob: received(bob).length };
      // Un compte clôturé ne porte plus qu'une adresse factice, qui n'est celle de personne.
      const { email: placeholder } = await prisma.user.findUniqueOrThrow({
        where: { id: bob.id },
        select: { email: true },
      });
      expect(placeholder).not.toBe(bob.email);

      // L'événement est présenté à nouveau — la remise est « au moins une fois ».
      await dispatcher().handle(envelope({ transferId: transfer.id, party: 'RECIPIENT' }));
      await dispatcher().handle(envelope({ transferId: transfer.id, party: 'SENDER' }));

      // Rien n'est adressé au compte clôturé : ni à son ancienne adresse, ni à l'adresse factice.
      expect(received(bob)).toHaveLength(before.bob);
      expect(mailbox(testApp).messagesFor(placeholder)).toHaveLength(0);
      expect(received(alice)).toHaveLength(before.alice + 1);
      const [latest] = received(alice);
      expect(latest?.text).toContain('Destinataire : un compte clôturé depuis');
      expect(latest?.text).not.toContain('closed.invalid');
      expect(latest?.text).not.toContain(bob.email);
    });

    it('sans moyen de remise configuré, l’événement est abandonné plutôt que retenté', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1);
      const { transfer } = await send(alice, bob, '25.00');
      await nextMessageOf(testApp, alice.email, 'transfer_sent');
      await backgroundWorkDone(testApp);
      const before = received(alice).length;

      const notifications = testApp.app.get(NotificationService);
      const delivery = jest.spyOn(notifications, 'canDeliver').mockReturnValue(false);
      try {
        await expect(
          dispatcher().handle(envelope({ transferId: transfer.id, party: 'SENDER' })),
        ).resolves.toBeUndefined();
        expect(delivery).toHaveBeenCalledWith('EMAIL');
      } finally {
        delivery.mockRestore();
      }
      expect(received(alice)).toHaveLength(before);
    });

    it('un événement sans transfert est abandonné ; un événement malformé est une erreur', async () => {
      await expect(
        dispatcher().handle(envelope({ transferId: UNKNOWN_ID, party: 'SENDER' })),
      ).resolves.toBeUndefined();
      for (const payload of [
        { transferId: UNKNOWN_ID, party: 'WITNESS' },
        { transferId: 'not-an-id', party: 'SENDER' },
        { party: 'SENDER' },
      ]) {
        await expect(dispatcher().handle(envelope(payload))).rejects.toThrow();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('copie des données et clôture', () => {
    const data = () => testApp.app.get(TransferAccountData);

    it('la copie des données contient les transferts envoyés et reçus, du plus récent au plus ancien', async () => {
      const alice = await member(1, '500.00');
      const bob = await member(1, '500.00');
      const sent = await send(alice, bob, '25.00');
      const back = await send(bob, alice, '5.00');

      expect(await data().exportData(prisma, alice.id)).toEqual({
        transfers: {
          items: [
            { ...back.transfer, direction: 'RECEIVED', counterparty: { email: bob.email } },
            sent.transfer,
          ],
          truncated: false,
        },
      });
      expect(await data().exportData(prisma, (await member(1)).id)).toEqual({
        transfers: { items: [], truncated: false },
      });
    });

    it('au-delà de 2 000 transferts, la copie garde les plus récents et se dit incomplète', async () => {
      const alice = await member(2);
      const bob = await member(2);
      await deposit(alice.id, '100.00');
      const [aliceAccount, bobAccount] = await asApp(async (db) => [
        await openLedgerAccount(db, 'user_available', 'USD', alice.id),
        await openLedgerAccount(db, 'user_available', 'USD', bob.id),
      ]);
      const writeMany = (count: number, amount: number) =>
        asApp(async (db) => {
          await db.query('BEGIN');
          for (let index = 0; index < count; index += 1) {
            await writeTransfer(db, {
              sender: alice.id,
              senderAccount: aliceAccount,
              recipient: bob.id,
              recipientAccount: bobAccount,
              amount,
              level: 2,
            });
          }
          await db.query('COMMIT');
        });

      await writeMany(1, 7);
      await writeMany(1999, 1);
      const complete = (await data().exportData(prisma, alice.id)).transfers;
      expect(complete?.truncated).toBe(false);
      expect(complete?.items).toHaveLength(2000);
      expect(complete?.items.at(-1)).toMatchObject({ amount: '0.07', direction: 'SENT' });

      // Un transfert de plus : le plus ancien sort de la copie.
      const latest = await send(alice, bob, '3.00');
      const truncated = (await data().exportData(prisma, alice.id)).transfers;
      expect(truncated?.truncated).toBe(true);
      expect(truncated?.items).toHaveLength(2000);
      expect(truncated?.items[0]).toEqual(latest.transfer);
      expect(truncated?.items.at(-1)).toMatchObject({ amount: '0.01' });
      expect(DATA_EXPORT_TRANSFERS_MAX_ENTRIES).toBe(2000);
    }, 120_000);

    it('des transferts ne retiennent pas la clôture ; ils demeurent, et l’autre partie les garde', async () => {
      const alice = await member(1, '100.00');
      const bob = await member(1);
      const { transfer } = await send(alice, bob, '100.00');
      expect(await data().closureBlockers()).toEqual([]);

      await close(alice);

      expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).status).toBe(
        'CLOSED',
      );
      expect(await sentBy(alice)).toBe(1);
      expect(await transfers.find(bob.id, transfer.id)).toEqual({
        ...transfer,
        direction: 'RECEIVED',
        counterparty: { email: null },
      });
      // La trace de la clôture garde l'adresse dix ans : une écriture a été passée sur le compte.
      const closure = await prisma.accountClosure.findUniqueOrThrow({
        where: { userId: alice.id },
      });
      expect(closure.legalRetentionUntil).not.toBeNull();
      // Bob garde ses fonds, et peut les envoyer à son tour.
      await send(bob, await member(1), '40.00');
      expect(await balanceOf(bob)).toBe(6_000n);
    });

    it('des fonds restants retiennent la clôture : il faut d’abord les envoyer', async () => {
      const alice = await member(1, '60.00');
      const bob = await member(1);

      const refused = await refusalOf(() => close(alice));
      expect(refused.code).toBe('CONFLICT');
      await send(alice, bob, '60.00');
      await close(alice);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).status).toBe(
        'CLOSED',
      );
    });
  });
});
