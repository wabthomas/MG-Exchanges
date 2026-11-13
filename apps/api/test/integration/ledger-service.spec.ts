import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { DATA_EXPORT_MOVEMENTS_MAX_ENTRIES } from '@mgx/contracts';
import { type Asset, defineAsset, Money } from '@mgx/shared';
import type pg from 'pg';

import { AppError } from '../../src/common/errors/app-error.js';
import { sqlStateOf } from '../../src/infrastructure/database/database-errors.js';
import { type DbClient, PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { AuditService } from '../../src/modules/audit/application/audit.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { LedgerAccountData } from '../../src/modules/ledger/application/ledger-account-data.js';
import { LedgerAdministrationService } from '../../src/modules/ledger/application/ledger-administration.service.js';
import {
  LEDGER_VERIFICATION_MAX_ANOMALIES,
  LedgerVerification,
  LedgerVerificationError,
} from '../../src/modules/ledger/application/ledger-verification.js';
import {
  type LedgerAnomaly,
  LedgerRepository,
} from '../../src/modules/ledger/application/ledger.repository.js';
import { LedgerService } from '../../src/modules/ledger/application/ledger.service.js';
import type {
  JournalEntryDraft,
  PostedEntry,
  PostingDraft,
} from '../../src/modules/ledger/domain/journal-entry.js';
import { platformAccount, userAccount } from '../../src/modules/ledger/domain/ledger-account.js';
import {
  AssetDefinitionMismatchError,
  HolderClosedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerIntegrityError,
  LedgerRuleError,
  UnknownAssetError,
} from '../../src/modules/ledger/domain/ledger-errors.js';
import {
  closeAccountInSql,
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
} from '../support/account-closure.js';
import { createAdmin } from '../support/identity.js';
import {
  insertEntryHeader,
  insertPostings,
  ledgerSize,
  openLedgerAccount,
  registerAssetInSql,
  tamperWithLedger,
} from '../support/ledger-sql.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';
import { sqlState, untilBlocked, withConnection } from '../support/test-database.js';

const USD = defineAsset('USD', 2);
const CDF = defineAsset('CDF', 2);
const BTC = defineAsset('BTC', 8);
const SYSTEM = { type: 'SYSTEM' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

const usd = (amount: string): Money => Money.parse(amount, USD);
const newKey = (): string => `test:${randomUUID()}`;

/** Erreur levée par `action`, ou échec du test si elle n'en lève aucune. */
async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to be refused.');
}

/** Résout `promise`, ou échoue si elle n'a pas abouti après `ms` millisecondes. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Still pending after ${String(ms)} ms.`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Grand livre — passer des écritures (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let repository: LedgerRepository;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { DATABASE_POOL_MAX: '10' } });
    prisma = testApp.app.get(PrismaService);
    ledger = testApp.app.get(LedgerService);
    repository = testApp.app.get(LedgerRepository);
    unitOfWork = testApp.app.get(UnitOfWork);
    await asOwner(async (db) => {
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);

  let sequence = 0;
  async function createUser(
    status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ): Promise<string> {
    sequence += 1;
    const user = await prisma.user.create({
      data: {
        email: `ledger-service${String(sequence)}@example.cd`,
        countryCode: 'CD',
        status,
        registeredAt: testClock.now(),
        emailVerifiedAt: status === 'PENDING_VERIFICATION' ? null : testClock.now(),
      },
      select: { id: true },
    });
    return user.id;
  }

  const custody = platformAccount('platform_custody');
  const fees = platformAccount('platform_fees');

  function depositDraft(userId: string, amount: Money, key = newKey()): JournalEntryDraft {
    return {
      idempotencyKey: key,
      kind: 'test.deposit',
      actor: SYSTEM,
      postings: [
        { account: custody, side: 'DEBIT', amount },
        { account: userAccount(userId), side: 'CREDIT', amount },
      ],
    };
  }

  function transferDraft(
    from: string,
    to: string,
    amount: Money,
    key = newKey(),
  ): JournalEntryDraft {
    return {
      idempotencyKey: key,
      kind: 'test.transfer',
      actor: { type: 'USER', id: from },
      postings: [
        { account: userAccount(from), side: 'DEBIT', amount },
        { account: userAccount(to), side: 'CREDIT', amount },
      ],
    };
  }

  /** Un titulaire actif, crédité de `amount` dollars. */
  async function holderWith(amount: string): Promise<string> {
    const user = await createUser();
    if (amount !== '0.00') {
      await ledger.post(depositDraft(user, usd(amount)));
    }
    return user;
  }

  /** Solde, en unités minimales, du portefeuille d'un titulaire ; `null` si le compte n'existe pas. */
  async function balanceOf(userId: string, asset: Asset = USD): Promise<string | null> {
    const rows = await prisma.$queryRaw<{ balance: string }[]>`
      SELECT balance::text AS balance FROM ledger_accounts
      WHERE user_id = ${userId}::uuid AND asset_code = ${asset.code}
        AND type_key = 'user_available'`;
    return rows[0]?.balance ?? null;
  }

  /** Solde, en unités minimales, d'un compte de la plateforme ; zéro s'il n'est pas ouvert. */
  async function platformBalanceOf(
    type: 'platform_custody' | 'platform_fees',
    asset: Asset = USD,
  ): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ balance: string }[]>`
      SELECT balance::text AS balance FROM ledger_accounts
      WHERE user_id IS NULL AND asset_code = ${asset.code} AND type_key = ${type}`;
    return BigInt(rows[0]?.balance ?? '0');
  }

  async function platformAccountIdOf(
    type: 'platform_custody' | 'platform_fees',
    asset: Asset = USD,
  ): Promise<string> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM ledger_accounts
      WHERE user_id IS NULL AND asset_code = ${asset.code} AND type_key = ${type}`;
    return rows[0]!.id;
  }

  async function accountIdOf(userId: string, asset: Asset = USD): Promise<string> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM ledger_accounts
      WHERE user_id = ${userId}::uuid AND asset_code = ${asset.code}
        AND type_key = 'user_available'`;
    return rows[0]!.id;
  }

  const size = (): Promise<{ entries: number; postings: number }> => asApp(ledgerSize);
  const anomalies = (limit = 100): Promise<LedgerAnomaly[]> =>
    repository.findAnomalies(prisma, limit);

  describe('passer une écriture', () => {
    it('un dépôt ouvre les comptes qu’il désigne, et rend l’écriture telle que la base la conserve', async () => {
      const user = await createUser();
      expect(await balanceOf(user)).toBeNull();
      const before = Date.now();

      const posted = await ledger.post({
        idempotencyKey: 'deposit:first-one',
        kind: 'test.deposit',
        actor: { type: 'SERVICE', id: 'bank-x' },
        requestId: 'request-0001',
        metadata: { depositId: 'dep_42', attempt: 1, confirmed: true, note: null },
        postings: [
          { account: custody, side: 'DEBIT', amount: usd('125.50') },
          { account: userAccount(user), side: 'CREDIT', amount: usd('125.50') },
        ],
      });

      expect(posted).toEqual({
        id: expect.stringMatching(UUID),
        kind: 'test.deposit',
        postedAt: expect.any(Date),
        replayed: false,
        postings: [
          {
            id: expect.stringMatching(UUID),
            lineNumber: 1,
            accountId: expect.stringMatching(UUID),
            account: custody,
            side: 'DEBIT',
            amount: usd('125.50'),
            balanceAfter: expect.any(Money),
          },
          {
            id: expect.stringMatching(UUID),
            lineNumber: 2,
            accountId: await accountIdOf(user),
            account: userAccount(user),
            side: 'CREDIT',
            amount: usd('125.50'),
            balanceAfter: usd('125.50'),
          },
        ],
      });
      expect(Math.abs(posted.postedAt.getTime() - before)).toBeLessThan(60_000);
      expect(await balanceOf(user)).toBe('12550');

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: posted.id } });
      expect(entry).toMatchObject({
        idempotencyKey: 'deposit:first-one',
        kind: 'test.deposit',
        postingCount: 2,
        actorType: 'SERVICE',
        actorId: 'bank-x',
        requestId: 'request-0001',
        metadata: { depositId: 'dep_42', attempt: 1, confirmed: true, note: null },
        postedAt: posted.postedAt,
      });
      // Les lignes, lues en texte : aucun montant ne passe par un nombre.
      const lines = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT id::text AS id, line_number AS line, account_id::text AS account,
               asset_code AS asset, side::text AS side, amount::text AS amount,
               account_sequence::text AS sequence, balance_after::text AS "balanceAfter"
        FROM ledger_postings WHERE entry_id = ${posted.id}::uuid ORDER BY line_number`;
      expect(lines).toEqual([
        {
          id: posted.postings[0]!.id,
          line: 1,
          account: posted.postings[0]!.accountId,
          asset: 'USD',
          side: 'DEBIT',
          amount: '12550',
          sequence: expect.stringMatching(/^[1-9][0-9]*$/),
          balanceAfter: posted.postings[0]!.balanceAfter.units.toString(),
        },
        {
          id: posted.postings[1]!.id,
          line: 2,
          account: posted.postings[1]!.accountId,
          asset: 'USD',
          side: 'CREDIT',
          amount: '12550',
          sequence: '1',
          balanceAfter: '12550',
        },
      ]);

      // Les comptes ont été ouverts avec le sens de leur type.
      const accounts = await prisma.ledgerAccount.findMany({
        where: { id: { in: posted.postings.map(({ accountId }) => accountId) } },
        orderBy: { typeKey: 'asc' },
      });
      expect(
        accounts.map((account) => ({
          type: account.typeKey,
          user: account.userId,
          asset: account.assetCode,
          side: account.normalSide,
        })),
      ).toEqual([
        { type: 'platform_custody', user: null, asset: 'USD', side: 'DEBIT' },
        { type: 'user_available', user, asset: 'USD', side: 'CREDIT' },
      ]);
    });

    it('un transfert avec frais : chaque solde rendu est celui que la ligne a laissé', async () => {
      const alice = await holderWith('100.00');
      const bob = await holderWith('5.00');
      const earned = await platformBalanceOf('platform_fees');

      const posted = await ledger.post({
        idempotencyKey: newKey(),
        kind: 'test.transfer',
        actor: { type: 'USER', id: alice },
        postings: [
          { account: userAccount(alice), side: 'DEBIT', amount: usd('30.00') },
          { account: userAccount(bob), side: 'CREDIT', amount: usd('30.00') },
          { account: userAccount(alice), side: 'DEBIT', amount: usd('0.45') },
          { account: fees, side: 'CREDIT', amount: usd('0.45') },
        ],
      });

      expect(posted.postings.map((line) => line.balanceAfter.toDecimalString())).toEqual([
        '70.00',
        '35.00',
        '69.55',
        Money.ofUnits(earned + 45n, USD).toDecimalString(),
      ]);
      expect(posted.postings.map((line) => line.lineNumber)).toEqual([1, 2, 3, 4]);
      expect(posted.postings[0]!.accountId).toBe(posted.postings[2]!.accountId);
      expect(await balanceOf(alice)).toBe('6955');
      expect(await balanceOf(bob)).toBe('3500');
      expect(await anomalies()).toEqual([]);
    });

    it('plusieurs actifs dans une écriture, chacun dans son nombre de décimales', async () => {
      const user = await createUser();
      const posted = await ledger.post({
        idempotencyKey: newKey(),
        kind: 'test.deposit',
        actor: SYSTEM,
        postings: [
          { account: custody, side: 'DEBIT', amount: Money.parse('2850.00', CDF) },
          { account: userAccount(user), side: 'CREDIT', amount: Money.parse('2850.00', CDF) },
          { account: custody, side: 'DEBIT', amount: Money.parse('0.00012345', BTC) },
          { account: userAccount(user), side: 'CREDIT', amount: Money.parse('0.00012345', BTC) },
        ],
      });
      expect(posted.postings[1]!.balanceAfter).toEqual(Money.parse('2850.00', CDF));
      expect(posted.postings[3]!.balanceAfter).toEqual(Money.parse('0.00012345', BTC));
      expect(await balanceOf(user, CDF)).toBe('285000');
      expect(await balanceOf(user, BTC)).toBe('12345');
      expect(await balanceOf(user, USD)).toBeNull();
    });

    it('un titulaire suspendu garde ses comptes : on peut encore y passer une écriture', async () => {
      const suspended = await createUser('SUSPENDED');
      await ledger.post(depositDraft(suspended, usd('1.00')));
      expect(await balanceOf(suspended)).toBe('100');
    });
  });

  describe('refus décidés avant toute écriture', () => {
    it('une écriture mal formée n’ouvre pas de transaction', async () => {
      const alice = await holderWith('10.00');
      const bob = await createUser();
      const before = await size();
      const run = jest.spyOn(unitOfWork, 'run');
      try {
        const unbalanced: JournalEntryDraft = {
          ...transferDraft(alice, bob, usd('1.00')),
          postings: [
            { account: userAccount(alice), side: 'DEBIT', amount: usd('1.00') },
            { account: userAccount(bob), side: 'CREDIT', amount: usd('0.99') },
          ],
        };
        const error = await errorOf(() => ledger.post(unbalanced));
        expect(error).toBeInstanceOf(LedgerRuleError);
        expect((error as LedgerRuleError).code).toBe('UNBALANCED');
        expect(run).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
      }
      expect(await size()).toEqual(before);
      expect(await balanceOf(bob)).toBeNull();
      // Dans la transaction d'un appelant, même refus, avant toute requête.
      await unitOfWork.run(async (tx) => {
        const error = await errorOf(() =>
          ledger.postWithin(tx, { ...transferDraft(alice, bob, usd('1.00')), kind: 'Bad Kind' }),
        );
        expect((error as LedgerRuleError).code).toBe('INVALID_KIND');
      });
    });

    it('un actif que le grand livre ne tient pas, ou présenté avec un autre nombre de décimales', async () => {
      const user = await createUser();
      const before = await size();
      const unknown = await errorOf(() =>
        ledger.post(depositDraft(user, Money.parse('1.00', defineAsset('EUR', 2)))),
      );
      expect(unknown).toBeInstanceOf(UnknownAssetError);
      expect((unknown as UnknownAssetError).assetCode).toBe('EUR');

      // « 1.000 » dollar à trois décimales : mille unités, qui vaudraient dix dollars.
      const mismatch = await errorOf(() =>
        ledger.post(depositDraft(user, Money.parse('1.000', defineAsset('USD', 3)))),
      );
      expect(mismatch).toBeInstanceOf(AssetDefinitionMismatchError);
      expect((mismatch as AssetDefinitionMismatchError).assetCode).toBe('USD');
      const satoshis = await errorOf(() =>
        ledger.post(depositDraft(user, Money.parse('1.00', defineAsset('BTC', 2)))),
      );
      expect(satoshis).toBeInstanceOf(AssetDefinitionMismatchError);

      expect(await size()).toEqual(before);
      expect(await balanceOf(user)).toBeNull();
      expect(await balanceOf(user, BTC)).toBeNull();
    });

    it('des fonds insuffisants : l’erreur désigne le compte, et rien n’est écrit — pas même un compte ouvert', async () => {
      const alice = await holderWith('10.00');
      const bob = await createUser();
      const before = await size();

      const error = await errorOf(() => ledger.post(transferDraft(alice, bob, usd('10.01'))));
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).account).toEqual({
        type: 'user_available',
        assetCode: 'USD',
        userId: alice,
      });
      // Le message ne dit ni le solde, ni le montant.
      expect((error as Error).message).toBe(
        'Insufficient funds on the user_available account in USD.',
      );

      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1000');
      expect(await balanceOf(bob)).toBeNull();
      // Jusqu'au dernier centime : accepté.
      await ledger.post(transferDraft(alice, bob, usd('10.00')));
      expect(await balanceOf(alice)).toBe('0');
      expect(await balanceOf(bob)).toBe('1000');
    });

    it('un compte qui n’existe pas encore ne détient rien', async () => {
      const alice = await createUser();
      const bob = await createUser();
      const error = await errorOf(() => ledger.post(transferDraft(alice, bob, usd('0.01'))));
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).account?.userId).toBe(alice);
      expect(await balanceOf(alice)).toBeNull();
    });

    it('le contrôle se fait ligne après ligne, comme dans la base : un découvert passager est refusé', async () => {
      const alice = await holderWith('1.00');
      const bob = await holderWith('5.00');
      const there: PostingDraft[] = [
        { account: userAccount(alice), side: 'DEBIT', amount: usd('3.00') },
        { account: userAccount(bob), side: 'CREDIT', amount: usd('3.00') },
      ];
      const back: PostingDraft[] = [
        { account: userAccount(bob), side: 'DEBIT', amount: usd('3.00') },
        { account: userAccount(alice), side: 'CREDIT', amount: usd('3.00') },
      ];
      const draft = (postings: PostingDraft[]): JournalEntryDraft => ({
        idempotencyKey: newKey(),
        kind: 'test.swap',
        actor: SYSTEM,
        postings,
      });

      const error = await errorOf(() => ledger.post(draft([...there, ...back])));
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).account?.userId).toBe(alice);

      const posted = await ledger.post(draft([...back, ...there]));
      expect(posted.postings.map((line) => line.balanceAfter.toDecimalString())).toEqual([
        '2.00',
        '4.00',
        '1.00',
        '5.00',
      ]);
    });

    it('la plateforme non plus ne rend pas ce qu’elle ne conserve pas', async () => {
      const user = await createUser();
      // Un satoshi de plus que ce qu'elle conserve.
      const tooMuch = Money.ofUnits((await platformBalanceOf('platform_custody', BTC)) + 1n, BTC);
      const error = await errorOf(() =>
        ledger.post({
          idempotencyKey: newKey(),
          kind: 'test.withdrawal',
          actor: SYSTEM,
          postings: [
            { account: custody, side: 'CREDIT', amount: tooMuch },
            { account: userAccount(user), side: 'DEBIT', amount: tooMuch },
          ],
        }),
      );
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).account).toEqual({
        type: 'platform_custody',
        assetCode: 'BTC',
        userId: null,
      });
      expect((error as Error).message).toBe(
        'Insufficient funds on the platform_custody account in BTC.',
      );
    });

    it('un solde qui dépasserait ce que le grand livre sait tenir', async () => {
      // Un actif à part : son compte de conservation part de zéro.
      await asOwner((db) => registerAssetInSql(db, 'XMAX', 0));
      const XMAX = defineAsset('XMAX', 0);
      const user = await createUser();
      const most = 10n ** 38n - 1n;
      await ledger.post(depositDraft(user, Money.ofUnits(most - 1n, XMAX)));
      await ledger.post(depositDraft(user, Money.ofUnits(1n, XMAX)));
      expect(await balanceOf(user, XMAX)).toBe(most.toString());

      const before = await size();
      const error = await errorOf(() => ledger.post(depositDraft(user, Money.ofUnits(1n, XMAX))));
      expect(error).toBeInstanceOf(LedgerRuleError);
      expect((error as LedgerRuleError).code).toBe('AMOUNT_TOO_LARGE');
      expect((error as Error).message).toBe(
        'The balance of an account would exceed what the ledger can hold.',
      );
      expect(await size()).toEqual(before);
      expect(await balanceOf(user, XMAX)).toBe(most.toString());
    });
  });

  describe('titulaires qui ne peuvent pas — ou plus — détenir de fonds', () => {
    it('un titulaire clôturé : rien ne s’écrit sur son compte, et aucun ne lui est ouvert', async () => {
      const alice = await holderWith('10.00');
      const closed = await holderWith('3.00');
      const never = await createUser();
      await ledger.post(transferDraft(closed, alice, usd('3.00')));
      await asApp(async (db) => {
        await closeAccountInSql(db, closed);
        await closeAccountInSql(db, never);
      });
      const before = await size();

      // Qu'il ait déjà un compte dans cet actif, qu'il n'en ait aucun, ou qu'il faille lui en
      // ouvrir un autre : l'écriture est refusée avant d'avoir rien écrit.
      for (const draft of [
        transferDraft(alice, closed, usd('1.00')),
        transferDraft(alice, never, usd('1.00')),
        depositDraft(closed, Money.parse('1.00', CDF)),
      ]) {
        const refused = await errorOf(() => ledger.post(draft));
        expect(refused).toBeInstanceOf(HolderClosedError);
        expect((refused as Error).message).toBe(
          'The holder of one of the accounts is closed: nothing can be posted to it.',
        );
        // Décidé par l'application, le titulaire retenu : la base n'a rien eu à refuser.
        expect((refused as Error).cause).toBeUndefined();
      }

      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1300');
      expect(await balanceOf(closed)).toBe('0');
      expect(await balanceOf(never)).toBeNull();
    });

    it('une inscription inachevée, un compte inconnu : défauts de l’appelant, refusés sans rien écrire', async () => {
      const alice = await holderWith('10.00');
      const pending = await createUser('PENDING_VERIFICATION');
      const before = await size();

      // Qu'il reçoive ou qu'il envoie, sur n'importe quelle ligne de l'écriture.
      for (const draft of [
        transferDraft(alice, pending, usd('1.00')),
        transferDraft(pending, alice, usd('1.00')),
        depositDraft(pending, usd('1.00')),
      ]) {
        const refused = await errorOf(() => ledger.post(draft));
        expect(refused).toBeInstanceOf(LedgerRuleError);
        expect((refused as LedgerRuleError).code).toBe('HOLDER_NOT_ELIGIBLE');
        expect((refused as Error).message).toBe(
          'The holder of one of the accounts never completed its registration: it cannot hold funds.',
        );
      }
      for (const draft of [
        transferDraft(alice, UNKNOWN_ID, usd('1.00')),
        depositDraft(UNKNOWN_ID, usd('1.00')),
      ]) {
        const refused = await errorOf(() => ledger.post(draft));
        expect(refused).toBeInstanceOf(LedgerRuleError);
        expect((refused as LedgerRuleError).code).toBe('UNKNOWN_HOLDER');
        expect((refused as Error).message).toBe(
          'The holder of one of the accounts does not exist.',
        );
      }

      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1000');
      expect(await balanceOf(pending)).toBeNull();
      expect(await prisma.ledgerAccount.count({ where: { userId: pending } })).toBe(0);
    });

    it('le titulaire est retenu avant ses comptes : une opération qui le verrouille, puis prend ses comptes, ne s’interbloque pas avec l’écriture', async () => {
      const alice = await holderWith('10.00');
      const accounts = [await accountIdOf(alice), await platformAccountIdOf('platform_custody')];
      const attempts = jest.spyOn(ledger, 'postWithin');

      try {
        const posted = await asApp((operation) =>
          asApp(async (observer) => {
            // Une opération verrouille le titulaire, en exclusivité — pour vérifier un plafond…
            await operation.query('BEGIN');
            await operation.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [alice]);
            const posting = ledger.post(depositDraft(alice, usd('5.00')));
            // … l'écriture l'attend, sans tenir aucun compte : l'opération prend ceux-ci à son
            // tour, sans attendre.
            await untilBlocked(observer);
            await operation.query(`SET LOCAL lock_timeout = '500ms'`);
            await operation.query('SELECT 1 FROM ledger_accounts WHERE id = ANY($1) FOR UPDATE', [
              accounts,
            ]);
            await operation.query('COMMIT');
            return posting;
          }),
        );

        expect(posted.replayed).toBe(false);
        // Aucune transaction annulée puis relancée : les verrous n'ont pas formé de cycle.
        expect(attempts).toHaveBeenCalledTimes(1);
      } finally {
        attempts.mockRestore();
      }
      expect(await balanceOf(alice)).toBe('1500');
    });

    it('une écriture en cours retient son titulaire : la clôture attend, puis trouve les fonds', async () => {
      const alice = await createUser();
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      const outcome = await asApp((closing) =>
        asApp(async (observer) => {
          let holding = (): void => undefined;
          const held = new Promise<void>((resolve) => {
            holding = resolve;
          });
          // L'écriture est passée ; sa transaction, elle, n'est pas encore validée.
          const operation = unitOfWork.run(async (tx) => {
            await ledger.postWithin(tx, depositDraft(alice, usd('0.01')));
            holding();
            await released;
          });
          await held;
          const closure = sqlState(() => closeAccountInSql(closing, alice));
          await untilBlocked(observer);
          release();
          await operation;
          return closure;
        }),
      );

      // La clôture a vu le centime : elle est refusée, et le compte reste ouvert.
      expect(outcome).toBe('MGX04');
      expect(await balanceOf(alice)).toBe('1');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: alice } })).status).toBe('ACTIVE');
    });

    it('une clôture en cours fait attendre l’écriture, qui est ensuite refusée sans avoir rien écrit', async () => {
      const alice = await holderWith('10.00');
      const leaving = await createUser();
      const before = await size();
      const attempts = jest.spyOn(ledger, 'postWithin');

      try {
        const refused = await asApp((closing) =>
          asApp(async (observer) => {
            // La clôture a commencé — le compte est verrouillé — et n'est pas encore validée.
            await closing.query('BEGIN');
            await insertClosureRecord(closing, leaving);
            await emptyAccount(closing, leaving);
            await markAccountClosed(closing, leaving);
            const posting = errorOf(() => ledger.post(transferDraft(alice, leaving, usd('1.00'))));
            await untilBlocked(observer);
            await closeVerificationCases(closing, leaving);
            await closing.query('COMMIT');
            return posting;
          }),
        );
        expect(refused).toBeInstanceOf(HolderClosedError);
        // Refusée par l'application elle-même : la base n'a rien eu à annuler.
        expect((refused as Error).cause).toBeUndefined();
        expect(attempts).toHaveBeenCalledTimes(1);
      } finally {
        attempts.mockRestore();
      }
      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1000');
      expect(await prisma.ledgerAccount.count({ where: { userId: leaving } })).toBe(0);
    });

    it('la même course, la clôture annulée : l’écriture passe', async () => {
      const alice = await holderWith('10.00');
      const staying = await createUser();

      const posted = await asApp((closing) =>
        asApp(async (observer) => {
          await closing.query('BEGIN');
          await insertClosureRecord(closing, staying);
          const posting = ledger.post(transferDraft(alice, staying, usd('1.00')));
          await untilBlocked(observer);
          await closing.query('ROLLBACK');
          return posting;
        }),
      );

      expect(posted.replayed).toBe(false);
      expect(await balanceOf(alice)).toBe('900');
      expect(await balanceOf(staying)).toBe('100');
    });
  });

  describe('idempotence', () => {
    it('la même écriture sous la même clé n’est passée qu’une fois : le résultat d’origine est rendu', async () => {
      const alice = await holderWith('100.00');
      const bob = await createUser();
      const draft = transferDraft(alice, bob, usd('40.00'), 'transfer:replayed-once');

      const first = await ledger.post(draft);
      expect(first.replayed).toBe(false);
      // Entre-temps, d'autres écritures changent les soldes.
      await ledger.post(transferDraft(alice, bob, usd('10.00')));
      const before = await size();

      const second = await ledger.post(draft);
      expect(second).toEqual({ ...first, replayed: true });
      expect(second.postings.map((line) => line.balanceAfter.toDecimalString())).toEqual([
        '60.00',
        '40.00',
      ]);
      const third = await ledger.post({ ...draft });
      expect(third).toEqual(second);

      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('5000');
      expect(await balanceOf(bob)).toBe('5000');
      expect(
        await prisma.ledgerEntry.count({ where: { idempotencyKey: draft.idempotencyKey } }),
      ).toBe(1);
    });

    it('rejouée alors que les fonds ont été dépensés depuis : le résultat d’origine, pas un refus', async () => {
      const alice = await holderWith('7.00');
      const bob = await createUser();
      const draft = transferDraft(alice, bob, usd('7.00'));
      const first = await ledger.post(draft);
      expect(await balanceOf(alice)).toBe('0');

      expect(await ledger.post(draft)).toEqual({ ...first, replayed: true });
      expect(await balanceOf(bob)).toBe('700');
    });

    it('ni l’auteur, ni la requête, ni les références n’en font une autre écriture', async () => {
      const alice = await holderWith('5.00');
      const bob = await createUser();
      const draft: JournalEntryDraft = {
        ...transferDraft(alice, bob, usd('5.00')),
        requestId: 'request-first',
        metadata: { attempt: 1 },
      };
      const first = await ledger.post(draft);

      const again = await ledger.post({
        ...draft,
        actor: SYSTEM,
        requestId: 'request-retried',
        metadata: { attempt: 2 },
      });
      expect(again).toEqual({ ...first, replayed: true });
      // L'écriture conservée est celle d'origine.
      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: first.id } });
      expect(entry).toMatchObject({
        actorType: 'USER',
        actorId: alice,
        requestId: 'request-first',
        metadata: { attempt: 1 },
      });
    });

    it('une écriture différente sous une clé déjà utilisée est refusée, quelle que soit la différence', async () => {
      const alice = await holderWith('50.00');
      const bob = await holderWith('50.00');
      const carol = await createUser();
      const key = newKey();
      const original = transferDraft(alice, bob, usd('5.00'), key);
      await ledger.post(original);
      const [debit, credit] = original.postings as [PostingDraft, PostingDraft];

      // Une écriture de quatre lignes, et un dépôt — qui touche un compte de la plateforme.
      const longer: JournalEntryDraft = {
        ...original,
        idempotencyKey: newKey(),
        postings: [debit, credit, debit, credit],
      };
      await ledger.post(longer);
      const deposit = depositDraft(alice, usd('5.00'));
      await ledger.post(deposit);
      const before = await size();

      const variants: Record<string, JournalEntryDraft> = {
        'autre montant': transferDraft(alice, bob, usd('5.01'), key),
        'autre bénéficiaire': transferDraft(alice, carol, usd('5.00'), key),
        'autre payeur': transferDraft(carol, bob, usd('5.00'), key),
        'sens inverse': transferDraft(bob, alice, usd('5.00'), key),
        // Mêmes comptes, dans le même ordre : seul le sens de chaque ligne diffère.
        'sens de chaque ligne inversé': {
          ...original,
          postings: [
            { ...debit, side: 'CREDIT' },
            { ...credit, side: 'DEBIT' },
          ],
        },
        'autre type': { ...original, kind: 'test.other' },
        'lignes dans un autre ordre': { ...original, postings: [credit, debit] },
        'lignes en plus': { ...original, postings: [debit, credit, debit, credit] },
        // Les deux premières lignes d'une écriture qui en compte quatre.
        'lignes en moins': { ...longer, postings: [debit, credit] },
        'autre type de compte': {
          ...original,
          postings: [debit, { account: fees, side: 'CREDIT', amount: usd('5.00') }],
        },
        // Même propriétaire — la plateforme —, même actif, même sens : seul le type diffère.
        'autre compte de la plateforme': {
          ...deposit,
          postings: [{ account: fees, side: 'DEBIT', amount: usd('5.00') }, deposit.postings[1]!],
        },
        'autre actif': {
          ...original,
          postings: [
            { ...debit, amount: Money.parse('5.00', CDF) },
            { ...credit, amount: Money.parse('5.00', CDF) },
          ],
        },
      };
      for (const [difference, draft] of Object.entries(variants)) {
        const error = await errorOf(() => ledger.post(draft));
        expect({ difference, error }).toEqual({
          difference,
          error: expect.any(IdempotencyConflictError),
        });
        expect((error as IdempotencyConflictError).idempotencyKey).toBe(draft.idempotencyKey);
      }

      expect(await size()).toEqual(before);
      // 50 − 5 − 10 + 5 pour l'une, 50 + 5 + 10 pour l'autre : rien d'autre n'a bougé.
      expect(await balanceOf(alice)).toBe('4000');
      expect(await balanceOf(bob)).toBe('6500');
      // Aucun compte n'a été ouvert pour une écriture refusée.
      expect(await balanceOf(carol)).toBeNull();
      expect(await balanceOf(alice, CDF)).toBeNull();
    });

    it('une écriture rejouée n’attend pas derrière les autres écritures de ses comptes', async () => {
      const alice = await holderWith('20.00');
      const bob = await createUser();
      const draft = transferDraft(alice, bob, usd('20.00'));
      const first = await ledger.post(draft);

      await asApp(async (busy) => {
        // Une autre écriture tient le compte d'Alice : rejouer ne s'y arrête pas.
        await busy.query('BEGIN');
        await busy.query('SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE', [
          await accountIdOf(alice),
        ]);
        try {
          expect(await within(3000, ledger.post(draft))).toEqual({ ...first, replayed: true });
        } finally {
          await busy.query('ROLLBACK');
        }
      });
    });

    it('la même écriture présentée plusieurs fois en même temps : une seule passe, toutes la rendent', async () => {
      // De quoi payer une seule fois : passée deux fois, la seconde serait refusée.
      const alice = await holderWith('9.00');
      const bob = await createUser();
      const draft = transferDraft(alice, bob, usd('9.00'));
      const before = await size();

      const outcomes = await asApp((busy) =>
        asApp(async (observer) => {
          // Toutes partent avant que la première n'ait pu passer : le compte d'Alice est tenu.
          await busy.query('BEGIN');
          await busy.query('SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE', [
            await accountIdOf(alice),
          ]);
          const attempts = [1, 2, 3, 4].map(() => ledger.post(draft));
          try {
            await untilBlocked(observer);
            // Laisse aux quatre le temps d'atteindre le verrou.
            await new Promise((resolve) => setTimeout(resolve, 150));
          } finally {
            await busy.query('ROLLBACK');
          }
          return Promise.all(attempts);
        }),
      );

      expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(3);
      const [first] = outcomes as [PostedEntry, ...PostedEntry[]];
      for (const outcome of outcomes) {
        expect({ ...outcome, replayed: false }).toEqual({ ...first, replayed: false });
      }
      expect(await size()).toEqual({ entries: before.entries + 1, postings: before.postings + 2 });
      expect(await balanceOf(alice)).toBe('0');
      expect(await balanceOf(bob)).toBe('900');
    });

    it('la même clé sur d’autres comptes, au même moment : la seconde attend la première, puis est refusée', async () => {
      const alice = await holderWith('10.00');
      const bob = await holderWith('10.00');
      const carol = await holderWith('10.00');
      const dave = await holderWith('10.00');
      const key = newKey();

      await asApp((first) =>
        asApp(async (observer) => {
          // Une première écriture sous cette clé, entre Alice et Bob, pas encore validée.
          await first.query('BEGIN');
          const entry = await insertEntryHeader(first, 2, { idempotency_key: key });
          await insertPostings(first, entry, [
            { account: await accountIdOf(alice), side: 'DEBIT', amount: 100 },
            { account: await accountIdOf(bob), side: 'CREDIT', amount: 100 },
          ]);

          const second = errorOf(() => ledger.post(transferDraft(carol, dave, usd('1.00'), key)));
          await untilBlocked(observer);
          await first.query('COMMIT');

          expect(await second).toBeInstanceOf(IdempotencyConflictError);
        }),
      );
      expect(await balanceOf(carol)).toBe('1000');
      expect(await balanceOf(dave)).toBe('1000');
      expect(await balanceOf(alice)).toBe('900');
    });

    it('la même course, la première annulée : la seconde passe', async () => {
      const alice = await holderWith('10.00');
      const bob = await holderWith('10.00');
      const carol = await holderWith('10.00');
      const dave = await holderWith('10.00');
      const key = newKey();

      const posted = await asApp((first) =>
        asApp(async (observer) => {
          await first.query('BEGIN');
          const entry = await insertEntryHeader(first, 2, { idempotency_key: key });
          await insertPostings(first, entry, [
            { account: await accountIdOf(alice), side: 'DEBIT', amount: 100 },
            { account: await accountIdOf(bob), side: 'CREDIT', amount: 100 },
          ]);

          const second = ledger.post(transferDraft(carol, dave, usd('1.00'), key));
          await untilBlocked(observer);
          await first.query('ROLLBACK');
          return second;
        }),
      );
      expect(posted.replayed).toBe(false);
      expect(await balanceOf(carol)).toBe('900');
      expect(await balanceOf(dave)).toBe('1100');
      expect(await balanceOf(alice)).toBe('1000');
    });
  });

  describe('écritures simultanées', () => {
    it('des transferts croisés lancés ensemble : aucun interblocage, aucun centime perdu', async () => {
      const holders: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        holders.push(await holderWith('1000.00'));
      }
      const drafts: JournalEntryDraft[] = [];
      for (let round = 0; round < 6; round += 1) {
        holders.forEach((holder, index) => {
          const next = holders[(index + 1) % holders.length]!;
          const amount = usd(`${String(round + 1)}.${String(10 + index)}`);
          // Dans les deux sens à la fois : sans ordre de verrouillage, l'interblocage est assuré.
          drafts.push(transferDraft(holder, next, amount), transferDraft(next, holder, amount));
        });
      }

      // Sans nouvelle tentative : un interblocage ferait échouer le test.
      const outcomes = await Promise.allSettled(
        drafts.map((draft) => unitOfWork.run((tx) => ledger.postWithin(tx, draft))),
      );
      expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual([]);
      expect(outcomes).toHaveLength(72);

      // Chaque aller a son retour : tous les soldes sont revenus à leur point de départ.
      for (const holder of holders) {
        expect(await balanceOf(holder)).toBe('100000');
      }
      const counts = await prisma.ledgerAccount.findMany({
        where: { userId: { in: holders } },
        select: { postingCount: true },
      });
      expect(counts.map(({ postingCount }) => postingCount)).toEqual(holders.map(() => 25n));
      expect(await anomalies()).toEqual([]);
    });

    it('un compte disputé : jamais plus que son solde, quel que soit l’ordre d’arrivée', async () => {
      const alice = await holderWith('10.00');
      const recipients: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        recipients.push(await createUser());
      }

      const outcomes = await Promise.allSettled(
        recipients.map((recipient) => ledger.post(transferDraft(alice, recipient, usd('1.00')))),
      );
      const refused = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
      );
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(10);
      expect(refused).toHaveLength(15);
      for (const error of refused) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
        // Décidé sous le verrou du compte, avant toute ligne : l'erreur le désigne, et la base
        // n'a rien eu à refuser.
        expect((error as InsufficientFundsError).account).toEqual({
          type: 'user_available',
          assetCode: 'USD',
          userId: alice,
        });
        expect((error as Error).cause).toBeUndefined();
      }

      expect(await balanceOf(alice)).toBe('0');
      const received = await Promise.all(recipients.map((recipient) => balanceOf(recipient)));
      expect(received.filter((balance) => balance === '100')).toHaveLength(10);
      // Un bénéficiaire qui n'a rien reçu n'a pas de compte : son ouverture a été annulée.
      expect(received.filter((balance) => balance === null)).toHaveLength(15);
      // Les soldes rendus : 9, 8, … 0 — chacun une seule fois.
      const balances = outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled'
          ? [outcome.value.postings[0]!.balanceAfter.toDecimalString()]
          : [],
      );
      expect(balances.sort()).toEqual(
        ['0.00', '1.00', '2.00', '3.00', '4.00', '5.00', '6.00', '7.00', '8.00', '9.00'].sort(),
      );
      expect(await anomalies()).toEqual([]);
    });

    it('les comptes s’ouvrent dans un ordre unique, quel que soit celui des lignes', async () => {
      const holders = [await createUser(), await createUser(), await createUser()].sort();
      const [a, b, c] = holders as [string, string, string];
      const francs = (units: bigint): Money => Money.ofUnits(units, CDF);
      const credit = (holder: string, units: bigint): PostingDraft => ({
        account: userAccount(holder),
        side: 'CREDIT',
        amount: francs(units),
      });
      const opened = jest.spyOn(repository, 'openAccounts');

      try {
        // Une écriture refusée après l'ouverture de ses comptes — la plateforme ne rend pas plus
        // de frais qu'elle n'en a perçu — : rien n'en reste, et la suivante les ouvre à son tour.
        const collected = await platformBalanceOf('platform_fees', CDF);
        const refused = await errorOf(() =>
          ledger.post({
            idempotencyKey: newKey(),
            kind: 'test.refund',
            actor: SYSTEM,
            postings: [
              credit(c, 1n),
              credit(a, 1n),
              credit(b, collected + 1n),
              { account: fees, side: 'DEBIT', amount: francs(collected + 3n) },
            ],
          }),
        );
        expect(refused).toBeInstanceOf(InsufficientFundsError);
        expect(await prisma.ledgerAccount.count({ where: { userId: { in: holders } } })).toBe(0);

        await ledger.post({
          idempotencyKey: newKey(),
          kind: 'test.deposit',
          actor: SYSTEM,
          postings: [
            credit(b, 100n),
            credit(c, 100n),
            { account: custody, side: 'DEBIT', amount: francs(300n) },
            credit(a, 100n),
          ],
        });

        // Dans l'ordre des lignes, deux écritures qui se croisent s'interbloqueraient.
        expect(opened).toHaveBeenCalledTimes(2);
        for (const [, keys] of opened.mock.calls) {
          expect(keys.flatMap(({ userId }) => (userId === null ? [] : [userId]))).toEqual([
            a,
            b,
            c,
          ]);
          // L'ordre complet est celui des clés : actif, type, titulaire.
          const texts = keys.map(
            ({ assetCode, type, userId }) => `${assetCode}|${type}|${userId ?? ''}`,
          );
          expect(texts).toEqual([...texts].sort());
        }
      } finally {
        opened.mockRestore();
      }
      expect(await Promise.all(holders.map((holder) => balanceOf(holder, CDF)))).toEqual([
        '100',
        '100',
        '100',
      ]);
    });

    it('une transaction que PostgreSQL annule pour interblocage est relancée, et l’écriture passe une fois', async () => {
      const first = await holderWith('10.00');
      const second = await holderWith('10.00');
      // L'écriture verrouille ses comptes dans l'ordre de leurs identifiants : `low`, puis `high`.
      const accounts = [
        { user: first, account: await accountIdOf(first) },
        { user: second, account: await accountIdOf(second) },
      ].sort((left, right) => (left.account < right.account ? -1 : 1));
      const [low, high] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
      const before = await size();
      const attempts = jest.spyOn(ledger, 'postWithin');

      try {
        const posted = await asApp((other) =>
          asApp(async (observer) => {
            // Un autre code prend les mêmes verrous dans l'ordre inverse : `high` d'abord…
            await other.query('BEGIN');
            await other.query('SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE', [
              high.account,
            ]);
            const posting = ledger.post(transferDraft(low.user, high.user, usd('4.00')));
            // … l'écriture tient `low` et attend `high` ; l'autre demande `low` : interblocage.
            await untilBlocked(observer);
            await other.query('SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE', [
              low.account,
            ]);
            // PostgreSQL a annulé l'écriture pour laisser passer l'autre, qui s'achève.
            await other.query('ROLLBACK');
            return posting;
          }),
        );

        expect(posted.replayed).toBe(false);
        // Un premier essai annulé par PostgreSQL, un second qui aboutit.
        expect(attempts).toHaveBeenCalledTimes(2);
      } finally {
        attempts.mockRestore();
      }
      expect(await size()).toEqual({ entries: before.entries + 1, postings: before.postings + 2 });
      expect(await balanceOf(low.user)).toBe('600');
      expect(await balanceOf(high.user)).toBe('1400');
    });
  });

  describe('dans la transaction de l’appelant', () => {
    it('l’écriture est validée ou annulée avec ce que l’opération écrit par ailleurs', async () => {
      const alice = await holderWith('10.00');
      const bob = await createUser();
      const audit = testApp.app.get(AuditService);
      const record = (tx: Parameters<AuditService['record']>[0], id: string): Promise<void> =>
        audit.record(tx, {
          actor: SYSTEM,
          action: 'test.operation_done',
          resource: { type: 'test', id },
          outcome: 'SUCCESS',
        });
      const traces = (id: string): Promise<number> =>
        prisma.auditLog.count({ where: { action: 'test.operation_done', resourceId: id } });
      const before = await size();

      // L'opération échoue après l'écriture : rien ne reste, ni l'une ni l'autre.
      const failure = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          await ledger.postWithin(tx, transferDraft(alice, bob, usd('4.00')));
          await record(tx, 'abandoned');
          throw new Error('The operation failed afterwards.');
        }),
      );
      expect((failure as Error).message).toBe('The operation failed afterwards.');
      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1000');
      expect(await balanceOf(bob)).toBeNull();
      expect(await traces('abandoned')).toBe(0);

      // Elle aboutit : les deux sont validées ensemble.
      const posted = await unitOfWork.run(async (tx) => {
        const entry = await ledger.postWithin(tx, transferDraft(alice, bob, usd('4.00')));
        await record(tx, 'completed');
        return entry;
      });
      expect(posted.replayed).toBe(false);
      expect(await balanceOf(alice)).toBe('600');
      expect(await balanceOf(bob)).toBe('400');
      expect(await traces('completed')).toBe(1);
    });

    it('un refus pour fonds insuffisants, titulaire clôturé ou clé déjà utilisée laisse la transaction utilisable', async () => {
      const alice = await holderWith('10.00');
      const bob = await createUser();
      const closed = await createUser();
      await asApp((db) => closeAccountInSql(db, closed));
      const used = transferDraft(alice, bob, usd('1.00'));
      await ledger.post(used);

      const posted = await unitOfWork.run(async (tx) => {
        expect(
          await errorOf(() => ledger.postWithin(tx, transferDraft(alice, bob, usd('99.00')))),
        ).toBeInstanceOf(InsufficientFundsError);
        expect(
          await errorOf(() => ledger.postWithin(tx, transferDraft(alice, closed, usd('1.00')))),
        ).toBeInstanceOf(HolderClosedError);
        expect(
          await errorOf(() =>
            ledger.postWithin(tx, transferDraft(alice, bob, usd('2.00'), used.idempotencyKey)),
          ),
        ).toBeInstanceOf(IdempotencyConflictError);
        // La transaction n'a rien écrit de travers : elle continue.
        return ledger.postWithin(tx, transferDraft(alice, bob, usd('3.00')));
      });
      expect(posted.postings[0]!.balanceAfter).toEqual(usd('6.00'));
      expect(await balanceOf(alice)).toBe('600');
      expect(await balanceOf(bob)).toBe('400');
    });
  });

  describe('la base a le dernier mot', () => {
    // Ce que le service écarte lui-même, la base le refuserait à son tour : le dépôt traduit
    // ses refus, pour que l'appelant reçoive la même erreur d'où qu'elle vienne.
    const header = (tx: DbClient, postingCount = 2): Promise<{ readonly id: string } | null> =>
      repository.insertEntry(tx, {
        idempotencyKey: newKey(),
        kind: 'test.transfer',
        postingCount,
        actor: SYSTEM,
        requestId: null,
        metadata: {},
      });
    const transferLines = (from: string, to: string, units: bigint, assetCode = 'USD') => [
      { lineNumber: 1, accountId: from, assetCode, side: 'DEBIT' as const, units },
      { lineNumber: 2, accountId: to, assetCode, side: 'CREDIT' as const, units },
    ];

    it('des fonds insuffisants : la même erreur, sans compte désigné', async () => {
      const alice = await holderWith('10.00');
      const bob = await holderWith('10.00');
      const [from, to] = [await accountIdOf(alice), await accountIdOf(bob)];
      const before = await size();

      const refused = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          const entry = await header(tx);
          await repository.insertPostings(tx, entry!.id, transferLines(from, to, 1001n));
        }),
      );
      expect(refused).toBeInstanceOf(InsufficientFundsError);
      expect((refused as InsufficientFundsError).account).toBeNull();
      expect((refused as Error).message).toBe('Insufficient funds.');
      expect(sqlStateOf((refused as Error).cause)).toBe('MGX09');
      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1000');
    });

    it('un titulaire clôturé : la même erreur, pour une ligne comme pour l’ouverture d’un compte', async () => {
      const alice = await holderWith('10.00');
      const closed = await holderWith('3.00');
      await ledger.post(transferDraft(closed, alice, usd('3.00')));
      const [from, to] = [await accountIdOf(alice), await accountIdOf(closed)];
      await asApp((db) => closeAccountInSql(db, closed));
      const before = await size();

      const posting = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          const entry = await header(tx);
          await repository.insertPostings(tx, entry!.id, transferLines(from, to, 100n));
        }),
      );
      const opening = await errorOf(() =>
        unitOfWork.run((tx) =>
          repository.openAccounts(tx, [
            { type: 'user_available', assetCode: 'CDF', userId: closed },
          ]),
        ),
      );
      for (const refused of [posting, opening]) {
        expect(refused).toBeInstanceOf(HolderClosedError);
        expect(sqlStateOf((refused as Error).cause)).toBe('MGX05');
      }
      expect(await size()).toEqual(before);
      expect(await balanceOf(alice)).toBe('1300');
      expect(await prisma.ledgerAccount.count({ where: { userId: closed } })).toBe(1);
    });

    it('une règle du grand livre enfreinte : un défaut, signalé comme tel', async () => {
      const alice = await holderWith('10.00');
      const bob = await holderWith('10.00');
      const pending = await createUser('PENDING_VERIFICATION');
      const [from, to] = [await accountIdOf(alice), await accountIdOf(bob)];
      const before = await size();

      // Une ligne dans un autre actif que celui de son compte.
      const mismatch = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          const entry = await header(tx);
          await repository.insertPostings(tx, entry!.id, transferLines(from, to, 100n, 'CDF'));
        }),
      );
      // Un compte ouvert à une inscription inachevée.
      const opening = await errorOf(() =>
        unitOfWork.run((tx) =>
          repository.openAccounts(tx, [
            { type: 'user_available', assetCode: 'USD', userId: pending },
          ]),
        ),
      );
      // Une écriture qui déclare trois lignes et n'en passe que deux : refusée à la validation.
      const incomplete = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          const entry = await header(tx, 3);
          await repository.insertPostings(tx, entry!.id, transferLines(from, to, 100n));
        }),
      );
      for (const refused of [mismatch, opening]) {
        expect(refused).toBeInstanceOf(LedgerIntegrityError);
        expect((refused as Error).message).toBe(
          'The ledger refused the entry: one of its rules would have been broken.',
        );
        expect(sqlStateOf((refused as Error).cause)).toBe('MGX08');
      }
      // À la validation, plus personne ne traduit : l'erreur de la base remonte telle quelle.
      expect(sqlStateOf(incomplete)).toBe('MGX08');
      expect(await size()).toEqual(before);
      expect(await prisma.ledgerAccount.count({ where: { userId: pending } })).toBe(0);
    });

    it('toute autre erreur de la base est relancée telle quelle', async () => {
      const alice = await holderWith('10.00');
      const bob = await holderWith('10.00');
      const [from, to] = [await accountIdOf(alice), await accountIdOf(bob)];

      // Un montant de 39 chiffres : la colonne ne le contient pas.
      const refused = await errorOf(() =>
        unitOfWork.run(async (tx) => {
          const entry = await header(tx);
          await repository.insertPostings(tx, entry!.id, transferLines(to, from, 10n ** 38n));
        }),
      );
      expect(refused).not.toBeInstanceOf(InsufficientFundsError);
      expect(refused).not.toBeInstanceOf(LedgerIntegrityError);
      expect(sqlStateOf(refused)).toBe('22003');
      expect(await balanceOf(alice)).toBe('1000');
    });
  });

  describe('enregistrer un actif', () => {
    const client = { requestId: 'request-asset-0001', ipAddress: '203.0.113.9', userAgent: 'jest' };

    it('un administrateur l’enregistre ; la trace porte sa justification', async () => {
      const admin = await createAdmin(testApp, { secondFactor: false });
      const administration = testApp.app.get(LedgerAdministrationService);
      const before = testClock.now().getTime();

      const asset = await administration.registerAsset(
        {
          code: 'XAF',
          name: 'Franc CFA (BEAC)',
          kind: 'FIAT',
          scale: 0,
          reason: 'Listing decision 12.',
        },
        { userId: admin.id, client },
      );
      expect(asset).toEqual({
        code: 'XAF',
        name: 'Franc CFA (BEAC)',
        kind: 'FIAT',
        scale: 0,
        registeredAt: expect.any(String),
        registeredBy: admin.id,
      });
      expect(Math.abs(new Date(asset.registeredAt).getTime() - before)).toBeLessThan(3_600_000);

      const trace = await prisma.auditLog.findMany({ where: { action: 'asset.registered' } });
      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        actorType: 'USER',
        actorId: admin.id,
        resourceType: 'asset',
        resourceId: 'XAF',
        outcome: 'SUCCESS',
        requestId: 'request-asset-0001',
        ipAddress: '203.0.113.9',
        userAgent: 'jest',
        metadata: {
          name: 'Franc CFA (BEAC)',
          kind: 'FIAT',
          scale: 0,
          reason: 'Listing decision 12.',
        },
      });

      // Une seconde fois, même à l'identique : refusé, sans nouvelle trace.
      const again = await errorOf(() =>
        administration.registerAsset(
          { code: 'XAF', name: 'Franc CFA (BEAC)', kind: 'FIAT', scale: 0, reason: 'Again.' },
          { userId: admin.id, client },
        ),
      );
      expect(again).toBeInstanceOf(AppError);
      expect(again).toMatchObject({
        code: 'CONFLICT',
        message: 'Asset XAF is already registered.',
      });
      expect(await prisma.auditLog.count({ where: { action: 'asset.registered' } })).toBe(1);
      // Aussitôt utilisable.
      const user = await createUser();
      await ledger.post(depositDraft(user, Money.parse('1500', defineAsset('XAF', 0))));
      expect(await balanceOf(user, defineAsset('XAF', 0))).toBe('1500');
    });

    it('la base vérifie elle-même le droit d’enregistrer : sans lui, refus, et rien n’est écrit', async () => {
      const holder = await createUser();
      const administration = testApp.app.get(LedgerAdministrationService);
      const error = await errorOf(() =>
        administration.registerAsset(
          { code: 'XIN', name: 'Intruder coin', kind: 'CRYPTO', scale: 2, reason: 'None.' },
          { userId: holder, client },
        ),
      );
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action.',
      });
      expect(await prisma.asset.count({ where: { code: 'XIN' } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { resourceId: 'XIN' } })).toBe(0);
    });
  });

  describe('clôture d’un compte et copie des données', () => {
    it('des fonds s’opposent à la clôture ; des écritures imposent dix ans de conservation', async () => {
      const data = testApp.app.get(LedgerAccountData);
      const never = await createUser();
      const funded = await holderWith('0.01');
      const emptied = await holderWith('5.00');
      const sink = await createUser();
      await ledger.post(transferDraft(emptied, sink, usd('5.00')));
      const closedAt = new Date('2027-03-15T10:20:30.456Z');

      expect(await data.closureBlockers(prisma, never)).toEqual([]);
      expect(await data.closureBlockers(prisma, funded)).toEqual(['FUNDS_REMAINING']);
      expect(await data.closureBlockers(prisma, emptied)).toEqual([]);

      expect(await data.legalRetentionUntil(prisma, never, closedAt)).toBeNull();
      expect(await data.legalRetentionUntil(prisma, emptied, closedAt)).toEqual(
        new Date('2037-03-15T10:20:30.456Z'),
      );
      expect(await data.legalRetentionUntil(prisma, funded, closedAt)).toEqual(
        new Date('2037-03-15T10:20:30.456Z'),
      );
      // Rien à verrouiller, à clore ni à effacer : le grand livre ne s'efface pas.
      await data.lockForClosure();
      expect(await data.closeAccount()).toBeNull();
      await data.eraseRetained();
      expect(await balanceOf(emptied)).toBe('0');
      expect(
        await prisma.ledgerPosting.count({
          where: { account: { userId: emptied } },
        }),
      ).toBe(2);
    });

    it('la copie contient les portefeuilles qui ont servi, et leurs mouvements du plus récent au plus ancien', async () => {
      const data = testApp.app.get(LedgerAccountData);
      const alice = await createUser();
      const bob = await createUser();
      expect(await data.exportData(prisma, alice)).toEqual({ wallets: [] });

      const deposit = await ledger.post(depositDraft(alice, usd('12.00')));
      const transfer = await ledger.post(transferDraft(alice, bob, usd('2.50')));
      await ledger.post(depositDraft(alice, Money.parse('0.5', BTC)));
      // Un portefeuille ouvert mais jamais mouvementé n'y figure pas.
      await asApp((db) => openLedgerAccount(db, 'user_available', 'CDF', alice));

      const exported = await data.exportData(prisma, alice);
      expect(exported).toEqual({
        wallets: [
          {
            asset: { code: 'BTC', name: 'Asset BTC', kind: 'CRYPTO', scale: 8 },
            available: '0.50000000',
            movements: [
              {
                id: expect.stringMatching(UUID),
                entryId: expect.stringMatching(UUID),
                kind: 'test.deposit',
                side: 'CREDIT',
                amount: '0.50000000',
                balanceAfter: '0.50000000',
                postedAt: expect.any(String),
              },
            ],
            truncated: false,
          },
          {
            asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
            available: '9.50',
            movements: [
              {
                id: transfer.postings[0]!.id,
                entryId: transfer.id,
                kind: 'test.transfer',
                side: 'DEBIT',
                amount: '2.50',
                balanceAfter: '9.50',
                postedAt: transfer.postedAt.toISOString(),
              },
              {
                id: deposit.postings[1]!.id,
                entryId: deposit.id,
                kind: 'test.deposit',
                side: 'CREDIT',
                amount: '12.00',
                balanceAfter: '12.00',
                postedAt: deposit.postedAt.toISOString(),
              },
            ],
            truncated: false,
          },
        ],
      });
      // Celle de Bob ne contient que ce qui le concerne.
      expect(await data.exportData(prisma, bob)).toEqual({
        wallets: [
          {
            asset: { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 },
            available: '2.50',
            movements: [
              {
                id: transfer.postings[1]!.id,
                entryId: transfer.id,
                kind: 'test.transfer',
                side: 'CREDIT',
                amount: '2.50',
                balanceAfter: '2.50',
                postedAt: transfer.postedAt.toISOString(),
              },
            ],
            truncated: false,
          },
        ],
      });
    });

    it('au-delà de 2 000 mouvements, la copie garde les plus récents et le dit', async () => {
      const data = testApp.app.get(LedgerAccountData);
      const alice = await createUser();
      const cent = usd('0.01');
      // Cinquante mouvements par écriture : quarante écritures font 2 000 mouvements, tout juste.
      const fiftyCredits: PostingDraft[] = Array.from({ length: 50 }).flatMap(() => [
        { account: custody, side: 'DEBIT' as const, amount: cent },
        { account: userAccount(alice), side: 'CREDIT' as const, amount: cent },
      ]);
      for (let entry = 0; entry < 40; entry += 1) {
        await ledger.post({
          idempotencyKey: newKey(),
          kind: 'test.deposit',
          actor: SYSTEM,
          postings: fiftyCredits,
        });
      }

      const complete = (await data.exportData(prisma, alice)).wallets;
      expect(complete).toHaveLength(1);
      expect(complete?.[0]).toMatchObject({ available: '20.00', truncated: false });
      expect(complete?.[0]?.movements).toHaveLength(2000);
      expect(complete?.[0]?.movements[0]).toMatchObject({ amount: '0.01', balanceAfter: '20.00' });
      expect(complete?.[0]?.movements.at(-1)).toMatchObject({
        amount: '0.01',
        balanceAfter: '0.01',
      });

      // Un mouvement de plus : le plus ancien sort de la copie, qui se dit incomplète.
      const latest = await ledger.post(depositDraft(alice, usd('5.00')));
      const truncated = (await data.exportData(prisma, alice)).wallets;
      expect(truncated?.[0]).toMatchObject({ available: '25.00', truncated: true });
      expect(truncated?.[0]?.movements).toHaveLength(2000);
      expect(truncated?.[0]?.movements[0]).toMatchObject({
        id: latest.postings[1]!.id,
        amount: '5.00',
        balanceAfter: '25.00',
      });
      expect(truncated?.[0]?.movements.at(-1)).toMatchObject({
        amount: '0.01',
        balanceAfter: '0.02',
      });
      expect(DATA_EXPORT_MOVEMENTS_MAX_ENTRIES).toBe(2000);
    });
  });

  // En dernier : ces scénarios altèrent le grand livre, puis le remettent en état.
  describe('vérification du grand livre', () => {
    const sorted = (found: readonly LedgerAnomaly[]): LedgerAnomaly[] =>
      [...found].sort((left, right) =>
        `${left.kind}|${left.subject}`.localeCompare(`${right.kind}|${right.subject}`),
      );

    /** Altère, relève les anomalies, remet en état — et vérifie qu'il n'en reste aucune. */
    async function anomaliesOf(alter: string, restore: string, parameters: unknown[]) {
      await asOwner((owner) =>
        tamperWithLedger(owner, async (db) => {
          await db.query(alter, parameters);
        }),
      );
      const found = sorted(await anomalies());
      await asOwner((owner) =>
        tamperWithLedger(owner, async (db) => {
          await db.query(restore, parameters);
        }),
      );
      expect(await anomalies()).toEqual([]);
      return found;
    }

    it('un grand livre sain ne présente aucune anomalie ; l’étape rend le nombre d’écritures vérifiées', async () => {
      expect(await anomalies()).toEqual([]);
      const { entries } = await size();
      expect(entries).toBeGreaterThan(100);
      expect(await testApp.app.get(LedgerVerification).run()).toBe(entries);

      const report = await testApp.app.get(AccountMaintenanceService).run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['verify-ledger']).toBe(entries);
      expect(await prisma.auditLog.count({ where: { action: 'ledger.verification_failed' } })).toBe(
        0,
      );
    });

    it('chaque altération est relevée, avec ce qu’elle touche', async () => {
      const alice = await holderWith('100.00');
      const bob = await createUser();
      const first = await ledger.post(transferDraft(alice, bob, usd('10.00')));
      const second = await ledger.post(transferDraft(alice, bob, usd('20.00')));
      const last = await ledger.post(transferDraft(alice, bob, usd('30.00')));
      const account = await accountIdOf(alice);
      const line = (entry: PostedEntry): string => entry.postings[0]!.id;

      // Un solde écrit sans la ligne qui le justifie : le compte, et la balance de l'actif.
      expect(
        await anomaliesOf(
          'UPDATE ledger_accounts SET balance = balance + 1 WHERE id = $1',
          'UPDATE ledger_accounts SET balance = balance - 1 WHERE id = $1',
          [account],
        ),
      ).toEqual([
        { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: account },
        { kind: 'ASSET_UNBALANCED', subject: 'USD' },
      ]);
      expect(
        await anomaliesOf(
          'UPDATE ledger_accounts SET posting_count = posting_count + 1 WHERE id = $1',
          'UPDATE ledger_accounts SET posting_count = posting_count - 1 WHERE id = $1',
          [account],
        ),
      ).toEqual([{ kind: 'ACCOUNT_BALANCE_MISMATCH', subject: account }]);

      // Le solde d'une ligne retouché : elle ne prolonge plus la précédente, ni la suivante elle.
      expect(
        await anomaliesOf(
          'UPDATE ledger_postings SET balance_after = balance_after + 1 WHERE id = $1',
          'UPDATE ledger_postings SET balance_after = balance_after - 1 WHERE id = $1',
          [line(second)],
        ),
      ).toEqual(
        sorted([
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(second) },
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(last) },
        ]),
      );
      // La dernière ligne : c'est le solde du compte qui ne lui correspond plus.
      expect(
        await anomaliesOf(
          'UPDATE ledger_postings SET balance_after = balance_after + 1 WHERE id = $1',
          'UPDATE ledger_postings SET balance_after = balance_after - 1 WHERE id = $1',
          [line(last)],
        ),
      ).toEqual(
        sorted([
          { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: account },
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(last) },
        ]),
      );
      // Un rang décalé : un trou dans la suite des lignes du compte.
      expect(
        await anomaliesOf(
          'UPDATE ledger_postings SET account_sequence = account_sequence + 5 WHERE id = $1',
          'UPDATE ledger_postings SET account_sequence = account_sequence - 5 WHERE id = $1',
          [line(last)],
        ),
      ).toEqual(
        sorted([
          { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: account },
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(last) },
        ]),
      );

      // Un montant retouché : l'écriture ne s'équilibre plus, et la ligne ne mène plus à son solde.
      expect(
        await anomaliesOf(
          'UPDATE ledger_postings SET amount = amount + 1 WHERE id = $1',
          'UPDATE ledger_postings SET amount = amount - 1 WHERE id = $1',
          [line(first)],
        ),
      ).toEqual(
        sorted([
          { kind: 'ENTRY_UNSOUND', subject: first.id },
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(first) },
        ]),
      );
      // Un sens inversé : de même.
      expect(
        await anomaliesOf(
          `UPDATE ledger_postings SET side = 'CREDIT' WHERE id = $1`,
          `UPDATE ledger_postings SET side = 'DEBIT' WHERE id = $1`,
          [line(first)],
        ),
      ).toEqual(
        sorted([
          { kind: 'ENTRY_UNSOUND', subject: first.id },
          { kind: 'POSTING_CHAIN_BROKEN', subject: line(first) },
        ]),
      );
      // Une ligne passée dans un autre actif que celui de son compte.
      expect(
        await anomaliesOf(
          `UPDATE ledger_postings SET asset_code = 'CDF' WHERE id = $1`,
          `UPDATE ledger_postings SET asset_code = 'USD' WHERE id = $1`,
          [line(first)],
        ),
      ).toEqual(
        sorted([
          { kind: 'ENTRY_UNSOUND', subject: first.id },
          { kind: 'POSTING_ASSET_MISMATCH', subject: line(first) },
        ]),
      );
      // Une écriture qui déclare plus de lignes qu'elle n'en a.
      expect(
        await anomaliesOf(
          'UPDATE ledger_entries SET posting_count = posting_count + 1 WHERE id = $1',
          'UPDATE ledger_entries SET posting_count = posting_count - 1 WHERE id = $1',
          [second.id],
        ),
      ).toEqual([{ kind: 'ENTRY_UNSOUND', subject: second.id }]);
      // Trois lignes déclarées, la première et la troisième présentes : la dernière porte bien
      // le numéro attendu, mais il en manque une.
      expect(
        await anomaliesOf(
          `WITH renumbered AS (
             UPDATE ledger_postings SET line_number = 3 WHERE entry_id = $1 AND line_number = 2
           )
           UPDATE ledger_entries SET posting_count = 3 WHERE id = $1`,
          `WITH renumbered AS (
             UPDATE ledger_postings SET line_number = 2 WHERE entry_id = $1 AND line_number = 3
           )
           UPDATE ledger_entries SET posting_count = 2 WHERE id = $1`,
          [second.id],
        ),
      ).toEqual([{ kind: 'ENTRY_UNSOUND', subject: second.id }]);
      // Une ligne renumérotée : la suite 1, 2 est rompue.
      expect(
        await anomaliesOf(
          'UPDATE ledger_postings SET line_number = line_number + 7 WHERE id = $1',
          'UPDATE ledger_postings SET line_number = line_number - 7 WHERE id = $1',
          [line(second)],
        ),
      ).toEqual([{ kind: 'ENTRY_UNSOUND', subject: second.id }]);
    });

    it('une ligne déplacée sur le compte de l’autre : l’écriture ne déplace plus rien', async () => {
      const carol = await holderWith('100.00');
      const dave = await createUser();
      const moved = await ledger.post(transferDraft(carol, dave, usd('10.00')));
      const [from, to] = [await accountIdOf(carol), await accountIdOf(dave)];
      const credit = moved.postings[1]!.id;

      // Débit et crédit sur le même compte : l'écriture reste équilibrée, complète — et vide.
      expect(
        await anomaliesOf(
          `UPDATE ledger_postings
           SET account_id = CASE WHEN account_id = $2::uuid THEN $3::uuid ELSE $2::uuid END,
               account_sequence = 3
           WHERE id = $1`,
          `UPDATE ledger_postings
           SET account_id = CASE WHEN account_id = $2::uuid THEN $3::uuid ELSE $2::uuid END,
               account_sequence = 1
           WHERE id = $1`,
          [credit, to, from],
        ),
      ).toEqual(
        sorted([
          // Le compte de Carol a une ligne de plus que son compteur ; celui de Dave, une de moins.
          { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: from },
          { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: to },
          { kind: 'ENTRY_UNSOUND', subject: moved.id },
          // 90 + 10 ne font pas le solde de 10 que porte la ligne.
          { kind: 'POSTING_CHAIN_BROKEN', subject: credit },
        ]),
      );
    });

    it('une anomalie fait échouer l’étape, qui la consigne au journal d’audit sans rien corriger', async () => {
      const alice = await holderWith('100.00');
      const account = await accountIdOf(alice);
      const verification = testApp.app.get(LedgerVerification);
      await asOwner((owner) =>
        tamperWithLedger(owner, async (db) => {
          await db.query('UPDATE ledger_accounts SET balance = balance + 1 WHERE id = $1', [
            account,
          ]);
        }),
      );
      try {
        const expected = [
          { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: account },
          { kind: 'ASSET_UNBALANCED', subject: 'USD' },
        ];
        const error = await errorOf(() => verification.run());
        expect(error).toBeInstanceOf(LedgerVerificationError);
        expect(sorted((error as LedgerVerificationError).anomalies)).toEqual(expected);
        expect((error as Error).message).toBe(
          'The ledger failed its verification: 2 anomaly(ies) found.',
        );
        // Au plus le nombre d'anomalies demandé.
        expect(await anomalies(1)).toHaveLength(1);

        const report = await testApp.app.get(AccountMaintenanceService).run();
        expect(report.failures).toBe(1);
        expect(report.otherSteps['verify-ledger']).toBe(0);

        const traces = await prisma.auditLog.findMany({
          where: { action: 'ledger.verification_failed' },
        });
        expect(traces).toHaveLength(2);
        for (const trace of traces) {
          expect(trace).toMatchObject({
            actorType: 'SYSTEM',
            actorId: null,
            resourceType: 'ledger',
            resourceId: null,
            outcome: 'FAILURE',
          });
          const metadata = trace.metadata as unknown as {
            anomalies: LedgerAnomaly[];
            truncated: boolean;
          };
          expect(sorted(metadata.anomalies)).toEqual(expected);
          expect(metadata.truncated).toBe(false);
        }
        // La balance le dit aussi, pour cet actif et pour l'ensemble — et seulement pour lui.
        const admin = await createAdmin(testApp, { secondFactor: false });
        const balance = await testApp.app.get(LedgerAdministrationService).trialBalance({
          userId: admin.id,
          client: { requestId: 'request-balance-0001', ipAddress: undefined, userAgent: undefined },
        });
        expect(balance.balanced).toBe(false);
        expect(
          balance.assets.filter(({ balanced }) => !balanced).map(({ asset }) => asset.code),
        ).toEqual(['USD']);
        const inUsd = balance.assets.find(({ asset }) => asset.code === 'USD');
        // Un centime de plus au crédit qu'au débit : celui qu'on a ajouté au solde d'Alice.
        expect(
          Money.parse(inUsd!.creditBalance, USD).minus(Money.parse(inUsd!.debitBalance, USD)),
        ).toEqual(usd('0.01'));
        const [viewed] = await prisma.auditLog.findMany({
          where: { action: 'ledger.trial_balance_viewed', actorId: admin.id },
        });
        expect(viewed?.metadata).toEqual({ assets: balance.assets.length, balanced: false });

        // Rien n'a été corrigé : le compte altéré le reste, et refuse toute ligne.
        expect(await balanceOf(alice)).toBe('10001');
        expect(await errorOf(() => ledger.post(depositDraft(alice, usd('1.00'))))).toBeInstanceOf(
          LedgerIntegrityError,
        );
      } finally {
        await asOwner((owner) =>
          tamperWithLedger(owner, async (db) => {
            await db.query('UPDATE ledger_accounts SET balance = balance - 1 WHERE id = $1', [
              account,
            ]);
          }),
        );
      }
      expect(await anomalies()).toEqual([]);
      expect(LEDGER_VERIFICATION_MAX_ANOMALIES).toBe(50);
    });

    it('au-delà de cinquante anomalies, la liste s’arrête là — et le dit', async () => {
      const verification = testApp.app.get(LedgerVerification);
      expect(await prisma.ledgerAccount.count()).toBeGreaterThan(50);
      const tamper = (change: string): Promise<void> =>
        asOwner((owner) =>
          tamperWithLedger(owner, async (db) => {
            await db.query(`UPDATE ledger_accounts SET posting_count = posting_count ${change}`);
          }),
        );

      await tamper('+ 1');
      try {
        const error = await errorOf(() => verification.run());
        expect(error).toBeInstanceOf(LedgerVerificationError);
        expect((error as LedgerVerificationError).anomalies).toHaveLength(50);
        expect((error as Error).message).toBe(
          'The ledger failed its verification: 50 anomaly(ies) found (list truncated).',
        );
        const [trace] = await prisma.auditLog.findMany({
          where: { action: 'ledger.verification_failed' },
          orderBy: { id: 'desc' },
          take: 1,
        });
        const metadata = trace?.metadata as unknown as {
          anomalies: LedgerAnomaly[];
          truncated: boolean;
        };
        expect(metadata.anomalies).toHaveLength(50);
        expect(metadata.truncated).toBe(true);
        expect(new Set(metadata.anomalies.map(({ kind }) => kind))).toEqual(
          new Set(['ACCOUNT_BALANCE_MISMATCH']),
        );
      } finally {
        await tamper('- 1');
      }
      expect(await anomalies()).toEqual([]);
    });
  });
});
