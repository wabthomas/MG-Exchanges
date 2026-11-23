import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { LEDGER_ADJUSTMENT_TTL_HOURS } from '@mgx/contracts';
import { type Asset, defineAsset, Money } from '@mgx/shared';
import type pg from 'pg';

import { AppError } from '../../src/common/errors/app-error.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { LedgerVerification } from '../../src/modules/ledger/application/ledger-verification.js';
import { AdjustmentNoticeDispatcher } from '../../src/modules/adjustments/application/adjustment-notice.dispatcher.js';
import { AdjustmentService } from '../../src/modules/adjustments/application/adjustment.service.js';
import { AccountClosureService } from '../../src/modules/identity/application/account-closure.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { ActivityService } from '../../src/modules/identity/application/activity.service.js';
import type { StaffActor } from '../../src/modules/identity/application/admin-users.service.js';
import { PasswordHasher } from '../../src/modules/identity/application/password-hasher.js';
import { UserRepository } from '../../src/modules/identity/application/user.repository.js';
import { LedgerAccountData } from '../../src/modules/ledger/application/ledger-account-data.js';
import { LedgerReader } from '../../src/modules/ledger/application/ledger-reader.js';
import { LedgerService } from '../../src/modules/ledger/application/ledger.service.js';
import { WalletFreezeRepository } from '../../src/modules/ledger/application/wallet-freeze.repository.js';
import { WalletFreezeService } from '../../src/modules/ledger/application/wallet-freeze.service.js';
import { WalletService } from '../../src/modules/ledger/application/wallet.service.js';
import { platformAccount, userAccount } from '../../src/modules/ledger/domain/ledger-account.js';
import { WalletFrozenError } from '../../src/modules/ledger/domain/ledger-errors.js';
import { NotificationService } from '../../src/modules/notifications/application/notification.service.js';
import { TransferService } from '../../src/modules/transfers/application/transfer.service.js';
import {
  backgroundWorkDone,
  createAdmin,
  enableSecondFactor,
  mailbox,
  nextMessageOf,
  nextTotpCode,
  PASSWORD,
  withOwner,
  wrongTotpCode,
} from '../support/identity.js';
import { ledgerSize, registerAssetInSql, registerEntryKindsInSql } from '../support/ledger-sql.js';
import { ageAdjustment } from '../support/staff-operations-sql.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { withConnection } from '../support/test-database.js';
import { freshKey, setLimitInSql, verifyUpTo } from '../support/transfers-sql.js';

const USD = defineAsset('USD', 2);
const BTC = defineAsset('BTC', 8);
const SYSTEM = { type: 'SYSTEM' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const REASON = 'Dépôt en espèces constaté au guichet, reçu n° 2026-11-0042';
const NOTE = 'Pièce justificative absente du dossier';
const HOUR_MS = 60 * 60 * 1000;
const USD_VIEW = { code: 'USD', name: 'Asset USD', kind: 'FIAT', scale: 2 };

const OWN_WALLET = {
  code: 'FORBIDDEN',
  message: 'You cannot request an adjustment of your own wallet.',
};
const SECOND_PERSON = (decision: string) => ({
  code: 'FORBIDDEN',
  message: `A ledger adjustment must be ${decision} by a second member of staff; you can cancel your own request.`,
});
const OWN_DECISION = {
  code: 'FORBIDDEN',
  message: 'You cannot decide on an adjustment of your own wallet.',
};
const NO_LONGER_ENTITLED = {
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.',
};
const INSUFFICIENT_FUNDS = {
  code: 'INSUFFICIENT_FUNDS',
  message: 'The wallet does not hold this amount.',
};
const NOT_FOUND = { code: 'NOT_FOUND', message: 'Ledger adjustment not found.' };
const NO_LONGER_PENDING = (status: string) => ({
  code: 'CONFLICT',
  message: `This adjustment is no longer pending (${status}).`,
});
const DUPLICATE = {
  code: 'CONFLICT',
  message:
    'An identical adjustment — same wallet, same direction, same amount — is already awaiting approval.',
};
const CLOSED_ACCOUNT = { code: 'CONFLICT', message: 'This account is closed: it has no wallet.' };
const UNKNOWN_ACCOUNT = { code: 'UNPROCESSABLE_ENTITY', message: 'Unknown account.' };

interface Member {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly totpSecret?: string;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
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
    };
  }
  throw new Error('Expected the action to be refused.');
}

/**
 * Ajustements et gels sont demandés aux services, comme le font les routes. Chaque scénario
 * crée ses comptes : aucun ne dépend d'un autre.
 */
describe('Opérations du personnel — services (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let adjustments: AdjustmentService;
  let freezes: WalletFreezeService;
  let ledger: LedgerService;
  let reader: LedgerReader;
  let wallets: WalletService;
  let transfers: TransferService;
  let passwordHash: string;
  /** Deux administrateurs (rôle super_admin), sans second facteur : l'un demande, l'autre décide. */
  let root: Member;
  let second: Member;
  let compliance: Member;
  let support: Member;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { DATABASE_POOL_MAX: '10' } });
    prisma = testApp.app.get(PrismaService);
    adjustments = testApp.app.get(AdjustmentService);
    freezes = testApp.app.get(WalletFreezeService);
    ledger = testApp.app.get(LedgerService);
    reader = testApp.app.get(LedgerReader);
    wallets = testApp.app.get(WalletService);
    transfers = testApp.app.get(TransferService);
    passwordHash = await testApp.app.get(PasswordHasher).hash(PASSWORD);
    root = await createAdmin(testApp, { secondFactor: false });
    second = await createAdmin(testApp, { secondFactor: false });
    compliance = await staff('compliance');
    support = await staff('support');
    await asOwner(async (db) => {
      // Les types d'écriture d'essai (`test.deposit`…) : d'elle-même, la base ne connaît que
      // ceux des opérations du produit.
      await registerEntryKindsInSql(db);
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
      // Transferts en dollars ouverts au niveau 1 : 100 par transfert, 250 par jour, 1 000 par mois.
      await setLimitInSql(db, 'USD', 1, [10_000, 25_000, 100_000]);
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

  /** Dépôt passé par le grand livre, sans ajustement : de quoi partir d'un solde. */
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
  /** Un titulaire actif, vérifié au niveau 1, crédité de `funds` dollars. */
  async function member(
    funds: string | null = null,
    data: { status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION'; locale?: string } = {},
  ): Promise<Member> {
    sequence += 1;
    const email = `staff-operations-service${String(sequence)}@example.cd`;
    const pending = data.status === 'PENDING_VERIFICATION';
    const { id } = await prisma.user.create({
      data: {
        email,
        countryCode: 'CD',
        status: pending ? 'PENDING_VERIFICATION' : 'ACTIVE',
        registeredAt: new Date(),
        emailVerifiedAt: pending ? null : new Date(),
        ...(data.locale === undefined ? {} : { locale: data.locale }),
        credential: { create: { passwordHash } },
      },
      select: { id: true },
    });
    if (!pending) {
      await asApp((db) => verifyUpTo(db, id, 1, root.id));
      if (funds !== null) {
        await deposit(id, funds);
      }
    }
    if (data.status === 'SUSPENDED') {
      await prisma.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    }
    return { id, email, password: PASSWORD };
  }

  /** Membre du personnel : un compte actif, et le rôle — attribué par le propriétaire. */
  async function staff(roleKey: string): Promise<Member> {
    sequence += 1;
    const email = `staff-operations-${roleKey}${String(sequence)}@example.cd`;
    const { id } = await prisma.user.create({
      data: {
        email,
        countryCode: 'CD',
        status: 'ACTIVE',
        registeredAt: new Date(),
        emailVerifiedAt: new Date(),
        credential: { create: { passwordHash } },
      },
      select: { id: true },
    });
    await withOwner(testApp, async (owner) => {
      const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
      await owner.userRole.create({ data: { userId: id, roleId: role.id } });
    });
    return { id, email, password: PASSWORD };
  }

  const clientOf = (requestId = `test-${randomUUID()}`) => ({
    requestId,
    ipAddress: '198.51.100.7',
    userAgent: 'jest',
  });
  const actorOf = (member: Member): StaffActor => ({ userId: member.id, client: clientOf() });
  const authOf = (member: Member) => ({ userId: member.id, sessionId: randomUUID() });

  // --- Ajustements ---

  interface RequestOptions {
    readonly by?: Member;
    readonly assetCode?: string;
    readonly reason?: string;
  }

  const request = (
    holder: Member | string,
    direction: 'CREDIT' | 'DEBIT',
    amount: string,
    options: RequestOptions = {},
  ) =>
    adjustments.request(
      {
        userId: typeof holder === 'string' ? holder : holder.id,
        assetCode: options.assetCode ?? 'USD',
        direction,
        amount,
        reason: options.reason ?? REASON,
      },
      actorOf(options.by ?? root),
    );

  interface ApproveOptions {
    readonly by?: Member;
    readonly password?: string;
    readonly code?: string;
    readonly note?: string;
    readonly requestId?: string;
  }

  const approve = (id: string, options: ApproveOptions = {}) => {
    const approver = options.by ?? second;
    return adjustments.approve(
      id,
      {
        currentPassword: options.password ?? approver.password,
        ...(options.code === undefined ? {} : { code: options.code }),
        ...(options.note === undefined ? {} : { note: options.note }),
      },
      authOf(approver),
      clientOf(options.requestId),
    );
  };

  /** Un crédit demandé par `root` et approuvé par `second` : le chemin par lequel des fonds entrent. */
  async function credited(holder: Member, amount: string) {
    const { id } = await request(holder, 'CREDIT', amount);
    return approve(id);
  }

  // --- Gels ---

  const freeze = (holder: Member | string, options: { by?: Member; assetCode?: string } = {}) =>
    freezes.freeze(
      {
        userId: typeof holder === 'string' ? holder : holder.id,
        assetCode: options.assetCode ?? 'USD',
        reason: 'Signalement du service conformité, dossier 2026-118',
      },
      actorOf(options.by ?? compliance),
    );
  const lift = (id: string, by: Member = second) =>
    freezes.lift(id, { reason: 'Vérification terminée, rien à signaler' }, actorOf(by));

  // --- Transferts ---

  const send = (sender: Member, to: Member, amount: string) =>
    transfers.create(
      authOf(sender),
      { recipientEmail: to.email, assetCode: 'USD', amount, currentPassword: sender.password },
      freshKey(),
      clientOf(),
    );

  // --- État ---

  /** Fonds disponibles d'un titulaire, en unités minimales. */
  const balanceOf = (holder: Member, assetCode = 'USD'): Promise<bigint> =>
    reader.availableBalance(prisma, holder.id, assetCode);
  const custodyBalance = async (assetCode = 'USD'): Promise<bigint> =>
    BigInt(
      (
        await prisma.ledgerAccount.findFirst({
          where: { typeKey: 'platform_custody', assetCode, userId: null },
        })
      )?.balance.toString() ?? '0',
    );
  const auditOf = async (actor: Member, action: string) =>
    (
      await prisma.auditLog.findMany({
        where: { actorId: actor.id, action },
        orderBy: { id: 'asc' },
      })
    ).map(({ resourceType, resourceId, outcome, metadata, requestId }) => ({
      resourceType,
      resourceId,
      outcome,
      metadata,
      requestId,
    }));
  const activityOf = async (holder: Member) =>
    (await testApp.app.get(ActivityService).list(holder.id, { limit: 50 })).entries;
  const statusOf = async (id: string): Promise<string> =>
    (await prisma.ledgerAdjustment.findUniqueOrThrow({ where: { id } })).status;
  /** Tout ce qu'un ajustement écrit : de quoi affirmer qu'un refus n'a rien écrit. */
  const written = async () => ({
    ledger: await asApp(ledgerSize),
    adjustments: await prisma.ledgerAdjustment.count(),
    approved: await prisma.ledgerAdjustment.count({ where: { status: 'APPROVED' } }),
    events: await prisma.outboxEvent.count({ where: { aggregateType: 'ledger_adjustment' } }),
  });

  // ---------------------------------------------------------------------------------------------
  describe('demander un ajustement', () => {
    it('enregistre la demande, en attente, sans rien déplacer', async () => {
      const holder = await member('40.00');
      const before = await written();

      const adjustment = await request(holder, 'CREDIT', '250.5');

      expect(adjustment).toEqual({
        id: expect.stringMatching(UUID),
        user: { id: holder.id, email: holder.email },
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
      expect(Date.parse(adjustment.expiresAt) - Date.parse(adjustment.requestedAt)).toBe(
        LEDGER_ADJUSTMENT_TTL_HOURS * HOUR_MS,
      );
      expect(await balanceOf(holder)).toBe(4_000n);
      expect(await written()).toEqual({ ...before, adjustments: before.adjustments + 1 });
      // Le journal d'audit garde les termes de la demande, et sa raison.
      expect(await auditOf(root, 'ledger_adjustment.requested')).toContainEqual({
        resourceType: 'ledger_adjustment',
        resourceId: adjustment.id,
        outcome: 'SUCCESS',
        requestId: expect.any(String),
        metadata: {
          userId: holder.id,
          assetCode: 'USD',
          direction: 'CREDIT',
          amount: '250.50',
          reason: REASON,
        },
      });
      // Le titulaire n'en sait rien : ni historique, ni message, tant que rien n'a bougé.
      expect((await activityOf(holder)).map(({ type }) => type)).toEqual([]);
    });

    it('nul ne demande l’ajustement de son propre portefeuille — et la tentative est tracée', async () => {
      const before = await written();
      expect(await refusalOf(() => request(root, 'CREDIT', '10.00'))).toEqual(OWN_WALLET);
      expect(await written()).toEqual(before);
      expect((await auditOf(root, 'ledger_adjustment.request_denied')).at(-1)).toMatchObject({
        resourceType: 'ledger_adjustment',
        resourceId: null,
        outcome: 'DENIED',
        metadata: { reason: 'OWN_WALLET' },
      });
      // Celui d'un autre administrateur, si.
      expect((await request(second, 'CREDIT', '10.00')).status).toBe('PENDING');
    });

    it('refuse ce qui ne peut pas être passé : actif, montant, compte, solde', async () => {
      const holder = await member('30.00');
      const closed = await member();
      await testApp.app
        .get(AccountClosureService)
        .closeOwn(authOf(closed), { currentPassword: PASSWORD, confirm: true }, clientOf());
      const pending = await member(null, { status: 'PENDING_VERIFICATION' });
      const before = await written();

      expect(
        await refusalOf(() => request(holder, 'CREDIT', '1.00', { assetCode: 'EUR' })),
      ).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        errors: [{ path: 'assetCode', message: 'The platform does not keep this asset.' }],
      });
      // Un centime n'a pas de moitié : rien n'est arrondi.
      expect(await refusalOf(() => request(holder, 'CREDIT', '1.005'))).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        errors: [
          { path: 'amount', message: 'Must have at most 2 decimal places: the precision of USD.' },
        ],
      });
      expect(await refusalOf(() => request(holder, 'CREDIT', '0.00'))).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'amount', message: 'Must be greater than zero.' }],
      });
      expect(await refusalOf(() => request(UNKNOWN_ID, 'CREDIT', '1.00'))).toEqual(UNKNOWN_ACCOUNT);
      expect(await refusalOf(() => request(closed, 'CREDIT', '1.00'))).toEqual(CLOSED_ACCOUNT);
      expect(await refusalOf(() => request(pending, 'CREDIT', '1.00'))).toEqual({
        code: 'CONFLICT',
        message: 'This registration was never verified: it has no wallet.',
      });
      // Un débit que le portefeuille ne couvre pas : refusé d'emblée. À un centime près.
      expect(await refusalOf(() => request(holder, 'DEBIT', '30.01'))).toEqual(INSUFFICIENT_FUNDS);
      expect(
        await refusalOf(() => request(holder, 'DEBIT', '0.00000001', { assetCode: 'BTC' })),
      ).toEqual(INSUFFICIENT_FUNDS);
      expect(await written()).toEqual(before);
      expect((await request(holder, 'DEBIT', '30.00')).status).toBe('PENDING');
    });

    it('une seule demande identique en attente : la seconde est refusée', async () => {
      const holder = await member('80.00');
      const first = await request(holder, 'CREDIT', '25.00');
      // Écrit autrement, c'est le même montant.
      expect(await refusalOf(() => request(holder, 'CREDIT', '25'))).toEqual(DUPLICATE);
      expect(await refusalOf(() => request(holder, 'CREDIT', '25.0', { by: second }))).toEqual(
        DUPLICATE,
      );
      // Ce qui la distingue suffit.
      expect((await request(holder, 'CREDIT', '25.01')).status).toBe('PENDING');
      expect((await request(holder, 'DEBIT', '25.00')).status).toBe('PENDING');
      // Décidée, elle ne s'oppose plus à une demande identique.
      await adjustments.cancel(first.id, actorOf(root));
      expect((await request(holder, 'CREDIT', '25.00')).status).toBe('PENDING');
    });

    it('un compte clôturé à l’instant où la demande s’écrit : la base la refuse, et c’est dit', async () => {
      const holder = await member();
      const before = await written();
      // Le compte est actif quand le service le lit, clôturé quand la demande s'écrit : la
      // clôture est glissée entre les deux, juste avant l'écriture.
      const closing = jest.spyOn(adjustments, 'closeOverdue').mockImplementationOnce(async () => {
        await testApp.app
          .get(AccountClosureService)
          .closeOwn(authOf(holder), { currentPassword: PASSWORD, confirm: true }, clientOf());
        return 0;
      });
      try {
        expect(await refusalOf(() => request(holder, 'CREDIT', '5.00'))).toEqual(CLOSED_ACCOUNT);
        expect(closing).toHaveBeenCalledTimes(1);
      } finally {
        closing.mockRestore();
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: holder.id } })).status).toBe(
        'CLOSED',
      );
      expect(await written()).toEqual(before);
    });

    it('la base refuse la demande de qui n’en a pas le droit, même si l’appelant l’a laissée passer', async () => {
      const holder = await member();
      const before = await written();
      for (const author of [compliance, support, await member()]) {
        expect(await refusalOf(() => request(holder, 'CREDIT', '5.00', { by: author }))).toEqual(
          NO_LONGER_ENTITLED,
        );
      }
      expect(await written()).toEqual(before);
    });

    it('un compte suspendu, un portefeuille gelé, un compte du personnel se demandent', async () => {
      const suspended = await member('20.00', { status: 'SUSPENDED' });
      const frozen = await member('20.00');
      await freeze(frozen);
      for (const holder of [suspended, frozen, support]) {
        expect((await request(holder, 'CREDIT', '1.00')).status).toBe('PENDING');
      }
      expect((await request(suspended, 'DEBIT', '20.00')).status).toBe('PENDING');
      expect((await request(frozen, 'DEBIT', '20.00')).status).toBe('PENDING');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('approuver un ajustement', () => {
    it('un crédit : le portefeuille est crédité, la conservation débitée, la demande approuvée', async () => {
      const holder = await member('40.00');
      const custodyBefore = await custodyBalance();
      const { id } = await request(holder, 'CREDIT', '250.50');
      const before = await written();

      const approved = await approve(id, { note: 'Reçu vérifié' });

      expect(approved).toEqual({
        id,
        user: { id: holder.id, email: holder.email },
        asset: USD_VIEW,
        direction: 'CREDIT',
        amount: '250.50',
        reason: REASON,
        status: 'APPROVED',
        requestedBy: { id: root.id, email: root.email },
        requestedAt: expect.stringMatching(ISO),
        expiresAt: expect.stringMatching(ISO),
        decidedBy: { id: second.id, email: second.email },
        decidedAt: expect.stringMatching(ISO),
        decisionNote: 'Reçu vérifié',
        entryId: expect.stringMatching(UUID),
      });
      expect(await balanceOf(holder)).toBe(29_050n);
      expect(await custodyBalance()).toBe(custodyBefore + 25_050n);
      expect(await written()).toEqual({
        ledger: { entries: before.ledger.entries + 1, postings: before.ledger.postings + 2 },
        adjustments: before.adjustments,
        approved: before.approved + 1,
        events: before.events + 1,
      });
    });

    it('l’écriture : son type, ses deux lignes, son auteur, ses références — sans rien de personnel', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '12.00');
      const requestId = `test-${randomUUID()}`;
      const { entryId } = await approve(id, { requestId });

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({
        where: { id: entryId! },
        include: { postings: { orderBy: { lineNumber: 'asc' }, include: { account: true } } },
      });
      expect(entry).toMatchObject({
        idempotencyKey: `adjustment:${id}`,
        kind: 'adjustment.credit',
        actorType: 'USER',
        actorId: second.id,
        requestId,
        metadata: { adjustmentId: id, requestedBy: root.id },
      });
      // Ni la raison, ni une adresse : une écriture ne s'efface jamais.
      expect(JSON.stringify(entry.metadata)).not.toMatch(/guichet|@/);
      expect(
        entry.postings.map(({ account, amount, side }) => ({
          type: account.typeKey,
          userId: account.userId,
          side,
          amount: amount.toString(),
        })),
      ).toEqual([
        { type: 'platform_custody', userId: null, side: 'DEBIT', amount: '1200' },
        { type: 'user_available', userId: holder.id, side: 'CREDIT', amount: '1200' },
      ]);
    });

    it('un débit : le portefeuille est débité, la conservation créditée — la ligne qui débite d’abord', async () => {
      const holder = await member('300.00');
      const custodyBefore = await custodyBalance();
      const { id } = await request(holder, 'DEBIT', '120.00');
      const approved = await approve(id);

      expect(approved).toMatchObject({ status: 'APPROVED', direction: 'DEBIT', amount: '120.00' });
      expect(await balanceOf(holder)).toBe(18_000n);
      expect(await custodyBalance()).toBe(custodyBefore - 12_000n);
      const postings = await prisma.ledgerPosting.findMany({
        where: { entryId: approved.entryId! },
        orderBy: { lineNumber: 'asc' },
        include: { account: true, entry: true },
      });
      expect(
        postings.map(({ account, entry, side }) => ({
          type: account.typeKey,
          side,
          kind: entry.kind,
        })),
      ).toEqual([
        { type: 'user_available', side: 'DEBIT', kind: 'adjustment.debit' },
        { type: 'platform_custody', side: 'CREDIT', kind: 'adjustment.debit' },
      ]);
    });

    it('le journal d’audit garde la décision, et l’historique du titulaire le mouvement — sans la raison', async () => {
      const holder = await member();
      const credit = await request(holder, 'CREDIT', '75.00');
      const approved = await approve(credit.id, { note: 'Reçu vérifié' });
      const debit = await request(holder, 'DEBIT', '5.00');
      const debited = await approve(debit.id);

      expect(await auditOf(second, 'ledger_adjustment.approved')).toContainEqual({
        resourceType: 'ledger_adjustment',
        resourceId: credit.id,
        outcome: 'SUCCESS',
        requestId: expect.any(String),
        metadata: {
          userId: holder.id,
          assetCode: 'USD',
          direction: 'CREDIT',
          amount: '75.00',
          requestedBy: root.id,
          entryId: approved.entryId,
          note: 'Reçu vérifié',
        },
      });
      // Rattachées au compte : ce que son titulaire lit dans son historique.
      const onAccount = await prisma.auditLog.findMany({
        where: { resourceType: 'user', resourceId: holder.id, actorId: second.id },
        orderBy: { id: 'asc' },
      });
      expect(onAccount.map(({ action, metadata }) => ({ action, metadata }))).toEqual([
        {
          action: 'user.wallet_credited',
          metadata: {
            adjustmentId: credit.id,
            assetCode: 'USD',
            amount: '75.00',
            entryId: approved.entryId,
            requestedBy: root.id,
          },
        },
        {
          action: 'user.wallet_debited',
          metadata: {
            adjustmentId: debit.id,
            assetCode: 'USD',
            amount: '5.00',
            entryId: debited.entryId,
            requestedBy: root.id,
          },
        },
      ]);
      // Ni l'adresse ni l'appareil du membre du personnel ne regardent le titulaire.
      expect(await activityOf(holder)).toEqual([
        {
          id: expect.stringMatching(UUID),
          type: 'WALLET_DEBITED',
          occurredAt: expect.stringMatching(ISO),
          outcome: 'SUCCESS',
          ipAddress: null,
          userAgent: null,
        },
        {
          id: expect.stringMatching(UUID),
          type: 'WALLET_CREDITED',
          occurredAt: expect.stringMatching(ISO),
          outcome: 'SUCCESS',
          ipAddress: null,
          userAgent: null,
        },
      ]);
      // Le mouvement figure au portefeuille, sous son type.
      const { movements, wallet } = await wallets.movements(holder.id, 'USD', { limit: 20 });
      expect(wallet.available).toBe('70.00');
      expect(movements.map(({ amount, kind, side }) => ({ kind, side, amount }))).toEqual([
        { kind: 'adjustment.debit', side: 'DEBIT', amount: '5.00' },
        { kind: 'adjustment.credit', side: 'CREDIT', amount: '75.00' },
      ]);
    });

    it('une session ne suffit pas : sans le mot de passe de l’approbateur, rien n’est examiné ni écrit', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const before = await written();

      expect(await refusalOf(() => approve(id, { password: 'pas-le-bon-mot-de-passe' }))).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'The current password is incorrect.',
      });
      // La preuve passe avant tout examen : une demande inconnue reçoit le même refus.
      expect(
        await refusalOf(() => approve(UNKNOWN_ID, { password: 'pas-le-bon-mot-de-passe' })),
      ).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(await written()).toEqual(before);
      expect(await statusOf(id)).toBe('PENDING');
      expect(await balanceOf(holder)).toBe(0n);
      expect((await auditOf(second, 'ledger_adjustment.approval_proof_failed')).length).toBe(2);
    });

    it('avec la validation en deux étapes, l’approbateur présente aussi son second facteur', async () => {
      const approver = await createAdmin(testApp, { secondFactor: false });
      const totpSecret = await enableSecondFactor(testApp, approver);
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const before = await written();

      expect(await refusalOf(() => approve(id, { by: approver }))).toEqual({
        code: 'UNPROCESSABLE_ENTITY',
        message:
          'Two-step verification is enabled on this account: provide "code" or "recoveryCode".',
      });
      expect(
        await refusalOf(() => approve(id, { by: approver, code: wrongTotpCode(totpSecret) })),
      ).toMatchObject({ code: 'INVALID_OR_EXPIRED_CODE' });
      expect(await written()).toEqual(before);

      const approved = await approve(id, { by: approver, code: nextTotpCode(totpSecret) });
      expect(approved).toMatchObject({
        status: 'APPROVED',
        decidedBy: { id: approver.id, email: approver.email },
      });
      expect(await balanceOf(holder)).toBe(1_000n);
    });

    it('quatre yeux : ni l’auteur de la demande, ni le titulaire ne l’approuvent — et la tentative est tracée', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      // Le portefeuille d'un administrateur : demandé par un autre.
      const own = await request(second, 'CREDIT', '11.00');
      const before = await written();

      expect(await refusalOf(() => approve(id, { by: root }))).toEqual(SECOND_PERSON('approved'));
      expect((await auditOf(root, 'ledger_adjustment.decision_denied')).at(-1)).toMatchObject({
        resourceType: 'ledger_adjustment',
        resourceId: id,
        outcome: 'DENIED',
        metadata: { reason: 'OWN_REQUEST' },
      });

      // Il ne l'approuve pas lui-même.
      expect(await refusalOf(() => approve(own.id, { by: second }))).toEqual(OWN_DECISION);
      expect((await auditOf(second, 'ledger_adjustment.decision_denied')).at(-1)).toMatchObject({
        resourceId: own.id,
        metadata: { reason: 'OWN_WALLET' },
      });
      expect(await written()).toEqual(before);

      // Un troisième, si.
      const third = await createAdmin(testApp, { secondFactor: false });
      expect((await approve(own.id, { by: third })).status).toBe('APPROVED');
    });

    it('la base refuse l’approbation de qui n’en a pas le droit ; la demande reste en attente', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const before = await written();
      const refused = {
        code: 'CONFLICT',
        message:
          'This adjustment can no longer be approved: the request has expired, or its author or you are no longer entitled.',
      };
      for (const approver of [compliance, support]) {
        expect(await refusalOf(() => approve(id, { by: approver }))).toEqual(refused);
        expect(
          (await auditOf(approver, 'ledger_adjustment.approval_refused')).at(-1),
        ).toMatchObject({
          resourceId: id,
          outcome: 'DENIED',
          metadata: { reason: 'DATABASE_RULE' },
        });
      }
      expect(await written()).toEqual(before);
      expect(await statusOf(id)).toBe('PENDING');
      expect(await balanceOf(holder)).toBe(0n);
    });

    it('l’auteur de la demande suspendu depuis : elle ne s’approuve plus', async () => {
      const author = await createAdmin(testApp, { secondFactor: false });
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00', { by: author });
      await prisma.user.update({ where: { id: author.id }, data: { status: 'SUSPENDED' } });
      const before = await written();

      expect(await refusalOf(() => approve(id))).toMatchObject({
        code: 'CONFLICT',
        message: expect.stringMatching(/^This adjustment can no longer be approved/),
      });
      expect(await written()).toEqual(before);
      expect(await balanceOf(holder)).toBe(0n);
      // Elle se refuse encore.
      expect((await adjustments.reject(id, { note: NOTE }, actorOf(second))).status).toBe(
        'REJECTED',
      );
    });

    it('un débit que le portefeuille ne couvre plus : refusé, tracé, et la demande reste en attente', async () => {
      const holder = await member('100.00');
      const other = await member();
      const { id } = await request(holder, 'DEBIT', '100.00');
      // Le titulaire envoie une partie de ses fonds avant que la demande ne soit approuvée.
      await send(holder, other, '0.01');
      const before = await written();

      expect(await refusalOf(() => approve(id))).toEqual(INSUFFICIENT_FUNDS);
      expect(await written()).toEqual(before);
      expect(await statusOf(id)).toBe('PENDING');
      expect(await balanceOf(holder)).toBe(9_999n);
      expect((await auditOf(second, 'ledger_adjustment.approval_refused')).at(-1)).toMatchObject({
        resourceId: id,
        outcome: 'DENIED',
        metadata: { reason: 'INSUFFICIENT_FUNDS' },
      });
      // Les fonds revenus, la même demande s'approuve.
      await send(other, holder, '0.01');
      expect((await approve(id)).status).toBe('APPROVED');
      expect(await balanceOf(holder)).toBe(0n);
    });

    it('un compte clôturé depuis la demande : rien n’y est passé', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      await testApp.app
        .get(AccountClosureService)
        .closeOwn(authOf(holder), { currentPassword: PASSWORD, confirm: true }, clientOf());
      const before = await written();

      expect(await refusalOf(() => approve(id))).toEqual({
        code: 'CONFLICT',
        message: 'This account is closed: nothing can be posted to its wallets.',
      });
      expect(await written()).toEqual(before);
      expect((await auditOf(second, 'ledger_adjustment.approval_refused')).at(-1)).toMatchObject({
        resourceId: id,
        metadata: { reason: 'ACCOUNT_CLOSED' },
      });
      // Le titulaire n'a plus d'adresse : la demande le montre.
      expect((await adjustments.get(id, actorOf(second))).user).toEqual({
        id: holder.id,
        email: null,
      });
    });

    it('une demande décidée ne s’approuve plus ; une demande inconnue n’existe pas', async () => {
      const holder = await member();
      const approved = await credited(holder, '10.00');
      const rejected = await request(holder, 'CREDIT', '20.00');
      await adjustments.reject(rejected.id, { note: NOTE }, actorOf(second));
      const cancelled = await request(holder, 'CREDIT', '30.00');
      await adjustments.cancel(cancelled.id, actorOf(root));
      const before = await written();

      expect(await refusalOf(() => approve(approved.id))).toEqual(NO_LONGER_PENDING('approved'));
      expect(await refusalOf(() => approve(rejected.id))).toEqual(NO_LONGER_PENDING('rejected'));
      expect(await refusalOf(() => approve(cancelled.id))).toEqual(NO_LONGER_PENDING('cancelled'));
      expect(await refusalOf(() => approve(UNKNOWN_ID))).toEqual(NOT_FOUND);
      expect(await written()).toEqual(before);
      // Créditer deux fois, c'est déposer deux demandes — pas approuver deux fois la même.
      expect(await balanceOf(holder)).toBe(1_000n);
    });

    it('deux approbations simultanées de la même demande : le portefeuille est crédité une fois', async () => {
      const third = await createAdmin(testApp, { secondFactor: false });
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const before = await written();

      const outcomes = await Promise.allSettled([
        approve(id, { by: second }),
        approve(id, { by: third }),
        approve(id, { by: second }),
        approve(id, { by: third }),
      ]);

      const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(AppError);
          expect((outcome.reason as AppError).code).toBe('CONFLICT');
        }
      }
      expect(await balanceOf(holder)).toBe(1_000n);
      expect(await written()).toEqual({
        ledger: { entries: before.ledger.entries + 1, postings: before.ledger.postings + 2 },
        adjustments: before.adjustments,
        approved: before.approved + 1,
        events: before.events + 1,
      });
    });

    it('un compte suspendu et un portefeuille gelé s’ajustent : c’est par là que leurs fonds sortent', async () => {
      const suspended = await member('60.00', { status: 'SUSPENDED' });
      const exit = await request(suspended, 'DEBIT', '60.00');
      expect((await approve(exit.id)).status).toBe('APPROVED');
      expect(await balanceOf(suspended)).toBe(0n);

      const frozen = await member('60.00');
      await freeze(frozen);
      const credit = await request(frozen, 'CREDIT', '15.00');
      expect((await approve(credit.id)).status).toBe('APPROVED');
      const debit = await request(frozen, 'DEBIT', '75.00');
      expect((await approve(debit.id)).status).toBe('APPROVED');
      expect(await balanceOf(frozen)).toBe(0n);
    });

    it('un actif à huit décimales : au satoshi près', async () => {
      const holder = await member();
      const { id, amount } = await request(holder, 'CREDIT', '0.00000001', { assetCode: 'BTC' });
      expect(amount).toBe('0.00000001');
      await approve(id);
      expect(await balanceOf(holder, 'BTC')).toBe(1n);
      expect(await balanceOf(holder)).toBe(0n);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refuser, retirer, laisser échoir', () => {
    it('refuser : un second membre du personnel, avec son motif ; rien ne bouge', async () => {
      const holder = await member('40.00');
      const { id } = await request(holder, 'DEBIT', '40.00');
      const before = await written();

      expect(await refusalOf(() => adjustments.reject(id, { note: NOTE }, actorOf(root)))).toEqual(
        SECOND_PERSON('rejected'),
      );
      const rejected = await adjustments.reject(id, { note: NOTE }, actorOf(second));

      expect(rejected).toMatchObject({
        id,
        status: 'REJECTED',
        decidedBy: { id: second.id, email: second.email },
        decidedAt: expect.stringMatching(ISO),
        decisionNote: NOTE,
        entryId: null,
      });
      expect(await written()).toEqual(before);
      expect(await balanceOf(holder)).toBe(4_000n);
      expect(await auditOf(second, 'ledger_adjustment.rejected')).toContainEqual({
        resourceType: 'ledger_adjustment',
        resourceId: id,
        outcome: 'SUCCESS',
        requestId: expect.any(String),
        metadata: {
          userId: holder.id,
          assetCode: 'USD',
          direction: 'DEBIT',
          amount: '40.00',
          note: NOTE,
        },
      });
      // Le titulaire n'en a rien su.
      expect(await activityOf(holder)).toEqual([]);
      expect(
        await refusalOf(() => adjustments.reject(id, { note: NOTE }, actorOf(second))),
      ).toEqual(NO_LONGER_PENDING('rejected'));
    });

    it('le titulaire, fût-il administrateur, ne refuse pas l’ajustement de son portefeuille', async () => {
      const { id } = await request(second, 'CREDIT', '12.00');
      expect(
        await refusalOf(() => adjustments.reject(id, { note: NOTE }, actorOf(second))),
      ).toEqual(OWN_DECISION);
      expect(await statusOf(id)).toBe('PENDING');
    });

    it('la base refuse le refus de qui n’en a pas le droit', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      for (const decider of [compliance, support]) {
        expect(
          await refusalOf(() => adjustments.reject(id, { note: NOTE }, actorOf(decider))),
        ).toEqual(NO_LONGER_ENTITLED);
      }
      expect(await statusOf(id)).toBe('PENDING');
    });

    it('retirer : seul l’auteur de la demande', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const before = await written();

      expect(await refusalOf(() => adjustments.cancel(id, actorOf(second)))).toEqual({
        code: 'FORBIDDEN',
        message: 'Only the author of a request can cancel it.',
      });
      const cancelled = await adjustments.cancel(id, actorOf(root));
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        decidedBy: { id: root.id, email: root.email },
        decisionNote: null,
        entryId: null,
      });
      expect(await written()).toEqual(before);
      expect((await auditOf(root, 'ledger_adjustment.cancelled')).at(-1)).toMatchObject({
        resourceId: id,
        metadata: { userId: holder.id, assetCode: 'USD', direction: 'CREDIT', amount: '10.00' },
      });
      expect(await refusalOf(() => adjustments.cancel(id, actorOf(root)))).toEqual(
        NO_LONGER_PENDING('cancelled'),
      );
      expect(await refusalOf(() => adjustments.cancel(UNKNOWN_ID, actorOf(root)))).toEqual(
        NOT_FOUND,
      );
      expect(
        await refusalOf(() => adjustments.reject(UNKNOWN_ID, { note: NOTE }, actorOf(second))),
      ).toEqual(NOT_FOUND);
    });

    it('après 72 heures sans décision, une demande échoit : elle ne s’approuve plus', async () => {
      const holder = await member();
      const stale = await request(holder, 'CREDIT', '10.00');
      const fresh = await request(holder, 'CREDIT', '11.00');
      await asOwner((owner) => ageAdjustment(owner, fresh.id, '71 hours'));
      await asOwner((owner) => ageAdjustment(owner, stale.id, '73 hours'));
      const before = await written();

      // Une lecture suffit à la clore : ce qui s'affiche « en attente » peut être approuvé.
      const seen = await adjustments.get(stale.id, actorOf(second));
      expect(seen).toMatchObject({
        status: 'EXPIRED',
        decidedBy: null,
        decidedAt: expect.stringMatching(ISO),
        entryId: null,
      });
      expect(await refusalOf(() => approve(stale.id))).toEqual(NO_LONGER_PENDING('expired'));
      expect(
        await refusalOf(() => adjustments.reject(stale.id, { note: NOTE }, actorOf(second))),
      ).toEqual(NO_LONGER_PENDING('expired'));
      expect(await refusalOf(() => adjustments.cancel(stale.id, actorOf(root)))).toEqual(
        NO_LONGER_PENDING('expired'),
      );
      expect(await written()).toEqual(before);
      // À une heure de son échéance, l'autre s'approuve encore.
      expect((await approve(fresh.id)).status).toBe('APPROVED');
      expect(await balanceOf(holder)).toBe(1_100n);
    });

    it('une demande échue est close par ce qui la rencontre en premier : une liste, une demande identique, une décision', async () => {
      const holder = await member();
      /** Une demande de crédit dont l'échéance est passée depuis une heure — et que rien n'a relue. */
      const overdue = async (amount: string): Promise<string> => {
        const { id } = await request(holder, 'CREDIT', amount);
        await asOwner((owner) => ageAdjustment(owner, id, '73 hours'));
        return id;
      };

      // Une liste : elle n'y figure pas « en attente ».
      const listed = await overdue('10.00');
      const pending = await adjustments.list(
        { status: 'PENDING', userId: holder.id, limit: 20 },
        actorOf(second),
      );
      expect(pending.adjustments).toEqual([]);
      expect(await statusOf(listed)).toBe('EXPIRED');

      // Une demande identique : l'ancienne, échue, ne lui fait pas obstacle.
      const replaced = await overdue('11.00');
      const again = await request(holder, 'CREDIT', '11.00');
      expect(again.status).toBe('PENDING');
      expect(await statusOf(replaced)).toBe('EXPIRED');

      // Une décision — approuver, refuser, retirer : la demande est échue, et le reste.
      const decisions: [string, (id: string) => Promise<unknown>][] = [
        ['approuver', (id) => approve(id)],
        ['refuser', (id) => adjustments.reject(id, { note: NOTE }, actorOf(second))],
        ['retirer', (id) => adjustments.cancel(id, actorOf(root))],
      ];
      for (const [label, decide] of decisions) {
        const id = await overdue('12.00');
        expect({ label, refusal: await refusalOf(() => decide(id)) }).toEqual({
          label,
          refusal: NO_LONGER_PENDING('expired'),
        });
        expect({ label, status: await statusOf(id) }).toEqual({ label, status: 'EXPIRED' });
      }
      expect(await balanceOf(holder)).toBe(0n);
    });

    it('la maintenance périodique clôt les demandes échues, et elles seules', async () => {
      const holder = await member();
      await adjustments.closeOverdue();
      const stale = [
        await request(holder, 'CREDIT', '1.00'),
        await request(holder, 'CREDIT', '2.00'),
      ];
      const fresh = await request(holder, 'CREDIT', '3.00');
      for (const { id } of stale) {
        await asOwner((owner) => ageAdjustment(owner, id, '72 hours 1 second'));
      }

      const report = await testApp.app.get(AccountMaintenanceService).run();

      expect(report.otherSteps['expire-ledger-adjustments']).toBe(2);
      expect(report.failures).toBe(0);
      for (const { id } of stale) {
        expect(await statusOf(id)).toBe('EXPIRED');
      }
      expect(await statusOf(fresh.id)).toBe('PENDING');
      // Rien à refaire au passage suivant.
      expect(await adjustments.closeOverdue()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('consulter les ajustements', () => {
    it('du plus récent au plus ancien, par statut ou par titulaire, page par page — et c’est tracé', async () => {
      const holder = await member();
      const other = await member();
      const made = [
        await request(holder, 'CREDIT', '1.00'),
        await request(holder, 'CREDIT', '2.00'),
        await request(other, 'CREDIT', '3.00'),
        await request(holder, 'CREDIT', '4.00'),
        await request(holder, 'CREDIT', '5.00'),
      ];
      await approve(made[1]!.id);
      await adjustments.reject(made[3]!.id, { note: NOTE }, actorOf(second));

      const all = await adjustments.list({ userId: holder.id, limit: 20 }, actorOf(second));
      expect(all.adjustments.map(({ amount, status }) => ({ amount, status }))).toEqual([
        { amount: '5.00', status: 'PENDING' },
        { amount: '4.00', status: 'REJECTED' },
        { amount: '2.00', status: 'APPROVED' },
        { amount: '1.00', status: 'PENDING' },
      ]);
      expect(all.nextCursor).toBeNull();
      expect(all.adjustments[2]).toMatchObject({
        user: { id: holder.id, email: holder.email },
        requestedBy: { id: root.id, email: root.email },
        decidedBy: { id: second.id, email: second.email },
        entryId: expect.stringMatching(UUID),
      });

      const pendingOnly = await adjustments.list(
        { userId: holder.id, status: 'PENDING', limit: 20 },
        actorOf(second),
      );
      expect(pendingOnly.adjustments.map(({ amount }) => amount)).toEqual(['5.00', '1.00']);
      // Sans filtre de titulaire : ceux de tous, donc aussi celui de l'autre compte.
      const everyPending = await adjustments.list(
        { status: 'PENDING', limit: 100 },
        actorOf(second),
      );
      expect(everyPending.adjustments.map(({ id }) => id)).toEqual(
        expect.arrayContaining([made[0]!.id, made[2]!.id, made[4]!.id]),
      );
      expect(everyPending.adjustments.every(({ status }) => status === 'PENDING')).toBe(true);

      // Page par page : rien n'est rendu deux fois, rien n'est omis. Le parcours est borné.
      const pages: string[][] = [];
      let after: string | undefined;
      do {
        const page = await adjustments.list(
          { userId: holder.id, limit: 3, ...(after === undefined ? {} : { after }) },
          actorOf(second),
        );
        pages.push(page.adjustments.map(({ amount }) => amount));
        after = page.nextCursor ?? undefined;
      } while (after !== undefined && pages.length < 5);
      expect(pages).toEqual([['5.00', '4.00', '2.00'], ['1.00']]);
      // Une page exactement pleine n'annonce pas de suite ; une de moins, si.
      expect(
        (await adjustments.list({ userId: holder.id, limit: 4 }, actorOf(second))).nextCursor,
      ).toBeNull();
      expect(
        (await adjustments.list({ userId: holder.id, limit: 3 }, actorOf(second))).nextCursor,
      ).toEqual(expect.any(String));
      // Un curseur qui n'en est pas un.
      expect(
        await refusalOf(() =>
          adjustments.list({ limit: 20, after: 'bm90LWEtY3Vyc29y' }, actorOf(second)),
        ),
      ).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'after' }] });

      const listed = await auditOf(second, 'ledger_adjustment.listed_by_admin');
      expect(listed.at(-1)).toMatchObject({
        resourceType: 'ledger_adjustment',
        resourceId: null,
        outcome: 'SUCCESS',
        metadata: { userId: holder.id, limit: 3, results: 3 },
      });
      expect(listed).toContainEqual(
        expect.objectContaining({
          metadata: { userId: holder.id, status: 'PENDING', limit: 20, results: 2 },
        }),
      );
    });

    it('une demande se consulte par son identifiant, et la consultation est tracée', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '10.00');
      const viewed = await adjustments.get(id, actorOf(second));
      expect(viewed).toMatchObject({ id, status: 'PENDING', amount: '10.00' });
      expect((await auditOf(second, 'ledger_adjustment.viewed_by_admin')).at(-1)).toMatchObject({
        resourceType: 'ledger_adjustment',
        resourceId: id,
        outcome: 'SUCCESS',
      });
      expect(await refusalOf(() => adjustments.get(UNKNOWN_ID, actorOf(second)))).toEqual(
        NOT_FOUND,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('prévenir le titulaire', () => {
    const received = (holder: Member) =>
      mailbox(testApp)
        .messagesFor(holder.email)
        .filter(({ template }) => template === 'wallet_adjusted');

    it('un ajustement approuvé est annoncé au titulaire, dans sa langue — sans la raison', async () => {
      const holder = await member();
      const english = await member(null, { locale: 'en' });
      const staffBefore = [received(root).length, received(second).length];
      await credited(holder, '1250.00');
      const debit = await request(holder, 'DEBIT', '50.00');
      await approve(debit.id);
      await credited(english, '7.00');

      await nextMessageOf(testApp, holder.email, 'wallet_adjusted', 2);
      const toEnglish = await nextMessageOf(testApp, english.email, 'wallet_adjusted');
      await backgroundWorkDone(testApp);
      expect(received(holder)).toHaveLength(2);
      const aboutCredit = received(holder).find(({ subject }) => subject.endsWith('crédité'));
      const aboutDebit = received(holder).find(({ subject }) => subject.endsWith('débité'));
      expect(aboutCredit).toMatchObject({ channel: 'EMAIL', locale: 'fr' });
      expect(aboutCredit!.text).toContain('Montant : 1250.00 USD');
      expect(aboutCredit!.text).toContain('vient de créditer votre portefeuille USD');
      expect(aboutDebit!.text).toContain('Montant : 50.00 USD');
      expect(aboutDebit!.text).toContain('vient de débiter votre portefeuille USD');
      expect(toEnglish).toMatchObject({ locale: 'en' });
      expect(toEnglish.subject).toMatch(/wallet credited$/);
      expect(toEnglish.text).toContain('Amount: 7.00 USD');
      // La raison reste interne ; les membres du personnel ne sont pas nommés.
      for (const message of [aboutCredit!, aboutDebit!, toEnglish]) {
        expect(message.text).not.toMatch(/guichet|reçu n°|admin-/);
      }
      // Ni l'auteur de la demande, ni l'approbateur ne reçoivent de message.
      expect([received(root).length, received(second).length]).toEqual(staffBefore);
    });

    it('le message porte l’heure de la décision, non celle de la demande', async () => {
      const holder = await member();
      const { id } = await request(holder, 'CREDIT', '5.00');
      // Demandé il y a vingt-six heures, approuvé à l'instant.
      await asOwner((owner) => ageAdjustment(owner, id, '26 hours'));
      const approved = await approve(id);
      const message = await nextMessageOf(testApp, holder.email, 'wallet_adjusted');
      const shown = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
      expect(shown(approved.requestedAt)).not.toBe(shown(approved.decidedAt!));
      expect(message.text).toContain(`Date : ${shown(approved.decidedAt!)}`);
      expect(message.text).not.toContain(shown(approved.requestedAt));
    });

    it('une demande refusée, retirée ou échue ne prévient personne', async () => {
      const holder = await member('10.00');
      const rejected = await request(holder, 'CREDIT', '1.00');
      await adjustments.reject(rejected.id, { note: NOTE }, actorOf(second));
      const cancelled = await request(holder, 'CREDIT', '2.00');
      await adjustments.cancel(cancelled.id, actorOf(root));
      await backgroundWorkDone(testApp);
      expect(received(holder)).toEqual([]);
      expect(
        await prisma.outboxEvent.count({
          where: {
            aggregateType: 'ledger_adjustment',
            aggregateId: { in: [rejected.id, cancelled.id] },
          },
        }),
      ).toBe(0);
    });

    it('un événement sans ajustement approuvé est abandonné ; un événement malformé est une erreur', async () => {
      const dispatcher = testApp.app.get(AdjustmentNoticeDispatcher);
      const holder = await member();
      const pending = await request(holder, 'CREDIT', '1.00');
      const envelope = (payload: Record<string, unknown>) => ({
        id: randomUUID(),
        aggregateType: 'ledger_adjustment',
        aggregateId: randomUUID(),
        eventType: 'ledger_adjustment.notice_requested',
        payload,
        metadata: {},
        occurredAt: new Date().toISOString(),
      });
      const rejected = await request(holder, 'CREDIT', '2.00');
      await adjustments.reject(rejected.id, { note: NOTE }, actorOf(second));
      const cancelled = await request(holder, 'CREDIT', '3.00');
      await adjustments.cancel(cancelled.id, actorOf(root));
      const expired = await request(holder, 'CREDIT', '4.00');
      await asOwner((owner) => ageAdjustment(owner, expired.id, '73 hours'));
      await adjustments.closeOverdue();
      expect(await statusOf(expired.id)).toBe('EXPIRED');

      // Inconnu, en attente, refusé, retiré, échu : rien n'a été passé, rien n'est annoncé.
      for (const id of [UNKNOWN_ID, pending.id, rejected.id, cancelled.id, expired.id]) {
        await dispatcher.handle(envelope({ adjustmentId: id }));
      }
      expect(received(holder)).toEqual([]);
      await expect(dispatcher.handle(envelope({}))).rejects.toThrow();
      await expect(dispatcher.handle(envelope({ adjustmentId: 'not-an-id' }))).rejects.toThrow();
    });

    it('un titulaire qui a clôturé son compte depuis n’est plus prévenu', async () => {
      const dispatcher = testApp.app.get(AdjustmentNoticeDispatcher);
      const holder = await member();
      const { id } = await credited(holder, '5.00');
      await nextMessageOf(testApp, holder.email, 'wallet_adjusted');
      const debit = await request(holder, 'DEBIT', '5.00');
      await approve(debit.id);
      await nextMessageOf(testApp, holder.email, 'wallet_adjusted', 2);
      await backgroundWorkDone(testApp);
      await testApp.app
        .get(AccountClosureService)
        .closeOwn(authOf(holder), { currentPassword: PASSWORD, confirm: true }, clientOf());
      const before = received(holder).length;
      const placeholder = `closed-${holder.id}@closed.invalid`;

      // L'événement est présenté de nouveau, après la clôture : aucun message ne part — ni à
      // l'ancienne adresse du compte, ni à l'adresse factice qu'il porte désormais.
      await dispatcher.handle({
        id: randomUUID(),
        aggregateType: 'ledger_adjustment',
        aggregateId: id,
        eventType: 'ledger_adjustment.notice_requested',
        payload: { adjustmentId: id },
        metadata: {},
        occurredAt: new Date().toISOString(),
      });
      expect(received(holder)).toHaveLength(before);
      expect(mailbox(testApp).messagesFor(placeholder)).toEqual([]);
    });

    it('sans moyen de remise configuré, l’événement est abandonné plutôt que retenté', async () => {
      const dispatcher = testApp.app.get(AdjustmentNoticeDispatcher);
      const notifications = testApp.app.get(NotificationService);
      const holder = await member();
      const { id } = await credited(holder, '5.00');
      await nextMessageOf(testApp, holder.email, 'wallet_adjusted');
      await backgroundWorkDone(testApp);
      const before = received(holder).length;

      const canDeliver = jest.spyOn(notifications, 'canDeliver').mockReturnValue(false);
      try {
        await dispatcher.handle({
          id: randomUUID(),
          aggregateType: 'ledger_adjustment',
          aggregateId: id,
          eventType: 'ledger_adjustment.notice_requested',
          payload: { adjustmentId: id },
          metadata: {},
          occurredAt: new Date().toISOString(),
        });
      } finally {
        canDeliver.mockRestore();
      }
      expect(received(holder).length).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('geler un portefeuille', () => {
    const FREEZE_REASON = 'Signalement du service conformité, dossier 2026-118';
    const LIFT_REASON = 'Vérification terminée, rien à signaler';
    const FREEZE_NOT_FOUND = { code: 'NOT_FOUND', message: 'Wallet freeze not found.' };

    it('gèle le portefeuille d’un actif, et lui seul ; le solde demeure', async () => {
      const holder = await member('40.00');
      await deposit(holder.id, '0.5', BTC);
      const before = await asApp(ledgerSize);

      const frozen = await freeze(holder);

      expect(frozen).toEqual({
        id: expect.stringMatching(UUID),
        userId: holder.id,
        asset: USD_VIEW,
        status: 'ACTIVE',
        reason: FREEZE_REASON,
        frozenBy: compliance.id,
        frozenAt: expect.stringMatching(ISO),
        liftedBy: null,
        liftedAt: null,
        liftReason: null,
      });
      // Geler ne passe aucune écriture.
      expect(await asApp(ledgerSize)).toEqual(before);
      // Le titulaire voit son portefeuille gelé — et celui-là seulement.
      expect((await wallets.list(holder.id)).wallets).toEqual([
        {
          asset: { code: 'BTC', name: 'Asset BTC', kind: 'CRYPTO', scale: 8 },
          available: '0.50000000',
          frozen: false,
        },
        { asset: USD_VIEW, available: '40.00', frozen: true },
      ]);
      expect((await wallets.movements(holder.id, 'USD', { limit: 20 })).wallet).toEqual({
        asset: USD_VIEW,
        available: '40.00',
        frozen: true,
      });
      expect((await wallets.movements(holder.id, 'BTC', { limit: 20 })).wallet.frozen).toBe(false);
      expect(await reader.isWalletFrozen(prisma, holder.id, 'USD')).toBe(true);
      expect(await reader.isWalletFrozen(prisma, holder.id, 'BTC')).toBe(false);
    });

    it('le journal d’audit garde la raison ; l’historique du titulaire, le gel — sans elle', async () => {
      const holder = await member();
      const frozen = await freeze(holder);
      expect(await auditOf(compliance, 'user.wallet_frozen')).toContainEqual({
        resourceType: 'user',
        resourceId: holder.id,
        outcome: 'SUCCESS',
        requestId: expect.any(String),
        metadata: { freezeId: frozen.id, assetCode: 'USD', reason: FREEZE_REASON },
      });
      expect(await activityOf(holder)).toEqual([
        {
          id: expect.stringMatching(UUID),
          type: 'WALLET_FROZEN',
          occurredAt: expect.stringMatching(ISO),
          outcome: 'SUCCESS',
          // Ni l'adresse ni l'appareil du membre du personnel ne regardent le titulaire.
          ipAddress: null,
          userAgent: null,
        },
      ]);
      // Aucun message ne part : le titulaire le voit sur son portefeuille.
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(holder.email)).toEqual([]);
    });

    it('un portefeuille jamais utilisé se gèle ; la copie des données dit lesquels le sont', async () => {
      const fresh = await member();
      await freeze(fresh, { assetCode: 'BTC' });
      expect(
        (await wallets.list(fresh.id)).wallets.map(({ asset, available, frozen }) => ({
          code: asset.code,
          available,
          frozen,
        })),
      ).toEqual([
        { code: 'BTC', available: '0.00000000', frozen: true },
        { code: 'USD', available: '0.00', frozen: false },
      ]);
      // Sans mouvement, il ne figure pas dans la copie ; avec, il y figure gelé.
      const data = testApp.app.get(LedgerAccountData);
      expect(await data.exportData(prisma, fresh.id)).toEqual({ wallets: [] });

      const holder = await member('12.00');
      await freeze(holder);
      const exported = await data.exportData(prisma, holder.id);
      expect(exported.wallets).toHaveLength(1);
      expect(exported.wallets![0]).toMatchObject({
        asset: USD_VIEW,
        available: '12.00',
        frozen: true,
        truncated: false,
      });
    });

    it('refuse ce qui ne se gèle pas : son propre portefeuille, un actif non tenu, un compte sans portefeuille', async () => {
      const holder = await member();
      const closed = await member();
      await testApp.app
        .get(AccountClosureService)
        .closeOwn(authOf(closed), { currentPassword: PASSWORD, confirm: true }, clientOf());
      const pending = await member(null, { status: 'PENDING_VERIFICATION' });

      expect(await refusalOf(() => freeze(compliance, { by: compliance }))).toEqual({
        code: 'FORBIDDEN',
        message: 'You cannot freeze your own wallet.',
      });
      expect((await auditOf(compliance, 'user.wallet_freeze_denied')).at(-1)).toMatchObject({
        resourceType: 'user',
        resourceId: compliance.id,
        outcome: 'DENIED',
        metadata: { reason: 'OWN_WALLET' },
      });
      expect(await refusalOf(() => freeze(holder, { assetCode: 'EUR' }))).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        errors: [{ path: 'assetCode', message: 'The platform does not keep this asset.' }],
      });
      expect(await refusalOf(() => freeze(UNKNOWN_ID))).toEqual(UNKNOWN_ACCOUNT);
      expect(await refusalOf(() => freeze(closed))).toEqual(CLOSED_ACCOUNT);
      expect(await refusalOf(() => freeze(pending))).toEqual({
        code: 'CONFLICT',
        message: 'This registration was never verified: it has no wallet.',
      });
      expect(await prisma.walletFreeze.count({ where: { userId: holder.id } })).toBe(0);

      // Un compte suspendu garde ses portefeuilles : ils se gèlent.
      const suspended = await member('5.00', { status: 'SUSPENDED' });
      expect((await freeze(suspended)).status).toBe('ACTIVE');
    });

    it('un compte clôturé à l’instant où le gel s’écrit : la base le refuse, et c’est dit', async () => {
      const holder = await member();
      const users = testApp.app.get(UserRepository);
      const read = users.findById.bind(users);
      // Le compte est actif quand le service le lit, clôturé quand le gel s'écrit : la clôture
      // est glissée juste après cette lecture.
      let closed = false;
      const reading = jest.spyOn(users, 'findById').mockImplementation(async (db, userId) => {
        const found = await read(db, userId);
        if (userId === holder.id && !closed) {
          closed = true;
          await testApp.app
            .get(AccountClosureService)
            .closeOwn(authOf(holder), { currentPassword: PASSWORD, confirm: true }, clientOf());
        }
        return found;
      });
      try {
        expect(await refusalOf(() => freeze(holder))).toEqual(CLOSED_ACCOUNT);
      } finally {
        reading.mockRestore();
      }
      expect(closed).toBe(true);
      expect(await prisma.walletFreeze.count({ where: { userId: holder.id } })).toBe(0);
    });

    it('un portefeuille ne se gèle pas deux fois ; la base refuse le gel de qui n’en a pas le droit', async () => {
      const holder = await member();
      await freeze(holder);
      expect(await refusalOf(() => freeze(holder))).toEqual({
        code: 'CONFLICT',
        message: 'This wallet is already frozen.',
      });
      expect(await refusalOf(() => freeze(holder, { by: second }))).toMatchObject({
        code: 'CONFLICT',
      });
      // Dans un autre actif, si.
      expect((await freeze(holder, { assetCode: 'BTC', by: second })).status).toBe('ACTIVE');

      const other = await member();
      for (const author of [support, await member()]) {
        expect(await refusalOf(() => freeze(other, { by: author }))).toEqual(NO_LONGER_ENTITLED);
      }
      expect(await prisma.walletFreeze.count({ where: { userId: other.id } })).toBe(0);
    });

    it('lever un gel : une autre permission ; le portefeuille redevient utilisable, le gel reste', async () => {
      const holder = await member('40.00');
      const frozen = await freeze(holder);

      // La conformité gèle ; elle ne lève pas.
      expect(await refusalOf(() => lift(frozen.id, compliance))).toEqual(NO_LONGER_ENTITLED);
      expect(await refusalOf(() => lift(frozen.id, support))).toEqual(NO_LONGER_ENTITLED);
      expect(await reader.isWalletFrozen(prisma, holder.id, 'USD')).toBe(true);

      const lifted = await lift(frozen.id);
      expect(lifted).toEqual({
        ...frozen,
        status: 'LIFTED',
        liftedBy: second.id,
        liftedAt: expect.stringMatching(ISO),
        liftReason: LIFT_REASON,
      });
      expect(Date.parse(lifted.liftedAt!)).toBeGreaterThanOrEqual(Date.parse(lifted.frozenAt));
      expect(await reader.isWalletFrozen(prisma, holder.id, 'USD')).toBe(false);
      expect((await wallets.list(holder.id)).wallets.map(({ frozen: state }) => state)).toEqual([
        false,
        false,
      ]);
      expect(await auditOf(second, 'user.wallet_unfrozen')).toContainEqual({
        resourceType: 'user',
        resourceId: holder.id,
        outcome: 'SUCCESS',
        requestId: expect.any(String),
        metadata: { freezeId: frozen.id, assetCode: 'USD', reason: LIFT_REASON },
      });
      expect((await activityOf(holder)).map(({ type }) => type)).toEqual([
        'WALLET_UNFROZEN',
        'WALLET_FROZEN',
      ]);

      expect(await refusalOf(() => lift(frozen.id))).toEqual({
        code: 'CONFLICT',
        message: 'This freeze was already lifted.',
      });
      expect(await refusalOf(() => lift(UNKNOWN_ID))).toEqual(FREEZE_NOT_FOUND);
      // Levé, le gel reste ; le portefeuille se gèle de nouveau.
      const again = await freeze(holder);
      expect(again.id).not.toBe(frozen.id);
      expect(await prisma.walletFreeze.count({ where: { userId: holder.id } })).toBe(2);
    });

    it('nul ne lève le gel de son propre portefeuille', async () => {
      const frozen = await freeze(second, { by: compliance });
      expect(await refusalOf(() => lift(frozen.id, second))).toEqual({
        code: 'FORBIDDEN',
        message: 'You cannot lift the freeze of your own wallet.',
      });
      expect((await auditOf(second, 'user.wallet_unfreeze_denied')).at(-1)).toMatchObject({
        resourceType: 'user',
        resourceId: second.id,
        outcome: 'DENIED',
        metadata: { reason: 'OWN_WALLET' },
      });
      // Un autre administrateur le lève — ce qui rend aussi son portefeuille aux autres essais.
      expect((await lift(frozen.id, root)).status).toBe('LIFTED');
    });

    it('de deux levées simultanées, une seule s’applique', async () => {
      const holder = await member();
      const frozen = await freeze(holder);
      const outcomes = await Promise.allSettled([
        lift(frozen.id, second),
        lift(frozen.id, root),
        lift(frozen.id, second),
      ]);
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect((outcome.reason as AppError).code).toBe('CONFLICT');
        }
      }
      expect(
        await prisma.auditLog.count({
          where: { action: 'user.wallet_unfrozen', resourceId: holder.id },
        }),
      ).toBe(1);
    });

    it('les gels se consultent du plus récent au plus ancien, par titulaire ou par état — et c’est tracé', async () => {
      const holder = await member();
      const first = await freeze(holder);
      await lift(first.id);
      const btc = await freeze(holder, { assetCode: 'BTC' });
      const usd = await freeze(holder);

      const all = await freezes.list({ userId: holder.id, limit: 20 }, actorOf(compliance));
      expect(all.freezes.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: usd.id, status: 'ACTIVE' },
        { id: btc.id, status: 'ACTIVE' },
        { id: first.id, status: 'LIFTED' },
      ]);
      expect(all.nextCursor).toBeNull();
      expect(all.freezes[2]).toMatchObject({
        asset: USD_VIEW,
        liftedBy: second.id,
        liftReason: LIFT_REASON,
      });
      const byStatus = async (status: 'ACTIVE' | 'LIFTED') =>
        (
          await freezes.list({ userId: holder.id, status, limit: 20 }, actorOf(compliance))
        ).freezes.map(({ id }) => id);
      expect(await byStatus('ACTIVE')).toEqual([usd.id, btc.id]);
      expect(await byStatus('LIFTED')).toEqual([first.id]);
      // Sans filtre de titulaire : ceux de tous.
      const everywhere = await freezes.list({ status: 'ACTIVE', limit: 100 }, actorOf(compliance));
      expect(everywhere.freezes.map(({ id }) => id)).toEqual(
        expect.arrayContaining([usd.id, btc.id]),
      );
      expect(everywhere.freezes.every(({ status }) => status === 'ACTIVE')).toBe(true);

      // Page par page, sans rien répéter ni omettre. Le parcours est borné.
      const pages: string[][] = [];
      let after: string | undefined;
      do {
        const page = await freezes.list(
          { userId: holder.id, limit: 2, ...(after === undefined ? {} : { after }) },
          actorOf(compliance),
        );
        pages.push(page.freezes.map(({ id }) => id));
        after = page.nextCursor ?? undefined;
      } while (after !== undefined && pages.length < 5);
      expect(pages).toEqual([[usd.id, btc.id], [first.id]]);
      expect(
        (await freezes.list({ userId: holder.id, limit: 3 }, actorOf(compliance))).nextCursor,
      ).toBeNull();
      expect(
        await refusalOf(() =>
          freezes.list({ limit: 20, after: 'bm90LWEtY3Vyc29y' }, actorOf(compliance)),
        ),
      ).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'after' }] });

      const listed = await auditOf(compliance, 'wallet_freeze.listed_by_admin');
      expect(listed).toContainEqual(
        expect.objectContaining({
          resourceType: 'wallet_freeze',
          resourceId: null,
          outcome: 'SUCCESS',
          metadata: { userId: holder.id, status: 'LIFTED', limit: 20, results: 1 },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('un portefeuille gelé', () => {
    const WALLET_FROZEN = {
      code: 'WALLET_FROZEN',
      message: 'Your wallet in this asset is frozen. Please contact support.',
    };
    const RECIPIENT_UNAVAILABLE = {
      code: 'RECIPIENT_UNAVAILABLE',
      message: 'This recipient cannot receive transfers.',
    };
    const transferCount = (): Promise<number> => prisma.transfer.count();

    it('le grand livre n’y passe aucune écriture, ni débit ni crédit — et le dit sans rien écrire', async () => {
      const holder = await member('40.00');
      await freeze(holder);
      const before = await asApp(ledgerSize);
      const amount = Money.parse('1.00', USD);

      for (const [walletSide, custodySide] of [
        ['DEBIT', 'CREDIT'],
        ['CREDIT', 'DEBIT'],
      ] as const) {
        const posting = ledger.post({
          idempotencyKey: `test:${randomUUID()}`,
          kind: 'test.entry',
          actor: SYSTEM,
          postings: [
            { account: userAccount(holder.id), side: walletSide, amount },
            { account: custody, side: custodySide, amount },
          ],
        });
        await expect(posting).rejects.toBeInstanceOf(WalletFrozenError);
        await expect(posting).rejects.toMatchObject({
          wallet: { userId: holder.id, assetCode: 'USD' },
        });
      }
      expect(await asApp(ledgerSize)).toEqual(before);
      expect(await balanceOf(holder)).toBe(4_000n);

      // Un autre actif du même titulaire n'est pas gelé.
      await deposit(holder.id, '0.1', BTC);
      expect(await balanceOf(holder, 'BTC')).toBe(10_000_000n);
    });

    it('la base le refuse elle aussi, si le contrôle de l’application est contourné', async () => {
      const holder = await member('40.00');
      const frozen = await freeze(holder);
      const amount = Money.parse('1.00', USD);
      const before = await asApp(ledgerSize);
      // Une transaction ouverte avant la levée du gel ne voit que ce que la base lui montre :
      // ici, le contrôle applicatif est neutralisé pour atteindre celui de la base.
      const repository = testApp.app.get(WalletFreezeRepository);
      const blind = jest.spyOn(repository, 'frozenAmong').mockResolvedValue([]);
      try {
        await expect(
          ledger.post({
            idempotencyKey: `test:${randomUUID()}`,
            kind: 'test.entry',
            actor: SYSTEM,
            postings: [
              { account: custody, side: 'DEBIT', amount },
              { account: userAccount(holder.id), side: 'CREDIT', amount },
            ],
          }),
        ).rejects.toMatchObject({ name: 'WalletFrozenError', wallet: null });
      } finally {
        blind.mockRestore();
      }
      expect(await asApp(ledgerSize)).toEqual(before);
      await lift(frozen.id);
      await deposit(holder.id, '1.00');
      expect(await balanceOf(holder)).toBe(4_100n);
    });

    it('rien n’en part : le transfert est refusé à son titulaire, sans la raison — avant tout autre examen', async () => {
      const sender = await member('500.00');
      const recipient = await member();
      await freeze(sender);
      const transfersBefore = await transferCount();

      expect(await refusalOf(() => send(sender, recipient, '10.00'))).toEqual(WALLET_FROZEN);
      // Au-delà du plafond, au-delà du solde, vers une adresse sans compte : le même refus.
      expect(await refusalOf(() => send(sender, recipient, '150.00'))).toEqual(WALLET_FROZEN);
      expect(await refusalOf(() => send(sender, recipient, '900.00'))).toEqual(WALLET_FROZEN);
      expect(
        await refusalOf(() =>
          transfers.create(
            authOf(sender),
            {
              recipientEmail: 'personne@example.cd',
              assetCode: 'USD',
              amount: '10.00',
              currentPassword: sender.password,
            },
            freshKey(),
            clientOf(),
          ),
        ),
      ).toEqual(WALLET_FROZEN);
      expect(await transferCount()).toBe(transfersBefore);
      expect(await balanceOf(sender)).toBe(50_000n);
      expect((await auditOf(sender, 'transfer.refused')).at(-1)).toMatchObject({
        outcome: 'DENIED',
        metadata: { reason: 'WALLET_FROZEN', assetCode: 'USD', amount: '10.00' },
      });
      expect((await activityOf(sender)).map(({ type }) => type)).toEqual([
        'TRANSFER_REFUSED',
        'TRANSFER_REFUSED',
        'TRANSFER_REFUSED',
        'TRANSFER_REFUSED',
        'WALLET_FROZEN',
      ]);
    });

    it('rien n’y arrive : pour l’émetteur, c’est le refus unique du destinataire', async () => {
      const sender = await member('500.00');
      const recipient = await member();
      const frozen = await freeze(recipient);
      const transfersBefore = await transferCount();

      expect(await refusalOf(() => send(sender, recipient, '10.00'))).toEqual(
        RECIPIENT_UNAVAILABLE,
      );
      expect(await transferCount()).toBe(transfersBefore);
      expect(await balanceOf(sender)).toBe(50_000n);
      expect(await balanceOf(recipient)).toBe(0n);
      // Le refus dit lequel au journal d'audit — pas à l'émetteur.
      expect((await auditOf(sender, 'transfer.refused')).at(-1)).toMatchObject({
        metadata: { reason: 'RECIPIENT_UNAVAILABLE', recipientId: recipient.id },
      });
      // Les fonds et les plafonds passent avant : ce refus-là vient en dernier.
      expect(await refusalOf(() => send(sender, recipient, '900.00'))).toMatchObject({
        code: 'TRANSFER_LIMIT_EXCEEDED',
      });

      // Le gel levé, le même transfert passe ; et le destinataire envoie à son tour.
      await lift(frozen.id);
      await send(sender, recipient, '10.00');
      await send(recipient, sender, '4.00');
      expect(await balanceOf(recipient)).toBe(600n);
    });

    it('un gel posé pendant une rafale de transferts : aucun n’aboutit après lui', async () => {
      const sender = await member('500.00');
      const recipient = await member();
      const transfersBefore = await transferCount();

      const [frozen, ...attempts] = await Promise.all([
        freeze(sender),
        ...Array.from({ length: 6 }, () =>
          send(sender, recipient, '1.00').then(
            ({ transfer }) => transfer,
            (error: unknown) => error,
          ),
        ),
      ]);

      const done = attempts.filter((outcome) => !(outcome instanceof Error));
      const refused = attempts.filter((outcome) => outcome instanceof Error);
      for (const error of refused) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('WALLET_FROZEN');
      }
      // Ce qui a abouti l'a fait avant le gel, et les soldes le disent au centime.
      expect(await transferCount()).toBe(transfersBefore + done.length);
      expect(await balanceOf(sender)).toBe(50_000n - BigInt(done.length) * 100n);
      expect(await balanceOf(recipient)).toBe(BigInt(done.length) * 100n);
      const rows = await prisma.transfer.findMany({ where: { senderId: sender.id } });
      for (const { createdAt } of rows) {
        expect(createdAt.getTime()).toBeLessThanOrEqual(Date.parse(frozen.frozenAt));
      }
      // Et plus rien ne part ensuite.
      expect(await refusalOf(() => send(sender, recipient, '1.00'))).toEqual(WALLET_FROZEN);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('clôture d’un compte', () => {
    const closure = {
      own: (holder: Member) =>
        testApp.app
          .get(AccountClosureService)
          .closeOwn(authOf(holder), { currentPassword: PASSWORD, confirm: true }, clientOf()),
      byStaff: (holder: Member, by: Member) =>
        testApp.app.get(AccountClosureService).closeByStaff(
          holder.id,
          {
            ground: 'PLATFORM_DECISION',
            reason: 'Fin de la relation, décision du comité',
            confirm: true,
          },
          actorOf(by),
        ),
    };

    it('un portefeuille gelé retient la clôture — par le titulaire comme par le personnel ; le gel levé, elle passe', async () => {
      const holder = await member();
      const frozen = await freeze(holder);
      const blocked = {
        code: 'CONFLICT',
        message:
          'The account cannot be closed: one of its wallets is frozen, and the freeze must be lifted first.',
      };
      expect(await refusalOf(() => closure.own(holder))).toEqual(blocked);
      expect(await refusalOf(() => closure.byStaff(holder, compliance))).toEqual(blocked);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: holder.id } })).status).toBe(
        'ACTIVE',
      );

      await lift(frozen.id);
      await closure.own(holder);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: holder.id } })).status).toBe(
        'CLOSED',
      );
      // Le gel levé reste, comme sa trace au journal d'audit.
      expect(await prisma.walletFreeze.count({ where: { userId: holder.id } })).toBe(1);
    });

    it('des fonds et un gel : la clôture cite les deux', async () => {
      const holder = await member('5.00');
      await freeze(holder);
      expect(await refusalOf(() => closure.own(holder))).toEqual({
        code: 'CONFLICT',
        message:
          'The account cannot be closed: it still holds funds, which must be withdrawn or transferred first; one of its wallets is frozen, and the freeze must be lifted first.',
      });
    });

    it('sortir les fonds d’un compte suspendu, puis le clôturer : un débit sous double validation', async () => {
      const holder = await member('120.00', { status: 'SUSPENDED' });
      // Suspendu, le compte ne peut rien envoyer ; tant qu'il détient des fonds, il ne se clôt pas.
      expect(await refusalOf(() => closure.byStaff(holder, compliance))).toMatchObject({
        code: 'CONFLICT',
        message: expect.stringMatching(/it still holds funds/),
      });

      const exit = await request(holder, 'DEBIT', '120.00', {
        reason: 'Restitution des fonds par virement, avant clôture du compte',
      });
      await approve(exit.id);
      expect(await balanceOf(holder)).toBe(0n);

      await closure.byStaff(holder, compliance);
      const closed = await prisma.user.findUniqueOrThrow({ where: { id: holder.id } });
      expect(closed.status).toBe('CLOSED');
      // L'ajustement et son écriture demeurent ; le titulaire n'y a plus d'adresse.
      expect(await adjustments.get(exit.id, actorOf(second))).toMatchObject({
        status: 'APPROVED',
        user: { id: holder.id, email: null },
      });
      // Des écritures ont été passées : les identifiants du compte sont gardés dix ans.
      const record = await prisma.accountClosure.findUniqueOrThrow({
        where: { userId: holder.id },
      });
      expect(record.legalRetentionUntil).not.toBeNull();
    });
  });

  describe('vérification du grand livre', () => {
    it('après toutes les opérations de ce fichier, la vérification horaire ne relève rien', async () => {
      // Les trois contrôles — grand livre, transferts, ajustements — relisent tout ce que les
      // tests de ce fichier ont écrit par les services : une opération réelle ne produit
      // aucune anomalie.
      expect(
        await prisma.ledgerAdjustment.count({ where: { status: 'APPROVED' } }),
      ).toBeGreaterThan(0);
      const { entries } = await asApp(ledgerSize);
      expect(await testApp.app.get(LedgerVerification).run()).toBe(entries);
    });
  });
});
