import { PERMISSIONS } from '@mgx/contracts';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import { verifiedLevelOf } from '../../src/modules/identity/domain/verification-level.js';
import {
  closeAccountInSql,
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
} from '../support/account-closure.js';
import { approve, type Level, reject, revoke, submitted } from '../support/kyc-sql.js';
import {
  accountState,
  insertEntryHeader,
  insertPostings,
  ledgerSize,
  openLedgerAccount,
  postEntryInSql,
  registerAssetInSql,
} from '../support/ledger-sql.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE } from '../support/test-environment.js';
import {
  backdateTransfer,
  freshKey,
  insertTransferRow,
  setLimitInSql,
  transferInSql,
  usageInSql,
  verifyUpTo,
  writeTransfer,
} from '../support/transfers-sql.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const STRING_TOO_LONG = '22001';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Écriture visant un compte clôturé (migration account_closure). */
const ACCOUNT_CLOSED = 'MGX05';
/** Fonds insuffisants (migration ledger). */
const INSUFFICIENT_FUNDS = 'MGX09';
/** Règle des transferts enfreinte (migration internal_transfers). */
const TRANSFER_RULE_VIOLATION = 'MGX10';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

// Toutes les règles des transferts lèvent le même code : c'est le message qui dit laquelle.
const NOT_ENTITLED = /^MGX10: account \S+ is not entitled to set transfer limits$/;
const OWNER_ONLY = /^MGX10: transfer limits without an author can only be set by the owner role$/;
const LIMIT_IDENTITY =
  /^MGX10: transfer limits cannot change their asset or their verification level$/;
const SENDER_STATUS = (status: string): RegExp =>
  new RegExp(`^MGX10: account \\S+ cannot send a transfer: it is ${status}$`);
const RECIPIENT_STATUS = (status: string): RegExp =>
  new RegExp(`^MGX10: account \\S+ cannot receive a transfer: it is ${status}$`);
const LEVEL_MISMATCH = (verified: number, claimed: number): RegExp =>
  new RegExp(
    `^MGX10: the verification level of account \\S+ is ${String(verified)}, not ${String(claimed)}$`,
  );
const LEVEL_NOT_OPEN = (level: number, asset = 'USD'): RegExp =>
  new RegExp(`^MGX10: transfers in ${asset} are not open to verification level ${String(level)}$`);
const OVER_PER_TRANSFER = (level: number): RegExp =>
  new RegExp(
    `^MGX10: the transfer exceeds the limit per transfer of verification level ${String(level)} in USD$`,
  );
const OVER_DAILY = (level: number): RegExp =>
  new RegExp(
    `^MGX10: the transfer exceeds the limit over 24 hours of verification level ${String(level)} in USD$`,
  );
const OVER_MONTHLY = (level: number): RegExp =>
  new RegExp(
    `^MGX10: the transfer exceeds the limit over 31 days of verification level ${String(level)} in USD$`,
  );
const RECIPIENT_NOT_OPEN =
  /^MGX10: transfers in USD are not open to the verification level of account \S+$/;
const NOT_ITS_ENTRY = /^MGX10: ledger entry \S+ is not the one of transfer \S+$/;
const ENTRY_WITHOUT_TRANSFER = /^MGX10: ledger entry \S+ is a transfer entry without a transfer$/;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Fuseau horaire fictif (règle POSIX) où l'heure a changé il y a `hoursAgo` heures : avancée
 * d'une heure (`FORWARD`) ou reculée d'une heure (`BACKWARD`). L'autre changement de l'année
 * est placé à cinq mois de là, hors de toute fenêtre examinée.
 */
function zoneWithShift(direction: 'FORWARD' | 'BACKWARD', now: Date, hoursAgo: number): string {
  /** Jour de l'année, compté de zéro, et heure — tels que la règle POSIX les écrit. */
  const rule = (moment: Date): string => {
    const startOfYear = Date.UTC(moment.getUTCFullYear(), 0, 1);
    const day = Math.floor((moment.getTime() - startOfYear) / (24 * HOUR_MS));
    return `${String(day)}/${String(moment.getUTCHours())}`;
  };
  const shift = new Date(now.getTime() - hoursAgo * HOUR_MS);
  const fiveMonths = 150 * 24 * HOUR_MS;
  // « XST0XDT,début,fin » : heure d'été du début à la fin, une heure d'avance sur l'heure UTC.
  return direction === 'FORWARD'
    ? `XST0XDT,${rule(shift)},${rule(new Date(shift.getTime() + fiveMonths))}`
    : `XST0XDT,${rule(new Date(shift.getTime() - fiveMonths))},${rule(shift)}`;
}

interface Holder {
  readonly user: string;
  /** Compte « fonds disponibles » en dollars. */
  readonly account: string;
}

describe('Transferts — règles portées par la base de données', () => {
  let database: TestDatabase;
  let admin: string;
  let support: string;
  let custody: string;
  let fees: string;
  /** Une écriture quelconque, déjà validée : de quoi désigner une écriture existante. */
  let anyEntry: string;

  // Plafonds en dollars, en unités minimales : niveau 0 sans plafond ; niveau 1 ; niveau 2 ;
  // niveau 3 refermé (plafonds nuls).
  const LEVEL_1 = [100, 250, 1000] as const;
  const LEVEL_2 = [1000, 2500, 10_000] as const;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      support = await insertStaff(db, 'support');
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
      await registerAssetInSql(db, 'EUR', 2);
      await setLimitInSql(db, 'USD', 1, LEVEL_1);
      await setLimitInSql(db, 'USD', 2, LEVEL_2);
      await setLimitInSql(db, 'USD', 3, [0, 0, 0]);
      await setLimitInSql(db, 'CDF', 1, [5000, 5000, 5000]);
    });
    await asApp(async (db) => {
      custody = await openLedgerAccount(db, 'platform_custody', 'USD');
      fees = await openLedgerAccount(db, 'platform_fees', 'USD');
      anyEntry = await postEntryInSql(db, [
        { account: custody, side: 'DEBIT', amount: 1 },
        { account: fees, side: 'CREDIT', amount: 1 },
      ]);
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
      email: `transfers${String(sequence)}@example.cd`,
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

  /** Le même, avec le message : toutes les règles des transferts lèvent le même code. */
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

  /**
   * Un titulaire actif au niveau de vérification voulu, et son compte « fonds disponibles » en
   * dollars, crédité de `units`.
   */
  async function holderAt(db: pg.Client, level: 0 | Level, units = 0): Promise<Holder> {
    const user = await insertUser(db);
    await verifyUpTo(db, user, level, admin);
    const account = await openLedgerAccount(db, 'user_available', 'USD', user);
    if (units > 0) {
      await deposit(db, account, units);
    }
    return { user, account };
  }

  /** Un transfert en dollars, validé, de `from` à `to` ; `level` est le niveau de l'émetteur. */
  const send = (
    db: pg.Client,
    from: Holder,
    to: Holder,
    amount: number,
    level = 1,
  ): Promise<{ transferId: string; entryId: string }> =>
    transferInSql(db, {
      sender: from.user,
      senderAccount: from.account,
      recipient: to.user,
      recipientAccount: to.account,
      amount,
      level,
    });

  /**
   * La seule ligne d'un transfert en dollars de `from` à `to`, dans une transaction annulée :
   * rend le refus de la base, ou `undefined` si elle l'admet. L'écriture désignée n'est pas la
   * sienne — ce que la base ne vérifie qu'à la validation, qui n'a pas lieu.
   */
  const rowRefusal = (
    db: pg.Client,
    from: Holder,
    to: Holder,
    amount: number,
    columns: Record<string, unknown> = {},
  ): Promise<string | undefined> =>
    refusal(db, () =>
      insertTransferRow(db, {
        sender_id: from.user,
        recipient_id: to.user,
        amount,
        entry_id: anyEntry,
        ...columns,
      }),
    );

  const grantsOn = async (db: pg.Client, table: string): Promise<string[]> =>
    (
      await db.query<{ privileges: string[] }>(
        `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_name = $2`,
        [TEST_APP_ROLE, table],
      )
    ).rows[0]!.privileges;

  const transferCount = async (db: pg.Client): Promise<number> =>
    (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM transfers`)).rows[0]!
      .count;

  describe('catalogue des permissions', () => {
    it('transfer_limits.read et transfer_limits.write y figurent ; seul super_admin les détient', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query(
          `SELECT p.key, p.description, array_agg(r.key ORDER BY r.key) AS roles
           FROM permissions p
           LEFT JOIN role_permissions rp ON rp.permission_key = p.key
           LEFT JOIN roles r ON r.id = rp.role_id
           WHERE p.key LIKE 'transfer_limits.%'
           GROUP BY p.key, p.description ORDER BY p.key`,
        );
        expect(rows).toEqual([
          {
            key: 'transfer_limits.read',
            description: PERMISSIONS['transfer_limits.read'],
            roles: ['super_admin'],
          },
          {
            key: 'transfer_limits.write',
            description: PERMISSIONS['transfer_limits.write'],
            roles: ['super_admin'],
          },
        ]);
      });
    });

    it('super_admin détient tout le catalogue, qui est celui de @mgx/contracts', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; held: boolean }>(
          `SELECT p.key, EXISTS (
             SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
             WHERE rp.permission_key = p.key AND r.key = 'super_admin') AS held
           FROM permissions p ORDER BY p.key COLLATE "C"`,
        );
        expect(rows).toEqual(
          Object.keys(PERMISSIONS)
            .sort()
            .map((key) => ({ key, held: true })),
        );
        expect(rows).toHaveLength(17);
      });
    });
  });

  describe('niveau de vérification d’un compte', () => {
    const levelOf = async (db: pg.Client, user: string): Promise<number> =>
      (await db.query<{ level: number }>(`SELECT mgx_verified_level($1) AS level`, [user])).rows[0]!
        .level;

    it.each([
      { approved: [], expected: 0 },
      { approved: [1], expected: 1 },
      { approved: [2], expected: 0 },
      { approved: [3], expected: 0 },
      { approved: [1, 2], expected: 2 },
      { approved: [1, 3], expected: 1 },
      { approved: [2, 3], expected: 0 },
      { approved: [1, 2, 3], expected: 3 },
    ] as const)(
      'niveaux acceptés $approved : niveau $expected, comme le calcule l’application',
      async ({ approved, expected }) => {
        await asApp(async (db) => {
          const user = await insertUser(db);
          const kept: readonly number[] = approved;
          if (kept.length > 0) {
            // Les trois niveaux sont acceptés tour à tour, puis certains retirés : c'est ainsi
            // qu'un niveau supérieur reste accepté sans celui qui le précède.
            const cases = await verifyUpTo(db, user, 3, admin);
            for (const level of [3, 2, 1] as const) {
              if (!kept.includes(level)) {
                await revoke(db, cases[level]!, admin);
              }
            }
          }
          const { rows } = await db.query<{ level: number }>(
            `SELECT level FROM kyc_cases WHERE user_id = $1 AND status = 'APPROVED' ORDER BY level`,
            [user],
          );
          expect(rows.map(({ level }) => level)).toEqual([...kept]);

          expect(await levelOf(db, user)).toBe(expected);
          expect(verifiedLevelOf(kept)).toBe(expected);
        });
      },
    );

    it('seul un dossier accepté compte : ni déposé, ni refusé, ni remplacé, ni retiré', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const first = await submitted(db, user, 1);
        expect(await levelOf(db, user)).toBe(0);
        await reject(db, first, admin);
        expect(await levelOf(db, user)).toBe(0);

        const second = await submitted(db, user, 1);
        await approve(db, second, admin);
        expect(await levelOf(db, user)).toBe(1);

        // Un nouveau dossier du même niveau, accepté, remplace le précédent : toujours niveau 1.
        const third = await submitted(db, user, 1);
        await approve(db, third, admin);
        const statuses = async (): Promise<string[]> =>
          (
            await db.query<{ status: string }>(
              `SELECT status::text AS status FROM kyc_cases WHERE user_id = $1 ORDER BY id`,
              [user],
            )
          ).rows.map(({ status }) => status);
        expect(await statuses()).toEqual(['REJECTED', 'SUPERSEDED', 'APPROVED']);
        expect(await levelOf(db, user)).toBe(1);

        // Retiré à son tour : il ne reste aucun dossier accepté — le dossier remplacé ne revit pas.
        await revoke(db, third, admin);
        expect(await statuses()).toEqual(['REJECTED', 'SUPERSEDED', 'REVOKED']);
        expect(await levelOf(db, user)).toBe(0);
      });
    });

    it('les dossiers d’un autre compte ne comptent pas, à aucun niveau ; un compte inconnu est au niveau 0', async () => {
      await asApp(async (db) => {
        // Un compte au niveau 3 : ses dossiers n'élèvent personne d'autre.
        const top = await insertUser(db);
        await verifyUpTo(db, top, 3, admin);
        const none = await insertUser(db);
        const first = await insertUser(db);
        await verifyUpTo(db, first, 1, admin);
        const second = await insertUser(db);
        await verifyUpTo(db, second, 2, admin);

        expect(await levelOf(db, top)).toBe(3);
        expect(await levelOf(db, none)).toBe(0);
        expect(await levelOf(db, first)).toBe(1);
        expect(await levelOf(db, second)).toBe(2);
        expect(await levelOf(db, UNKNOWN_ID)).toBe(0);
      });
    });
  });

  describe('plafonds', () => {
    /** Refus de plafonds en francs congolais au niveau 2, fixés par l'administrateur. */
    const setting = (
      db: pg.Client,
      ceilings: readonly [number, number, number],
      overrides: Record<string, unknown> = {},
      level = 2,
    ): Promise<string | undefined> =>
      refusal(db, () => setLimitInSql(db, 'CDF', level, ceilings, { set_by: admin, ...overrides }));

    it('un niveau de 0 à 3', async () => {
      await asApp(async (db) => {
        for (const level of [-1, 4, 10]) {
          expect({ level, outcome: await setting(db, [1, 2, 3], {}, level) }).toEqual({
            level,
            outcome: expect.stringMatching(/^23514: .*transfer_limits_kyc_level_check/),
          });
        }
        for (const level of [0, 2, 3]) {
          expect({ level, outcome: await setting(db, [1, 2, 3], {}, level) }).toEqual({
            level,
            outcome: undefined,
          });
        }
      });
    });

    it('des montants positifs ou nuls, et croissants : par transfert ≤ sur 24 heures ≤ sur 31 jours', async () => {
      await asApp(async (db) => {
        for (const ceilings of [
          // Négatifs.
          [-1, 2, 3],
          [-3, -2, 3],
          [-3, -2, -1],
          // Décroissants.
          [101, 100, 1000],
          [100, 1001, 1000],
          [1, 0, 0],
          [0, 1, 0],
        ] as const) {
          expect({ ceilings, outcome: await setting(db, ceilings) }).toEqual({
            ceilings,
            outcome: expect.stringMatching(/^23514: .*transfer_limits_amounts_check/),
          });
        }
        for (const ceilings of [
          [0, 0, 0],
          [100, 100, 100],
          [100, 100, 101],
          [99, 100, 100],
          [0, 0, 1],
          [0, 1, 1],
        ] as const) {
          expect({ ceilings, outcome: await setting(db, ceilings) }).toEqual({
            ceilings,
            outcome: undefined,
          });
        }
      });
    });

    it('jusqu’à 38 chiffres, sans perte', async () => {
      await asApp(async (db) => {
        const huge = '9'.repeat(38);
        await db.query('BEGIN');
        try {
          await db.query(
            `INSERT INTO transfer_limits
               (asset_code, kyc_level, per_transfer_max, daily_max, monthly_max, set_by)
             VALUES ('CDF', 2, $1, $1, $1, $2)`,
            [huge, admin],
          );
          const { rows } = await db.query(
            `SELECT per_transfer_max::text AS per, monthly_max::text AS monthly
             FROM transfer_limits WHERE asset_code = 'CDF' AND kyc_level = 2`,
          );
          expect(rows).toEqual([{ per: huge, monthly: huge }]);
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('pour un actif que la plateforme tient', async () => {
      await asApp(async (db) => {
        expect(
          await attempt(db, () => setLimitInSql(db, 'XXX', 1, [1, 2, 3], { set_by: admin })),
        ).toBe(FOREIGN_KEY_VIOLATION);
      });
    });

    it('un seul jeu de plafonds par actif et par niveau', async () => {
      await asApp(async (db) => {
        expect(
          await attempt(db, () =>
            db.query(
              `INSERT INTO transfer_limits
                 (asset_code, kyc_level, per_transfer_max, daily_max, monthly_max, set_by)
               VALUES ('USD', 1, 1, 2, 3, $1)`,
              [admin],
            ),
          ),
        ).toBe(UNIQUE_VIOLATION);
      });
    });

    it('fixés par un membre du personnel actif qui détient transfer_limits.write', async () => {
      await asOwner(async (db) => {
        const holder = await insertUser(db);
        const suspended = await insertStaff(db, 'super_admin');
        await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);

        for (const author of [support, holder, suspended, UNKNOWN_ID]) {
          expect({ author, outcome: await setting(db, [1, 2, 3], { set_by: author }) }).toEqual({
            author,
            outcome: expect.stringMatching(NOT_ENTITLED),
          });
        }
        expect(await setting(db, [1, 2, 3], { set_by: admin })).toBeUndefined();
      });
    });

    it('consulter les plafonds n’habilite pas à les fixer', async () => {
      await asOwner(async (db) => {
        const reader = await insertUser(db);
        // Un rôle qui ne détient que transfer_limits.read — aucun rôle livré n'est dans ce cas —
        // le temps d'une transaction annulée.
        await db.query('BEGIN');
        try {
          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO roles (key, name, description)
             VALUES ('limits_reader', 'Limits reader', 'Reads the limits.') RETURNING id`,
          );
          const role = rows[0]!.id;
          await db.query(
            `INSERT INTO role_permissions (role_id, permission_key)
             VALUES ($1, 'transfer_limits.read')`,
            [role],
          );
          await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
            reader,
            role,
          ]);
          const setting = async (): Promise<string | undefined> => {
            await db.query('SAVEPOINT setting');
            const outcome = await failure(() =>
              setLimitInSql(db, 'CDF', 2, [1, 2, 3], { set_by: reader }),
            );
            await db.query('ROLLBACK TO SAVEPOINT setting');
            return outcome;
          };
          expect(await setting()).toMatch(NOT_ENTITLED);
          // Le même compte, le même rôle, une fois la permission accordée : c'est bien elle qui
          // manquait.
          await db.query(
            `INSERT INTO role_permissions (role_id, permission_key)
             VALUES ($1, 'transfer_limits.write')`,
            [role],
          );
          expect(await setting()).toBeUndefined();
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('sans auteur : réservé au rôle propriétaire, celui d’un outil d’exploitation', async () => {
      await asApp(async (db) => {
        expect(await setting(db, [1, 2, 3], { set_by: null })).toMatch(OWNER_ONLY);
        // Y compris en modifiant des plafonds existants.
        expect(
          await refusal(db, () =>
            db.query(
              `UPDATE transfer_limits SET per_transfer_max = 1, set_by = NULL
               WHERE asset_code = 'USD' AND kyc_level = 1`,
            ),
          ),
        ).toMatch(OWNER_ONLY);
      });
      await asOwner(async (db) => {
        expect(await setting(db, [1, 2, 3], { set_by: null })).toBeUndefined();
      });
    });

    it('chaque modification nomme son auteur, qui doit y être habilité à cet instant', async () => {
      await asOwner(async (db) => {
        await db.query('BEGIN');
        try {
          const author = await insertStaff(db, 'super_admin');
          await setLimitInSql(db, 'CDF', 2, [1, 2, 3], { set_by: author });
          const changing = async (assignment: string): Promise<string | undefined> => {
            await db.query('SAVEPOINT changing');
            const outcome = await failure(() =>
              db.query(
                `UPDATE transfer_limits SET ${assignment}
                 WHERE asset_code = 'CDF' AND kyc_level = 2`,
              ),
            );
            await db.query('ROLLBACK TO SAVEPOINT changing');
            return outcome;
          };
          expect(await changing('monthly_max = 4')).toBeUndefined();

          // L'auteur est suspendu : les plafonds qu'il a fixés demeurent, mais il ne peut plus en
          // signer la modification — un autre le peut.
          await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [author]);
          expect(await changing('monthly_max = 4')).toMatch(NOT_ENTITLED);
          await db.query(
            `UPDATE transfer_limits SET monthly_max = 4, set_by = $1
             WHERE asset_code = 'CDF' AND kyc_level = 2`,
            [admin],
          );
          const { rows } = await db.query(
            `SELECT monthly_max::text AS monthly, set_by FROM transfer_limits
             WHERE asset_code = 'CDF' AND kyc_level = 2`,
          );
          expect(rows).toEqual([{ monthly: '4', set_by: admin }]);
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('des plafonds ne changent ni d’actif, ni de niveau', async () => {
      await asApp(async (db) => {
        for (const assignment of [`asset_code = 'BTC'`, `kyc_level = 0`]) {
          expect({
            assignment,
            outcome: await refusal(db, () =>
              db.query(
                `UPDATE transfer_limits SET ${assignment}, set_by = $1
                 WHERE asset_code = 'USD' AND kyc_level = 1`,
                [admin],
              ),
            ),
          }).toEqual({ assignment, outcome: expect.stringMatching(LIMIT_IDENTITY) });
        }
      });
      // Pas même par le rôle propriétaire.
      await asOwner(async (db) => {
        expect(
          await refusal(db, () =>
            db.query(
              `UPDATE transfer_limits SET kyc_level = 0 WHERE asset_code = 'USD' AND kyc_level = 1`,
            ),
          ),
        ).toMatch(LIMIT_IDENTITY);
      });
    });

    it('l’heure d’une modification est celle de la base, quoi qu’on lui fournisse', async () => {
      await asApp(async (db) => {
        await db.query('BEGIN');
        try {
          const { rows: before } = await db.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
          await setLimitInSql(db, 'CDF', 2, [1, 2, 3], {
            set_by: admin,
            set_at: '2020-01-01T00:00:00Z',
          });
          const read = async (): Promise<Date> =>
            (
              await db.query<{ set_at: Date }>(
                `SELECT set_at FROM transfer_limits WHERE asset_code = 'CDF' AND kyc_level = 2`,
              )
            ).rows[0]!.set_at;
          const created = await read();
          expect(created.getTime()).toBeGreaterThanOrEqual(before[0]!.now.getTime());

          await db.query(`SELECT pg_sleep(0.01)`);
          await db.query(
            `UPDATE transfer_limits SET monthly_max = 4, set_at = '2020-01-01T00:00:00Z'
             WHERE asset_code = 'CDF' AND kyc_level = 2`,
          );
          const updated = await read();
          // L'horloge, et non le début de la transaction : l'heure a avancé depuis la création.
          expect(updated.getTime()).toBeGreaterThan(created.getTime());
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('des plafonds ne se suppriment pas, même par le rôle propriétaire', async () => {
      await asOwner(async (db) => {
        expect(
          await attempt(db, () =>
            db.query(`DELETE FROM transfer_limits WHERE asset_code = 'USD' AND kyc_level = 1`),
          ),
        ).toBe(FORBIDDEN_MUTATION);
        expect(await attempt(db, () => db.query(`TRUNCATE transfer_limits`))).toBe(
          FORBIDDEN_MUTATION,
        );
      });
      await asApp(async (db) => {
        // UPDATE : remplacer des plafonds en est un.
        expect(await grantsOn(db, 'transfer_limits')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
        for (const statement of [`DELETE FROM transfer_limits`, `TRUNCATE transfer_limits`]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
        const { rows } = await db.query(
          `SELECT kyc_level, per_transfer_max::text AS per, daily_max::text AS daily,
                  monthly_max::text AS monthly, set_by
           FROM transfer_limits WHERE asset_code = 'USD' ORDER BY kyc_level`,
        );
        expect(rows).toEqual([
          { kyc_level: 1, per: '100', daily: '250', monthly: '1000', set_by: null },
          { kyc_level: 2, per: '1000', daily: '2500', monthly: '10000', set_by: null },
          { kyc_level: 3, per: '0', daily: '0', monthly: '0', set_by: null },
        ]);
      });
    });

    it('ni un actif, ni l’auteur de plafonds ne s’effacent sous eux', async () => {
      await asOwner(async (db) => {
        const { rows } = await db.query(
          `SELECT conname, confdeltype::text AS on_delete FROM pg_constraint
           WHERE conrelid = 'transfer_limits'::regclass AND contype = 'f' ORDER BY conname`,
        );
        // « r » : RESTRICT.
        expect(rows).toEqual([
          { conname: 'transfer_limits_asset_code_fkey', on_delete: 'r' },
          { conname: 'transfer_limits_set_by_fkey', on_delete: 'r' },
        ]);
      });
    });
  });

  describe('ligne d’un transfert', () => {
    let alice: Holder;
    let bob: Holder;

    beforeAll(async () => {
      await asApp(async (db) => {
        alice = await holderAt(db, 1, 10_000);
        bob = await holderAt(db, 1);
      });
    });

    /** Code de l'erreur d'une ligne d'Alice à Bob, toujours annulée. */
    const row = (db: pg.Client, columns: Record<string, unknown>): Promise<string | undefined> =>
      attempt(db, () =>
        insertTransferRow(db, {
          sender_id: alice.user,
          recipient_id: bob.user,
          amount: 50,
          entry_id: anyEntry,
          ...columns,
        }),
      );

    it('une ligne valide est admise — c’est le témoin des refus qui suivent', async () => {
      await asApp(async (db) => {
        expect(await row(db, {})).toBeUndefined();
      });
    });

    it('un montant strictement positif', async () => {
      await asApp(async (db) => {
        for (const amount of [0, -1, -50]) {
          expect({ amount, outcome: await row(db, { amount }) }).toEqual({
            amount,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await row(db, { amount: 1 })).toBeUndefined();
      });
    });

    it('deux comptes distincts', async () => {
      await asApp(async (db) => {
        expect(await row(db, { recipient_id: alice.user })).toBe(CHECK_VIOLATION);
      });
    });

    it('un niveau de 0 à 3 — même si la règle qui le compare à celui de l’émetteur est neutralisée', async () => {
      await asApp(async (db) => {
        for (const level of [-1, 4]) {
          // La comparaison au niveau de l'émetteur le refuse la première.
          expect({ level, outcome: await row(db, { sender_level: level }) }).toEqual({
            level,
            outcome: TRANSFER_RULE_VIOLATION,
          });
        }
      });
      await asOwner(async (db) => {
        await db.query('BEGIN');
        try {
          await db.query('ALTER TABLE transfers DISABLE TRIGGER USER');
          const inserting = async (level: number): Promise<string | undefined> => {
            await db.query('SAVEPOINT inserting');
            const outcome = await sqlState(() =>
              insertTransferRow(db, {
                sender_id: alice.user,
                recipient_id: bob.user,
                amount: 50,
                entry_id: anyEntry,
                sender_level: level,
              }),
            );
            await db.query('ROLLBACK TO SAVEPOINT inserting');
            return outcome;
          };
          for (const level of [-1, 4]) {
            expect({ level, outcome: await inserting(level) }).toEqual({
              level,
              outcome: CHECK_VIOLATION,
            });
          }
          expect(await inserting(3)).toBeUndefined();
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('une clé d’idempotence de 16 à 128 caractères sûrs', async () => {
      await asApp(async (db) => {
        for (const key of [
          '',
          'a'.repeat(15),
          '-'.repeat(16),
          '.aaaaaaaaaaaaaaaa',
          'clé-d-idempotence-accentuée',
          'with space inside the key',
          'with/slash/inside/the/key',
          'trailing-newline-in-key\n',
          "quote'-in-the-idempotency-key",
        ]) {
          expect({ key, outcome: await row(db, { idempotency_key: key }) }).toEqual({
            key,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await row(db, { idempotency_key: 'a'.repeat(129) })).toBe(STRING_TOO_LONG);
        for (const key of [
          'a'.repeat(16),
          'a'.repeat(128),
          '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
          'Order_42:retry.3-final',
          '0000000000000000',
        ]) {
          expect({ key, outcome: await row(db, { idempotency_key: key }) }).toEqual({
            key,
            outcome: undefined,
          });
        }
      });
    });

    it('une empreinte de requête de 32 octets', async () => {
      await asApp(async (db) => {
        for (const length of [0, 31, 33, 64]) {
          expect({
            length,
            outcome: await row(db, { request_digest: Buffer.alloc(length, 7) }),
          }).toEqual({ length, outcome: CHECK_VIOLATION });
        }
      });
    });

    it('un émetteur, un destinataire, un actif et une écriture qui existent', async () => {
      await asApp(async (db) => {
        for (const columns of [
          { sender_id: UNKNOWN_ID },
          { recipient_id: UNKNOWN_ID },
          { entry_id: UNKNOWN_ID },
        ]) {
          expect({ columns, outcome: await row(db, columns) }).toEqual({
            columns,
            outcome: FOREIGN_KEY_VIOLATION,
          });
        }
        // Un actif inconnu n'a pas de plafonds : la règle des plafonds le dit la première.
        expect(await row(db, { asset_code: 'XXX' })).toBe(TRANSFER_RULE_VIOLATION);
      });
    });

    it('l’heure d’un transfert est celle de la base, quoi qu’on lui fournisse', async () => {
      await asApp(async (db) => {
        await db.query('BEGIN');
        try {
          const { rows: before } = await db.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
          const id = await insertTransferRow(db, {
            sender_id: alice.user,
            recipient_id: bob.user,
            amount: 50,
            entry_id: anyEntry,
            created_at: '2020-01-01T00:00:00Z',
          });
          const { rows } = await db.query<{ created_at: Date; now: Date }>(
            `SELECT created_at, clock_timestamp() AS now FROM transfers WHERE id = $1`,
            [id],
          );
          const { created_at: createdAt, now } = rows[0]!;
          expect(createdAt.getTime()).toBeGreaterThanOrEqual(before[0]!.now.getTime());
          expect(createdAt.getTime()).toBeLessThanOrEqual(now.getTime());
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });
  });

  describe('parties d’un transfert', () => {
    it('l’émetteur est un compte actif', async () => {
      await asApp(async (db) => {
        const bob = await holderAt(db, 1);
        for (const [status, wording] of [
          ['SUSPENDED', 'suspended'],
          ['PENDING_VERIFICATION', 'pending_verification'],
        ] as const) {
          const sender = await holderAt(db, 1, 500);
          expect(await rowRefusal(db, sender, bob, 50)).toBeUndefined();
          await db.query(`UPDATE users SET status = $2::user_status WHERE id = $1`, [
            sender.user,
            status,
          ]);
          expect({ status, outcome: await rowRefusal(db, sender, bob, 50) }).toEqual({
            status,
            outcome: expect.stringMatching(SENDER_STATUS(wording)),
          });
        }
      });
    });

    it('le destinataire est un compte actif', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        for (const [status, wording] of [
          ['SUSPENDED', 'suspended'],
          ['PENDING_VERIFICATION', 'pending_verification'],
        ] as const) {
          const recipient = await holderAt(db, 1);
          expect(await rowRefusal(db, alice, recipient, 50)).toBeUndefined();
          await db.query(`UPDATE users SET status = $2::user_status WHERE id = $1`, [
            recipient.user,
            status,
          ]);
          expect({ status, outcome: await rowRefusal(db, alice, recipient, 50) }).toEqual({
            status,
            outcome: expect.stringMatching(RECIPIENT_STATUS(wording)),
          });
        }
      });
    });

    it('un compte clôturé n’envoie ni ne reçoit : ni la ligne du transfert, ni son écriture', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const closed = await holderAt(db, 1);
        await closeAccountInSql(db, closed.user);

        expect(await rowRefusal(db, closed, alice, 50)).toMatch(SENDER_STATUS('closed'));
        expect(await rowRefusal(db, alice, closed, 50)).toMatch(RECIPIENT_STATUS('closed'));
        // Le grand livre, de son côté, refuse toute ligne sur le compte d'un titulaire clôturé.
        expect(
          await attempt(db, () =>
            writeTransfer(db, {
              sender: alice.user,
              senderAccount: alice.account,
              recipient: closed.user,
              recipientAccount: closed.account,
              amount: 50,
            }),
          ),
        ).toBe(ACCOUNT_CLOSED);
      });
    });
  });

  describe('niveau de vérification et plafonds de l’émetteur', () => {
    it('le niveau que porte le transfert est celui de l’émetteur à cet instant', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const bob = await holderAt(db, 1);
        expect(await rowRefusal(db, alice, bob, 50, { sender_level: 1 })).toBeUndefined();
        for (const claimed of [0, 2, 3]) {
          expect({
            claimed,
            outcome: await rowRefusal(db, alice, bob, 50, { sender_level: claimed }),
          }).toEqual({ claimed, outcome: expect.stringMatching(LEVEL_MISMATCH(1, claimed)) });
        }
      });
    });

    it('un niveau sans plafond dans l’actif n’envoie rien', async () => {
      await asApp(async (db) => {
        const unverified = await holderAt(db, 0, 500);
        const bob = await holderAt(db, 1);
        expect(await rowRefusal(db, unverified, bob, 1, { sender_level: 0 })).toMatch(
          LEVEL_NOT_OPEN(0),
        );
        // Les plafonds valent actif par actif : ceux du dollar n'ouvrent pas le bitcoin.
        const alice = await holderAt(db, 1, 500);
        expect(await rowRefusal(db, alice, bob, 1, { asset_code: 'BTC' })).toMatch(
          LEVEL_NOT_OPEN(1, 'BTC'),
        );
        expect(await rowRefusal(db, alice, bob, 1)).toBeUndefined();
      });
    });

    it('un plafond par transfert nul referme le niveau', async () => {
      await asApp(async (db) => {
        const top = await holderAt(db, 3, 500);
        const bob = await holderAt(db, 1);
        expect(await rowRefusal(db, top, bob, 1, { sender_level: 3 })).toMatch(LEVEL_NOT_OPEN(3));
      });
    });

    it('le plafond par transfert est inclus : son montant exact passe, pas une unité de plus', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const bob = await holderAt(db, 1);
        expect(await rowRefusal(db, alice, bob, 100)).toBeUndefined();
        expect(await rowRefusal(db, alice, bob, 101)).toMatch(OVER_PER_TRANSFER(1));
      });
    });

    it('les plafonds appliqués sont ceux du niveau : un niveau 2 envoie ce qu’un niveau 1 ne peut pas', async () => {
      await asApp(async (db) => {
        const second = await holderAt(db, 2, 5000);
        const bob = await holderAt(db, 1);
        expect(await rowRefusal(db, second, bob, 1000, { sender_level: 2 })).toBeUndefined();
        expect(await rowRefusal(db, second, bob, 1001, { sender_level: 2 })).toMatch(
          OVER_PER_TRANSFER(2),
        );
      });
    });

    it('sur 24 heures : le cumul des envois s’atteint exactement, et ne se dépasse pas', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 100);
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '200', last31Days: '200' });

        expect(await rowRefusal(db, alice, bob, 51)).toMatch(OVER_DAILY(1));
        expect(await rowRefusal(db, alice, bob, 50)).toBeUndefined();
        await send(db, alice, bob, 50);
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(OVER_DAILY(1));
        // Un transfert refusé n'a rien écrit.
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '250', last31Days: '250' });
      });
    });

    it('sur 24 heures glissantes : un envoi de plus de 24 heures ne compte plus', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1);
        const first = await send(db, alice, bob, 100);
        const second = await send(db, alice, bob, 100);
        const third = await send(db, alice, bob, 50);
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(OVER_DAILY(1));

        await asOwner(async (owner) => {
          await backdateTransfer(owner, first.transferId, '23 hours 59 minutes');
          await backdateTransfer(owner, second.transferId, '24 hours 1 minute');
          await backdateTransfer(owner, third.transferId, '72 hours');
        });
        // Seul le premier, vieux d'un peu moins de 24 heures, compte encore.
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '100', last31Days: '250' });
        expect(await rowRefusal(db, alice, bob, 100)).toBeUndefined();
      });
    });

    it('sur 31 jours : le cumul des envois s’atteint exactement, et ne se dépasse pas', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1);
        // Neuf envois de 100, un par jour passé : 900 sur 31 jours, rien sur 24 heures.
        const sent: string[] = [];
        for (let day = 2; day <= 10; day += 1) {
          const { transferId } = await send(db, alice, bob, 100);
          await asOwner((owner) =>
            backdateTransfer(owner, transferId, `${String(day * 24)} hours`),
          );
          sent.push(transferId);
        }
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '0', last31Days: '900' });

        expect(await rowRefusal(db, alice, bob, 100)).toBeUndefined();
        await send(db, alice, bob, 100);
        // Le plafond des 24 heures admettrait encore 150 : c'est celui des 31 jours qui refuse.
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(OVER_MONTHLY(1));

        // Glissants : un envoi vieux de plus de 31 jours ne compte plus, un envoi d'un peu
        // moins de 31 jours compte encore.
        await asOwner(async (owner) => {
          // Déjà vieux de 10 et 9 jours : les voici à 31 jours et une minute, et à 31 jours
          // moins une minute.
          await backdateTransfer(owner, sent[8]!, '504 hours 1 minute');
          await backdateTransfer(owner, sent[7]!, '527 hours 59 minutes');
        });
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '100', last31Days: '900' });
        expect(await rowRefusal(db, alice, bob, 100)).toBeUndefined();
        expect(await rowRefusal(db, alice, bob, 101)).toMatch(OVER_PER_TRANSFER(1));
      });
    });

    it('24 heures et 744 heures, quel que soit le fuseau de la session — même à un changement d’heure', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1);
        const recent = await send(db, alice, bob, 30);
        const old = await send(db, alice, bob, 70);
        await asOwner(async (owner) => {
          await backdateTransfer(owner, recent.transferId, '23 hours 30 minutes');
          await backdateTransfer(owner, old.transferId, '743 hours 30 minutes');
        });

        const { rows } = await db.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
        const now = rows[0]!.now;
        // Des fuseaux fictifs où l'heure a changé il y a douze heures, ou il y a dix jours —
        // dans un sens, puis dans l'autre : « un jour » y dure 23 ou 25 heures, « 31 jours »,
        // 743 ou 745.
        const zones = [
          { zone: 'UTC', day: 24, month: 744 },
          { zone: zoneWithShift('FORWARD', now, 12), day: 23, month: 743 },
          { zone: zoneWithShift('BACKWARD', now, 12), day: 25, month: 745 },
          { zone: zoneWithShift('FORWARD', now, 240), day: 24, month: 743 },
          { zone: zoneWithShift('BACKWARD', now, 240), day: 24, month: 745 },
        ];
        const usageIn = async (zone: string) => {
          await db.query(`SELECT set_config('TimeZone', $1, false)`, [zone]);
          return usageInSql(db, alice.user);
        };

        for (const { zone, day, month } of zones) {
          await db.query(`SELECT set_config('TimeZone', $1, false)`, [zone]);
          // Témoin : dans ce fuseau, des durées comptées en jours ne valent pas 24 et 744 heures.
          const { rows: durations } = await db.query(
            `SELECT (extract(epoch FROM $1::timestamptz - ($1::timestamptz - INTERVAL '1 day'))
                     / 3600)::int AS day,
                    (extract(epoch FROM $1::timestamptz - ($1::timestamptz - INTERVAL '31 days'))
                     / 3600)::int AS month`,
            [now],
          );
          expect({ zone, durations: durations[0] }).toEqual({ zone, durations: { day, month } });
          // Un peu moins de 24 heures, un peu moins de 744 : comptés tous deux, partout.
          expect({ zone, usage: await usageIn(zone) }).toEqual({
            zone,
            usage: { last24Hours: '30', last31Days: '100' },
          });
        }

        await asOwner(async (owner) => {
          await backdateTransfer(owner, recent.transferId, '1 hour');
          await backdateTransfer(owner, old.transferId, '1 hour');
        });
        // Un peu plus de 24 heures, un peu plus de 744 : plus comptés, nulle part.
        for (const { zone } of zones) {
          expect({ zone, usage: await usageIn(zone) }).toEqual({
            zone,
            usage: { last24Hours: '0', last31Days: '30' },
          });
        }
      });
    });

    it('seuls comptent les envois, dans l’actif du transfert', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1, 5000);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 50);
        // Bob a reçu 250 : il n'a rien envoyé.
        expect(await usageInSql(db, bob.user)).toEqual({ last24Hours: '0', last31Days: '0' });
        expect(await rowRefusal(db, bob, alice, 100)).toBeUndefined();

        // Alice a épuisé ses plafonds en dollars : pas en francs congolais.
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(OVER_DAILY(1));
        expect(await usageInSql(db, alice.user, 'CDF')).toEqual({
          last24Hours: '0',
          last31Days: '0',
        });
        expect(await rowRefusal(db, alice, bob, 5000, { asset_code: 'CDF' })).toBeUndefined();
      });
    });

    it('les cumuls suivent le compte lorsque son niveau change', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 20_000);
        const bob = await holderAt(db, 1);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 50);
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(OVER_DAILY(1));

        // Niveau 2 accepté : les plafonds sont désormais ceux du niveau 2, ce qui a été envoyé
        // au niveau 1 reste compté.
        const second = await submitted(db, alice.user, 2);
        await approve(db, second, admin);
        expect(await rowRefusal(db, alice, bob, 1)).toMatch(LEVEL_MISMATCH(2, 1));
        expect(await rowRefusal(db, alice, bob, 1000, { sender_level: 2 })).toBeUndefined();
        await send(db, alice, bob, 1000, 2);
        await send(db, alice, bob, 1000, 2);
        expect(await usageInSql(db, alice.user)).toEqual({
          last24Hours: '2250',
          last31Days: '2250',
        });
        expect(await rowRefusal(db, alice, bob, 251, { sender_level: 2 })).toMatch(OVER_DAILY(2));
        expect(await rowRefusal(db, alice, bob, 250, { sender_level: 2 })).toBeUndefined();

        // Le niveau 1 est retiré : le niveau 2, toujours accepté, ne vaut plus rien — et le
        // niveau 0 n'a pas de plafond.
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM kyc_cases WHERE user_id = $1 AND level = 1 AND status = 'APPROVED'`,
          [alice.user],
        );
        await revoke(db, rows[0]!.id, admin);
        expect(await rowRefusal(db, alice, bob, 1, { sender_level: 2 })).toMatch(
          LEVEL_MISMATCH(0, 2),
        );
        expect(await rowRefusal(db, alice, bob, 1, { sender_level: 0 })).toMatch(LEVEL_NOT_OPEN(0));
      });
    });

    it('abaisser des plafonds vaut aussitôt, y compris pour ce qui a déjà été envoyé', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 2, 20_000);
        const bob = await holderAt(db, 1);
        await send(db, alice, bob, 1000, 2);
        expect(await rowRefusal(db, alice, bob, 1000, { sender_level: 2 })).toBeUndefined();

        await db.query('BEGIN');
        try {
          // De 1 000 / 2 500 à 500 / 1 200 : les 1 000 déjà envoyés comptent sous le nouveau
          // plafond des 24 heures.
          await setLimitInSql(db, 'USD', 2, [500, 1200, 10_000], { set_by: admin });
          const sending = async (amount: number): Promise<string | undefined> => {
            await db.query('SAVEPOINT sending');
            const outcome = await failure(() =>
              insertTransferRow(db, {
                sender_id: alice.user,
                recipient_id: bob.user,
                amount,
                entry_id: anyEntry,
                sender_level: 2,
              }),
            );
            await db.query('ROLLBACK TO SAVEPOINT sending');
            return outcome;
          };
          expect(await sending(501)).toMatch(OVER_PER_TRANSFER(2));
          expect(await sending(201)).toMatch(OVER_DAILY(2));
          expect(await sending(200)).toBeUndefined();
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });
  });

  describe('niveau de vérification du destinataire', () => {
    it('recevoir suppose, comme envoyer, un niveau ouvert dans l’actif', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const unverified = await holderAt(db, 0);
        const closedLevel = await holderAt(db, 3);
        const first = await holderAt(db, 1);
        const second = await holderAt(db, 2);

        expect(await rowRefusal(db, alice, unverified, 1)).toMatch(RECIPIENT_NOT_OPEN);
        expect(await rowRefusal(db, alice, closedLevel, 1)).toMatch(RECIPIENT_NOT_OPEN);
        expect(await rowRefusal(db, alice, first, 1)).toBeUndefined();
        expect(await rowRefusal(db, alice, second, 1)).toBeUndefined();
        // Actif par actif : le niveau 2 n'a pas de plafond en francs congolais.
        expect(await rowRefusal(db, alice, first, 1, { asset_code: 'CDF' })).toBeUndefined();
        expect(await rowRefusal(db, alice, second, 1, { asset_code: 'CDF' })).toMatch(
          /^MGX10: transfers in CDF are not open to the verification level of account \S+$/,
        );
      });
    });

    it('les plafonds du destinataire ne bornent pas ce qu’il reçoit', async () => {
      await asApp(async (db) => {
        const second = await holderAt(db, 2, 5000);
        const first = await holderAt(db, 1);
        // 1 000 : dix fois le plafond par transfert du niveau 1, celui du destinataire.
        await send(db, second, first, 1000, 2);
        await send(db, second, first, 1000, 2);
        expect(await accountState(db, first.account)).toMatchObject({ balance: '2000' });
        expect(await usageInSql(db, first.user)).toEqual({ last24Hours: '0', last31Days: '0' });
      });
    });
  });

  describe('un transfert et son écriture', () => {
    let alice: Holder;
    let bob: Holder;
    let carol: Holder;

    beforeAll(async () => {
      await asApp(async (db) => {
        alice = await holderAt(db, 2, 100_000);
        bob = await holderAt(db, 1, 1000);
        carol = await holderAt(db, 1, 1000);
      });
    });

    /** Écrit un en-tête de type transfert, ses lignes, puis la ligne d'un transfert de 50. */
    async function writing(
      db: pg.Client,
      postings: Parameters<typeof insertPostings>[2],
      columns: Record<string, unknown> = {},
      header: Record<string, unknown> = {},
    ): Promise<void> {
      const entryId = await insertEntryHeader(db, postings.length, {
        kind: 'transfer.internal',
        ...header,
      });
      await insertPostings(db, entryId, postings);
      await insertTransferRow(db, {
        sender_id: alice.user,
        recipient_id: bob.user,
        amount: 50,
        entry_id: entryId,
        sender_level: 2,
        ...columns,
      });
    }

    it('l’écriture qui débite l’émetteur et crédite le destinataire du montant : validée', async () => {
      await asApp(async (db) => {
        const before = {
          alice: await accountState(db, alice.account),
          bob: await accountState(db, bob.account),
        };
        expect(
          await commitOf(db, () =>
            writing(db, [
              { account: alice.account, side: 'DEBIT', amount: 50 },
              { account: bob.account, side: 'CREDIT', amount: 50 },
            ]),
          ),
        ).toBeUndefined();
        expect(await accountState(db, alice.account)).toMatchObject({
          balance: String(Number(before.alice.balance) - 50),
        });
        expect(await accountState(db, bob.account)).toMatchObject({
          balance: String(Number(before.bob.balance) + 50),
        });
      });
    });

    it.each([
      {
        name: 'une écriture d’un autre type',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 50 },
          { account: bob.account, side: 'CREDIT' as const, amount: 50 },
        ],
        header: { kind: 'test.entry' },
      },
      {
        name: 'un autre montant',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 60 },
          { account: bob.account, side: 'CREDIT' as const, amount: 60 },
        ],
      },
      {
        name: 'les fonds d’un tiers',
        postings: () => [
          { account: carol.account, side: 'DEBIT' as const, amount: 50 },
          { account: bob.account, side: 'CREDIT' as const, amount: 50 },
        ],
      },
      {
        name: 'un crédit à un tiers',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 50 },
          { account: carol.account, side: 'CREDIT' as const, amount: 50 },
        ],
      },
      {
        name: 'un crédit à un compte de la plateforme',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 50 },
          { account: fees, side: 'CREDIT' as const, amount: 50 },
        ],
      },
      {
        name: 'le sens inverse : le destinataire débité, l’émetteur crédité',
        postings: () => [
          { account: bob.account, side: 'DEBIT' as const, amount: 50 },
          { account: alice.account, side: 'CREDIT' as const, amount: 50 },
        ],
      },
      {
        name: 'une troisième et une quatrième lignes, qui déplacent autre chose',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 50 },
          { account: bob.account, side: 'CREDIT' as const, amount: 50 },
          { account: carol.account, side: 'DEBIT' as const, amount: 700 },
          { account: bob.account, side: 'CREDIT' as const, amount: 700 },
        ],
      },
      {
        name: 'une part du montant détournée vers un troisième compte',
        postings: () => [
          { account: alice.account, side: 'DEBIT' as const, amount: 50 },
          { account: bob.account, side: 'CREDIT' as const, amount: 40 },
          { account: fees, side: 'CREDIT' as const, amount: 10 },
        ],
      },
    ])('refusé à la validation : $name', async ({ postings, header }) => {
      await asApp(async (db) => {
        const before = { ledger: await ledgerSize(db), transfers: await transferCount(db) };
        expect(await commitOf(db, () => writing(db, postings(), {}, header ?? {}))).toMatch(
          NOT_ITS_ENTRY,
        );
        // Rien n'est resté : ni l'écriture, ni le transfert.
        expect({ ledger: await ledgerSize(db), transfers: await transferCount(db) }).toEqual(
          before,
        );
      });
    });

    it('l’ordre des deux lignes est indifférent : le crédit peut précéder le débit', async () => {
      await asApp(async (db) => {
        expect(
          await commitOf(db, () =>
            writing(db, [
              { account: bob.account, side: 'CREDIT', amount: 50 },
              { account: alice.account, side: 'DEBIT', amount: 50 },
            ]),
          ),
        ).toBeUndefined();
      });
    });

    it('chaque ligne est vérifiée pour elle-même, sans s’en remettre à l’équilibre de l’écriture', async () => {
      await asApp(async (db) => {
        const aliceFrancs = await openLedgerAccount(db, 'user_available', 'CDF', alice.user);
        const bobFrancs = await openLedgerAccount(db, 'user_available', 'CDF', bob.user);
        const custodyFrancs = await openLedgerAccount(db, 'platform_custody', 'CDF');
        await postEntryInSql(db, [
          { account: custodyFrancs, side: 'DEBIT', amount: 1000, asset: 'CDF' },
          { account: aliceFrancs, side: 'CREDIT', amount: 500, asset: 'CDF' },
          { account: bobFrancs, side: 'CREDIT', amount: 500, asset: 'CDF' },
        ]);

        // Des écritures déséquilibrées, que le grand livre refuserait à la validation : la
        // vérification du transfert est demandée seule, sans attendre (SET CONSTRAINTS), dans
        // une transaction annulée. Elle doit refuser d'elle-même.
        const checked = async (
          postings: Parameters<typeof insertPostings>[2],
        ): Promise<string | undefined> => {
          await db.query('BEGIN');
          try {
            return await failure(async () => {
              await writing(db, postings);
              await db.query('SET CONSTRAINTS "transfers_entry_matches" IMMEDIATE');
            });
          } finally {
            await db.query('ROLLBACK');
          }
        };
        const debit = { account: alice.account, side: 'DEBIT' as const, amount: 50 };
        const credit = { account: bob.account, side: 'CREDIT' as const, amount: 50 };

        for (const [name, postings] of [
          // La ligne de l'émetteur.
          ['l’émetteur crédité', [{ ...debit, side: 'CREDIT' as const }, credit]],
          ['l’émetteur débité d’un autre montant', [{ ...debit, amount: 60 }, credit]],
          [
            'l’émetteur débité dans un autre actif',
            [{ account: aliceFrancs, side: 'DEBIT' as const, amount: 50, asset: 'CDF' }, credit],
          ],
          // La ligne du destinataire.
          ['le destinataire débité', [debit, { ...credit, side: 'DEBIT' as const }]],
          ['le destinataire crédité d’un autre montant', [debit, { ...credit, amount: 40 }]],
          [
            'le destinataire crédité dans un autre actif',
            [debit, { account: bobFrancs, side: 'CREDIT' as const, amount: 50, asset: 'CDF' }],
          ],
        ] as const) {
          expect({ name, outcome: await checked([...postings]) }).toEqual({
            name,
            outcome: expect.stringMatching(NOT_ITS_ENTRY),
          });
        }
        // Témoin : la même vérification immédiate admet l'écriture attendue.
        expect(await checked([debit, credit])).toBeUndefined();
      });
    });

    it('refusé à la validation : une écriture dans un autre actif que celui du transfert', async () => {
      await asApp(async (db) => {
        const aliceFrancs = await openLedgerAccount(db, 'user_available', 'CDF', alice.user);
        const bobFrancs = await openLedgerAccount(db, 'user_available', 'CDF', bob.user);
        const custodyFrancs = await openLedgerAccount(db, 'platform_custody', 'CDF');
        await postEntryInSql(db, [
          { account: custodyFrancs, side: 'DEBIT', amount: 500, asset: 'CDF' },
          { account: aliceFrancs, side: 'CREDIT', amount: 500, asset: 'CDF' },
        ]);
        // Le transfert se dit en dollars — ce sont ses plafonds qui sont examinés — mais
        // l'écriture déplace des francs.
        expect(
          await commitOf(db, () =>
            writing(db, [
              { account: aliceFrancs, side: 'DEBIT', amount: 50, asset: 'CDF' },
              { account: bobFrancs, side: 'CREDIT', amount: 50, asset: 'CDF' },
            ]),
          ),
        ).toMatch(NOT_ITS_ENTRY);
      });
    });

    it('refusé : des fonds de l’émetteur ou du destinataire qui ne sont pas des « fonds disponibles »', async () => {
      await asOwner(async (db) => {
        // Le plan de comptes ne connaît encore qu'un type de compte de titulaire. Un second, le
        // temps d'une transaction annulée : la vérification de fin de transaction y est
        // demandée sans attendre (SET CONSTRAINTS).
        await db.query('BEGIN');
        try {
          await db.query(
            `INSERT INTO ledger_account_types (key, owner, normal_side, description)
             VALUES ('user_reserved', 'USER', 'CREDIT', 'Funds set aside.')`,
          );
          const aliceReserved = await openLedgerAccount(db, 'user_reserved', 'USD', alice.user);
          const bobReserved = await openLedgerAccount(db, 'user_reserved', 'USD', bob.user);
          const entryId = await insertEntryHeader(db, 2);
          await insertPostings(db, entryId, [
            { account: custody, side: 'DEBIT', amount: 500 },
            { account: aliceReserved, side: 'CREDIT', amount: 500 },
          ]);

          const checked = async (from: string, to: string): Promise<string | undefined> => {
            await db.query('SAVEPOINT checked');
            const outcome = await failure(async () => {
              await writing(db, [
                { account: from, side: 'DEBIT', amount: 50 },
                { account: to, side: 'CREDIT', amount: 50 },
              ]);
              await db.query('SET CONSTRAINTS ALL IMMEDIATE');
            });
            await db.query('ROLLBACK TO SAVEPOINT checked');
            return outcome;
          };
          expect(await checked(aliceReserved, bob.account)).toMatch(NOT_ITS_ENTRY);
          expect(await checked(alice.account, bobReserved)).toMatch(NOT_ITS_ENTRY);
          // Témoin : la même vérification immédiate admet un transfert de fonds disponibles.
          expect(await checked(alice.account, bob.account)).toBeUndefined();
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('refusé à la validation : un transfert qui désigne une écriture passée auparavant', async () => {
      await asApp(async (db) => {
        // Un dépôt de 50 au crédit de Bob, validé : ce n'est pas un transfert d'Alice.
        const earlier = await deposit(db, bob.account, 50);
        expect(
          await commitOf(db, () =>
            insertTransferRow(db, {
              sender_id: alice.user,
              recipient_id: bob.user,
              amount: 50,
              entry_id: earlier,
              sender_level: 2,
            }),
          ),
        ).toMatch(NOT_ITS_ENTRY);
      });
    });

    it('une écriture ne réalise qu’un transfert', async () => {
      await asApp(async (db) => {
        const { entryId } = await send(db, alice, bob, 50, 2);
        expect(
          await attempt(db, () =>
            insertTransferRow(db, {
              sender_id: alice.user,
              recipient_id: bob.user,
              amount: 50,
              entry_id: entryId,
              sender_level: 2,
            }),
          ),
        ).toBe(UNIQUE_VIOLATION);
      });
    });

    it('refusé à la validation : une écriture de type transfert sans transfert', async () => {
      await asApp(async (db) => {
        const before = await ledgerSize(db);
        const moving = async (kind: string): Promise<string | undefined> =>
          commitOf(db, async () => {
            const entryId = await insertEntryHeader(db, 2, { kind });
            await insertPostings(db, entryId, [
              { account: alice.account, side: 'DEBIT', amount: 50 },
              { account: bob.account, side: 'CREDIT', amount: 50 },
            ]);
          });
        // Sans cette règle, des fonds passeraient d'un titulaire à l'autre hors de tout plafond
        // sous l'apparence d'un transfert.
        expect(await moving('transfer.internal')).toMatch(ENTRY_WITHOUT_TRANSFER);
        expect(await ledgerSize(db)).toEqual(before);
        // Témoin : la même écriture, d'un autre type, n'est pas un transfert.
        expect(await moving('test.entry')).toBeUndefined();
      });
    });

    it('les règles du grand livre valent pour l’écriture d’un transfert : pas de découvert', async () => {
      await asApp(async (db) => {
        const poor = await holderAt(db, 1, 30);
        expect(
          await attempt(db, () =>
            writeTransfer(db, {
              sender: poor.user,
              senderAccount: poor.account,
              recipient: bob.user,
              recipientAccount: bob.account,
              amount: 31,
            }),
          ),
        ).toBe(INSUFFICIENT_FUNDS);
        await send(db, poor, bob, 30);
        expect(await accountState(db, poor.account)).toMatchObject({ balance: '0' });
      });
    });
  });

  describe('clé d’idempotence', () => {
    it('une clé ne sert qu’une fois par émetteur ; deux émetteurs peuvent employer la même', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const bob = await holderAt(db, 1, 500);
        const key = freshKey();
        const sending = (from: Holder, to: Holder) => ({
          sender: from.user,
          senderAccount: from.account,
          recipient: to.user,
          recipientAccount: to.account,
          amount: 10,
          columns: { idempotency_key: key },
        });
        await transferInSql(db, sending(alice, bob));
        expect(await sqlState(() => transferInSql(db, sending(alice, bob)))).toBe(UNIQUE_VIOLATION);
        // Le second essai n'a rien déplacé.
        expect(await accountState(db, alice.account)).toMatchObject({ balance: '490' });
        expect(await sqlState(() => transferInSql(db, sending(bob, alice)))).toBeUndefined();
      });
    });
  });

  describe('immuabilité', () => {
    it('un transfert ne se modifie ni ne s’efface, même par le rôle propriétaire', async () => {
      const { transferId } = await asApp(async (db) => {
        const alice = await holderAt(db, 1, 500);
        const bob = await holderAt(db, 1);
        return send(db, alice, bob, 10);
      });
      await asOwner(async (db) => {
        for (const statement of [
          `UPDATE transfers SET amount = 1 WHERE id = '${transferId}'`,
          `UPDATE transfers SET created_at = created_at - INTERVAL '2 days' WHERE id = '${transferId}'`,
          `DELETE FROM transfers WHERE id = '${transferId}'`,
          `TRUNCATE transfers`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: FORBIDDEN_MUTATION,
          });
        }
      });
      await asApp(async (db) => {
        expect(await grantsOn(db, 'transfers')).toEqual(['INSERT', 'SELECT']);
        for (const statement of [
          `UPDATE transfers SET amount = 1`,
          `DELETE FROM transfers`,
          `TRUNCATE transfers`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });

    it('vider en cascade un actif ou le grand livre ne vide ni les transferts, ni les plafonds', async () => {
      // Les tables du grand livre refusent d'être vidées ; ces protections levées — par le
      // propriétaire, dans une transaction annulée —, celles des transferts tiennent encore.
      const ledgerGuards: Record<string, string> = {
        assets: 'assets_immutable_truncate',
        ledger_account_types: 'ledger_account_types_immutable_truncate',
        ledger_accounts: 'ledger_accounts_no_truncate',
        ledger_entries: 'ledger_entries_immutable_truncate',
        ledger_postings: 'ledger_postings_immutable_truncate',
      };
      const ownGuards: Record<string, string> = {
        transfer_limits: 'transfer_limits_no_truncate',
        transfers: 'transfers_immutable_truncate',
      };
      await asOwner(async (db) => {
        const before = { transfers: await transferCount(db), ledger: await ledgerSize(db) };
        const truncating = (kept: string): Promise<string | undefined> =>
          attempt(db, async () => {
            for (const [table, guard] of Object.entries({ ...ledgerGuards, ...ownGuards })) {
              if (table !== kept) {
                await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
              }
            }
            await db.query(`TRUNCATE assets CASCADE`);
          });
        for (const table of Object.keys(ownGuards)) {
          expect({ table, outcome: await truncating(table) }).toEqual({
            table,
            outcome: FORBIDDEN_MUTATION,
          });
        }
        // Témoin : toutes les protections levées, le vidage aboutirait.
        expect(await truncating('none')).toBeUndefined();
        expect({ transfers: await transferCount(db), ledger: await ledgerSize(db) }).toEqual(
          before,
        );
      });
    });

    it('ni un compte, ni un actif, ni une écriture ne s’effacent sous un transfert', async () => {
      await asOwner(async (db) => {
        const { rows } = await db.query(
          `SELECT conname, confdeltype::text AS on_delete FROM pg_constraint
           WHERE conrelid = 'transfers'::regclass AND contype = 'f' ORDER BY conname`,
        );
        // « r » : RESTRICT.
        expect(rows).toEqual([
          { conname: 'transfers_asset_code_fkey', on_delete: 'r' },
          { conname: 'transfers_entry_id_fkey', on_delete: 'r' },
          { conname: 'transfers_recipient_id_fkey', on_delete: 'r' },
          { conname: 'transfers_sender_id_fkey', on_delete: 'r' },
        ]);
      });
    });
  });

  describe('transferts simultanés', () => {
    it('deux transferts du même émetteur passent l’un après l’autre : le second compte le premier', async () => {
      await asApp(async (first) => {
        await asApp(async (second) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 5000);
            const bob = await holderAt(observer, 1);
            const carol = await holderAt(observer, 1);
            await send(observer, alice, bob, 100);
            // 100 déjà envoyés ; deux transferts de 100 ne tiennent pas ensemble sous 250.

            // La ligne du transfert d'abord, son écriture ensuite : ce n'est donc pas le verrou
            // du compte du grand livre qui retient le second, mais celui de l'émetteur.
            const begin = async (db: pg.Client): Promise<string> => {
              await db.query('BEGIN');
              return insertEntryHeader(db, 2, { kind: 'transfer.internal' });
            };
            const rowOf = (db: pg.Client, to: Holder, entryId: string): Promise<string> =>
              insertTransferRow(db, {
                sender_id: alice.user,
                recipient_id: to.user,
                amount: 100,
                entry_id: entryId,
              });
            const postingsOf = (db: pg.Client, to: Holder, entryId: string): Promise<unknown> =>
              insertPostings(db, entryId, [
                { account: alice.account, side: 'DEBIT', amount: 100 },
                { account: to.account, side: 'CREDIT', amount: 100 },
              ]);

            const firstEntry = await begin(first);
            const secondEntry = await begin(second);
            await rowOf(first, bob, firstEntry);

            const pending = failure(() => rowOf(second, carol, secondEntry));
            await untilBlocked(observer);

            await postingsOf(first, bob, firstEntry);
            await first.query('COMMIT');

            // Le second, libéré, compte le premier : 100 + 100 + 100 > 250.
            expect(await pending).toMatch(OVER_DAILY(1));
            await second.query('ROLLBACK');

            expect(await usageInSql(observer, alice.user)).toEqual({
              last24Hours: '200',
              last31Days: '200',
            });
            expect(await accountState(observer, carol.account)).toMatchObject({ balance: '0' });
          });
        });
      });
    });

    it('deux transferts croisés, de l’un à l’autre et de l’autre à l’un, aboutissent tous deux', async () => {
      await asApp(async (first) => {
        await asApp(async (second) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 500);
            const bob = await holderAt(observer, 1, 500);
            const transfer = (from: Holder, to: Holder, amount: number) => ({
              sender: from.user,
              senderAccount: from.account,
              recipient: to.user,
              recipientAccount: to.account,
              amount,
            });

            // Chacun prend ses verrous dans l'ordre de l'application : son émetteur d'abord ;
            // puis, comme le fait le grand livre avant d'écrire, les deux titulaires, qu'il
            // retient ouverts. Les deux transferts en sont là au même instant.
            const lock = (db: pg.Client, user: string): Promise<unknown> =>
              db.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [user]);
            const hold = (db: pg.Client): Promise<unknown> =>
              db.query(`SELECT 1 FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`, [
                [alice.user, bob.user],
              ]);
            await first.query('BEGIN');
            await second.query('BEGIN');
            // Rien de ce qu'écrit le premier ne doit attendre le second : passé ce délai, c'est
            // qu'un verrou de trop les oppose — et qu'ils s'interbloqueraient.
            await first.query(`SET LOCAL lock_timeout = '3s'`);
            await lock(first, alice.user);
            await lock(second, bob.user);
            await hold(first);
            await hold(second);

            // Le verrou que la base prend sur l'émetteur laisse passer celui par lequel l'autre
            // transfert retient son destinataire : le premier écrit sans attendre.
            expect(
              await failure(() => writeTransfer(first, transfer(alice, bob, 70))),
            ).toBeUndefined();
            // Le second attend le premier sur les comptes du grand livre — et lui seul attend.
            const pending = failure(() => writeTransfer(second, transfer(bob, alice, 20)));
            await untilBlocked(observer);
            expect(await failure(() => first.query('COMMIT'))).toBeUndefined();
            expect(await pending).toBeUndefined();
            expect(await failure(() => second.query('COMMIT'))).toBeUndefined();

            expect(await accountState(observer, alice.account)).toMatchObject({ balance: '450' });
            expect(await accountState(observer, bob.account)).toMatchObject({ balance: '550' });
          });
        });
      });
    });

    it('un transfert attend la clôture en cours de son destinataire, puis est refusé', async () => {
      await asApp(async (closing) => {
        await asApp(async (sending) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 500);
            const leaving = await holderAt(observer, 1);

            // La clôture verrouille d'abord le compte qu'elle va fermer, comme le fait
            // l'application, puis écrit tout ce qu'une clôture écrit.
            await closing.query('BEGIN');
            await closing.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [leaving.user]);

            await sending.query('BEGIN');
            const pending = failure(() =>
              insertTransferRow(sending, {
                sender_id: alice.user,
                recipient_id: leaving.user,
                amount: 10,
                entry_id: anyEntry,
              }),
            );
            await untilBlocked(observer);

            await insertClosureRecord(closing, leaving.user);
            await emptyAccount(closing, leaving.user);
            await markAccountClosed(closing, leaving.user);
            await closeVerificationCases(closing, leaving.user);
            expect(await failure(() => closing.query('COMMIT'))).toBeUndefined();

            // Libéré, le transfert relit le statut du destinataire : le compte est clôturé.
            expect(await pending).toMatch(RECIPIENT_STATUS('closed'));
            await sending.query('ROLLBACK');
          });
        });
      });
    });

    it('la clôture d’un émetteur attend son transfert en cours, puis voit les fonds qu’il laisse', async () => {
      await asApp(async (sending) => {
        await asApp(async (closing) => {
          await asApp(async (observer) => {
            const leaving = await holderAt(observer, 1, 500);
            const bob = await holderAt(observer, 1);

            await sending.query('BEGIN');
            await writeTransfer(sending, {
              sender: leaving.user,
              senderAccount: leaving.account,
              recipient: bob.user,
              recipientAccount: bob.account,
              amount: 100,
            });

            await closing.query('BEGIN');
            const locking = failure(() =>
              closing.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [leaving.user]),
            );
            await untilBlocked(observer);
            expect(await failure(() => sending.query('COMMIT'))).toBeUndefined();
            expect(await locking).toBeUndefined();

            // Le transfert est validé : 400 restent, que la clôture voit.
            const { rows } = await closing.query(
              `SELECT balance::text AS balance FROM ledger_accounts WHERE id = $1`,
              [leaving.account],
            );
            expect(rows).toEqual([{ balance: '400' }]);
            await closing.query('ROLLBACK');
          });
        });
      });
    });

    it('la suspension d’un émetteur attend son transfert en cours ; le suivant est refusé', async () => {
      await asApp(async (sending) => {
        await asApp(async (suspending) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 500);
            const bob = await holderAt(observer, 1);

            await sending.query('BEGIN');
            await writeTransfer(sending, {
              sender: alice.user,
              senderAccount: alice.account,
              recipient: bob.user,
              recipientAccount: bob.account,
              amount: 100,
            });

            const suspension = failure(() =>
              suspending.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [alice.user]),
            );
            await untilBlocked(observer);
            expect(await failure(() => sending.query('COMMIT'))).toBeUndefined();
            expect(await suspension).toBeUndefined();

            // Le transfert en cours a abouti ; le compte, suspendu, n'en fait plus d'autre.
            expect(await accountState(observer, bob.account)).toMatchObject({ balance: '100' });
            expect(await rowRefusal(observer, alice, bob, 10)).toMatch(SENDER_STATUS('suspended'));
          });
        });
      });
    });

    it('un transfert attend la suspension en cours de son émetteur, puis est refusé', async () => {
      await asApp(async (suspending) => {
        await asApp(async (sending) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 500);
            const bob = await holderAt(observer, 1);

            await suspending.query('BEGIN');
            await suspending.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [
              alice.user,
            ]);

            await sending.query('BEGIN');
            const pending = failure(() =>
              insertTransferRow(sending, {
                sender_id: alice.user,
                recipient_id: bob.user,
                amount: 10,
                entry_id: anyEntry,
              }),
            );
            await untilBlocked(observer);
            expect(await failure(() => suspending.query('COMMIT'))).toBeUndefined();

            // Libéré, le transfert relit le statut de son émetteur : le compte est suspendu.
            expect(await pending).toMatch(SENDER_STATUS('suspended'));
            await sending.query('ROLLBACK');
            expect(await accountState(observer, bob.account)).toMatchObject({ balance: '0' });
          });
        });
      });
    });

    it('la suspension d’un destinataire n’attend pas le transfert en cours, qui aboutit', async () => {
      await asApp(async (sending) => {
        await asApp(async (suspending) => {
          await asApp(async (observer) => {
            const alice = await holderAt(observer, 1, 500);
            const bob = await holderAt(observer, 1);

            await sending.query('BEGIN');
            await writeTransfer(sending, {
              sender: alice.user,
              senderAccount: alice.account,
              recipient: bob.user,
              recipientAccount: bob.account,
              amount: 100,
            });

            // Le destinataire n'est que retenu ouvert : sa suspension passe aussitôt.
            await suspending.query(`SET lock_timeout = '3s'`);
            expect(
              await failure(() =>
                suspending.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [bob.user]),
              ),
            ).toBeUndefined();
            expect(await failure(() => sending.query('COMMIT'))).toBeUndefined();

            // Ce qui était en cours est arrivé ; plus rien n'arrive ensuite.
            expect(await accountState(observer, bob.account)).toMatchObject({ balance: '100' });
            expect(await rowRefusal(observer, alice, bob, 10)).toMatch(
              RECIPIENT_STATUS('suspended'),
            );
          });
        });
      });
    });
  });

  describe('cumul des envois', () => {
    it('zéro pour un compte qui n’a rien envoyé, et pour un compte inconnu', async () => {
      await asApp(async (db) => {
        const alice = await holderAt(db, 1);
        expect(await usageInSql(db, alice.user)).toEqual({ last24Hours: '0', last31Days: '0' });
        expect(await usageInSql(db, UNKNOWN_ID)).toEqual({ last24Hours: '0', last31Days: '0' });
      });
    });
  });

  describe('robustesse des fonctions', () => {
    it('les règles ne résolvent les noms que dans le schéma de l’application', async () => {
      await asOwner(async (owner) => {
        const { rows } = await owner.query<{ proname: string; proconfig: string[] | null }>(
          `SELECT proname, proconfig FROM pg_proc
           WHERE proname IN ('mgx_verified_level', 'mgx_enforce_transfer_limit',
                             'mgx_transfer_usage', 'mgx_enforce_transfer',
                             'mgx_check_transfer_entry', 'mgx_check_transfer_recorded')
           ORDER BY proname`,
        );
        expect(rows).toHaveLength(6);
        for (const { proname, proconfig } of rows) {
          expect({ proname, proconfig }).toEqual({
            proname,
            proconfig: ['search_path=public, pg_temp'],
          });
        }
      });
    });

    it('des copies des tables placées sur le chemin de recherche n’ouvrent ni niveau, ni plafond', async () => {
      await asApp(async (db) => {
        const intruder = await holderAt(db, 0, 5000);
        const alice = await holderAt(db, 1, 5000);
        const bob = await holderAt(db, 1);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 100);
        await send(db, alice, bob, 50);

        // Dans son schéma temporaire : des plafonds immenses à tous les niveaux, aucun
        // transfert passé, tous les comptes au niveau 3, et l'intrus administrateur.
        await db.query(`CREATE TEMP TABLE transfer_limits AS SELECT * FROM public.transfer_limits`);
        await db.query(
          `INSERT INTO transfer_limits
             (asset_code, kyc_level, per_transfer_max, daily_max, monthly_max, set_at)
           VALUES ('USD', 0, 1000000, 1000000, 1000000, now())`,
        );
        await db.query(
          `UPDATE transfer_limits
           SET per_transfer_max = 1000000, daily_max = 1000000, monthly_max = 1000000`,
        );
        await db.query(`CREATE TEMP TABLE transfers AS SELECT * FROM public.transfers WHERE false`);
        await db.query(`CREATE TEMP TABLE kyc_cases AS SELECT * FROM public.kyc_cases`);
        await db.query(`UPDATE kyc_cases SET status = 'APPROVED'`);
        await db.query(`CREATE TEMP TABLE users AS SELECT * FROM public.users`);
        await db.query(
          `CREATE TEMP TABLE user_roles AS
           SELECT user_id, role_id, granted_by, granted_at FROM public.user_roles
           UNION ALL
           SELECT $1::uuid, id, NULL::uuid, now() FROM public.roles WHERE key = 'super_admin'`,
          [intruder.user],
        );
        await db.query(
          `CREATE TEMP TABLE role_permissions AS SELECT * FROM public.role_permissions`,
        );
        await db.query(`SET search_path = pg_temp, public`);
        try {
          const sending = (
            from: Holder,
            amount: number,
            level: number,
          ): Promise<string | undefined> =>
            refusal(db, () =>
              db.query(
                `INSERT INTO public.transfers
                   (sender_id, recipient_id, asset_code, amount, entry_id, idempotency_key,
                    request_digest, sender_level)
                 VALUES ($1, $2, 'USD', $3, $4, $5, $6, $7)`,
                [from.user, bob.user, amount, anyEntry, freshKey(), Buffer.alloc(32, 1), level],
              ),
            );
          // L'intrus reste au niveau 0, qui n'a pas de plafond.
          expect(await sending(intruder, 1, 0)).toMatch(LEVEL_NOT_OPEN(0));
          expect(await sending(intruder, 1, 3)).toMatch(LEVEL_MISMATCH(0, 3));
          // Les plafonds et les cumuls d'Alice restent les vrais.
          expect(await sending(alice, 101, 1)).toMatch(OVER_PER_TRANSFER(1));
          expect(await sending(alice, 1, 1)).toMatch(OVER_DAILY(1));
          // Et l'intrus ne fixe aucun plafond.
          expect(
            await refusal(db, () =>
              db.query(
                `INSERT INTO public.transfer_limits
                   (asset_code, kyc_level, per_transfer_max, daily_max, monthly_max, set_by)
                 VALUES ('USD', 0, 1000000, 1000000, 1000000, $1)`,
                [intruder.user],
              ),
            ),
          ).toMatch(NOT_ENTITLED);
        } finally {
          await db.query(`RESET search_path`);
        }
      });
    });
  });
});
