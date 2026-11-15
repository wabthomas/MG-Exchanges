import {
  LEDGER_ADJUSTMENT_ENTRY_KINDS,
  LEDGER_ADJUSTMENT_TTL_HOURS,
  PERMISSIONS,
  SYSTEM_ROLES,
} from '@mgx/contracts';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import { ENTRY_KINDS_PASSING_A_FREEZE } from '../../src/modules/ledger/domain/wallet-freeze.js';
import { closeAccountInSql } from '../support/account-closure.js';
import {
  accountState,
  insertEntryHeader,
  insertPostings,
  ledgerSize,
  openLedgerAccount,
  postEntryInSql,
  registerAssetInSql,
  type SqlPosting,
} from '../support/ledger-sql.js';
import {
  adjustmentRow,
  ageAdjustment,
  approveInSql,
  freezeRow,
  insertAdjustmentRow,
  insertFreezeRow,
  liftFreezeInSql,
  type SqlAdjustmentEntry,
  updateAdjustment,
  updateFreeze,
  writeAdjustmentEntry,
  writeApproval,
} from '../support/staff-operations-sql.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE } from '../support/test-environment.js';
import { setLimitInSql, verifyUpTo, writeTransfer } from '../support/transfers-sql.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const STRING_TOO_LONG = '22001';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Règle de clôture enfreinte (migration account_closure). */
const CLOSURE_RULE_VIOLATION = 'MGX04';
/** Écriture visant un compte clôturé (migration account_closure). */
const ACCOUNT_CLOSED = 'MGX05';
/** Fonds insuffisants (migration ledger). */
const INSUFFICIENT_FUNDS = 'MGX09';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const HOUR_MS = 60 * 60 * 1000;

// Toutes les règles des opérations du personnel lèvent le même code : c'est le message qui dit
// laquelle. Un portefeuille gelé a le sien (MGX12).
const CREATED_PENDING = /^MGX11: a ledger adjustment is created pending$/;
const NO_WALLET_TO_ADJUST = (status: string): RegExp =>
  new RegExp(`^MGX11: account \\S+ has no wallet to adjust: it is ${status}$`);
const NOT_ENTITLED_TO_REQUEST =
  /^MGX11: account \S+ is not entitled to request a ledger adjustment$/;
const NO_LONGER_ENTITLED_TO_REQUEST =
  /^MGX11: account \S+ is no longer entitled to request a ledger adjustment$/;
const NOT_ENTITLED_TO_DECIDE =
  /^MGX11: account \S+ is not entitled to decide on a ledger adjustment$/;
const ALREADY_DECIDED = (status: string): RegExp =>
  new RegExp(`^MGX11: ledger adjustment \\S+ is already decided \\(${status}\\)$`);
const ONLY_DECIDED = /^MGX11: a pending ledger adjustment can only be decided$/;
const TERMS_FIXED = /^MGX11: the terms of a ledger adjustment cannot be modified$/;
const NOT_EXPIRED_YET = /^MGX11: ledger adjustment \S+ has not expired yet$/;
const EXPIRED = /^MGX11: ledger adjustment \S+ has expired$/;
const NOT_ITS_ENTRY = /^MGX11: ledger entry \S+ is not the one of ledger adjustment \S+$/;
const ENTRY_WITHOUT_ADJUSTMENT =
  /^MGX11: ledger entry \S+ is an adjustment entry without an approved adjustment$/;
const CREATED_IN_FORCE = /^MGX11: a wallet freeze is created in force$/;
const NO_WALLET_TO_FREEZE = (status: string): RegExp =>
  new RegExp(`^MGX11: account \\S+ has no wallet to freeze: it is ${status}$`);
const NOT_ENTITLED_TO_FREEZE = /^MGX11: account \S+ is not entitled to freeze a wallet$/;
const NOT_ENTITLED_TO_LIFT = /^MGX11: account \S+ is not entitled to lift a wallet freeze$/;
const ALREADY_LIFTED = /^MGX11: wallet freeze \S+ is already lifted$/;
const FREEZE_TERMS_FIXED = /^MGX11: the terms of a wallet freeze cannot be modified$/;
const ONLY_LIFTED = /^MGX11: a wallet freeze in force can only be lifted$/;
const WALLET_FROZEN = (asset = 'USD'): RegExp =>
  new RegExp(`^MGX12: the ${asset} wallet of account \\S+ is frozen: nothing can be posted to it$`);
const FROZEN_AT_CLOSURE = /^MGX04: account \S+ has a frozen wallet: it cannot be closed$/;
const CHECK = (constraint: string): RegExp =>
  new RegExp(`^${CHECK_VIOLATION}: .*violates check constraint "${constraint}"$`);

interface Holder {
  readonly user: string;
  /** Compte « fonds disponibles » en dollars. */
  readonly account: string;
}

describe('Opérations du personnel — règles portées par la base de données', () => {
  let database: TestDatabase;
  /** Deux administrateurs (rôle super_admin) : l'un demande, l'autre décide. */
  let admin: string;
  let second: string;
  let support: string;
  let compliance: string;
  let custody: string;
  let fees: string;
  let custodyCdf: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      second = await insertStaff(db, 'super_admin');
      support = await insertStaff(db, 'support');
      compliance = await insertStaff(db, 'compliance');
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await setLimitInSql(db, 'USD', 1, [1000, 2500, 10_000]);
    });
    await asApp(async (db) => {
      custody = await openLedgerAccount(db, 'platform_custody', 'USD');
      fees = await openLedgerAccount(db, 'platform_fees', 'USD');
      custodyCdf = await openLedgerAccount(db, 'platform_custody', 'CDF');
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);

  let sequence = 0;
  async function insertUser(
    db: pg.Client,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    sequence += 1;
    const row: Record<string, unknown> = {
      email: `staff-operations${String(sequence)}@example.cd`,
      country_code: 'CD',
      registered_at: new Date(),
      status: 'ACTIVE',
      email_verified_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return result.rows[0]!.id;
  }

  async function insertStaff(owner: pg.Client, roleKey: string): Promise<string> {
    const id = await insertUser(owner);
    await owner.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`,
      [id, roleKey],
    );
    return id;
  }

  /** Code et message de l'erreur levée par `action`, ou `undefined` si elle réussit. */
  async function failure(action: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await action();
      return undefined;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      return `${code ?? 'UNKNOWN'}: ${message ?? ''}`;
    }
  }

  /** Exécute `work` dans une transaction toujours annulée, et rend le code de son erreur. */
  async function attempt(db: pg.Client, work: () => Promise<unknown>): Promise<string | undefined> {
    await db.query('BEGIN');
    try {
      return await sqlState(work);
    } finally {
      await db.query('ROLLBACK');
    }
  }

  /** Le même, avec le message : c'est lui qui dit quelle règle a été enfreinte. */
  async function refusal(db: pg.Client, work: () => Promise<unknown>): Promise<string | undefined> {
    await db.query('BEGIN');
    try {
      return await failure(work);
    } finally {
      await db.query('ROLLBACK');
    }
  }

  /**
   * Exécute `work` dans une transaction — il doit réussir — puis la valide : rend l'erreur levée
   * **à la validation**, ou `undefined` si la transaction est validée.
   */
  async function commitOf(
    db: pg.Client,
    work: () => Promise<unknown>,
  ): Promise<string | undefined> {
    await db.query('BEGIN');
    try {
      await work();
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    return failure(() => db.query('COMMIT'));
  }

  /** Dépôt : la plateforme conserve `units` de plus, et les doit au titulaire. */
  const deposit = (db: pg.Client, account: string, units: number): Promise<string> =>
    postEntryInSql(db, [
      { account: custody, side: 'DEBIT', amount: units },
      { account, side: 'CREDIT', amount: units },
    ]);

  /** Un titulaire actif et son compte « fonds disponibles » en dollars, crédité de `units`. */
  async function holderWith(db: pg.Client, units = 0): Promise<Holder> {
    const user = await insertUser(db);
    const account = await openLedgerAccount(db, 'user_available', 'USD', user);
    if (units > 0) {
      await deposit(db, account, units);
    }
    return { user, account };
  }

  /** Une demande en attente, déposée par `admin` : par défaut, un crédit de 100 unités en dollars. */
  const requested = (
    db: pg.Client,
    holder: Holder,
    columns: Record<string, unknown> = {},
  ): Promise<string> =>
    insertAdjustmentRow(db, { user_id: holder.user, requested_by: admin, ...columns });

  /** L'écriture attendue d'un ajustement en dollars. */
  const entryOf = (
    holder: Holder,
    direction: 'CREDIT' | 'DEBIT' = 'CREDIT',
    amount = 100,
  ): SqlAdjustmentEntry => ({
    direction,
    holderAccount: holder.account,
    custodyAccount: custody,
    amount,
  });

  const grantsOn = async (db: pg.Client, table: string): Promise<string[]> =>
    (
      await db.query<{ privileges: string[] }>(
        `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_name = $2`,
        [TEST_APP_ROLE, table],
      )
    ).rows[0]!.privileges;

  const databaseTime = async (db: pg.Client): Promise<Date> =>
    (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;

  // ---------------------------------------------------------------------------------------------
  describe('catalogue des permissions et des rôles', () => {
    it('six permissions nouvelles ; super_admin détient tout le catalogue, qui est celui de @mgx/contracts', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; description: string; held: boolean }>(
          `SELECT p.key, p.description, EXISTS (
             SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
             WHERE rp.permission_key = p.key AND r.key = 'super_admin') AS held
           FROM permissions p ORDER BY p.key COLLATE "C"`,
        );
        expect(rows).toEqual(
          Object.entries(PERMISSIONS)
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, description]) => ({ key, description, held: true })),
        );
        expect(
          rows
            .map(({ key }) => key)
            .filter((key) => key.startsWith('adjustments.') || key.startsWith('wallet_freezes.')),
        ).toEqual([
          'adjustments.approve',
          'adjustments.read',
          'adjustments.request',
          'wallet_freezes.create',
          'wallet_freezes.lift',
          'wallet_freezes.read',
        ]);
      });
    });

    it('la conformité gèle un portefeuille et consulte les gels — rien d’autre ; le support, rien', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; permissions: string[] }>(
          `SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS permissions
           FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
           WHERE r.is_system GROUP BY r.key`,
        );
        const staffOperations = (role: string): string[] =>
          (rows.find(({ key }) => key === role)?.permissions ?? []).filter(
            (key) => key.startsWith('adjustments.') || key.startsWith('wallet_freezes.'),
          );
        expect(staffOperations('compliance')).toEqual([
          'wallet_freezes.create',
          'wallet_freezes.read',
        ]);
        expect(staffOperations('support')).toEqual([]);
        expect(staffOperations('super_admin')).toHaveLength(6);
        for (const role of ['compliance', 'support'] as const) {
          expect(rows.find(({ key }) => key === role)?.permissions).toEqual(
            [...SYSTEM_ROLES[role]].sort(),
          );
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ajustement — la demande', () => {
    it('naît en attente, à l’heure de la base, avec une échéance de 72 heures', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const before = await databaseTime(db);
        // L'heure et l'échéance fournies sont ignorées.
        const id = await requested(db, holder, {
          requested_at: new Date('2020-01-01T00:00:00Z'),
          expires_at: new Date('2099-01-01T00:00:00Z'),
        });
        const after = await databaseTime(db);
        const row = await adjustmentRow(db, id);
        expect(row).toMatchObject({
          status: 'PENDING',
          direction: 'CREDIT',
          amount: '100',
          decided_by: null,
          decided_at: null,
          decision_note: null,
          entry_id: null,
        });
        expect(row.requested_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(row.requested_at.getTime()).toBeLessThanOrEqual(after.getTime());
        expect(row.expires_at.getTime() - row.requested_at.getTime()).toBe(
          LEDGER_ADJUSTMENT_TTL_HOURS * HOUR_MS,
        );
        // Rien n'a bougé : une demande ne passe aucune écriture.
        expect(await accountState(db, holder.account)).toEqual({ balance: '0', postings: '0' });
      });
    });

    it('ne naît ni décidée, ni échue', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        for (const status of ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']) {
          expect({
            status,
            outcome: await refusal(db, () =>
              requested(db, holder, { status, decided_by: second, decision_note: 'Décidée' }),
            ),
          }).toEqual({ status, outcome: expect.stringMatching(CREATED_PENDING) });
        }
        // En attente, mais déjà pourvue d'une décision ou d'une écriture : la forme le refuse.
        for (const columns of [
          { decided_by: second },
          { decision_note: 'Note' },
          { decided_at: new Date() },
        ]) {
          expect(await refusal(db, () => requested(db, holder, columns))).toMatch(
            CHECK('ledger_adjustments_decision_check'),
          );
        }
      });
    });

    it('seul la dépose un membre du personnel actif qui détient adjustments.request', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const customer = await insertUser(db);
        for (const [label, author] of [
          ['support', support],
          ['conformité', compliance],
          ['client', customer],
        ] as const) {
          expect({
            label,
            outcome: await refusal(db, () => requested(db, holder, { requested_by: author })),
          }).toEqual({ label, outcome: expect.stringMatching(NOT_ENTITLED_TO_REQUEST) });
        }
        // Un administrateur suspendu n'a plus qualité.
        expect(
          await refusal(db, async () => {
            await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [second]);
            await requested(db, holder, { requested_by: second });
          }),
        ).toMatch(NOT_ENTITLED_TO_REQUEST);
        // Un auteur inconnu : même refus — la règle passe avant la clé étrangère.
        expect(
          await refusal(db, () => requested(db, holder, { requested_by: UNKNOWN_ID })),
        ).toMatch(NOT_ENTITLED_TO_REQUEST);
        expect(await refusal(db, () => requested(db, holder, { requested_by: second }))).toBe(
          undefined,
        );
      });
    });

    it('nul ne demande l’ajustement de son propre portefeuille', async () => {
      await asApp(async (db) => {
        const own = await openLedgerAccount(db, 'user_available', 'USD', admin);
        expect(await refusal(db, () => requested(db, { user: admin, account: own }))).toMatch(
          CHECK('ledger_adjustments_not_self_requested_check'),
        );
        // Celui d'un autre administrateur, si.
        expect(
          await refusal(db, () =>
            requested(db, { user: admin, account: own }, { requested_by: second }),
          ),
        ).toBeUndefined();
      });
    });

    it('le titulaire est un compte actif ou suspendu : ni inscription inachevée, ni compte clôturé, ni inconnu', async () => {
      await asApp(async (db) => {
        const suspended = await insertUser(db, { status: 'SUSPENDED' });
        expect(
          await refusal(db, () => requested(db, { user: suspended, account: UNKNOWN_ID })),
        ).toBeUndefined();

        const pending = await insertUser(db, {
          status: 'PENDING_VERIFICATION',
          email_verified_at: null,
        });
        expect(
          await refusal(db, () => requested(db, { user: pending, account: UNKNOWN_ID })),
        ).toMatch(NO_WALLET_TO_ADJUST('pending_verification'));

        const closed = await insertUser(db);
        await closeAccountInSql(db, closed);
        expect(await attempt(db, () => requested(db, { user: closed, account: UNKNOWN_ID }))).toBe(
          ACCOUNT_CLOSED,
        );

        expect(
          await attempt(db, () => requested(db, { user: UNKNOWN_ID, account: UNKNOWN_ID })),
        ).toBe(FOREIGN_KEY_VIOLATION);
      });
    });

    it('un montant strictement positif, un actif tenu, un sens, une raison réelle', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const refusals: [string, Record<string, unknown>, string][] = [
          ['montant nul', { amount: 0 }, CHECK_VIOLATION],
          ['montant négatif', { amount: -1 }, CHECK_VIOLATION],
          ['actif non tenu', { asset_code: 'EUR' }, FOREIGN_KEY_VIOLATION],
          ['sens inconnu', { direction: 'IN' }, '22P02'],
          ['raison vide', { reason: '' }, CHECK_VIOLATION],
          ['raison faite d’espaces', { reason: '   ' }, CHECK_VIOLATION],
          ['raison de 501 caractères', { reason: 'x'.repeat(501) }, STRING_TOO_LONG],
        ];
        for (const [label, columns, code] of refusals) {
          expect({ label, code: await attempt(db, () => requested(db, holder, columns)) }).toEqual({
            label,
            code,
          });
        }
        expect(await refusal(db, () => requested(db, holder, { amount: 0 }))).toMatch(
          CHECK('ledger_adjustments_amount_check'),
        );
        expect(await refusal(db, () => requested(db, holder, { reason: ' ' }))).toMatch(
          CHECK('ledger_adjustments_reason_not_blank_check'),
        );
        // Le plus grand montant que le grand livre sait tenir, et une raison de 500 caractères.
        expect(
          await attempt(db, () =>
            requested(db, holder, { amount: '9'.repeat(38), reason: 'x'.repeat(500) }),
          ),
        ).toBeUndefined();
      });
    });

    it('une seule demande identique en attente : même portefeuille, même sens, même montant', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 500);
        const other = await holderWith(db);
        const first = await requested(db, holder);
        // Même demande, même d'un autre auteur : refusée.
        expect(await attempt(db, () => requested(db, holder))).toBe(UNIQUE_VIOLATION);
        expect(await attempt(db, () => requested(db, holder, { requested_by: second }))).toBe(
          UNIQUE_VIOLATION,
        );
        // Ce qui la distingue — le montant, le sens, l'actif, le portefeuille — suffit.
        for (const [label, target, columns] of [
          ['autre montant', holder, { amount: 101 }],
          ['autre sens', holder, { direction: 'DEBIT' }],
          ['autre actif', holder, { asset_code: 'CDF' }],
          ['autre portefeuille', other, {}],
        ] as const) {
          expect({ label, code: await attempt(db, () => requested(db, target, columns)) }).toEqual({
            label,
            code: undefined,
          });
        }
        // Décidée, elle ne s'oppose plus à une demande identique.
        await updateAdjustment(db, first, { status: 'CANCELLED', decided_by: admin });
        expect(await attempt(db, () => requested(db, holder))).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ajustement — la décision', () => {
    it('une demande se décide une seule fois, et ses termes ne changent jamais', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const other = await holderWith(db);
        const id = await requested(db, holder);

        // En attente : ni ses termes ne se retouchent, ni elle ne se réécrit sans décision.
        const terms: [string, Record<string, unknown>][] = [
          ['titulaire', { user_id: other.user }],
          ['actif', { asset_code: 'CDF' }],
          ['sens', { direction: 'DEBIT' }],
          ['montant', { amount: 1_000_000 }],
          ['raison', { reason: 'Une autre raison, écrite après coup' }],
          ['auteur', { requested_by: second }],
          ['heure de la demande', { requested_at: new Date('2020-01-01T00:00:00Z') }],
          ['échéance', { expires_at: new Date('2099-01-01T00:00:00Z') }],
        ];
        for (const [label, columns] of terms) {
          // Avec une décision valide : ce sont bien les termes qui sont refusés.
          expect({
            label,
            outcome: await refusal(db, () =>
              updateAdjustment(db, id, {
                ...columns,
                status: 'REJECTED',
                decided_by: second,
                decision_note: 'Refusée',
              }),
            ),
          }).toEqual({ label, outcome: expect.stringMatching(TERMS_FIXED) });
          // Sans décision : une demande en attente ne se réécrit pas.
          expect({
            label,
            outcome: await refusal(db, () => updateAdjustment(db, id, columns)),
          }).toEqual({ label, outcome: expect.stringMatching(ONLY_DECIDED) });
        }

        await updateAdjustment(db, id, {
          status: 'REJECTED',
          decided_by: second,
          decision_note: 'Pièce justificative absente',
        });
        // Décidée : plus rien ne s'y écrit — ni une autre décision, ni un retour en attente.
        for (const [label, columns] of [
          ['approuver', { status: 'APPROVED', decided_by: second, entry_id: UNKNOWN_ID }],
          ['retirer', { status: 'CANCELLED', decided_by: admin }],
          [
            'rouvrir',
            { status: 'PENDING', decided_by: null, decided_at: null, decision_note: null },
          ],
          ['changer la note', { decision_note: 'Une autre note' }],
          ['changer le montant', { amount: 5 }],
        ] as const) {
          expect({
            label,
            outcome: await refusal(db, () => updateAdjustment(db, id, columns)),
          }).toEqual({ label, outcome: expect.stringMatching(ALREADY_DECIDED('REJECTED')) });
        }
        // Le propriétaire du schéma n'y échappe pas.
        await asOwner(async (owner) => {
          expect(
            await refusal(owner, () => updateAdjustment(owner, id, { decision_note: 'Réécrite' })),
          ).toMatch(ALREADY_DECIDED('REJECTED'));
        });
      });
    });

    it('refuser : un autre que l’auteur et que le titulaire, actif et habilité, avec un motif', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const id = await requested(db, holder);
        const reject = (columns: Record<string, unknown>): Promise<string | undefined> =>
          refusal(db, () =>
            updateAdjustment(db, id, {
              status: 'REJECTED',
              decision_note: 'Pièce justificative absente',
              ...columns,
            }),
          );

        expect(await reject({ decided_by: admin })).toMatch(
          CHECK('ledger_adjustments_four_eyes_check'),
        );
        expect(await reject({ decided_by: support })).toMatch(NOT_ENTITLED_TO_DECIDE);
        expect(await reject({ decided_by: compliance })).toMatch(NOT_ENTITLED_TO_DECIDE);
        expect(await reject({ decided_by: null })).toMatch(
          CHECK('ledger_adjustments_decision_check'),
        );
        expect(await reject({ decided_by: second, decision_note: null })).toMatch(
          CHECK('ledger_adjustments_rejection_note_check'),
        );
        expect(await reject({ decided_by: second, decision_note: '  ' })).toMatch(
          CHECK('ledger_adjustments_decision_note_not_blank_check'),
        );
        // Un refus ne désigne aucune écriture.
        expect(await reject({ decided_by: second, entry_id: UNKNOWN_ID })).toMatch(
          CHECK('ledger_adjustments_decision_check'),
        );
        // Un administrateur suspendu n'a plus qualité.
        expect(
          await refusal(db, async () => {
            await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [second]);
            await updateAdjustment(db, id, {
              status: 'REJECTED',
              decided_by: second,
              decision_note: 'Refusée',
            });
          }),
        ).toMatch(NOT_ENTITLED_TO_DECIDE);

        // Le titulaire, fût-il administrateur, ne décide pas de son propre portefeuille.
        const ownWallet = await requested(db, { user: second, account: UNKNOWN_ID }, { amount: 7 });
        expect(
          await refusal(db, () =>
            updateAdjustment(db, ownWallet, {
              status: 'REJECTED',
              decided_by: second,
              decision_note: 'Refusée',
            }),
          ),
        ).toMatch(CHECK('ledger_adjustments_four_eyes_check'));

        // L'heure de la décision est celle de la base : celle qu'on fournit est ignorée.
        const before = await databaseTime(db);
        await updateAdjustment(db, id, {
          status: 'REJECTED',
          decided_by: second,
          decision_note: 'Pièce justificative absente',
          decided_at: new Date('2020-01-01T00:00:00Z'),
        });
        const row = await adjustmentRow(db, id);
        expect(row).toMatchObject({
          status: 'REJECTED',
          decided_by: second,
          decision_note: 'Pièce justificative absente',
          entry_id: null,
        });
        expect(row.decided_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(await accountState(db, holder.account)).toEqual({ balance: '0', postings: '0' });
      });
    });

    it('retirer : seul son auteur — même s’il n’a plus sa permission', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const id = await requested(db, holder);
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, { status: 'CANCELLED', decided_by: second }),
          ),
        ).toMatch(CHECK('ledger_adjustments_cancelled_by_requester_check'));
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, { status: 'CANCELLED', decided_by: null }),
          ),
        ).toMatch(CHECK('ledger_adjustments_decision_check'));
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, {
              status: 'CANCELLED',
              decided_by: admin,
              entry_id: UNKNOWN_ID,
            }),
          ),
        ).toMatch(CHECK('ledger_adjustments_decision_check'));
      });
      // Son auteur a perdu son rôle depuis : il retire encore sa demande.
      await asOwner(async (owner) => {
        const holder = await holderWith(owner);
        const id = await requested(owner, holder);
        expect(
          await refusal(owner, async () => {
            await owner.query(`DELETE FROM user_roles WHERE user_id = $1`, [admin]);
            await updateAdjustment(owner, id, { status: 'CANCELLED', decided_by: admin });
            expect((await adjustmentRow(owner, id)).status).toBe('CANCELLED');
          }),
        ).toBeUndefined();
      });
    });

    it('échoir : seulement une fois l’échéance passée, et sans auteur', async () => {
      const [holder, id] = await asApp(async (db) => {
        const created = await holderWith(db);
        return [created, await requested(db, created)] as const;
      });
      await asApp(async (db) => {
        expect(await refusal(db, () => updateAdjustment(db, id, { status: 'EXPIRED' }))).toMatch(
          NOT_EXPIRED_YET,
        );
      });
      // À une minute de l'échéance : pas encore.
      await asOwner((owner) => ageAdjustment(owner, id, '71 hours 59 minutes'));
      await asApp(async (db) => {
        expect(await refusal(db, () => updateAdjustment(db, id, { status: 'EXPIRED' }))).toMatch(
          NOT_EXPIRED_YET,
        );
      });
      await asOwner((owner) => ageAdjustment(owner, id, '2 minutes'));
      await asApp(async (db) => {
        // Personne ne décide d'une échéance.
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, { status: 'EXPIRED', decided_by: second }),
          ),
        ).toMatch(CHECK('ledger_adjustments_decision_check'));
        // Échue, elle ne s'approuve plus — même par qui en a le droit, avec la bonne écriture.
        expect(await refusal(db, () => writeApproval(db, id, second, entryOf(holder)))).toMatch(
          EXPIRED,
        );
        // Elle se refuse et se retire encore : rien ne bouge.
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, {
              status: 'REJECTED',
              decided_by: second,
              decision_note: 'Trop tard',
            }),
          ),
        ).toBeUndefined();

        const before = await databaseTime(db);
        await updateAdjustment(db, id, { status: 'EXPIRED' });
        const row = await adjustmentRow(db, id);
        expect(row).toMatchObject({ status: 'EXPIRED', decided_by: null, entry_id: null });
        expect(row.decided_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      });
    });

    it('approuver : un second membre du personnel habilité — l’auteur l’étant toujours', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const id = await requested(db, holder);
        const approving = (
          approver: string | null,
          before: () => Promise<unknown> = () => Promise.resolve(),
        ): Promise<string | undefined> =>
          refusal(db, async () => {
            await before();
            // Sans approbateur, la décision est écrite sans auteur.
            await writeApproval(db, id, second, entryOf(holder), { decided_by: approver });
          });

        expect(await approving(admin)).toMatch(CHECK('ledger_adjustments_four_eyes_check'));
        expect(await approving(support)).toMatch(NOT_ENTITLED_TO_DECIDE);
        expect(await approving(compliance)).toMatch(NOT_ENTITLED_TO_DECIDE);
        expect(await approving(null)).toMatch(CHECK('ledger_adjustments_decision_check'));
        // L'approbateur, suspendu depuis.
        expect(
          await approving(second, () =>
            db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [second]),
          ),
        ).toMatch(NOT_ENTITLED_TO_DECIDE);
        // L'auteur de la demande, suspendu depuis : sa demande ne s'approuve plus.
        expect(
          await approving(second, () =>
            db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [admin]),
          ),
        ).toMatch(NO_LONGER_ENTITLED_TO_REQUEST);
        // Une approbation désigne son écriture.
        expect(
          await refusal(db, () =>
            updateAdjustment(db, id, { status: 'APPROVED', decided_by: second }),
          ),
        ).toMatch(CHECK('ledger_adjustments_decision_check'));
        // Une écriture qui n'existe pas : la clé étrangère le dit.
        expect(
          await attempt(db, () =>
            updateAdjustment(db, id, {
              status: 'APPROVED',
              decided_by: second,
              entry_id: UNKNOWN_ID,
            }),
          ),
        ).toBe(FOREIGN_KEY_VIOLATION);
      });

      // L'auteur a perdu son rôle depuis : même refus. Seul le propriétaire retire un rôle.
      await asOwner(async (owner) => {
        const holder = await holderWith(owner);
        const id = await requested(owner, holder);
        expect(
          await refusal(owner, async () => {
            await owner.query(`DELETE FROM user_roles WHERE user_id = $1`, [admin]);
            await writeApproval(owner, id, second, entryOf(holder));
          }),
        ).toMatch(NO_LONGER_ENTITLED_TO_REQUEST);
        // L'approbateur a perdu le sien.
        expect(
          await refusal(owner, async () => {
            await owner.query(`DELETE FROM user_roles WHERE user_id = $1`, [second]);
            await writeApproval(owner, id, second, entryOf(holder));
          }),
        ).toMatch(NOT_ENTITLED_TO_DECIDE);
        // Le propriétaire du schéma lui-même ne se passe pas de deux personnes habilitées.
        expect(
          await refusal(owner, () => writeApproval(owner, id, admin, entryOf(holder))),
        ).toMatch(CHECK('ledger_adjustments_four_eyes_check'));
      });
    });

    it('le titulaire, fût-il administrateur, n’approuve pas l’ajustement de son portefeuille', async () => {
      await asApp(async (db) => {
        const own: Holder = {
          user: second,
          account: await openLedgerAccount(db, 'user_available', 'USD', second),
        };
        const id = await requested(db, own, { amount: 9 });
        expect(
          await refusal(db, () => writeApproval(db, id, second, entryOf(own, 'CREDIT', 9))),
        ).toMatch(CHECK('ledger_adjustments_four_eyes_check'));
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ajustement — l’écriture', () => {
    it('un crédit approuvé : la conservation est débitée, le portefeuille crédité, du même montant', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 40);
        const custodyBefore = await accountState(db, custody);
        const id = await requested(db, holder, { amount: 250 });
        const before = await databaseTime(db);
        const entryId = await approveInSql(db, id, second, entryOf(holder, 'CREDIT', 250), {
          decision_note: 'Reçu vérifié',
          decided_at: new Date('2020-01-01T00:00:00Z'),
        });

        const row = await adjustmentRow(db, id);
        expect(row).toMatchObject({
          status: 'APPROVED',
          decided_by: second,
          decision_note: 'Reçu vérifié',
          entry_id: entryId,
        });
        // L'heure de la décision est celle de la base.
        expect(row.decided_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(await accountState(db, holder.account)).toEqual({ balance: '290', postings: '2' });
        expect(await accountState(db, custody)).toEqual({
          balance: (BigInt(custodyBefore.balance) + 250n).toString(),
          postings: (BigInt(custodyBefore.postings) + 1n).toString(),
        });
        const { rows } = await db.query(
          `SELECT a.type_key, p.side::text AS side, p.amount::text AS amount, e.kind
           FROM ledger_postings p
           JOIN ledger_accounts a ON a.id = p.account_id
           JOIN ledger_entries e ON e.id = p.entry_id
           WHERE p.entry_id = $1 ORDER BY p.line_number`,
          [entryId],
        );
        expect(rows).toEqual([
          { type_key: 'platform_custody', side: 'DEBIT', amount: '250', kind: 'adjustment.credit' },
          { type_key: 'user_available', side: 'CREDIT', amount: '250', kind: 'adjustment.credit' },
        ]);
      });
    });

    it('un débit approuvé : le portefeuille est débité, la conservation créditée ; jamais au-delà du solde', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 300);
        const custodyBefore = await accountState(db, custody);
        const tooMuch = await requested(db, holder, { direction: 'DEBIT', amount: 301 });
        // Le grand livre refuse lui-même un solde négatif : la demande reste en attente.
        expect(
          await attempt(db, () =>
            writeApproval(db, tooMuch, second, entryOf(holder, 'DEBIT', 301)),
          ),
        ).toBe(INSUFFICIENT_FUNDS);
        expect((await adjustmentRow(db, tooMuch)).status).toBe('PENDING');

        const id = await requested(db, holder, { direction: 'DEBIT', amount: 300 });
        const entryId = await approveInSql(db, id, second, entryOf(holder, 'DEBIT', 300));
        expect(await accountState(db, holder.account)).toEqual({ balance: '0', postings: '2' });
        expect(await accountState(db, custody)).toEqual({
          balance: (BigInt(custodyBefore.balance) - 300n).toString(),
          postings: (BigInt(custodyBefore.postings) + 1n).toString(),
        });
        const { rows } = await db.query(
          `SELECT a.type_key, p.side::text AS side, e.kind
           FROM ledger_postings p
           JOIN ledger_accounts a ON a.id = p.account_id
           JOIN ledger_entries e ON e.id = p.entry_id
           WHERE p.entry_id = $1 ORDER BY p.line_number`,
          [entryId],
        );
        expect(rows).toEqual([
          { type_key: 'user_available', side: 'DEBIT', kind: 'adjustment.debit' },
          { type_key: 'platform_custody', side: 'CREDIT', kind: 'adjustment.debit' },
        ]);
      });
    });

    it('l’ordre des deux lignes est indifférent ; un compte suspendu s’ajuste', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const id = await requested(db, holder);
        // Le crédit du portefeuille d'abord, le débit de la conservation ensuite.
        const entry: SqlAdjustmentEntry = {
          ...entryOf(holder),
          postings: [
            { account: holder.account, side: 'CREDIT', amount: 100 },
            { account: custody, side: 'DEBIT', amount: 100 },
          ],
        };
        expect(await commitOf(db, () => writeApproval(db, id, second, entry))).toBeUndefined();
        expect(await accountState(db, holder.account)).toEqual({ balance: '100', postings: '1' });

        // Suspendu, le compte garde ses fonds : c'est par un débit qu'ils en sortent.
        await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [holder.user]);
        const exit = await requested(db, holder, { direction: 'DEBIT', amount: 100 });
        await approveInSql(db, exit, second, entryOf(holder, 'DEBIT', 100));
        expect(await accountState(db, holder.account)).toEqual({ balance: '0', postings: '2' });
      });
    });

    it('à la validation de la transaction, l’écriture désignée est celle de l’ajustement — sinon rien n’est écrit', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 500);
        const other = await holderWith(db, 500);
        const holderCdf = await openLedgerAccount(db, 'user_available', 'CDF', holder.user);
        await postEntryInSql(db, [
          { account: custodyCdf, side: 'DEBIT', amount: 500, asset: 'CDF' },
          { account: holderCdf, side: 'CREDIT', amount: 500, asset: 'CDF' },
        ]);
        const id = await requested(db, holder);
        const debit = await requested(db, holder, { direction: 'DEBIT', amount: 100 });
        const size = await ledgerSize(db);

        const line = (
          account: string,
          side: 'DEBIT' | 'CREDIT',
          amount = 100,
          asset = 'USD',
        ): SqlPosting => ({ account, side, amount, asset });
        const expected = entryOf(holder);
        const wrong: [string, string, SqlAdjustmentEntry][] = [
          ['le type de l’autre sens', id, { ...expected, kind: 'adjustment.debit' }],
          [
            'un autre montant',
            id,
            {
              ...expected,
              postings: [line(custody, 'DEBIT', 99), line(holder.account, 'CREDIT', 99)],
            },
          ],
          [
            'un autre actif',
            id,
            {
              ...expected,
              postings: [
                line(custodyCdf, 'DEBIT', 100, 'CDF'),
                line(holderCdf, 'CREDIT', 100, 'CDF'),
              ],
            },
          ],
          [
            'le portefeuille d’un autre',
            id,
            { ...expected, postings: [line(custody, 'DEBIT'), line(other.account, 'CREDIT')] },
          ],
          [
            'une contrepartie qui n’est pas la conservation',
            debit,
            {
              ...entryOf(holder, 'DEBIT'),
              postings: [line(holder.account, 'DEBIT'), line(fees, 'CREDIT')],
            },
          ],
          [
            'le sens inverse sur le portefeuille',
            id,
            { ...expected, postings: [line(holder.account, 'DEBIT'), line(custody, 'CREDIT')] },
          ],
          [
            'une ligne de plus',
            id,
            {
              ...expected,
              postings: [
                line(custody, 'DEBIT', 100),
                line(holder.account, 'CREDIT', 100),
                line(other.account, 'DEBIT', 50),
                line(holder.account, 'CREDIT', 50),
              ],
            },
          ],
          [
            'le montant en deux lignes',
            id,
            {
              ...expected,
              postings: [
                line(custody, 'DEBIT', 100),
                line(holder.account, 'CREDIT', 60),
                line(holder.account, 'CREDIT', 40),
              ],
            },
          ],
        ];
        for (const [label, adjustment, entry] of wrong) {
          expect({
            label,
            outcome: await commitOf(db, () => writeApproval(db, adjustment, second, entry)),
          }).toEqual({ label, outcome: expect.stringMatching(NOT_ITS_ENTRY) });
        }

        // Une écriture d'un autre type, déjà validée : elle ne devient pas celle d'un ajustement.
        const foreign = await postEntryInSql(db, [
          line(custody, 'DEBIT'),
          line(holder.account, 'CREDIT'),
        ]);
        expect(
          await commitOf(db, () =>
            updateAdjustment(db, id, { status: 'APPROVED', decided_by: second, entry_id: foreign }),
          ),
        ).toMatch(NOT_ITS_ENTRY);

        // Rien n'a été écrit, les deux demandes sont toujours en attente.
        expect(await ledgerSize(db)).toEqual({
          entries: size.entries + 1,
          postings: size.postings + 2,
        });
        expect((await adjustmentRow(db, id)).status).toBe('PENDING');
        expect((await adjustmentRow(db, debit)).status).toBe('PENDING');
        expect(await accountState(db, holder.account)).toEqual({ balance: '600', postings: '2' });
      });
    });

    it('une écriture d’ajustement n’existe pas sans son ajustement approuvé', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 500);
        const size = await ledgerSize(db);
        const loneEntry = (direction: 'CREDIT' | 'DEBIT'): Promise<string | undefined> =>
          commitOf(db, () => writeAdjustmentEntry(db, entryOf(holder, direction)));

        // Seule : ni un crédit, ni un débit n'échappe à la double validation.
        expect(await loneEntry('CREDIT')).toMatch(ENTRY_WITHOUT_ADJUSTMENT);
        expect(await loneEntry('DEBIT')).toMatch(ENTRY_WITHOUT_ADJUSTMENT);

        // Avec une demande restée en attente, refusée ou retirée : pas davantage.
        const pending = await requested(db, holder);
        expect(await commitOf(db, () => writeAdjustmentEntry(db, entryOf(holder)))).toMatch(
          ENTRY_WITHOUT_ADJUSTMENT,
        );
        expect(
          await commitOf(db, async () => {
            await writeAdjustmentEntry(db, entryOf(holder));
            await updateAdjustment(db, pending, {
              status: 'REJECTED',
              decided_by: second,
              decision_note: 'Refusée',
            });
          }),
        ).toMatch(ENTRY_WITHOUT_ADJUSTMENT);
        expect((await adjustmentRow(db, pending)).status).toBe('PENDING');

        // Une écriture ne sert pas deux ajustements.
        const first = await requested(db, holder, { amount: 30 });
        const twin = await requested(db, holder, { amount: 30, direction: 'DEBIT' });
        const entryId = await approveInSql(db, first, second, entryOf(holder, 'CREDIT', 30));
        expect(
          await attempt(db, () =>
            updateAdjustment(db, twin, {
              status: 'APPROVED',
              decided_by: second,
              entry_id: entryId,
            }),
          ),
        ).toBe(UNIQUE_VIOLATION);

        expect(await ledgerSize(db)).toEqual({
          entries: size.entries + 1,
          postings: size.postings + 2,
        });
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ajustement — immuabilité et privilèges', () => {
    it('une demande ne s’efface pas, quel que soit le rôle ; le rôle applicatif n’en a pas même le droit', async () => {
      const id = await asApp(async (db) => requested(db, await holderWith(db)));
      await asOwner(async (owner) => {
        for (const statement of [
          `DELETE FROM ledger_adjustments WHERE id = '${id}'`,
          `TRUNCATE ledger_adjustments`,
          `TRUNCATE ledger_adjustments CASCADE`,
        ]) {
          expect({
            statement,
            outcome: await attempt(owner, () => owner.query(statement)),
          }).toEqual({ statement, outcome: FORBIDDEN_MUTATION });
        }
      });
      await asApp(async (db) => {
        expect(await grantsOn(db, 'ledger_adjustments')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
        for (const statement of [`DELETE FROM ledger_adjustments`, `TRUNCATE ledger_adjustments`]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
        // Ni lever une protection, ni redéfinir une règle.
        for (const statement of [
          `ALTER TABLE ledger_adjustments DISABLE TRIGGER ledger_adjustments_enforce`,
          `ALTER TABLE ledger_adjustments DISABLE TRIGGER USER`,
          `DROP TRIGGER ledger_adjustments_entry_matches ON ledger_adjustments`,
          `CREATE OR REPLACE FUNCTION mgx_holds_permission(uuid, text) RETURNS boolean
             LANGUAGE sql AS 'SELECT true'`,
          `SET session_replication_role = replica`,
        ]) {
          expect({ statement, code: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            code: INSUFFICIENT_PRIVILEGE,
          });
        }
      });
    });

    it('ni un compte, ni un actif, ni une écriture ne s’effacent sous une demande ou sous un gel', async () => {
      await asOwner(async (db) => {
        const { rows } = await db.query(
          `SELECT conrelid::regclass::text AS relation, conname, confdeltype::text AS on_delete
           FROM pg_constraint
           WHERE conrelid IN ('ledger_adjustments'::regclass, 'wallet_freezes'::regclass)
             AND contype = 'f'
           ORDER BY conname`,
        );
        // « r » : RESTRICT.
        expect(rows).toEqual([
          {
            relation: 'ledger_adjustments',
            conname: 'ledger_adjustments_asset_code_fkey',
            on_delete: 'r',
          },
          {
            relation: 'ledger_adjustments',
            conname: 'ledger_adjustments_decided_by_fkey',
            on_delete: 'r',
          },
          {
            relation: 'ledger_adjustments',
            conname: 'ledger_adjustments_entry_id_fkey',
            on_delete: 'r',
          },
          {
            relation: 'ledger_adjustments',
            conname: 'ledger_adjustments_requested_by_fkey',
            on_delete: 'r',
          },
          {
            relation: 'ledger_adjustments',
            conname: 'ledger_adjustments_user_id_fkey',
            on_delete: 'r',
          },
          { relation: 'wallet_freezes', conname: 'wallet_freezes_asset_code_fkey', on_delete: 'r' },
          { relation: 'wallet_freezes', conname: 'wallet_freezes_frozen_by_fkey', on_delete: 'r' },
          { relation: 'wallet_freezes', conname: 'wallet_freezes_lifted_by_fkey', on_delete: 'r' },
          { relation: 'wallet_freezes', conname: 'wallet_freezes_user_id_fkey', on_delete: 'r' },
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('gel — le poser', () => {
    /** Gèle le portefeuille en dollars de `holder`, au nom de `admin` par défaut. */
    const freeze = (
      db: pg.Client,
      holder: string,
      columns: Record<string, unknown> = {},
    ): Promise<string> => insertFreezeRow(db, { user_id: holder, frozen_by: admin, ...columns });

    it('naît en vigueur, à l’heure de la base', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 50);
        const before = await databaseTime(db);
        const id = await freeze(db, holder.user, {
          frozen_at: new Date('2020-01-01T00:00:00Z'),
        });
        const after = await databaseTime(db);
        const row = await freezeRow(db, id);
        expect(row).toMatchObject({ lifted_by: null, lifted_at: null, lift_reason: null });
        expect(row.frozen_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(row.frozen_at.getTime()).toBeLessThanOrEqual(after.getTime());
        // Le solde demeure.
        expect(await accountState(db, holder.account)).toEqual({ balance: '50', postings: '1' });

        // Il ne naît pas levé.
        const other = await insertUser(db);
        for (const columns of [
          { lifted_by: second, lift_reason: 'Déjà levé' },
          { lifted_at: new Date() },
          { lift_reason: 'Déjà levé' },
        ]) {
          expect(await refusal(db, () => freeze(db, other, columns))).toMatch(CREATED_IN_FORCE);
        }
      });
    });

    it('seul le pose un membre du personnel actif qui détient wallet_freezes.create : la conformité, pas le support', async () => {
      await asApp(async (db) => {
        const holder = await insertUser(db);
        const customer = await insertUser(db);
        expect(await refusal(db, () => freeze(db, holder, { frozen_by: compliance }))).toBe(
          undefined,
        );
        expect(await refusal(db, () => freeze(db, holder, { frozen_by: second }))).toBeUndefined();
        for (const [label, author] of [
          ['support', support],
          ['client', customer],
          ['inconnu', UNKNOWN_ID],
        ] as const) {
          expect({
            label,
            outcome: await refusal(db, () => freeze(db, holder, { frozen_by: author })),
          }).toEqual({ label, outcome: expect.stringMatching(NOT_ENTITLED_TO_FREEZE) });
        }
        // Suspendu, un membre de la conformité n'a plus qualité.
        expect(
          await refusal(db, async () => {
            await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [compliance]);
            await freeze(db, holder, { frozen_by: compliance });
          }),
        ).toMatch(NOT_ENTITLED_TO_FREEZE);
      });
    });

    it('nul ne gèle son propre portefeuille', async () => {
      await asApp(async (db) => {
        expect(await refusal(db, () => freeze(db, admin))).toMatch(
          CHECK('wallet_freezes_not_self_frozen_check'),
        );
        expect(await refusal(db, () => freeze(db, admin, { frozen_by: second }))).toBeUndefined();
      });
    });

    it('le titulaire est un compte actif ou suspendu ; l’actif est tenu ; la raison est réelle', async () => {
      await asApp(async (db) => {
        const suspended = await insertUser(db, { status: 'SUSPENDED' });
        expect(await refusal(db, () => freeze(db, suspended))).toBeUndefined();

        const pending = await insertUser(db, {
          status: 'PENDING_VERIFICATION',
          email_verified_at: null,
        });
        expect(await refusal(db, () => freeze(db, pending))).toMatch(
          NO_WALLET_TO_FREEZE('pending_verification'),
        );

        const closed = await insertUser(db);
        await closeAccountInSql(db, closed);
        expect(await attempt(db, () => freeze(db, closed))).toBe(ACCOUNT_CLOSED);
        expect(await attempt(db, () => freeze(db, UNKNOWN_ID))).toBe(FOREIGN_KEY_VIOLATION);

        const holder = await insertUser(db);
        expect(await attempt(db, () => freeze(db, holder, { asset_code: 'EUR' }))).toBe(
          FOREIGN_KEY_VIOLATION,
        );
        expect(await refusal(db, () => freeze(db, holder, { reason: '  ' }))).toMatch(
          CHECK('wallet_freezes_reason_not_blank_check'),
        );
        expect(await attempt(db, () => freeze(db, holder, { reason: 'x'.repeat(501) }))).toBe(
          STRING_TOO_LONG,
        );
      });
    });

    it('un seul gel en vigueur par portefeuille ; un autre actif, un autre titulaire se gèlent', async () => {
      await asApp(async (db) => {
        const holder = await insertUser(db);
        const other = await insertUser(db);
        const id = await freeze(db, holder);
        expect(await attempt(db, () => freeze(db, holder))).toBe(UNIQUE_VIOLATION);
        expect(await attempt(db, () => freeze(db, holder, { frozen_by: compliance }))).toBe(
          UNIQUE_VIOLATION,
        );
        expect(await attempt(db, () => freeze(db, holder, { asset_code: 'CDF' }))).toBeUndefined();
        expect(await attempt(db, () => freeze(db, other))).toBeUndefined();
        // Levé, il ne s'oppose plus à un nouveau gel : les deux restent, l'un après l'autre.
        await liftFreezeInSql(db, id, second);
        const again = await freeze(db, holder, { frozen_by: compliance });
        const { rows } = await db.query(
          `SELECT id::text AS id, lifted_at IS NULL AS in_force FROM wallet_freezes
           WHERE user_id = $1 ORDER BY id`,
          [holder],
        );
        expect(rows).toEqual([
          { id, in_force: false },
          { id: again, in_force: true },
        ]);
      });
    });

    it('geler ouvre le compte du portefeuille s’il ne l’était pas — vide —, et n’en ouvre pas un second', async () => {
      await asApp(async (db) => {
        const fresh = await insertUser(db);
        const accountsOf = async (user: string): Promise<Record<string, string>[]> =>
          (
            await db.query<Record<string, string>>(
              `SELECT type_key, asset_code, balance::text AS balance,
                      posting_count::text AS postings
               FROM ledger_accounts WHERE user_id = $1 ORDER BY asset_code`,
              [user],
            )
          ).rows;
        expect(await accountsOf(fresh)).toEqual([]);
        await freeze(db, fresh, { asset_code: 'CDF' });
        // Le seul compte du portefeuille gelé : il y a désormais un verrou à prendre.
        expect(await accountsOf(fresh)).toEqual([
          { type_key: 'user_available', asset_code: 'CDF', balance: '0', postings: '0' },
        ]);

        const holder = await holderWith(db, 75);
        await freeze(db, holder.user);
        expect(await accountsOf(holder.user)).toEqual([
          { type_key: 'user_available', asset_code: 'USD', balance: '75', postings: '1' },
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('gel — le lever', () => {
    const frozen = async (db: pg.Client, holder: string): Promise<string> =>
      insertFreezeRow(db, { user_id: holder, frozen_by: compliance });

    it('seul le lève un membre du personnel actif qui détient wallet_freezes.lift — pas la conformité', async () => {
      await asApp(async (db) => {
        const id = await frozen(db, await insertUser(db));
        for (const [label, author] of [
          ['conformité', compliance],
          ['support', support],
          ['inconnu', UNKNOWN_ID],
        ] as const) {
          expect({
            label,
            outcome: await refusal(db, () => liftFreezeInSql(db, id, author)),
          }).toEqual({ label, outcome: expect.stringMatching(NOT_ENTITLED_TO_LIFT) });
        }
        expect(
          await refusal(db, async () => {
            await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [second]);
            await liftFreezeInSql(db, id, second);
          }),
        ).toMatch(NOT_ENTITLED_TO_LIFT);

        const before = await databaseTime(db);
        // L'heure de la levée est celle de la base : celle qu'on fournit est ignorée.
        await updateFreeze(db, id, {
          lifted_by: second,
          lift_reason: 'Vérification terminée',
          lifted_at: new Date('2020-01-01T00:00:00Z'),
        });
        const row = await freezeRow(db, id);
        expect(row).toMatchObject({ lifted_by: second, lift_reason: 'Vérification terminée' });
        expect(row.lifted_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(row.lifted_at!.getTime()).toBeGreaterThanOrEqual(row.frozen_at.getTime());
      });
    });

    it('nul ne lève le gel de son propre portefeuille ; une levée a son auteur et sa raison', async () => {
      await asApp(async (db) => {
        const own = await insertFreezeRow(db, { user_id: second, frozen_by: admin });
        expect(await refusal(db, () => liftFreezeInSql(db, own, second))).toMatch(
          CHECK('wallet_freezes_not_self_lifted_check'),
        );
        // Un autre le lève — ce qui rend aussi son portefeuille à la suite des essais.
        await liftFreezeInSql(db, own, admin);
        expect((await freezeRow(db, own)).lifted_by).toBe(admin);

        const id = await frozen(db, await insertUser(db));
        expect(await refusal(db, () => updateFreeze(db, id, { lifted_by: second }))).toMatch(
          CHECK('wallet_freezes_lift_check'),
        );
        expect(
          await refusal(db, () => updateFreeze(db, id, { lifted_by: second, lift_reason: ' ' })),
        ).toMatch(CHECK('wallet_freezes_lift_reason_not_blank_check'));
        // Sans auteur, ce n'est pas une levée.
        expect(
          await refusal(db, () => updateFreeze(db, id, { lift_reason: 'Sans auteur' })),
        ).toMatch(ONLY_LIFTED);
        expect(await refusal(db, () => updateFreeze(db, id, { lifted_at: new Date() }))).toMatch(
          ONLY_LIFTED,
        );
      });
    });

    it('les termes d’un gel ne changent jamais ; levé, il ne change plus ; il ne s’efface pas', async () => {
      const id = await asApp(async (db) => {
        const holder = await insertUser(db);
        const other = await insertUser(db);
        const created = await frozen(db, holder);
        const terms: [string, Record<string, unknown>][] = [
          ['titulaire', { user_id: other }],
          ['actif', { asset_code: 'CDF' }],
          ['raison', { reason: 'Une autre raison, écrite après coup' }],
          ['auteur', { frozen_by: second }],
          ['heure', { frozen_at: new Date('2020-01-01T00:00:00Z') }],
        ];
        for (const [label, columns] of terms) {
          expect({
            label,
            outcome: await refusal(db, () =>
              updateFreeze(db, created, { ...columns, lifted_by: second, lift_reason: 'Levé' }),
            ),
          }).toEqual({ label, outcome: expect.stringMatching(FREEZE_TERMS_FIXED) });
        }
        await liftFreezeInSql(db, created, second);
        for (const [label, columns] of [
          ['lever de nouveau', { lifted_by: admin, lift_reason: 'Une seconde fois' }],
          ['rétablir', { lifted_by: null, lifted_at: null, lift_reason: null }],
          ['changer la raison de la levée', { lift_reason: 'Réécrite' }],
        ] as const) {
          expect({
            label,
            outcome: await refusal(db, () => updateFreeze(db, created, columns)),
          }).toEqual({ label, outcome: expect.stringMatching(ALREADY_LIFTED) });
        }
        expect(await grantsOn(db, 'wallet_freezes')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
        for (const statement of [`DELETE FROM wallet_freezes`, `TRUNCATE wallet_freezes`]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
        for (const statement of [
          `ALTER TABLE wallet_freezes DISABLE TRIGGER wallet_freezes_enforce`,
          `ALTER TABLE ledger_postings DISABLE TRIGGER ledger_postings_frozen_wallet`,
          `DROP TRIGGER ledger_postings_frozen_wallet ON ledger_postings`,
        ]) {
          expect({ statement, code: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            code: INSUFFICIENT_PRIVILEGE,
          });
        }
        return created;
      });
      await asOwner(async (owner) => {
        expect(
          await refusal(owner, () => updateFreeze(owner, id, { lift_reason: 'Réécrite' })),
        ).toMatch(ALREADY_LIFTED);
        for (const statement of [
          `DELETE FROM wallet_freezes WHERE id = '${id}'`,
          `TRUNCATE wallet_freezes`,
        ]) {
          expect({
            statement,
            outcome: await attempt(owner, () => owner.query(statement)),
          }).toEqual({ statement, outcome: FORBIDDEN_MUTATION });
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('portefeuille gelé — les écritures', () => {
    /** Gèle, au nom de la conformité, le portefeuille en dollars de `holder`. */
    const frozenWallet = (db: pg.Client, holder: Holder, asset = 'USD'): Promise<string> =>
      insertFreezeRow(db, { user_id: holder.user, frozen_by: compliance, asset_code: asset });

    /** Une écriture quelconque de deux lignes, dans une transaction annulée : le refus de la base. */
    const posting = (
      db: pg.Client,
      lines: readonly SqlPosting[],
      kind = 'test.entry',
    ): Promise<string | undefined> =>
      refusal(db, async () => {
        const entryId = await insertEntryHeader(db, lines.length, { kind });
        await insertPostings(db, entryId, lines);
      });

    it('aucune ligne n’y passe, ni débit ni crédit ; les autres portefeuilles ne sont pas touchés', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 200);
        const other = await holderWith(db, 200);
        const holderCdf = await openLedgerAccount(db, 'user_available', 'CDF', holder.user);
        await frozenWallet(db, holder);

        expect(
          await posting(db, [
            { account: holder.account, side: 'DEBIT', amount: 10 },
            { account: custody, side: 'CREDIT', amount: 10 },
          ]),
        ).toMatch(WALLET_FROZEN());
        expect(
          await posting(db, [
            { account: custody, side: 'DEBIT', amount: 10 },
            { account: holder.account, side: 'CREDIT', amount: 10 },
          ]),
        ).toMatch(WALLET_FROZEN());
        // Le gel ne tient pas au type de l'opération : toute écriture est refusée.
        for (const kind of [
          'transfer.internal',
          'deposit.confirmed',
          'adjustment',
          'adjustment.creditx',
        ]) {
          expect({
            kind,
            outcome: await posting(
              db,
              [
                { account: custody, side: 'DEBIT', amount: 10 },
                { account: holder.account, side: 'CREDIT', amount: 10 },
              ],
              kind,
            ),
          }).toEqual({ kind, outcome: expect.stringMatching(WALLET_FROZEN()) });
        }

        // Le même titulaire, dans un autre actif ; un autre titulaire, dans le même : rien ne change.
        expect(
          await posting(db, [
            { account: custodyCdf, side: 'DEBIT', amount: 10, asset: 'CDF' },
            { account: holderCdf, side: 'CREDIT', amount: 10, asset: 'CDF' },
          ]),
        ).toBeUndefined();
        expect(
          await posting(db, [
            { account: other.account, side: 'DEBIT', amount: 10 },
            { account: custody, side: 'CREDIT', amount: 10 },
          ]),
        ).toBeUndefined();
        // Rien n'a bougé sur le portefeuille gelé.
        expect(await accountState(db, holder.account)).toEqual({ balance: '200', postings: '1' });
      });
    });

    it('un transfert n’en part ni n’y arrive', async () => {
      await asApp(async (db) => {
        const sender = await holderWith(db, 500);
        const recipient = await holderWith(db);
        await verifyUpTo(db, sender.user, 1, admin);
        await verifyUpTo(db, recipient.user, 1, admin);
        const transfer = (from: Holder, to: Holder): Promise<string | undefined> =>
          refusal(db, () =>
            writeTransfer(db, {
              sender: from.user,
              senderAccount: from.account,
              recipient: to.user,
              recipientAccount: to.account,
              amount: 100,
            }),
          );
        // Témoin : sans gel, le transfert passe.
        expect(await transfer(sender, recipient)).toBeUndefined();

        const id = await frozenWallet(db, sender);
        expect(await transfer(sender, recipient)).toMatch(WALLET_FROZEN());
        await liftFreezeInSql(db, id, second);
        // Levé, le gel ne s'oppose plus à rien.
        expect(await transfer(sender, recipient)).toBeUndefined();

        await frozenWallet(db, recipient);
        expect(await transfer(sender, recipient)).toMatch(WALLET_FROZEN());
      });
    });

    it('les ajustements du personnel y passent, crédit comme débit : c’est par eux que des fonds en sortent', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 200);
        await frozenWallet(db, holder);
        const credit = await requested(db, holder, { amount: 50 });
        await approveInSql(db, credit, second, entryOf(holder, 'CREDIT', 50));
        const debit = await requested(db, holder, { direction: 'DEBIT', amount: 250 });
        await approveInSql(db, debit, second, entryOf(holder, 'DEBIT', 250));
        expect(await accountState(db, holder.account)).toEqual({ balance: '0', postings: '3' });
        // Le type seul n'ouvre rien : sans son ajustement approuvé, l'écriture n'est pas validée.
        expect(
          await commitOf(db, () => writeAdjustmentEntry(db, entryOf(holder, 'CREDIT', 5))),
        ).toMatch(ENTRY_WITHOUT_ADJUSTMENT);
      });
    });

    it('les types d’écriture qui passent un gel sont, dans la base, ceux du code', async () => {
      await asOwner(async (owner) => {
        const { rows } = await owner.query<{ source: string }>(
          `SELECT pg_get_functiondef('mgx_forbid_frozen_wallet_posting'::regproc) AS source`,
        );
        const list = /entry_kind NOT IN \(([^)]*)\)/.exec(rows[0]!.source)?.[1];
        const kinds = (list ?? '').split(',').map((kind) => kind.trim().replace(/^'|'$/g, ''));
        expect(kinds.sort()).toEqual([...ENTRY_KINDS_PASSING_A_FREEZE].sort());
        expect(kinds.sort()).toEqual(Object.values(LEDGER_ADJUSTMENT_ENTRY_KINDS).sort());
        // Et ce sont ceux que la base exige d'un ajustement approuvé.
        const reciprocal = await owner.query<{ condition: string }>(
          `SELECT pg_get_triggerdef(oid) AS condition FROM pg_trigger
           WHERE tgname = 'ledger_entries_adjustment_recorded'`,
        );
        for (const kind of kinds) {
          expect(reciprocal.rows[0]!.condition).toContain(`'${kind}'`);
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('gel et écritures simultanées', () => {
    const begin = async (db: pg.Client): Promise<void> => {
      await db.query('BEGIN');
      // Un essai qui ne rend pas la main échoue, au lieu d'attendre.
      await db.query(`SET LOCAL lock_timeout = '5s'`);
    };
    const freezeOf = (db: pg.Client, holder: string, asset = 'USD'): Promise<string> =>
      insertFreezeRow(db, { user_id: holder, frozen_by: compliance, asset_code: asset });
    const debitOf = async (db: pg.Client, holder: Holder, amount: number): Promise<void> => {
      const entryId = await insertEntryHeader(db, 2);
      await insertPostings(db, entryId, [
        { account: holder.account, side: 'DEBIT', amount },
        { account: custody, side: 'CREDIT', amount },
      ]);
    };

    it('le gel attend l’écriture en cours sur le portefeuille ; la suivante est refusée', async () => {
      const holder = await asApp((db) => holderWith(db, 100));
      await asApp(async (writer) => {
        await asApp(async (freezer) => {
          await asApp(async (observer) => {
            await begin(writer);
            await debitOf(writer, holder, 60);
            // L'écriture n'est pas validée : le gel attend.
            const freezing = freezeOf(freezer, holder.user);
            await untilBlocked(observer);
            await writer.query('COMMIT');
            const freezeId = await freezing;

            expect(await accountState(observer, holder.account)).toEqual({
              balance: '40',
              postings: '2',
            });
            // Le gel est daté d'après l'écriture qu'il a attendue.
            const { rows } = await observer.query<{ after: boolean }>(
              `SELECT f.frozen_at >= e.posted_at AS after
               FROM wallet_freezes f, ledger_entries e
               WHERE f.id = $1 AND e.id = (
                 SELECT entry_id FROM ledger_postings WHERE account_id = $2
                 ORDER BY account_sequence DESC LIMIT 1)`,
              [freezeId, holder.account],
            );
            expect(rows).toEqual([{ after: true }]);
            expect(await refusal(observer, () => debitOf(observer, holder, 10))).toMatch(
              WALLET_FROZEN(),
            );
          });
        });
      });
    });

    it('une écriture attend le gel en cours, puis est refusée', async () => {
      const holder = await asApp((db) => holderWith(db, 100));
      await asApp(async (writer) => {
        await asApp(async (freezer) => {
          await asApp(async (observer) => {
            await begin(freezer);
            await freezeOf(freezer, holder.user);
            // Le gel n'est pas validé : l'écriture attend le verrou du compte.
            await begin(writer);
            const writing = failure(() => debitOf(writer, holder, 60));
            await untilBlocked(observer);
            await freezer.query('COMMIT');
            expect(await writing).toMatch(WALLET_FROZEN());
            await writer.query('ROLLBACK');
            expect(await accountState(observer, holder.account)).toEqual({
              balance: '100',
              postings: '1',
            });
          });
        });
      });
    });

    it('un gel annulé ne gèle rien : l’écriture qui l’attendait passe', async () => {
      const holder = await asApp((db) => holderWith(db, 100));
      await asApp(async (writer) => {
        await asApp(async (freezer) => {
          await asApp(async (observer) => {
            await begin(freezer);
            await freezeOf(freezer, holder.user);
            await begin(writer);
            const writing = failure(() => debitOf(writer, holder, 60));
            await untilBlocked(observer);
            await freezer.query('ROLLBACK');
            expect(await writing).toBeUndefined();
            await writer.query('COMMIT');
            expect(await accountState(observer, holder.account)).toEqual({
              balance: '40',
              postings: '2',
            });
          });
        });
      });
    });

    it('le gel attend le transfert en cours de l’émetteur, avant même sa première ligne', async () => {
      const holder = await asApp((db) => holderWith(db, 100));
      await asApp(async (sender) => {
        await asApp(async (freezer) => {
          await asApp(async (observer) => {
            await begin(sender);
            // Un transfert commence par verrouiller son émetteur — et rien d'autre encore.
            await sender.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [
              holder.user,
            ]);
            const freezing = freezeOf(freezer, holder.user);
            await untilBlocked(observer);
            // Le transfert se poursuit : ses lignes passent, le gel n'étant pas encore posé.
            await debitOf(sender, holder, 60);
            await sender.query('COMMIT');
            await freezing;
            expect(await accountState(observer, holder.account)).toEqual({
              balance: '40',
              postings: '2',
            });
          });
        });
      });
    });

    it('le premier crédit d’un portefeuille jamais utilisé attend le gel, qui ouvre son compte', async () => {
      const user = await asApp((db) => insertUser(db));
      await asApp(async (writer) => {
        await asApp(async (freezer) => {
          await asApp(async (observer) => {
            await begin(freezer);
            await freezeOf(freezer, user, 'CDF');
            await begin(writer);
            // L'écriture ouvre le compte comme le fait l'application : elle attend le gel.
            const opening = openLedgerAccount(writer, 'user_available', 'CDF', user);
            await untilBlocked(observer);
            await freezer.query('COMMIT');
            const account = await opening;
            expect(
              await failure(async () => {
                const entryId = await insertEntryHeader(writer, 2);
                await insertPostings(writer, entryId, [
                  { account: custodyCdf, side: 'DEBIT', amount: 10, asset: 'CDF' },
                  { account, side: 'CREDIT', amount: 10, asset: 'CDF' },
                ]);
              }),
            ).toMatch(WALLET_FROZEN('CDF'));
            await writer.query('ROLLBACK');
          });
        });
      });
    });

    it('de deux gels simultanés du même portefeuille, un seul est posé', async () => {
      const holder = await asApp((db) => holderWith(db, 100));
      await asApp(async (first) => {
        await asApp(async (secondSession) => {
          await asApp(async (observer) => {
            await begin(first);
            await freezeOf(first, holder.user);
            await begin(secondSession);
            const competing = sqlState(() =>
              insertFreezeRow(secondSession, { user_id: holder.user, frozen_by: second }),
            );
            await untilBlocked(observer);
            await first.query('COMMIT');
            expect(await competing).toBe(UNIQUE_VIOLATION);
            await secondSession.query('ROLLBACK');
            const { rows } = await observer.query(
              `SELECT count(*)::int AS in_force FROM wallet_freezes
               WHERE user_id = $1 AND lifted_at IS NULL`,
              [holder.user],
            );
            expect(rows).toEqual([{ in_force: 1 }]);
          });
        });
      });
    });

    it('de deux décisions simultanées sur une même demande, une seule s’applique', async () => {
      const [holder, id] = await asApp(async (db) => {
        const created = await holderWith(db);
        return [created, await requested(db, created)] as const;
      });
      await asApp(async (approver) => {
        await asApp(async (rejecter) => {
          await asApp(async (observer) => {
            await begin(approver);
            await writeApproval(approver, id, second, entryOf(holder));
            await begin(rejecter);
            const rejecting = failure(() =>
              updateAdjustment(rejecter, id, {
                status: 'REJECTED',
                decided_by: second,
                decision_note: 'Refusée',
              }),
            );
            await untilBlocked(observer);
            await approver.query('COMMIT');
            expect(await rejecting).toMatch(ALREADY_DECIDED('APPROVED'));
            await rejecter.query('ROLLBACK');
            expect((await adjustmentRow(observer, id)).status).toBe('APPROVED');
            expect(await accountState(observer, holder.account)).toEqual({
              balance: '100',
              postings: '1',
            });
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('clôture d’un compte', () => {
    it('un compte dont un portefeuille est gelé ne se clôt pas ; le gel levé, il se clôt', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertFreezeRow(db, { user_id: user, frozen_by: compliance });
        expect(await failure(() => closeAccountInSql(db, user))).toMatch(FROZEN_AT_CLOSURE);
        expect(await sqlState(() => closeAccountInSql(db, user))).toBe(CLOSURE_RULE_VIOLATION);
        // Un gel dans un autre actif s'y oppose tout autant ; un gel levé, non.
        await liftFreezeInSql(db, id, second);
        const other = await insertFreezeRow(db, {
          user_id: user,
          frozen_by: compliance,
          asset_code: 'CDF',
        });
        expect(await failure(() => closeAccountInSql(db, user))).toMatch(FROZEN_AT_CLOSURE);
        await liftFreezeInSql(db, other, second);
        await closeAccountInSql(db, user);
        const { rows } = await db.query(`SELECT status::text AS status FROM users WHERE id = $1`, [
          user,
        ]);
        expect(rows).toEqual([{ status: 'CLOSED' }]);
        // Les deux gels restent : ils sont la trace de ce qui a été décidé.
        const freezes = await db.query(
          `SELECT count(*)::int AS kept FROM wallet_freezes WHERE user_id = $1`,
          [user],
        );
        expect(freezes.rows).toEqual([{ kept: 2 }]);
      });
    });

    it('le propriétaire du schéma lui-même ne clôt pas un compte au portefeuille gelé', async () => {
      const user = await asApp(async (db) => {
        const created = await insertUser(db);
        await insertFreezeRow(db, { user_id: created, frozen_by: compliance });
        return created;
      });
      await asOwner(async (owner) => {
        expect(await failure(() => closeAccountInSql(owner, user))).toMatch(FROZEN_AT_CLOSURE);
      });
    });

    it('une demande en attente ne retient pas la clôture : elle ne s’approuve plus, mais se refuse et se retire', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const credit = await requested(db, holder);
        const other = await requested(db, holder, { amount: 55 });
        await closeAccountInSql(db, holder.user);
        // Plus rien ne s'écrit sur le compte clôturé : l'écriture de l'approbation est refusée.
        expect(await attempt(db, () => writeApproval(db, credit, second, entryOf(holder)))).toBe(
          ACCOUNT_CLOSED,
        );
        await updateAdjustment(db, credit, {
          status: 'REJECTED',
          decided_by: second,
          decision_note: 'Compte clôturé depuis',
        });
        await updateAdjustment(db, other, { status: 'CANCELLED', decided_by: admin });
        expect((await adjustmentRow(db, credit)).status).toBe('REJECTED');
        expect((await adjustmentRow(db, other)).status).toBe('CANCELLED');
        // Et aucune nouvelle demande ne vise un compte clôturé.
        expect(await attempt(db, () => requested(db, holder, { amount: 56 }))).toBe(ACCOUNT_CLOSED);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('robustesse des règles', () => {
    it('chaque fonction ne résout les noms que dans le schéma de l’application', async () => {
      await asOwner(async (owner) => {
        const { rows } = await owner.query<{ proname: string; proconfig: string[] | null }>(
          `SELECT proname, proconfig FROM pg_proc
           WHERE proname IN ('mgx_holds_permission', 'mgx_enforce_ledger_adjustment',
                             'mgx_check_adjustment_entry', 'mgx_check_adjustment_recorded',
                             'mgx_enforce_wallet_freeze', 'mgx_forbid_frozen_wallet_posting',
                             'mgx_forbid_closure_with_frozen_wallet')
           ORDER BY proname`,
        );
        expect(rows).toHaveLength(7);
        for (const { proname, proconfig } of rows) {
          expect({ proname, proconfig }).toEqual({
            proname,
            proconfig: ['search_path=public, pg_temp'],
          });
        }
      });
    });

    it('des copies des tables placées sur le chemin de recherche ne donnent ni permission, ni dégel', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db, 100);
        const customer = await insertUser(db);
        await insertFreezeRow(db, { user_id: holder.user, frozen_by: compliance });
        // Des tables temporaires homonymes : tout le monde y est administrateur, rien n'y est gelé.
        await db.query(`CREATE TEMP TABLE user_roles AS
                          SELECT u.id AS user_id, r.id AS role_id FROM public.users u, public.roles r
                          WHERE r.key = 'super_admin'`);
        await db.query(`CREATE TEMP TABLE wallet_freezes (LIKE public.wallet_freezes)`);
        await db.query(`SET search_path = pg_temp, public`);
        try {
          expect(
            await refusal(db, () =>
              db.query(
                `INSERT INTO public.ledger_adjustments
                   (user_id, asset_code, direction, amount, reason, requested_by)
                 VALUES ($1, 'USD', 'CREDIT', 100, 'Demande d’un client', $2)`,
                [holder.user, customer],
              ),
            ),
          ).toMatch(NOT_ENTITLED_TO_REQUEST);
          expect(
            await refusal(db, () =>
              db.query(
                `INSERT INTO public.wallet_freezes (user_id, asset_code, reason, frozen_by)
                 VALUES ($1, 'CDF', 'Gel posé par un client', $2)`,
                [holder.user, customer],
              ),
            ),
          ).toMatch(NOT_ENTITLED_TO_FREEZE);
          expect(
            await refusal(db, async () => {
              const { rows } = await db.query<{ id: string }>(
                `INSERT INTO public.ledger_entries (idempotency_key, kind, posting_count, actor_type)
                 VALUES ('test:search-path-freeze', 'test.entry', 2, 'SYSTEM') RETURNING id`,
              );
              await db.query(
                `INSERT INTO public.ledger_postings
                   (entry_id, line_number, account_id, asset_code, side, amount, account_sequence,
                    balance_after)
                 VALUES ($1, 1, $2, 'USD', 'DEBIT', 10, 0, 0), ($1, 2, $3, 'USD', 'CREDIT', 10, 0, 0)`,
                [rows[0]!.id, holder.account, custody],
              );
            }),
          ).toMatch(WALLET_FROZEN());
        } finally {
          await db.query(`RESET search_path`);
        }
      });
    });
  });
});
