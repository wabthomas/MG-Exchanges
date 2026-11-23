import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { LEDGER_ENTRY_KIND_KEYS } from '@mgx/contracts';
import { PinoLogger } from 'nestjs-pino';
import type pg from 'pg';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import {
  type LedgerCheck,
  LedgerCheckRegistry,
} from '../../src/modules/ledger/application/ledger-check.registry.js';
import {
  LEDGER_OWN_CHECK,
  LEDGER_VERIFICATION_MAX_ANOMALIES,
  LedgerVerification,
  LedgerVerificationError,
  LedgerVerificationIncompleteError,
} from '../../src/modules/ledger/application/ledger-verification.js';
import {
  type LedgerAnomaly,
  LedgerRepository,
} from '../../src/modules/ledger/application/ledger.repository.js';
import {
  insertEntryHeader,
  insertPostings,
  LEDGER_TABLES,
  ledgerSize,
  openLedgerAccount,
  OPERATION_TABLES,
  registerAssetInSql,
  registerEntryKindsInSql,
  tamperWithLedger,
} from '../support/ledger-sql.js';
import {
  approveInSql,
  insertAdjustmentRow,
  updateAdjustment,
} from '../support/staff-operations-sql.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { sqlState, withConnection } from '../support/test-database.js';
import { withAdmin } from '../support/test-environment.js';
import { setLimitInSql, transferInSql, verifyUpTo } from '../support/transfers-sql.js';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

/** Une altération : ce que seul le propriétaire du schéma — ou un superutilisateur — peut écrire. */
type Tamper = (db: pg.Client) => Promise<unknown>;

const sql =
  (text: string, parameters: unknown[] = []): Tamper =>
  (db) =>
    db.query(text, parameters);

const sorted = (found: readonly LedgerAnomaly[]): LedgerAnomaly[] =>
  [...found].sort((left, right) =>
    `${left.kind}|${left.subject}`.localeCompare(`${right.kind}|${right.subject}`),
  );

/** Erreur levée par `action`, ou échec du test si elle n'en lève aucune. */
async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to be refused.');
}

/** Les lignes d'erreur de la vérification, parmi tout ce que l'application journalise. */
const verificationLines = (logged: { mock: { calls: unknown[][] } }): unknown[][] =>
  logged.mock.calls.filter(
    ([, message]) => typeof message === 'string' && message.startsWith('Ledger verification'),
  );

interface Holder {
  readonly user: string;
  /** Compte « fonds disponibles » en dollars. */
  readonly account: string;
}

/** Un ajustement approuvé, son écriture et ses deux lignes. */
interface Adjustment {
  readonly id: string;
  readonly entry: string;
  readonly walletLine: string;
  readonly custodyLine: string;
}

/** Un transfert, son écriture et ses deux lignes. */
interface Transfer {
  readonly id: string;
  readonly entry: string;
  readonly debitLine: string;
  readonly creditLine: string;
}

/**
 * La base est ici **telle que les migrations la laissent** — aucun type d'essai ne lui est
 * déclaré — et ne contient que ce que le produit écrit : des ajustements approuvés et des
 * transferts, chacun avec son écriture. Chaque scénario l'altère comme seul le propriétaire du
 * schéma peut le faire, relève ce que la vérification périodique en dit, puis la remet en état.
 */
describe('Vérification du grand livre — types d’écriture et opérations (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let verification: LedgerVerification;
  let maintenance: AccountMaintenanceService;
  let checks: LedgerCheckRegistry;
  /** Deux administrateurs (rôle super_admin) : l'un demande un ajustement, l'autre l'approuve. */
  let admin: string;
  let second: string;
  let custody: string;

  // Ce que contient le grand livre : Alice reçoit 100,00 $ par un ajustement, en envoie 2,50 à
  // Bob, puis est débitée de 5,00 $ par un second ajustement. Carol n'a rien reçu ni envoyé.
  let alice: Holder;
  let bob: Holder;
  let carol: Holder;
  let funding: Adjustment;
  let transfer: Transfer;
  let debit: Adjustment;

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = testApp.app.get(PrismaService);
    verification = testApp.app.get(LedgerVerification);
    maintenance = testApp.app.get(AccountMaintenanceService);
    checks = testApp.app.get(LedgerCheckRegistry);
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      second = await insertStaff(db, 'super_admin');
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await setLimitInSql(db, 'USD', 1, [1000, 2500, 10_000]);
    });
    await asApp(async (db) => {
      custody = await openLedgerAccount(db, 'platform_custody', 'USD');
      alice = await holder(db);
      bob = await holder(db);
      carol = await holder(db);
      funding = await adjust(db, alice, 'CREDIT', 10_000);
      // Les plafonds de l'actif sont fixés pour le niveau 1 : les deux parties y sont portées.
      await verifyUpTo(db, alice.user, 1, admin);
      await verifyUpTo(db, bob.user, 1, admin);
      const sent = await transferInSql(db, {
        sender: alice.user,
        senderAccount: alice.account,
        recipient: bob.user,
        recipientAccount: bob.account,
        amount: 250,
      });
      transfer = {
        id: sent.transferId,
        entry: sent.entryId,
        debitLine: await lineOf(db, sent.entryId, alice.account),
        creditLine: await lineOf(db, sent.entryId, bob.account),
      };
      debit = await adjust(db, alice, 'DEBIT', 500);

      // Des demandes qui n'ont pas d'écriture, et n'ont pas à en avoir : en attente, refusée,
      // retirée par son auteur.
      await insertAdjustmentRow(db, { user_id: bob.user, requested_by: admin, amount: 1 });
      const rejected = await insertAdjustmentRow(db, {
        user_id: bob.user,
        requested_by: admin,
        amount: 2,
      });
      await updateAdjustment(db, rejected, {
        status: 'REJECTED',
        decided_by: second,
        decision_note: 'No receipt.',
      });
      const cancelled = await insertAdjustmentRow(db, {
        user_id: bob.user,
        requested_by: admin,
        amount: 3,
      });
      await updateAdjustment(db, cancelled, { status: 'CANCELLED', decided_by: admin });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await testApp.close();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(testApp.database.ownerUrl, work);

  let sequence = 0;
  async function insertUser(db: pg.Client): Promise<string> {
    sequence += 1;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, country_code, registered_at, status, email_verified_at)
       VALUES ($1, 'CD', now(), 'ACTIVE', now()) RETURNING id`,
      [`ledger-verification${String(sequence)}@example.cd`],
    );
    return rows[0]!.id;
  }

  async function insertStaff(owner: pg.Client, roleKey: string): Promise<string> {
    const id = await insertUser(owner);
    await owner.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`,
      [id, roleKey],
    );
    return id;
  }

  /** Un titulaire actif et son compte « fonds disponibles » en dollars, vide. */
  async function holder(db: pg.Client): Promise<Holder> {
    const user = await insertUser(db);
    return { user, account: await openLedgerAccount(db, 'user_available', 'USD', user) };
  }

  /** La ligne qu'une écriture passe sur un compte. */
  async function lineOf(db: pg.Client, entry: string, account: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ledger_postings WHERE entry_id = $1 AND account_id = $2`,
      [entry, account],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  /** Un ajustement par la seule voie du produit : demandé par l'un, approuvé par l'autre. */
  async function adjust(
    db: pg.Client,
    wallet: Holder,
    direction: 'CREDIT' | 'DEBIT',
    amount: number,
  ): Promise<Adjustment> {
    const id = await insertAdjustmentRow(db, {
      user_id: wallet.user,
      requested_by: admin,
      direction,
      amount,
    });
    const entry = await approveInSql(db, id, second, {
      direction,
      holderAccount: wallet.account,
      custodyAccount: custody,
      amount,
    });
    return {
      id,
      entry,
      walletLine: await lineOf(db, entry, wallet.account),
      custodyLine: await lineOf(db, entry, custody),
    };
  }

  /**
   * Ce que relève l'étape horaire, telle que la tâche de maintenance l'exécute : les contrôles
   * du grand livre, puis ceux que les transferts et les ajustements y ont inscrits.
   */
  async function anomalies(): Promise<LedgerAnomaly[]> {
    try {
      await verification.run();
      return [];
    } catch (error) {
      if (error instanceof LedgerVerificationError) {
        return sorted(error.anomalies);
      }
      throw error;
    }
  }

  /** Écrit ce que les règles de la base refusent : celles des cinq tables sont neutralisées. */
  const tamper = (work: Tamper): Promise<void> =>
    asOwner((owner) =>
      tamperWithLedger(
        owner,
        async (db) => {
          await work(db);
        },
        [...LEDGER_TABLES, ...OPERATION_TABLES],
      ),
    );

  /** Le même, clés étrangères comprises : il y faut un superutilisateur. */
  const tamperWithoutForeignKeys = (work: Tamper): Promise<void> =>
    withAdmin(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL session_replication_role = replica`);
        await work(db);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }, testApp.database.name);

  /** Altère, relève les anomalies, remet en état — et vérifie qu'il n'en reste aucune. */
  async function anomaliesOf(
    alter: Tamper,
    restore: Tamper,
    write: (work: Tamper) => Promise<void> = tamper,
  ): Promise<LedgerAnomaly[]> {
    await write(alter);
    let found: LedgerAnomaly[];
    try {
      found = await anomalies();
    } finally {
      await write(restore);
    }
    expect(await anomalies()).toEqual([]);
    return found;
  }

  /** Une altération d'une colonne, et sa remise en état. */
  const column = (
    table: string,
    id: string,
    name: string,
    altered: string,
    parameters: unknown[] = [],
  ): [Tamper, Tamper] => [
    async (db) => {
      // La valeur d'origine est gardée dans la base : elle n'en sort pas, et y revient telle quelle.
      await db.query(
        `CREATE TABLE tampered AS SELECT id, ${name} FROM ${table} WHERE id = '${id}'`,
      );
      const { rowCount } = await db.query(
        `UPDATE ${table} SET ${name} = ${altered} WHERE id = $1`,
        [id, ...parameters],
      );
      expect(rowCount).toBe(1);
    },
    async (db) => {
      const { rowCount } = await db.query(
        `UPDATE ${table} AS t SET ${name} = saved.${name} FROM tampered AS saved
         WHERE t.id = saved.id`,
      );
      expect(rowCount).toBe(1);
      await db.query(`DROP TABLE tampered`);
    },
  ];

  /** La suppression d'une ligne, et son rétablissement à l'identique. */
  const removal = (table: string, id: string): [Tamper, Tamper] => [
    async (db) => {
      await db.query(`CREATE TABLE tampered AS SELECT * FROM ${table} WHERE id = '${id}'`);
      const { rowCount } = await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      expect(rowCount).toBe(1);
    },
    async (db) => {
      const { rowCount } = await db.query(`INSERT INTO ${table} SELECT * FROM tampered`);
      expect(rowCount).toBe(1);
      await db.query(`DROP TABLE tampered`);
    },
  ];

  /** Vérifie une liste de scénarios : chacun dit ce qu'il altère, et ce qui doit en être relevé. */
  async function expectEach(
    scenarios: readonly (readonly [
      title: string,
      alteration: [Tamper, Tamper],
      expected: LedgerAnomaly[],
    ])[],
    write: (work: Tamper) => Promise<void> = tamper,
  ): Promise<void> {
    for (const [title, [alter, restore], expected] of scenarios) {
      expect({ title, found: await anomaliesOf(alter, restore, write) }).toEqual({
        title,
        found: sorted(expected),
      });
    }
  }

  const unknownKind = (entry: string): LedgerAnomaly => ({
    kind: 'ENTRY_KIND_UNKNOWN',
    subject: entry,
  });
  const unsound = (entry: string): LedgerAnomaly => ({ kind: 'ENTRY_UNSOUND', subject: entry });
  const brokenChain = (line: string): LedgerAnomaly => ({
    kind: 'POSTING_CHAIN_BROKEN',
    subject: line,
  });
  const wrongAsset = (line: string): LedgerAnomaly => ({
    kind: 'POSTING_ASSET_MISMATCH',
    subject: line,
  });
  const transferMismatch = (id: string): LedgerAnomaly => ({
    kind: 'TRANSFER_ENTRY_MISMATCH',
    subject: id,
  });
  const withoutTransfer = (entry: string): LedgerAnomaly => ({
    kind: 'ENTRY_WITHOUT_TRANSFER',
    subject: entry,
  });
  const adjustmentMismatch = (id: string): LedgerAnomaly => ({
    kind: 'ADJUSTMENT_ENTRY_MISMATCH',
    subject: id,
  });
  const withoutAdjustment = (entry: string): LedgerAnomaly => ({
    kind: 'ENTRY_WITHOUT_ADJUSTMENT',
    subject: entry,
  });

  describe('un grand livre sain', () => {
    it('ne présente aucune anomalie : l’étape rend le nombre d’écritures vérifiées', async () => {
      const { entries } = await asApp(ledgerSize);
      // Un crédit, un transfert, un débit — et rien d'autre : ni type d'essai, ni écriture d'essai.
      expect(entries).toBe(3);
      expect(await verification.run()).toBe(3);

      const report = await maintenance.run();
      expect(report.failures).toBe(0);
      expect(report.otherSteps['verify-ledger']).toBe(3);
      expect(await prisma.auditLog.count({ where: { action: 'ledger.verification_failed' } })).toBe(
        0,
      );
    });

    it('les transferts et les ajustements ont inscrit leur contrôle, une fois chacun', () => {
      expect(
        checks
          .checks()
          .map(({ name }) => name)
          .sort(),
      ).toEqual(['adjustments', 'transfers']);
      expect(LEDGER_OWN_CHECK).toBe('ledger');
    });
  });

  describe('le type d’une écriture', () => {
    it('une écriture d’un type que la base ne connaît pas est relevée — avec l’opération qui n’a plus la sienne', async () => {
      await expectEach([
        [
          'the entry of a transfer',
          column('ledger_entries', transfer.entry, 'kind', `'gift.card'`),
          [unknownKind(transfer.entry), transferMismatch(transfer.id)],
        ],
        [
          'the entry of a credit',
          column('ledger_entries', funding.entry, 'kind', `'gift.card'`),
          [unknownKind(funding.entry), adjustmentMismatch(funding.id)],
        ],
        [
          'the entry of a debit',
          column('ledger_entries', debit.entry, 'kind', `'adjustment.refund'`),
          [unknownKind(debit.entry), adjustmentMismatch(debit.id)],
        ],
      ]);
      // Un type se compare en entier : ni le début, ni la fin, ni le prolongement d'un type connu
      // n'en est un.
      for (const kind of [
        'transfer',
        'internal',
        'transfer.internal_fee',
        'transfer.internal.fee',
        'staff.transfer.internal',
        'adjustment',
        'adjustment.credit_note',
      ]) {
        const [alter, restore] = column('ledger_entries', transfer.entry, 'kind', '$2', [kind]);
        expect({ kind, found: await anomaliesOf(alter, restore) }).toEqual({
          kind,
          found: sorted([unknownKind(transfer.entry), transferMismatch(transfer.id)]),
        });
      }
    });

    it('une écriture saine passée pendant que la règle était neutralisée est relevée, à chaque passage, tant que la base ne connaît pas son type', async () => {
      // Ce que contient une base où une écriture a été passée en SQL avant que la liste des
      // types n'existe : une écriture équilibrée, entière — d'un type qu'aucune opération ne
      // passe.
      const rule = 'ledger_entries_kind_known';
      await asOwner((owner) => owner.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ${rule}`));
      let seed = '';
      try {
        await asOwner(async (owner) => {
          // Les autres règles restent en vigueur : l'écriture est entière et équilibrée, et la
          // base la vérifie à la validation.
          await owner.query('BEGIN');
          seed = await insertEntryHeader(owner, 2, { kind: 'preview.seed' });
          await insertPostings(owner, seed, [
            { account: custody, side: 'DEBIT', amount: 700 },
            { account: carol.account, side: 'CREDIT', amount: 700 },
          ]);
          await owner.query('COMMIT');
        });
      } finally {
        await asOwner((owner) => owner.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ${rule}`));
      }
      // La règle est de nouveau en vigueur : la base refuse désormais ce type.
      expect(
        await asOwner((owner) =>
          sqlState(() => insertEntryHeader(owner, 2, { kind: 'preview.seed' })),
        ),
      ).toBe('MGX13');

      expect(await anomalies()).toEqual([unknownKind(seed)]);
      // Rien n'est corrigé, et rien ne s'oublie : le passage suivant la relève encore.
      expect(await anomalies()).toEqual([unknownKind(seed)]);
      const report = await maintenance.run();
      expect(report.failures).toBe(1);
      expect(report.otherSteps['verify-ledger']).toBe(0);

      // Le type se compare à la liste que la base consulte à l'écriture, non à celle du code :
      // une fois ce type déclaré par le propriétaire, l'écriture n'est plus une anomalie. C'est
      // aussi une limite — un type déclaré hors d'une migration n'est lié à aucune opération, et
      // la vérification ne le relève pas.
      await asOwner((owner) => registerEntryKindsInSql(owner, ['preview.seed']));
      expect(await anomalies()).toEqual([]);
      expect(await verification.run()).toBe(4);
    });
  });

  describe('un transfert et son écriture', () => {
    it('un transfert qui ne dit plus ce que son écriture a déplacé est relevé', async () => {
      const mismatch = [transferMismatch(transfer.id)];
      await expectEach([
        ['amount', column('transfers', transfer.id, 'amount', 'amount + 1'), mismatch],
        ['asset', column('transfers', transfer.id, 'asset_code', `'CDF'`), mismatch],
        ['sender', column('transfers', transfer.id, 'sender_id', '$2', [carol.user]), mismatch],
        [
          'recipient',
          column('transfers', transfer.id, 'recipient_id', '$2', [carol.user]),
          mismatch,
        ],
      ]);
    });

    it('une ligne altérée de son écriture est relevée — avec ce que le grand livre en dit lui-même', async () => {
      const { id, entry, debitLine, creditLine } = transfer;
      await expectEach([
        [
          'debit line: amount',
          column('ledger_postings', debitLine, 'amount', 'amount + 1'),
          [unsound(entry), brokenChain(debitLine), transferMismatch(id)],
        ],
        [
          'credit line: amount',
          column('ledger_postings', creditLine, 'amount', 'amount + 1'),
          [unsound(entry), brokenChain(creditLine), transferMismatch(id)],
        ],
        [
          'debit line: asset',
          column('ledger_postings', debitLine, 'asset_code', `'CDF'`),
          [unsound(entry), wrongAsset(debitLine), transferMismatch(id)],
        ],
        [
          'credit line: asset',
          column('ledger_postings', creditLine, 'asset_code', `'CDF'`),
          [unsound(entry), wrongAsset(creditLine), transferMismatch(id)],
        ],
        [
          'debit line: side',
          column('ledger_postings', debitLine, 'side', `'CREDIT'`),
          [unsound(entry), brokenChain(debitLine), transferMismatch(id)],
        ],
        [
          'credit line: side',
          column('ledger_postings', creditLine, 'side', `'DEBIT'`),
          [unsound(entry), brokenChain(creditLine), transferMismatch(id)],
        ],
      ]);
    });

    it('une écriture qui n’est pas — ou plus — une écriture de transfert est relevée', async () => {
      await expectEach([
        [
          'the entry becomes an adjustment entry',
          column('ledger_entries', transfer.entry, 'kind', `'adjustment.credit'`),
          [transferMismatch(transfer.id), withoutAdjustment(transfer.entry)],
        ],
        [
          'the transfer names the entry of an adjustment',
          column('transfers', transfer.id, 'entry_id', '$2', [funding.entry]),
          [transferMismatch(transfer.id), withoutTransfer(transfer.entry)],
        ],
      ]);
    });

    it('une écriture de transfert sans son transfert est relevée', async () => {
      await expectEach([
        [
          'the transfer is deleted',
          removal('transfers', transfer.id),
          [withoutTransfer(transfer.entry)],
        ],
      ]);
    });

    it('un transfert dont l’écriture n’existe pas est relevé', async () => {
      // Une clé étrangère l'interdit : il y faut un superutilisateur — ou une restauration
      // partielle.
      await expectEach(
        [
          [
            'the transfer names an entry that does not exist',
            column('transfers', transfer.id, 'entry_id', '$2', [UNKNOWN_ID]),
            [transferMismatch(transfer.id), withoutTransfer(transfer.entry)],
          ],
        ],
        tamperWithoutForeignKeys,
      );
    });
  });

  describe('un ajustement approuvé et son écriture', () => {
    it('un ajustement qui ne dit plus ce que son écriture a déplacé est relevé', async () => {
      const mismatch = [adjustmentMismatch(funding.id)];
      await expectEach([
        ['amount', column('ledger_adjustments', funding.id, 'amount', 'amount + 1'), mismatch],
        ['asset', column('ledger_adjustments', funding.id, 'asset_code', `'CDF'`), mismatch],
        [
          'holder',
          column('ledger_adjustments', funding.id, 'user_id', '$2', [carol.user]),
          mismatch,
        ],
        ['direction', column('ledger_adjustments', funding.id, 'direction', `'DEBIT'`), mismatch],
        [
          'direction of a debit',
          column('ledger_adjustments', debit.id, 'direction', `'CREDIT'`),
          [adjustmentMismatch(debit.id)],
        ],
      ]);
    });

    it('une ligne altérée de son écriture est relevée — avec ce que le grand livre en dit lui-même', async () => {
      const { id, entry, walletLine, custodyLine } = funding;
      await expectEach([
        [
          'wallet line: amount',
          column('ledger_postings', walletLine, 'amount', 'amount + 1'),
          [adjustmentMismatch(id), unsound(entry), brokenChain(walletLine)],
        ],
        [
          'custody line: amount',
          column('ledger_postings', custodyLine, 'amount', 'amount + 1'),
          [adjustmentMismatch(id), unsound(entry), brokenChain(custodyLine)],
        ],
        [
          'wallet line: asset',
          column('ledger_postings', walletLine, 'asset_code', `'CDF'`),
          [adjustmentMismatch(id), unsound(entry), wrongAsset(walletLine)],
        ],
        [
          'custody line: asset',
          column('ledger_postings', custodyLine, 'asset_code', `'CDF'`),
          [adjustmentMismatch(id), unsound(entry), wrongAsset(custodyLine)],
        ],
        [
          'wallet line: side',
          column('ledger_postings', walletLine, 'side', `'DEBIT'`),
          [adjustmentMismatch(id), unsound(entry), brokenChain(walletLine)],
        ],
        [
          'custody line: side',
          column('ledger_postings', custodyLine, 'side', `'CREDIT'`),
          [adjustmentMismatch(id), unsound(entry), brokenChain(custodyLine)],
        ],
      ]);
    });

    it('une écriture qui n’est pas — ou plus — celle de son sens est relevée', async () => {
      await expectEach([
        [
          'the entry of a credit becomes the entry of a debit',
          column('ledger_entries', funding.entry, 'kind', `'adjustment.debit'`),
          [adjustmentMismatch(funding.id)],
        ],
        [
          'the entry of a debit becomes the entry of a credit',
          column('ledger_entries', debit.entry, 'kind', `'adjustment.credit'`),
          [adjustmentMismatch(debit.id)],
        ],
        [
          'the entry becomes a transfer entry',
          column('ledger_entries', funding.entry, 'kind', `'transfer.internal'`),
          [adjustmentMismatch(funding.id), withoutTransfer(funding.entry)],
        ],
        [
          'the adjustment names the entry of a transfer',
          column('ledger_adjustments', funding.id, 'entry_id', '$2', [transfer.entry]),
          [adjustmentMismatch(funding.id), withoutAdjustment(funding.entry)],
        ],
      ]);
    });

    it('une écriture d’ajustement sans son ajustement approuvé est relevée', async () => {
      await expectEach([
        [
          'the adjustment is deleted',
          removal('ledger_adjustments', funding.id),
          [withoutAdjustment(funding.entry)],
        ],
        [
          'the debit is deleted',
          removal('ledger_adjustments', debit.id),
          [withoutAdjustment(debit.entry)],
        ],
      ]);
      // Un ajustement qui se dit refusé, et ne désigne plus d'écriture : les fonds, eux, ont
      // bougé.
      const rejected: [Tamper, Tamper] = [
        sql(
          `UPDATE ledger_adjustments
           SET status = 'REJECTED', entry_id = NULL, decision_note = 'Altered after the fact.'
           WHERE id = $1`,
          [funding.id],
        ),
        sql(
          `UPDATE ledger_adjustments
           SET status = 'APPROVED', entry_id = $2, decision_note = NULL
           WHERE id = $1`,
          [funding.id, funding.entry],
        ),
      ];
      await expectEach([
        ['the adjustment claims it was rejected', rejected, [withoutAdjustment(funding.entry)]],
      ]);
    });

    it('une écriture que désigne un ajustement qui n’est pas approuvé est relevée', async () => {
      // Une contrainte l'interdit — seul un ajustement approuvé désigne une écriture : il faut
      // que le propriétaire l'ait retirée.
      const constraint = 'ledger_adjustments_decision_check';
      const definition = await asOwner(async (owner) => {
        const { rows } = await owner.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
          [constraint],
        );
        expect(rows).toHaveLength(1);
        await owner.query(`ALTER TABLE ledger_adjustments DROP CONSTRAINT ${constraint}`);
        return rows[0]!.definition;
      });
      try {
        await expectEach([
          [
            'the adjustment claims it was rejected, and still names its entry',
            [
              sql(
                `UPDATE ledger_adjustments
                 SET status = 'REJECTED', decision_note = 'Altered after the fact.'
                 WHERE id = $1`,
                [funding.id],
              ),
              sql(
                `UPDATE ledger_adjustments SET status = 'APPROVED', decision_note = NULL
                 WHERE id = $1`,
                [funding.id],
              ),
            ],
            [withoutAdjustment(funding.entry)],
          ],
        ]);
      } finally {
        await asOwner((owner) =>
          owner.query(`ALTER TABLE ledger_adjustments ADD CONSTRAINT ${constraint} ${definition}`),
        );
      }
      expect(await anomalies()).toEqual([]);
    });

    it('un ajustement approuvé dont l’écriture n’existe pas est relevé', async () => {
      await expectEach(
        [
          [
            'the adjustment names an entry that does not exist',
            column('ledger_adjustments', funding.id, 'entry_id', '$2', [UNKNOWN_ID]),
            [adjustmentMismatch(funding.id), withoutAdjustment(funding.entry)],
          ],
        ],
        tamperWithoutForeignKeys,
      );
    });
  });

  describe('les comptes et le nombre de lignes', () => {
    it('une ligne passée sur un compte qui n’est pas celui de l’opération est relevée', async () => {
      await expectEach([
        [
          'the account of the sender is no longer a wallet',
          column('ledger_accounts', alice.account, 'type_key', `'platform_fees'`),
          // Le compte d'Alice porte aussi une ligne de chacun de ses deux ajustements.
          [
            transferMismatch(transfer.id),
            adjustmentMismatch(funding.id),
            adjustmentMismatch(debit.id),
          ],
        ],
        [
          'the account of the recipient is no longer a wallet',
          column('ledger_accounts', bob.account, 'type_key', `'platform_fees'`),
          [transferMismatch(transfer.id)],
        ],
        [
          'the custody account is no longer one',
          column('ledger_accounts', custody, 'type_key', `'platform_fees'`),
          [adjustmentMismatch(funding.id), adjustmentMismatch(debit.id)],
        ],
        [
          'the custody account belongs to a holder',
          column('ledger_accounts', custody, 'user_id', '$2', [carol.user]),
          [adjustmentMismatch(funding.id), adjustmentMismatch(debit.id)],
        ],
      ]);
    });

    it('une écriture qui a ses deux lignes, et une de plus, est relevée', async () => {
      // La ligne « conservation » du débit passe dans l'écriture du transfert, puis la ligne
      // « destinataire » du transfert dans celle du crédit : l'écriture qui la reçoit garde ses
      // deux lignes, celle qui la perd n'en a plus qu'une.
      const moved = (line: string, to: string, from: string): [Tamper, Tamper] => [
        sql(`UPDATE ledger_postings SET entry_id = $2, line_number = 3 WHERE id = $1`, [line, to]),
        sql(`UPDATE ledger_postings SET entry_id = $2, line_number = 2 WHERE id = $1`, [
          line,
          from,
        ]),
      ];
      await expectEach([
        [
          'a third line in the entry of a transfer',
          moved(debit.custodyLine, transfer.entry, debit.entry),
          [
            unsound(transfer.entry),
            unsound(debit.entry),
            transferMismatch(transfer.id),
            adjustmentMismatch(debit.id),
          ],
        ],
        [
          'a third line in the entry of an adjustment',
          moved(transfer.creditLine, funding.entry, transfer.entry),
          [
            unsound(funding.entry),
            unsound(transfer.entry),
            adjustmentMismatch(funding.id),
            transferMismatch(transfer.id),
          ],
        ],
      ]);
    });
  });

  describe('une écriture entière, sans son opération', () => {
    /**
     * Passe une écriture saine — entière, équilibrée, sur des comptes dont les soldes suivent —
     * d'un type réservé à une opération, sans cette opération : seule la règle qui l'exige est
     * neutralisée, le temps de la validation. Puis relève ce que la vérification en dit, et
     * retire l'écriture.
     */
    async function forged(
      rule: string,
      kind: string,
      postings: readonly { account: string; side: 'DEBIT' | 'CREDIT'; amount: number }[],
    ): Promise<{ entry: string; found: LedgerAnomaly[] }> {
      const accounts = postings.map(({ account }) => account);
      const saved = await asApp(async (db) => {
        const { rows } = await db.query<{ id: string; balance: string; posting_count: string }>(
          `SELECT id, balance::text, posting_count::text FROM ledger_accounts WHERE id = ANY($1)`,
          [accounts],
        );
        return rows;
      });
      expect(saved).toHaveLength(accounts.length);

      await asOwner((owner) => owner.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ${rule}`));
      let entry = '';
      try {
        await asOwner(async (owner) => {
          await owner.query('BEGIN');
          entry = await insertEntryHeader(owner, postings.length, { kind });
          await insertPostings(owner, entry, postings);
          await owner.query('COMMIT');
        });
      } finally {
        await asOwner((owner) => owner.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ${rule}`));
      }
      let found: LedgerAnomaly[];
      try {
        found = await anomalies();
      } finally {
        await tamper(async (db) => {
          await db.query(`DELETE FROM ledger_postings WHERE entry_id = $1`, [entry]);
          await db.query(`DELETE FROM ledger_entries WHERE id = $1`, [entry]);
          for (const account of saved) {
            await db.query(
              `UPDATE ledger_accounts SET balance = $2::numeric, posting_count = $3::bigint
               WHERE id = $1`,
              [account.id, account.balance, account.posting_count],
            );
          }
        });
      }
      expect(await anomalies()).toEqual([]);
      return { entry, found };
    }

    it('un crédit que personne n’a demandé ni approuvé est relevé — et lui seul', async () => {
      const credit = await forged('ledger_entries_adjustment_recorded', 'adjustment.credit', [
        { account: custody, side: 'DEBIT', amount: 700 },
        { account: carol.account, side: 'CREDIT', amount: 700 },
      ]);
      expect(credit.found).toEqual([withoutAdjustment(credit.entry)]);

      const withdrawal = await forged('ledger_entries_adjustment_recorded', 'adjustment.debit', [
        { account: bob.account, side: 'DEBIT', amount: 100 },
        { account: custody, side: 'CREDIT', amount: 100 },
      ]);
      expect(withdrawal.found).toEqual([withoutAdjustment(withdrawal.entry)]);
    });

    it('un mouvement entre deux titulaires qui n’est le transfert de personne est relevé — et lui seul', async () => {
      // Aucun plafond ne l'a vu passer : les cumuls se calculent sur les transferts.
      const moved = await forged('ledger_entries_transfer_recorded', 'transfer.internal', [
        { account: alice.account, side: 'DEBIT', amount: 9000 },
        { account: carol.account, side: 'CREDIT', amount: 9000 },
      ]);
      expect(moved.found).toEqual([withoutTransfer(moved.entry)]);
    });
  });

  describe('chaque contrôle', () => {
    it('ne rend pas plus d’anomalies qu’on ne lui en demande', async () => {
      const byName = new Map(checks.checks().map((check) => [check.name, check]));
      const count = async (name: string, limit: number): Promise<number> =>
        (await byName.get(name)!.findAnomalies(prisma, limit)).length;
      // Deux anomalies pour chacun des deux contrôles : chaque opération désigne l'écriture de
      // l'autre.
      const [alterTransfer, restoreTransfer] = column('transfers', transfer.id, 'entry_id', '$2', [
        funding.entry,
      ]);
      const alterAdjustment = sql(`UPDATE ledger_adjustments SET entry_id = $2 WHERE id = $1`, [
        funding.id,
        transfer.entry,
      ]);
      const restoreAdjustment = sql(`UPDATE ledger_adjustments SET entry_id = $2 WHERE id = $1`, [
        funding.id,
        funding.entry,
      ]);
      await tamper(async (db) => {
        await alterTransfer(db);
        await alterAdjustment(db);
      });
      try {
        expect(await anomalies()).toEqual(
          sorted([
            transferMismatch(transfer.id),
            adjustmentMismatch(funding.id),
            withoutAdjustment(funding.entry),
            withoutTransfer(transfer.entry),
          ]),
        );
        for (const name of ['transfers', 'adjustments']) {
          expect({
            name,
            counts: [await count(name, 1), await count(name, 2), await count(name, 50)],
          }).toEqual({ name, counts: [1, 2, 2] });
        }
        expect((await testApp.app.get(LedgerRepository).findAnomalies(prisma, 50)).length).toBe(0);
      } finally {
        await tamper(async (db) => {
          await restoreAdjustment(db);
          await restoreTransfer(db);
        });
      }
      expect(await anomalies()).toEqual([]);
    });
  });

  describe('chaque type d’écriture a son contrôle', () => {
    it('une écriture de l’un des types du produit, sans son opération, est toujours relevée', async () => {
      // Tout type que la base connaît est réservé à une opération. Un type ajouté sans que son
      // module inscrive un contrôle (`LedgerCheckRegistry`) fait échouer ce test : l'écriture
      // d'une autre opération, à qui l'on donne ce type, ne serait désignée par aucune anomalie.
      expect(LEDGER_ENTRY_KIND_KEYS.length).toBeGreaterThanOrEqual(3);
      for (const kind of LEDGER_ENTRY_KIND_KEYS) {
        const entry = kind === 'transfer.internal' ? funding.entry : transfer.entry;
        const [alter, restore] = column('ledger_entries', entry, 'kind', '$2', [kind]);
        const found = await anomaliesOf(alter, restore);
        expect({ kind, named: found.filter(({ subject }) => subject === entry) }).toEqual({
          kind,
          named: [expect.objectContaining({ subject: entry })],
        });
      }
    });
  });

  describe('l’étape', () => {
    /** Les contrôles inscrits, dans l'ordre où l'étape les exécute. */
    const registered = (): [LedgerCheck, LedgerCheck] => {
      const [first, last, ...others] = checks.checks();
      expect(others).toEqual([]);
      return [first!, last!];
    };
    const made = (count: number): LedgerAnomaly[] =>
      Array.from({ length: count }, (_, index) => ({
        kind: 'TRANSFER_ENTRY_MISMATCH',
        subject: `made-up-${String(index)}`,
      }));

    it('le nombre maximal d’anomalies vaut pour l’ensemble des contrôles : chacun n’est interrogé que sur ce qu’il en reste', async () => {
      const [first, last] = registered();
      const [alter, restore] = column('ledger_accounts', bob.account, 'balance', 'balance + 1');
      await tamper(alter);
      try {
        // Le grand livre relève le compte et l'actif ; le premier contrôle inscrit, quarante-sept
        // anomalies : il en reste 50 - 2, puis une seule — et le dernier est interrogé pour elle.
        const asked = [
          jest.spyOn(first, 'findAnomalies').mockResolvedValueOnce(made(47)),
          jest.spyOn(last, 'findAnomalies'),
        ];
        const error = await errorOf(() => verification.run());
        expect(error).toBeInstanceOf(LedgerVerificationError);
        expect(sorted((error as LedgerVerificationError).anomalies)).toEqual(
          sorted([
            { kind: 'ACCOUNT_BALANCE_MISMATCH', subject: bob.account },
            { kind: 'ASSET_UNBALANCED', subject: 'USD' },
            ...made(47),
          ]),
        );
        expect(asked.map((spy) => spy.mock.calls.map(([, limit]) => limit))).toEqual([[48], [1]]);
        // Quarante-neuf anomalies : la liste n'est pas tronquée.
        expect((error as Error).message).toBe(
          'The ledger failed its verification: 49 anomaly(ies) found.',
        );
        expect(LEDGER_VERIFICATION_MAX_ANOMALIES).toBe(50);
      } finally {
        await tamper(restore);
      }
      expect(await anomalies()).toEqual([]);
    });

    it('un contrôle qui rend plus qu’on ne lui demande n’allonge pas la liste ; le maximum atteint, les suivants ne sont pas interrogés', async () => {
      const [first, last] = registered();
      const asked = jest.spyOn(first, 'findAnomalies').mockResolvedValueOnce(made(60));
      const skipped = jest.spyOn(last, 'findAnomalies');

      const error = await errorOf(() => verification.run());

      expect(error).toBeInstanceOf(LedgerVerificationError);
      expect((error as LedgerVerificationError).anomalies).toEqual(made(50));
      expect((error as Error).message).toBe(
        'The ledger failed its verification: 50 anomaly(ies) found (list truncated).',
      );
      expect(asked).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
      const [trace] = await prisma.auditLog.findMany({
        where: { action: 'ledger.verification_failed' },
        orderBy: { id: 'desc' },
        take: 1,
      });
      expect(trace?.metadata).toEqual({ anomalies: made(50), truncated: true });
    });

    it('un contrôle qui échoue n’empêche pas les autres : ce qu’ils relèvent est signalé, et consigné', async () => {
      const [first, last] = registered();
      const logged = jest.spyOn(PinoLogger.prototype, 'error');
      const timeout = new Error('canceling statement due to statement timeout');
      const traces = (): Promise<number> =>
        prisma.auditLog.count({ where: { action: 'ledger.verification_failed' } });
      const before = await traces();
      const [alter, restore] = column('ledger_entries', transfer.entry, 'kind', `'gift.card'`);
      await tamper(alter);
      try {
        // Le premier contrôle inscrit échoue ; le grand livre avant lui, et le second après
        // lui, sont interrogés tout de même.
        jest.spyOn(first, 'findAnomalies').mockRejectedValueOnce(timeout);
        const after = jest.spyOn(last, 'findAnomalies').mockResolvedValueOnce(made(1));

        const error = await errorOf(() => verification.run());

        expect(error).toBeInstanceOf(LedgerVerificationError);
        expect(sorted((error as LedgerVerificationError).anomalies)).toEqual(
          sorted([unknownKind(transfer.entry), ...made(1)]),
        );
        // L'erreur, la ligne de journal et la trace d'audit nomment le contrôle qui a manqué :
        // aucune ne laisse croire que tout a été relu.
        expect(error).toMatchObject({
          failedChecks: [first.name],
          message:
            'The ledger failed its verification: 2 anomaly(ies) found. ' +
            `1 check(s) failed (${first.name}).`,
        });
        expect(after.mock.calls.map(([, limit]) => limit)).toEqual([49]);
        const found = (error as LedgerVerificationError).anomalies;
        expect(verificationLines(logged)).toEqual([
          [{ err: timeout, check: first.name }, 'Ledger verification check failed'],
          [{ anomalies: found, failedChecks: [first.name] }, 'Ledger verification failed'],
        ]);
        expect(await traces()).toBe(before + 1);
        const [trace] = await prisma.auditLog.findMany({
          where: { action: 'ledger.verification_failed' },
          orderBy: { id: 'desc' },
          take: 1,
        });
        expect(trace?.metadata).toEqual({
          anomalies: found,
          truncated: false,
          failedChecks: [first.name],
        });
      } finally {
        await tamper(restore);
      }
      expect(await anomalies()).toEqual([]);
    });

    it('rien n’est relevé, mais un contrôle a échoué : l’étape échoue, et dit lequel', async () => {
      const [first, last] = registered();
      const logged = jest.spyOn(PinoLogger.prototype, 'error');
      const traces = (): Promise<number> =>
        prisma.auditLog.count({ where: { action: 'ledger.verification_failed' } });
      const before = await traces();
      const timeout = new Error('canceling statement due to statement timeout');

      const asked = jest.spyOn(last, 'findAnomalies').mockRejectedValueOnce(timeout);
      const error = await errorOf(() => verification.run());
      expect(error).toBeInstanceOf(LedgerVerificationIncompleteError);
      expect(error).toMatchObject({
        name: 'LedgerVerificationIncompleteError',
        failedChecks: [last.name],
        message: `The ledger could not be verified entirely: 1 check(s) failed (${last.name}).`,
      });
      // Une ligne nomme le contrôle ; aucune ne parle d'anomalie.
      expect(verificationLines(logged)).toEqual([
        [{ err: timeout, check: last.name }, 'Ledger verification check failed'],
      ]);

      // Le contrôle du grand livre lui-même peut échouer aussi : les autres passent, et
      // l'étape de la tâche horaire est comptée en échec.
      const own = jest
        .spyOn(testApp.app.get(LedgerRepository), 'findAnomalies')
        .mockRejectedValue(timeout);
      jest.spyOn(first, 'findAnomalies').mockRejectedValueOnce(timeout);
      asked.mockClear();
      expect(await errorOf(() => verification.run())).toMatchObject({
        failedChecks: [LEDGER_OWN_CHECK, first.name],
        message:
          'The ledger could not be verified entirely: 2 check(s) failed ' +
          `(${LEDGER_OWN_CHECK}, ${first.name}).`,
      });
      expect(asked.mock.calls.map(([, limit]) => limit)).toEqual([50]);

      const report = await maintenance.run();
      expect(report.failures).toBe(1);
      expect(report.otherSteps['verify-ledger']).toBe(0);
      own.mockRestore();

      // Aucune anomalie n'a été relevée : rien n'est inscrit au journal d'audit.
      expect(await traces()).toBe(before);
      const { entries } = await asApp(ledgerSize);
      expect(await verification.run()).toBe(entries);
    });
  });
});

/**
 * Rien n'est simulé ici : une application dont le délai d'exécution des requêtes est de
 * 400 ms, et une autre session qui tient la table des transferts — le contrôle des transferts
 * attend, et la base annule son instruction.
 */
describe('Vérification du grand livre — délai d’exécution des requêtes (PostgreSQL réel)', () => {
  let slow: TestApp;

  beforeAll(async () => {
    slow = await createTestApp({ env: { DATABASE_STATEMENT_TIMEOUT_MS: '400' }, terms: 'none' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await slow.close();
  });

  it('un contrôle dont l’instruction dépasse le délai échoue seul, et l’étape le nomme', async () => {
    const step = slow.app.get(LedgerVerification);
    const logged = jest.spyOn(PinoLogger.prototype, 'error');
    await withConnection(slow.database.ownerUrl, async (owner) => {
      await owner.query('BEGIN');
      await owner.query('LOCK TABLE transfers IN ACCESS EXCLUSIVE MODE');
      try {
        const started = Date.now();
        const error = await errorOf(() => step.run());
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        // Le grand livre et les ajustements ont été relus ; les transferts, non.
        expect(error).toBeInstanceOf(LedgerVerificationIncompleteError);
        expect(error).toMatchObject({
          failedChecks: ['transfers'],
          message: 'The ledger could not be verified entirely: 1 check(s) failed (transfers).',
        });
      } finally {
        await owner.query('ROLLBACK');
      }
    });
    const lines = verificationLines(logged);
    expect(lines).toEqual([
      [{ err: expect.any(Error), check: 'transfers' }, 'Ledger verification check failed'],
    ]);
    // C'est bien la base qui a annulé l'instruction, au délai : la ligne de journal le dit.
    const [[{ err }]] = lines as [[{ err: Error }]];
    expect(err.message).toContain('canceling statement due to statement timeout');

    // La table libérée, le même grand livre — vide — se vérifie, et l'étape horaire aboutit.
    expect(await step.run()).toBe(0);
    const report = await slow.app.get(AccountMaintenanceService).run();
    expect(report.failures).toBe(0);
    expect(report.otherSteps['verify-ledger']).toBe(0);
  });
});
