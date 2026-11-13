import { LEDGER_ACCOUNT_TYPES, PERMISSIONS } from '@mgx/contracts';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  closeAccountInSql,
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
} from '../support/account-closure.js';
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
  createTestDatabase,
  sqlState,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE } from '../support/test-environment.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const STRING_TOO_LONG = '22001';
const NUMERIC_OVERFLOW = '22003';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Règle de clôture d'un compte enfreinte (migration account_closure). */
const CLOSURE_RULE_VIOLATION = 'MGX04';
/** Écriture visant un compte clôturé (migration account_closure). */
const ACCOUNT_CLOSED = 'MGX05';
/** Règle du grand livre enfreinte (migration ledger). */
const LEDGER_RULE_VIOLATION = 'MGX08';
/** Fonds insuffisants (migration ledger). */
const INSUFFICIENT_FUNDS = 'MGX09';

const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Même instant, dix ans plus tard, compté en UTC — comme le fait l'application. */
function tenYearsAfter(date: Date): Date {
  const later = new Date(date);
  later.setUTCFullYear(date.getUTCFullYear() + 10);
  return later;
}

describe('Grand livre — règles portées par la base de données', () => {
  let database: TestDatabase;
  let admin: string;
  let support: string;
  /** Comptes de la plateforme en dollars, ouverts une fois pour toutes. */
  let custody: string;
  let fees: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      support = await insertStaff(db, 'support');
      await registerAssetInSql(db, 'USD', 2);
      await registerAssetInSql(db, 'CDF', 2);
      await registerAssetInSql(db, 'BTC', 8, { kind: 'CRYPTO' });
    });
    await asApp(async (db) => {
      custody = await openLedgerAccount(db, 'platform_custody', 'USD');
      fees = await openLedgerAccount(db, 'platform_fees', 'USD');
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
      email: `ledger${String(sequence)}@example.cd`,
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

  /** Exécute `work` dans une transaction toujours annulée, et rend le code de son erreur. */
  async function attempt(db: pg.Client, work: () => Promise<unknown>): Promise<string | undefined> {
    await db.query('BEGIN');
    try {
      return await sqlState(work);
    } finally {
      await db.query('ROLLBACK');
    }
  }

  /**
   * Exécute `work` dans une transaction — il doit réussir — puis la valide : rend le code de
   * l'erreur levée **à la validation**, ou `undefined` si la transaction est validée.
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
    return sqlState(() => db.query('COMMIT'));
  }

  /** Un titulaire actif et son compte « fonds disponibles » en dollars, crédité de `units`. */
  async function holderWith(
    db: pg.Client,
    units: number,
  ): Promise<{ user: string; account: string }> {
    const user = await insertUser(db);
    const account = await openLedgerAccount(db, 'user_available', 'USD', user);
    if (units > 0) {
      await deposit(db, account, units);
    }
    return { user, account };
  }

  /** Dépôt : la plateforme conserve `units` de plus, et les doit au titulaire. */
  const deposit = (db: pg.Client, account: string, units: number): Promise<string> =>
    postEntryInSql(db, [
      { account: custody, side: 'DEBIT', amount: units },
      { account, side: 'CREDIT', amount: units },
    ]);

  /** Retrait : l'inverse d'un dépôt. */
  const withdraw = (db: pg.Client, account: string, units: number): Promise<string> =>
    postEntryInSql(db, [
      { account, side: 'DEBIT', amount: units },
      { account: custody, side: 'CREDIT', amount: units },
    ]);

  const transfer = (from: string, to: string, units: number): SqlPosting[] => [
    { account: from, side: 'DEBIT', amount: units },
    { account: to, side: 'CREDIT', amount: units },
  ];

  const grantsOn = async (db: pg.Client, table: string): Promise<string[]> =>
    (
      await db.query<{ privileges: string[] }>(
        `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_name = $2`,
        [TEST_APP_ROLE, table],
      )
    ).rows[0]!.privileges;

  describe('catalogues', () => {
    it('le plan de comptes de la base est celui de @mgx/contracts', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query(
          `SELECT key, owner::text AS owner, normal_side::text AS "normalSide", description
           FROM ledger_account_types ORDER BY key`,
        );
        expect(rows).toEqual(
          Object.entries(LEDGER_ACCOUNT_TYPES)
            .map(([key, type]) => ({ key, ...type }))
            .sort((left, right) => left.key.localeCompare(right.key)),
        );
        expect(rows).toHaveLength(3);
      });
    });

    it('ledger.read et ledger.manage_assets figurent au catalogue ; seul super_admin les détient', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query(
          `SELECT p.key, p.description, array_agg(r.key ORDER BY r.key) AS roles
           FROM permissions p
           LEFT JOIN role_permissions rp ON rp.permission_key = p.key
           LEFT JOIN roles r ON r.id = rp.role_id
           WHERE p.key LIKE 'ledger.%'
           GROUP BY p.key, p.description ORDER BY p.key`,
        );
        expect(rows).toEqual([
          {
            key: 'ledger.manage_assets',
            description: PERMISSIONS['ledger.manage_assets'],
            roles: ['super_admin'],
          },
          { key: 'ledger.read', description: PERMISSIONS['ledger.read'], roles: ['super_admin'] },
        ]);
      });
    });
  });

  describe('actifs', () => {
    /** Code de l'erreur d'un enregistrement tenté par l'administrateur, toujours annulé. */
    const registration = (
      db: pg.Client,
      overrides: Record<string, unknown>,
    ): Promise<string | undefined> =>
      attempt(db, () => registerAssetInSql(db, 'XTS', 2, { registered_by: admin, ...overrides }));

    it('un code de 2 à 12 majuscules ou chiffres, qui commence par une lettre', async () => {
      await asApp(async (db) => {
        for (const code of ['usd', 'Usd', 'U', '', '1AB', 'US D', 'US-D', 'USD ', 'ÉUR']) {
          expect({ code, outcome: await registration(db, { code }) }).toEqual({
            code,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await registration(db, { code: 'A234567890123' })).toBe(STRING_TOO_LONG);
        for (const code of ['XT', 'X2', 'A23456789012']) {
          expect({ code, outcome: await registration(db, { code }) }).toEqual({
            code,
            outcome: undefined,
          });
        }
      });
    });

    it('de 0 à 18 décimales', async () => {
      await asApp(async (db) => {
        expect(await registration(db, { scale: -1 })).toBe(CHECK_VIOLATION);
        expect(await registration(db, { scale: 19 })).toBe(CHECK_VIOLATION);
        expect(await registration(db, { scale: 0 })).toBeUndefined();
        expect(await registration(db, { scale: 18 })).toBeUndefined();
      });
    });

    it('un libellé d’une ligne : ni vide, ni bordé d’espaces, ni caractère de contrôle', async () => {
      await asApp(async (db) => {
        for (const name of [
          '',
          ' ',
          ' Dollar',
          'Dollar ',
          'Dol\nlar',
          'Dol\tlar',
          'Dollar\n',
          'Dol\u0001lar',
          'Dol\u001Flar',
          'Dol\u007Flar',
          'Dol\u0085lar',
          'Dol\u009Flar',
        ]) {
          expect({ name, outcome: await registration(db, { name }) }).toEqual({
            name,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await registration(db, { name: 'x'.repeat(65) })).toBe(STRING_TOO_LONG);
        for (const name of ['x', 'x'.repeat(64), 'Franc congolais', 'Dollar des États-Unis', '~']) {
          expect({ name, outcome: await registration(db, { name }) }).toEqual({
            name,
            outcome: undefined,
          });
        }
        expect(await registration(db, { kind: 'COMMODITY' })).toBe('22P02');
      });
    });

    it('seul l’enregistre un membre du personnel actif qui détient ledger.manage_assets', async () => {
      const [suspended, holder] = await asOwner(async (db) => [
        await insertStaff(db, 'super_admin'),
        await insertUser(db),
      ]);
      await asOwner((db) =>
        db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [suspended]),
      );
      await asApp(async (db) => {
        expect(await registration(db, { registered_by: admin })).toBeUndefined();
        // Habilité à autre chose, sans rôle, suspendu, inconnu : refusé.
        for (const registrar of [support, holder, suspended, UNKNOWN_ID]) {
          expect(await registration(db, { registered_by: registrar })).toBe(LEDGER_RULE_VIOLATION);
        }
      });
    });

    it('la permission se lit au moment d’enregistrer : retirée, elle ne vaut plus', async () => {
      const former = await asOwner((db) => insertStaff(db, 'super_admin'));
      await asApp(async (db) => {
        expect(await registration(db, { registered_by: former })).toBeUndefined();
      });
      await asOwner((db) => db.query(`DELETE FROM user_roles WHERE user_id = $1`, [former]));
      await asApp(async (db) => {
        expect(await registration(db, { registered_by: former })).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('consulter le grand livre n’habilite pas à y enregistrer un actif', async () => {
      await asOwner(async (db) => {
        const reader = await insertUser(db);
        // Un rôle qui ne détient que ledger.read — aucun rôle livré n'est dans ce cas — le temps
        // d'une transaction annulée : le catalogue des rôles reste celui des migrations.
        await db.query('BEGIN');
        try {
          const { rows } = await db.query<{ id: string }>(
            `INSERT INTO roles (key, name, description)
             VALUES ('ledger_reader', 'Ledger reader', 'Reads the ledger.') RETURNING id`,
          );
          const role = rows[0]!.id;
          await db.query(
            `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'ledger.read')`,
            [role],
          );
          await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
            reader,
            role,
          ]);
          const registering = async (): Promise<string | undefined> => {
            await db.query('SAVEPOINT registering');
            const outcome = await sqlState(() =>
              registerAssetInSql(db, 'XRD', 2, { registered_by: reader }),
            );
            await db.query('ROLLBACK TO SAVEPOINT registering');
            return outcome;
          };
          expect(await registering()).toBe(LEDGER_RULE_VIOLATION);
          // Le même compte, le même rôle, une fois la permission accordée : c'est bien elle qui
          // manquait.
          await db.query(
            `INSERT INTO role_permissions (role_id, permission_key)
             VALUES ($1, 'ledger.manage_assets')`,
            [role],
          );
          expect(await registering()).toBeUndefined();
        } finally {
          await db.query('ROLLBACK');
        }
        const { rows: roles } = await db.query(`SELECT key FROM roles WHERE key = 'ledger_reader'`);
        expect(roles).toEqual([]);
      });
    });

    it('sans auteur : réservé au rôle propriétaire, celui d’un outil d’exploitation', async () => {
      await asApp(async (db) => {
        expect(await registration(db, { registered_by: null })).toBe(LEDGER_RULE_VIOLATION);
      });
      await asOwner(async (db) => {
        expect(await registration(db, { registered_by: null })).toBeUndefined();
      });
    });

    it('l’heure d’enregistrement est celle de la base, quelle que soit celle qu’on lui donne', async () => {
      await asApp(async (db) => {
        await registerAssetInSql(db, 'XAF', 0, {
          registered_by: admin,
          registered_at: new Date('2001-02-03T04:05:06Z'),
        });
        const { rows } = await db.query<{ age: number; registered_by: string; scale: number }>(
          `SELECT abs(extract(epoch FROM now() - registered_at))::float8 AS age, registered_by,
                  scale
           FROM assets WHERE code = 'XAF'`,
        );
        expect(rows).toEqual([{ age: expect.any(Number), registered_by: admin, scale: 0 }]);
        expect(rows[0]!.age).toBeLessThan(60);
      });
    });

    it('un code ne s’enregistre qu’une fois', async () => {
      await asApp(async (db) => {
        expect(await registration(db, { code: 'USD', scale: 6 })).toBe(UNIQUE_VIOLATION);
      });
    });

    it('un actif enregistré ne change plus : ni modification, ni suppression, ni vidage — même par le propriétaire', async () => {
      await asOwner(async (db) => {
        for (const statement of [
          `UPDATE assets SET scale = 3 WHERE code = 'USD'`,
          `UPDATE assets SET name = 'Autre libellé' WHERE code = 'USD'`,
          `UPDATE assets SET kind = 'CRYPTO' WHERE code = 'USD'`,
          `UPDATE assets SET code = 'USX' WHERE code = 'BTC'`,
          `DELETE FROM assets WHERE code = 'BTC'`,
          `TRUNCATE assets CASCADE`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: FORBIDDEN_MUTATION,
          });
        }
        const { rows } = await db.query(
          `SELECT code, scale, kind::text AS kind FROM assets WHERE code IN ('USD', 'BTC')
           ORDER BY code`,
        );
        expect(rows).toEqual([
          { code: 'BTC', scale: 8, kind: 'CRYPTO' },
          { code: 'USD', scale: 2, kind: 'FIAT' },
        ]);
      });
    });

    it('le rôle applicatif n’a, sur les actifs, que le droit de lire et d’ajouter', async () => {
      await asApp(async (db) => {
        expect(await grantsOn(db, 'assets')).toEqual(['INSERT', 'SELECT']);
        for (const statement of [
          `UPDATE assets SET scale = 3`,
          `DELETE FROM assets`,
          `TRUNCATE assets CASCADE`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });
  });

  describe('plan de comptes', () => {
    it('il ne change que par migration : le rôle applicatif ne fait que le lire', async () => {
      await asApp(async (db) => {
        expect(await grantsOn(db, 'ledger_account_types')).toEqual(['SELECT']);
        for (const statement of [
          `INSERT INTO ledger_account_types (key, owner, normal_side, description)
           VALUES ('user_savings', 'USER', 'CREDIT', 'Savings.')`,
          `UPDATE ledger_account_types SET normal_side = 'DEBIT'`,
          `DELETE FROM ledger_account_types`,
          `TRUNCATE ledger_account_types CASCADE`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });

    it('un type ne se modifie ni ne se retire, même par le propriétaire — qui peut en ajouter', async () => {
      await asOwner(async (db) => {
        for (const statement of [
          `UPDATE ledger_account_types SET normal_side = 'DEBIT' WHERE key = 'user_available'`,
          `UPDATE ledger_account_types SET owner = 'PLATFORM' WHERE key = 'user_available'`,
          `DELETE FROM ledger_account_types WHERE key = 'platform_fees'`,
          `TRUNCATE ledger_account_types CASCADE`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: FORBIDDEN_MUTATION,
          });
        }
        const added = (key: string): Promise<string | undefined> =>
          attempt(db, () =>
            db.query(
              `INSERT INTO ledger_account_types (key, owner, normal_side, description)
               VALUES ($1, 'USER', 'CREDIT', 'Funds set aside.')`,
              [key],
            ),
          );
        expect(await added('user_reserved')).toBeUndefined();
        expect(await added('User_Reserved')).toBe(CHECK_VIOLATION);
        expect(await added('user-reserved')).toBe(CHECK_VIOLATION);
        expect(await added('1reserved')).toBe(CHECK_VIOLATION);
      });
    });
  });

  describe('comptes', () => {
    const opening = (
      db: pg.Client,
      type: string,
      assetCode: string,
      userId: string | null,
      extra: Record<string, unknown> = {},
    ): Promise<string | undefined> => {
      const row: Record<string, unknown> = {
        type_key: type,
        asset_code: assetCode,
        user_id: userId,
        ...extra,
      };
      const columns = Object.keys(row);
      return attempt(db, () =>
        db.query(
          `INSERT INTO ledger_accounts (${columns.join(', ')})
           VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
          Object.values(row),
        ),
      );
    };

    it('un compte de titulaire appartient à un titulaire ; un compte de la plateforme, à personne', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        expect(await opening(db, 'user_available', 'CDF', user)).toBeUndefined();
        expect(await opening(db, 'platform_custody', 'CDF', null)).toBeUndefined();
        expect(await opening(db, 'platform_fees', 'CDF', null)).toBeUndefined();

        expect(await opening(db, 'user_available', 'CDF', null)).toBe(LEDGER_RULE_VIOLATION);
        expect(await opening(db, 'platform_custody', 'CDF', user)).toBe(LEDGER_RULE_VIOLATION);
        expect(await opening(db, 'platform_fees', 'CDF', user)).toBe(LEDGER_RULE_VIOLATION);
        expect(await opening(db, 'user_savings', 'CDF', user)).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('dans un actif enregistré', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        expect(await opening(db, 'user_available', 'EUR', user)).toBe(FOREIGN_KEY_VIOLATION);
        expect(await opening(db, 'platform_custody', 'EUR', null)).toBe(FOREIGN_KEY_VIOLATION);
      });
    });

    it('pour un titulaire actif ou suspendu — ni inscription inachevée, ni compte clôturé, ni inconnu', async () => {
      await asApp(async (db) => {
        const active = await insertUser(db);
        const suspended = await insertUser(db, { status: 'SUSPENDED' });
        const pending = await insertUser(db, {
          status: 'PENDING_VERIFICATION',
          email_verified_at: null,
        });
        const closed = await insertUser(db);
        await closeAccountInSql(db, closed);

        expect(await opening(db, 'user_available', 'USD', active)).toBeUndefined();
        expect(await opening(db, 'user_available', 'USD', suspended)).toBeUndefined();
        expect(await opening(db, 'user_available', 'USD', pending)).toBe(LEDGER_RULE_VIOLATION);
        expect(await opening(db, 'user_available', 'USD', closed)).toBe(ACCOUNT_CLOSED);
        expect(await opening(db, 'user_available', 'USD', UNKNOWN_ID)).toBe(FOREIGN_KEY_VIOLATION);
      });
    });

    it('un compte s’ouvre vide ; son sens et sa date sont ceux que fixe la base', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        expect(await opening(db, 'user_available', 'USD', user, { balance: 100 })).toBe(
          LEDGER_RULE_VIOLATION,
        );
        expect(await opening(db, 'user_available', 'USD', user, { posting_count: 1 })).toBe(
          LEDGER_RULE_VIOLATION,
        );

        // Le sens fourni est le mauvais, la date est ancienne : la base n'en tient pas compte.
        await db.query(
          `INSERT INTO ledger_accounts (type_key, asset_code, user_id, normal_side, created_at)
           VALUES ('user_available', 'USD', $1, 'DEBIT', '2001-02-03T04:05:06Z'),
                  ('user_available', 'BTC', $1, 'CREDIT', '2001-02-03T04:05:06Z')`,
          [user],
        );
        const { rows } = await db.query(
          `SELECT asset_code, normal_side::text AS side, balance::text AS balance,
                  posting_count::text AS postings,
                  abs(extract(epoch FROM now() - created_at)) < 60 AS recent
           FROM ledger_accounts WHERE user_id = $1 ORDER BY asset_code`,
          [user],
        );
        expect(rows).toEqual([
          { asset_code: 'BTC', side: 'CREDIT', balance: '0', postings: '0', recent: true },
          { asset_code: 'USD', side: 'CREDIT', balance: '0', postings: '0', recent: true },
        ]);
        const platform = await db.query(
          `SELECT type_key, normal_side::text AS side FROM ledger_accounts
           WHERE id IN ($1, $2) ORDER BY type_key`,
          [custody, fees],
        );
        expect(platform.rows).toEqual([
          { type_key: 'platform_custody', side: 'DEBIT' },
          { type_key: 'platform_fees', side: 'CREDIT' },
        ]);
      });
    });

    it('un seul compte par type et par actif — pour chaque titulaire, et pour la plateforme', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const other = await insertUser(db);
        const account = await openLedgerAccount(db, 'user_available', 'USD', user);
        expect(await opening(db, 'user_available', 'USD', user)).toBe(UNIQUE_VIOLATION);
        expect(await opening(db, 'platform_custody', 'USD', null)).toBe(UNIQUE_VIOLATION);
        expect(await opening(db, 'platform_fees', 'USD', null)).toBe(UNIQUE_VIOLATION);
        // Un autre actif, un autre titulaire : d'autres comptes.
        expect(await opening(db, 'user_available', 'CDF', user)).toBeUndefined();
        expect(await opening(db, 'user_available', 'USD', other)).toBeUndefined();
        // Ouvrir un compte qui existe ne fait rien, et rend le même.
        expect(await openLedgerAccount(db, 'user_available', 'USD', user)).toBe(account);
        expect(await openLedgerAccount(db, 'platform_custody', 'USD')).toBe(custody);
      });
    });

    it('un compte ne change ni de type, ni d’actif, ni de titulaire, ni de sens', async () => {
      await asApp(async (db) => {
        const { account } = await holderWith(db, 0);
        const other = await insertUser(db);
        for (const [assignment, value] of [
          ['type_key = $2', 'platform_fees'],
          ['asset_code = $2', 'CDF'],
          ['user_id = $2', other],
          ['user_id = $2', null],
          ['normal_side = $2', 'DEBIT'],
          ['created_at = $2', new Date('2001-02-03T04:05:06Z')],
          ['id = $2', UNKNOWN_ID],
        ] as const) {
          expect({
            assignment,
            outcome: await attempt(db, () =>
              db.query(`UPDATE ledger_accounts SET ${assignment} WHERE id = $1`, [account, value]),
            ),
          }).toEqual({ assignment, outcome: LEDGER_RULE_VIOLATION });
        }
      });
    });

    it('un compte ne se supprime pas', async () => {
      const account = await asApp(async (db) => (await holderWith(db, 0)).account);
      await asOwner(async (db) => {
        expect(
          await attempt(db, () => db.query('DELETE FROM ledger_accounts WHERE id = $1', [account])),
        ).toBe(FORBIDDEN_MUTATION);
        expect(await attempt(db, () => db.query('TRUNCATE ledger_accounts CASCADE'))).toBe(
          FORBIDDEN_MUTATION,
        );
      });
      await asApp(async (db) => {
        // UPDATE : c'est le privilège qui permet de verrouiller un compte, et sous lequel la
        // base met son solde à jour quand une ligne y passe.
        expect(await grantsOn(db, 'ledger_accounts')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
        expect(
          await attempt(db, () => db.query('DELETE FROM ledger_accounts WHERE id = $1', [account])),
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await attempt(db, () => db.query('TRUNCATE ledger_accounts CASCADE'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
    });
  });

  describe('en-tête d’une écriture', () => {
    const header = (
      db: pg.Client,
      overrides: Record<string, unknown>,
      postingCount = 2,
    ): Promise<string | undefined> =>
      attempt(db, () => insertEntryHeader(db, postingCount, overrides));

    it('une clé d’idempotence de 8 à 160 caractères sûrs, qui commence par une lettre ou un chiffre', async () => {
      await asApp(async (db) => {
        for (const key of [
          '',
          'short',
          'a'.repeat(7),
          '-transfer:1',
          ':transfer:1',
          '.transfer:1',
          '_transfer:1',
          'transfer 12345',
          'transfer/12345',
          'transfer:é2345',
          'transfer:1234\n',
        ]) {
          expect({ key, outcome: await header(db, { idempotency_key: key }) }).toEqual({
            key,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await header(db, { idempotency_key: 'a'.repeat(161) })).toBe(STRING_TOO_LONG);
        for (const key of [
          'a'.repeat(8),
          'a'.repeat(160),
          '1transfer',
          'Transfer:0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
          'deposit.bank_x:2026-11-13:0001',
        ]) {
          expect({ key, outcome: await header(db, { idempotency_key: key }) }).toEqual({
            key,
            outcome: undefined,
          });
        }
      });
    });

    it('un type en minuscules, en segments séparés par des points', async () => {
      await asApp(async (db) => {
        for (const kind of [
          '',
          'Transfer',
          'transfer.',
          '.transfer',
          'transfer..internal',
          'transfer-internal',
          'transfer internal',
          'transfer.1internal',
          '1transfer',
          'transfer.internal\n',
        ]) {
          expect({ kind, outcome: await header(db, { kind }) }).toEqual({
            kind,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await header(db, { kind: 'a'.repeat(65) })).toBe(STRING_TOO_LONG);
        for (const kind of ['deposit', 'transfer.internal', 'a1.b_2.c', 'a'.repeat(64)]) {
          expect({ kind, outcome: await header(db, { kind }) }).toEqual({
            kind,
            outcome: undefined,
          });
        }
      });
    });

    it('de 2 à 100 lignes déclarées', async () => {
      await asApp(async (db) => {
        for (const count of [-1, 0, 1, 101]) {
          expect({ count, outcome: await header(db, {}, count) }).toEqual({
            count,
            outcome: CHECK_VIOLATION,
          });
        }
        expect(await header(db, {}, 2)).toBeUndefined();
        expect(await header(db, {}, 100)).toBeUndefined();
      });
    });

    it('un auteur identifié — sauf la plateforme elle-même, qui n’a pas d’identifiant', async () => {
      await asApp(async (db) => {
        expect(await header(db, { actor_type: 'SYSTEM', actor_id: 'someone' })).toBe(
          CHECK_VIOLATION,
        );
        expect(await header(db, { actor_type: 'USER' })).toBe(CHECK_VIOLATION);
        expect(await header(db, { actor_type: 'SERVICE' })).toBe(CHECK_VIOLATION);
        expect(await header(db, { actor_type: 'SYSTEM' })).toBeUndefined();
        expect(await header(db, { actor_type: 'USER', actor_id: UNKNOWN_ID })).toBeUndefined();
        expect(await header(db, { actor_type: 'SERVICE', actor_id: 'bank-x' })).toBeUndefined();
      });
    });

    it('des références : un objet JSON, de taille bornée', async () => {
      await asApp(async (db) => {
        for (const metadata of ['[]', '"text"', '12', 'null', '[{"a": 1}]']) {
          expect({ metadata, outcome: await header(db, { metadata }) }).toEqual({
            metadata,
            outcome: CHECK_VIOLATION,
          });
        }
        // Tel que la base le met en forme : {"k": "…"} — neuf octets autour de la valeur.
        const sized = (bytes: number): string => JSON.stringify({ k: 'a'.repeat(bytes - 9) });
        expect(await header(db, { metadata: sized(4096) })).toBeUndefined();
        expect(await header(db, { metadata: sized(4097) })).toBe(CHECK_VIOLATION);
        expect(await header(db, { metadata: '{}' })).toBeUndefined();
        // La taille se compte en octets : « é » en occupe deux.
        expect(await header(db, { metadata: JSON.stringify({ k: 'é'.repeat(2043) }) })).toBe(
          undefined,
        );
        expect(await header(db, { metadata: JSON.stringify({ k: 'é'.repeat(2044) }) })).toBe(
          CHECK_VIOLATION,
        );
      });
    });

    it('une clé ne sert qu’une fois', async () => {
      await asApp(async (db) => {
        const { account } = await holderWith(db, 0);
        await postEntryInSql(db, transfer(custody, account, 500), {
          idempotency_key: 'deposit:only-once',
        });
        expect(await header(db, { idempotency_key: 'deposit:only-once' })).toBe(UNIQUE_VIOLATION);
        expect(await header(db, { idempotency_key: 'deposit:only-oncE' })).toBeUndefined();
      });
    });

    it('l’heure de l’écriture est celle de la base, quelle que soit celle qu’on lui donne', async () => {
      await asApp(async (db) => {
        const { account } = await holderWith(db, 0);
        const entry = await postEntryInSql(db, transfer(custody, account, 500), {
          posted_at: new Date('2001-02-03T04:05:06Z'),
        });
        const { rows } = await db.query<{ recent: boolean }>(
          `SELECT abs(extract(epoch FROM now() - posted_at)) < 60 AS recent
           FROM ledger_entries WHERE id = $1`,
          [entry],
        );
        expect(rows).toEqual([{ recent: true }]);
      });
    });

    it('une écriture ne se modifie ni ne s’efface — même par le propriétaire', async () => {
      const entry = await asApp(async (db) => {
        const { account } = await holderWith(db, 0);
        return postEntryInSql(db, transfer(custody, account, 500));
      });
      await asOwner(async (db) => {
        for (const statement of [
          `UPDATE ledger_entries SET kind = 'other.kind' WHERE id = '${entry}'`,
          `UPDATE ledger_entries SET posting_count = 3 WHERE id = '${entry}'`,
          `UPDATE ledger_entries SET metadata = '{"a": 1}' WHERE id = '${entry}'`,
          `UPDATE ledger_entries SET idempotency_key = 'another:key:1' WHERE id = '${entry}'`,
          `DELETE FROM ledger_entries WHERE id = '${entry}'`,
          `TRUNCATE ledger_entries CASCADE`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: FORBIDDEN_MUTATION,
          });
        }
      });
      await asApp(async (db) => {
        expect(await grantsOn(db, 'ledger_entries')).toEqual(['INSERT', 'SELECT']);
        for (const statement of [
          `UPDATE ledger_entries SET kind = 'other.kind'`,
          `DELETE FROM ledger_entries`,
          `TRUNCATE ledger_entries CASCADE`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });
  });

  describe('lignes', () => {
    /** Code de l'erreur levée en passant ces lignes ; la transaction est toujours annulée. */
    const posting = (db: pg.Client, lines: readonly SqlPosting[]): Promise<string | undefined> =>
      attempt(db, async () => {
        const entry = await insertEntryHeader(db, Math.min(Math.max(lines.length, 2), 100));
        await insertPostings(db, entry, lines);
      });

    /** Code et message de l'erreur levée en passant ces lignes. */
    async function refusal(
      db: pg.Client,
      lines: readonly SqlPosting[],
    ): Promise<{ code: string | undefined; message: string } | undefined> {
      await db.query('BEGIN');
      try {
        const entry = await insertEntryHeader(db, lines.length);
        await insertPostings(db, entry, lines);
        return undefined;
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return { code, message };
      } finally {
        await db.query('ROLLBACK');
      }
    }

    it('un montant strictement positif, un numéro de ligne à partir de 1', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 1000);
        expect(await posting(db, transfer(alice.account, bob.account, 0))).toBe(CHECK_VIOLATION);
        // Un montant négatif inverserait le sens de la ligne.
        expect(await posting(db, transfer(bob.account, alice.account, -5))).toBe(CHECK_VIOLATION);
        expect(
          await posting(db, [
            { account: alice.account, side: 'DEBIT', amount: 5, line: 0 },
            { account: bob.account, side: 'CREDIT', amount: 5, line: 1 },
          ]),
        ).toBe(CHECK_VIOLATION);
        expect(await posting(db, transfer(alice.account, bob.account, 1))).toBeUndefined();
      });
    });

    it('sur un compte qui existe, et dans l’actif de ce compte', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        expect(await posting(db, transfer(alice.account, UNKNOWN_ID, 5))).toBe(
          LEDGER_RULE_VIOLATION,
        );
        // Mille francs ne sont pas mille dollars.
        expect(
          await posting(db, [
            { account: custody, side: 'DEBIT', amount: 5, asset: 'CDF' },
            { account: alice.account, side: 'CREDIT', amount: 5, asset: 'CDF' },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
        expect(
          await posting(db, [
            { account: custody, side: 'DEBIT', amount: 5 },
            { account: alice.account, side: 'CREDIT', amount: 5, asset: 'EUR' },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('le rang de la ligne et le solde qui en résulte sont calculés par la base, quoi qu’on lui fournisse', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        const before = await accountState(db, custody);

        await db.query('BEGIN');
        const entry = await insertEntryHeader(db, 2);
        const written = await insertPostings(db, entry, transfer(alice.account, bob.account, 300), {
          sequence: 999,
          balanceAfter: 123_456,
        });
        await db.query('COMMIT');

        // Alice : deuxième ligne de son compte (après le dépôt) ; Bob : première.
        expect(written).toEqual([
          { line: 1, sequence: '2', balanceAfter: '700' },
          { line: 2, sequence: '1', balanceAfter: '300' },
        ]);
        expect(await accountState(db, alice.account)).toEqual({ balance: '700', postings: '2' });
        expect(await accountState(db, bob.account)).toEqual({ balance: '300', postings: '1' });
        expect(await accountState(db, custody)).toEqual(before);
      });
    });

    it('plusieurs lignes d’un même compte dans une écriture : passées dans l’ordre, chacune prolonge la précédente', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        await db.query('BEGIN');
        const entry = await insertEntryHeader(db, 6);
        const written = await insertPostings(db, entry, [
          ...transfer(alice.account, bob.account, 300),
          ...transfer(alice.account, fees, 7),
          ...transfer(bob.account, alice.account, 100),
        ]);
        await db.query('COMMIT');

        expect(written).toEqual([
          { line: 1, sequence: '2', balanceAfter: '700' },
          { line: 2, sequence: '1', balanceAfter: '300' },
          { line: 3, sequence: '3', balanceAfter: '693' },
          { line: 4, sequence: expect.any(String), balanceAfter: expect.any(String) },
          { line: 5, sequence: '2', balanceAfter: '200' },
          { line: 6, sequence: '4', balanceAfter: '793' },
        ]);
        expect(await accountState(db, alice.account)).toEqual({ balance: '793', postings: '4' });
        expect(await accountState(db, bob.account)).toEqual({ balance: '200', postings: '2' });
      });
    });

    it('aucun solde ne devient négatif — celui d’un titulaire comme celui de la plateforme', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        expect(await posting(db, transfer(alice.account, bob.account, 1001))).toBe(
          INSUFFICIENT_FUNDS,
        );
        expect(await posting(db, transfer(bob.account, alice.account, 1))).toBe(INSUFFICIENT_FUNDS);
        // Jusqu'au dernier centime : accepté.
        await postEntryInSql(db, transfer(alice.account, bob.account, 1000));
        expect(await accountState(db, alice.account)).toEqual({ balance: '0', postings: '2' });

        // La plateforme ne rend pas plus qu'elle ne conserve. Son compte augmente au débit :
        // c'est un crédit qui le diminue — et c'est bien ce compte-là que la base désigne.
        const held = BigInt((await accountState(db, custody)).balance);
        expect(held).toBeGreaterThanOrEqual(1000n);
        const paidOut = (units: bigint): SqlPosting[] => [
          { account: custody, side: 'CREDIT', amount: units },
          { account: bob.account, side: 'DEBIT', amount: units },
        ];
        expect(await refusal(db, paidOut(held + 1n))).toEqual({
          code: INSUFFICIENT_FUNDS,
          message: `insufficient funds on ledger account ${custody}`,
        });
        // Jusqu'au dernier centime conservé, la ligne passe : c'est la suivante qui est refusée.
        expect(await refusal(db, paidOut(held))).toEqual({
          code: INSUFFICIENT_FUNDS,
          message: `insufficient funds on ledger account ${bob.account}`,
        });

        // Ni ne reprend des frais qu'elle n'a pas perçus : ce compte-ci augmente au crédit.
        await postEntryInSql(db, transfer(bob.account, fees, 25));
        const earned = BigInt((await accountState(db, fees)).balance);
        expect(earned).toBeGreaterThanOrEqual(25n);
        expect(await refusal(db, transfer(fees, bob.account, Number(earned) + 1))).toEqual({
          code: INSUFFICIENT_FUNDS,
          message: `insufficient funds on ledger account ${fees}`,
        });
        expect(await posting(db, transfer(fees, bob.account, Number(earned)))).toBeUndefined();
      });
    });

    it('le contrôle se fait ligne après ligne : un découvert, même passager, est refusé', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 0);
        const bob = await holderWith(db, 100);
        // Alice rend 50 avant de les avoir reçus : refusé, bien que l'écriture s'équilibre.
        expect(
          await posting(db, [
            ...transfer(alice.account, bob.account, 50),
            ...transfer(bob.account, alice.account, 50),
          ]),
        ).toBe(INSUFFICIENT_FUNDS);
        // Les mêmes lignes, dans l'ordre où les fonds existent : accepté.
        expect(
          await posting(db, [
            ...transfer(bob.account, alice.account, 50),
            ...transfer(alice.account, bob.account, 50),
          ]),
        ).toBeUndefined();
      });
    });

    it('un montant ou un solde de plus de 38 chiffres ne s’écrit pas', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 0);
        const max = 10n ** 38n - 1n;
        const btcCustody = await openLedgerAccount(db, 'platform_custody', 'BTC');
        const btc = await openLedgerAccount(db, 'user_available', 'BTC', alice.user);
        const inBtc = (amount: bigint): SqlPosting[] => [
          { account: btcCustody, side: 'DEBIT', amount, asset: 'BTC' },
          { account: btc, side: 'CREDIT', amount, asset: 'BTC' },
        ];
        expect(await posting(db, inBtc(max + 1n))).toBe(NUMERIC_OVERFLOW);
        await postEntryInSql(db, inBtc(max));
        expect(await accountState(db, btc)).toEqual({ balance: max.toString(), postings: '1' });
        expect(await posting(db, inBtc(1n))).toBe(NUMERIC_OVERFLOW);
      });
    });

    it('une ligne ne se modifie ni ne s’efface — même par le propriétaire', async () => {
      await asApp(async (db) => {
        const { account } = await holderWith(db, 500);
        expect(await grantsOn(db, 'ledger_postings')).toEqual(['INSERT', 'SELECT']);
        for (const statement of [
          `UPDATE ledger_postings SET amount = 1`,
          `DELETE FROM ledger_postings`,
          `TRUNCATE ledger_postings`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
        await asOwner(async (owner) => {
          for (const statement of [
            `UPDATE ledger_postings SET amount = 1 WHERE account_id = '${account}'`,
            `UPDATE ledger_postings SET balance_after = 1 WHERE account_id = '${account}'`,
            `UPDATE ledger_postings SET side = 'DEBIT' WHERE account_id = '${account}'`,
            `UPDATE ledger_postings SET account_id = '${custody}' WHERE account_id = '${account}'`,
            `DELETE FROM ledger_postings WHERE account_id = '${account}'`,
            `TRUNCATE ledger_postings`,
          ]) {
            expect({
              statement,
              outcome: await attempt(owner, () => owner.query(statement)),
            }).toEqual({ statement, outcome: FORBIDDEN_MUTATION });
          }
        });
        expect(await accountState(db, account)).toEqual({ balance: '500', postings: '1' });
      });
    });
  });

  describe('vider une table', () => {
    /** Table, et le déclencheur qui refuse qu'on la vide. */
    const guards: Record<string, string> = {
      assets: 'assets_immutable_truncate',
      ledger_account_types: 'ledger_account_types_immutable_truncate',
      ledger_accounts: 'ledger_accounts_no_truncate',
      ledger_entries: 'ledger_entries_immutable_truncate',
      ledger_postings: 'ledger_postings_immutable_truncate',
    };

    it('chaque table du grand livre le refuse d’elle-même, même si les autres ne sont plus protégées', async () => {
      // Vider une table entraîne celles qui s'y réfèrent, protégées elles aussi : pour savoir
      // ce que vaut la protection de chacune, celle des autres est levée — par le propriétaire,
      // seul à le pouvoir, dans une transaction annulée.
      await asApp((db) => holderWith(db, 100));
      await asOwner(async (db) => {
        const before = await ledgerSize(db);
        expect(before.entries).toBeGreaterThan(0);
        for (const [table, guard] of Object.entries(guards)) {
          const outcome = await attempt(db, async () => {
            for (const [other, otherGuard] of Object.entries(guards)) {
              if (other !== table) {
                await db.query(`ALTER TABLE ${other} DISABLE TRIGGER ${otherGuard}`);
              }
            }
            await db.query(`TRUNCATE ${table} CASCADE`);
          });
          expect({ table, guard, outcome }).toEqual({ table, guard, outcome: FORBIDDEN_MUTATION });
        }
        // Sans aucune protection, le vidage aboutirait : ce sont bien elles qui l'empêchent.
        expect(
          await attempt(db, async () => {
            for (const [table, guard] of Object.entries(guards)) {
              await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
            }
            await db.query(`TRUNCATE assets CASCADE`);
          }),
        ).toBeUndefined();
        expect(await ledgerSize(db)).toEqual(before);
      });
    });

    it('le rôle applicatif ne peut lever aucune de ces protections', async () => {
      await asApp(async (db) => {
        for (const [table, guard] of Object.entries(guards)) {
          expect(
            await attempt(db, () => db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`)),
          ).toBe(INSUFFICIENT_PRIVILEGE);
          expect(await attempt(db, () => db.query(`TRUNCATE ${table} CASCADE`))).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
        }
      });
    });
  });

  describe('à la validation, une écriture est entière et équilibrée — ou n’est pas', () => {
    /**
     * Passe l'en-tête (qui déclare `declared` lignes) et les lignes, puis valide : rend le code
     * de l'erreur levée à la validation, après avoir vérifié qu'il n'en reste rien.
     */
    async function committing(
      db: pg.Client,
      declared: number,
      lines: readonly SqlPosting[],
    ): Promise<string | undefined> {
      const accounts = [...new Set(lines.map(({ account }) => account))];
      const states = async (): Promise<unknown[]> => {
        const found: unknown[] = [];
        for (const account of accounts) {
          found.push(await accountState(db, account));
        }
        return found;
      };
      const before = { size: await ledgerSize(db), accounts: await states() };

      const outcome = await commitOf(db, async () => {
        const entry = await insertEntryHeader(db, declared);
        if (lines.length > 0) {
          await insertPostings(db, entry, lines);
        }
      });
      if (outcome !== undefined) {
        expect({ size: await ledgerSize(db), accounts: await states() }).toEqual(before);
      }
      return outcome;
    }

    it('un en-tête sans ses lignes n’est pas validé', async () => {
      await asApp(async (db) => {
        expect(await committing(db, 2, [])).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('ni moins de lignes que déclaré, ni davantage', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        const two = transfer(alice.account, bob.account, 10);
        const four = [...two, ...transfer(alice.account, bob.account, 20)];
        expect(await committing(db, 3, two)).toBe(LEDGER_RULE_VIOLATION);
        expect(await committing(db, 2, four)).toBe(LEDGER_RULE_VIOLATION);
        expect(await committing(db, 4, four)).toBeUndefined();
        expect(await committing(db, 2, two)).toBeUndefined();
      });
    });

    it('des lignes numérotées 1, 2, 3… sans trou ni doublon', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        const numbered = (first: number, second: number): SqlPosting[] => [
          { account: alice.account, side: 'DEBIT', amount: 10, line: first },
          { account: bob.account, side: 'CREDIT', amount: 10, line: second },
        ];
        expect(await committing(db, 2, numbered(1, 3))).toBe(LEDGER_RULE_VIOLATION);
        expect(await committing(db, 2, numbered(2, 3))).toBe(LEDGER_RULE_VIOLATION);
        // Trois lignes déclarées, la première et la troisième écrites : la dernière porte bien
        // le numéro attendu, mais il en manque une.
        expect(await committing(db, 3, numbered(1, 3))).toBe(LEDGER_RULE_VIOLATION);
        expect(
          await attempt(db, async () => {
            await insertPostings(db, await insertEntryHeader(db, 2), numbered(1, 1));
          }),
        ).toBe(UNIQUE_VIOLATION);
        // L'ordre d'écriture importe peu, pourvu que les numéros soient 1 et 2.
        expect(await committing(db, 2, numbered(2, 1))).toBeUndefined();
      });
    });

    it('des débits égaux aux crédits', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        for (const [debit, credit] of [
          [100, 99],
          [99, 100],
          [1, 2],
        ] as const) {
          expect(
            await committing(db, 2, [
              { account: alice.account, side: 'DEBIT', amount: debit },
              { account: bob.account, side: 'CREDIT', amount: credit },
            ]),
          ).toBe(LEDGER_RULE_VIOLATION);
        }
        // Deux débits, ou deux crédits : rien ne les compense.
        expect(
          await committing(db, 2, [
            { account: alice.account, side: 'DEBIT', amount: 5 },
            { account: custody, side: 'DEBIT', amount: 5 },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
        expect(
          await committing(db, 2, [
            { account: alice.account, side: 'CREDIT', amount: 5 },
            { account: bob.account, side: 'CREDIT', amount: 5 },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
        // Trois lignes : un débit, deux crédits qui le répartissent.
        expect(
          await committing(db, 3, [
            { account: alice.account, side: 'DEBIT', amount: 100 },
            { account: bob.account, side: 'CREDIT', amount: 97 },
            { account: fees, side: 'CREDIT', amount: 3 },
          ]),
        ).toBeUndefined();
      });
    });

    it('actif par actif : cent dollars ne compensent pas cent francs', async () => {
      await asApp(async (db) => {
        const { user, account: usd } = await holderWith(db, 0);
        const cdf = await openLedgerAccount(db, 'user_available', 'CDF', user);
        const cdfCustody = await openLedgerAccount(db, 'platform_custody', 'CDF');
        expect(
          await committing(db, 2, [
            { account: custody, side: 'DEBIT', amount: 100, asset: 'USD' },
            { account: cdf, side: 'CREDIT', amount: 100, asset: 'CDF' },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
        // Équilibrée au total, mais dans aucun des deux actifs.
        expect(
          await committing(db, 4, [
            { account: custody, side: 'DEBIT', amount: 100, asset: 'USD' },
            { account: usd, side: 'CREDIT', amount: 60, asset: 'USD' },
            { account: cdfCustody, side: 'DEBIT', amount: 60, asset: 'CDF' },
            { account: cdf, side: 'CREDIT', amount: 100, asset: 'CDF' },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
        // Deux actifs, chacun équilibré : une seule écriture.
        expect(
          await committing(db, 4, [
            { account: custody, side: 'DEBIT', amount: 100, asset: 'USD' },
            { account: usd, side: 'CREDIT', amount: 100, asset: 'USD' },
            { account: cdfCustody, side: 'DEBIT', amount: 285_000, asset: 'CDF' },
            { account: cdf, side: 'CREDIT', amount: 285_000, asset: 'CDF' },
          ]),
        ).toBeUndefined();
        expect(await accountState(db, cdf)).toEqual({ balance: '285000', postings: '1' });
      });
    });

    it('entre deux comptes au moins : une écriture ne se compense pas sur un seul', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        expect(
          await committing(db, 2, [
            { account: alice.account, side: 'DEBIT', amount: 10 },
            { account: alice.account, side: 'CREDIT', amount: 10 },
          ]),
        ).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('plus rien ne s’ajoute à une écriture validée', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        const entry = await postEntryInSql(db, transfer(alice.account, bob.account, 10));
        const size = await ledgerSize(db);

        // Deux lignes de plus, équilibrées, numérotées à la suite : l'écriture n'aurait plus le
        // nombre de lignes qu'elle a déclaré.
        expect(
          await commitOf(db, () =>
            insertPostings(db, entry, [
              { account: alice.account, side: 'DEBIT', amount: 500, line: 3 },
              { account: bob.account, side: 'CREDIT', amount: 500, line: 4 },
            ]),
          ),
        ).toBe(LEDGER_RULE_VIOLATION);
        expect(await ledgerSize(db)).toEqual(size);
        expect(await accountState(db, alice.account)).toEqual({ balance: '990', postings: '2' });
        expect(await accountState(db, bob.account)).toEqual({ balance: '10', postings: '1' });
      });
    });

    it('ces vérifications ne se contournent pas avec le rôle applicatif', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        for (const statement of [
          'ALTER TABLE ledger_postings DISABLE TRIGGER ALL',
          'ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_sound',
          'ALTER TABLE ledger_accounts DISABLE TRIGGER ledger_accounts_balance_proven',
          `SET session_replication_role = 'replica'`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: INSUFFICIENT_PRIVILEGE,
          });
        }
        // Les avancer ne les supprime pas : l'en-tête est alors refusé dès son écriture…
        expect(
          await attempt(db, async () => {
            await db.query('SET CONSTRAINTS ALL IMMEDIATE');
            await insertEntryHeader(db, 2);
          }),
        ).toBe(LEDGER_RULE_VIOLATION);
        // … et les rétablir en cours de route vérifie aussitôt ce qui a été écrit.
        expect(
          await attempt(db, async () => {
            const entry = await insertEntryHeader(db, 2);
            await insertPostings(db, entry, [
              { account: alice.account, side: 'DEBIT', amount: 10 },
              { account: bob.account, side: 'CREDIT', amount: 9 },
            ]);
            await db.query('SET CONSTRAINTS ALL IMMEDIATE');
          }),
        ).toBe(LEDGER_RULE_VIOLATION);
      });
    });
  });

  describe('le solde d’un compte n’est que le reflet de sa dernière ligne', () => {
    it('un solde écrit directement n’est jamais validé — ni par le rôle applicatif, ni par le propriétaire', async () => {
      const alice = await asApp((db) => holderWith(db, 1000));
      const update = (db: pg.Client, assignment: string): Promise<string | undefined> =>
        commitOf(db, () =>
          db.query(`UPDATE ledger_accounts SET ${assignment} WHERE id = $1`, [alice.account]),
        );
      for (const run of [asApp, asOwner]) {
        await run(async (db) => {
          for (const assignment of [
            'balance = balance + 1000',
            'balance = balance - 1',
            'balance = 0',
            'posting_count = posting_count + 1',
            'posting_count = 0, balance = 0',
            'balance = balance + 1, posting_count = posting_count + 1',
          ]) {
            expect({ assignment, outcome: await update(db, assignment) }).toEqual({
              assignment,
              outcome: LEDGER_RULE_VIOLATION,
            });
          }
          // Un solde négatif n'attend pas la validation : la contrainte du compte le refuse
          // aussitôt, même sur un compte qui a des lignes.
          expect(
            await attempt(db, () =>
              db.query('UPDATE ledger_accounts SET balance = -1 WHERE id = $1', [alice.account]),
            ),
          ).toBe(CHECK_VIOLATION);
          expect(await accountState(db, alice.account)).toEqual({ balance: '1000', postings: '1' });
        });
      }
    });

    it('un compte vide ne reçoit pas davantage de solde sans ligne', async () => {
      await asApp(async (db) => {
        const { account } = await holderWith(db, 0);
        expect(
          await attempt(db, () =>
            db.query('UPDATE ledger_accounts SET balance = 5 WHERE id = $1', [account]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await attempt(db, () =>
            db.query('UPDATE ledger_accounts SET balance = -1 WHERE id = $1', [account]),
          ),
        ).toBe(CHECK_VIOLATION);
        // Un nombre de lignes négatif est refusé aussitôt, lui aussi.
        expect(
          await attempt(db, () =>
            db.query('UPDATE ledger_accounts SET posting_count = -1 WHERE id = $1', [account]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await commitOf(db, () =>
            db.query('UPDATE ledger_accounts SET posting_count = 1 WHERE id = $1', [account]),
          ),
        ).toBe(LEDGER_RULE_VIOLATION);
        expect(
          await commitOf(db, () =>
            db.query('UPDATE ledger_accounts SET posting_count = 1, balance = 5 WHERE id = $1', [
              account,
            ]),
          ),
        ).toBe(LEDGER_RULE_VIOLATION);
      });
    });

    it('passer une ligne puis retoucher le solde à la main ne passe pas non plus', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 0);
        expect(
          await commitOf(db, async () => {
            const entry = await insertEntryHeader(db, 2);
            await insertPostings(db, entry, transfer(alice.account, bob.account, 10));
            await db.query('UPDATE ledger_accounts SET balance = balance + 990 WHERE id = $1', [
              bob.account,
            ]);
          }),
        ).toBe(LEDGER_RULE_VIOLATION);
        expect(await accountState(db, bob.account)).toEqual({ balance: '0', postings: '0' });
        // Une retouche annulée dans la même transaction ne laisse rien : elle est validée.
        expect(
          await commitOf(db, async () => {
            await db.query('UPDATE ledger_accounts SET balance = balance + 5 WHERE id = $1', [
              alice.account,
            ]);
            await db.query('UPDATE ledger_accounts SET balance = balance - 5 WHERE id = $1', [
              alice.account,
            ]);
          }),
        ).toBeUndefined();
        expect(await accountState(db, alice.account)).toEqual({ balance: '1000', postings: '1' });
      });
    });

    it('un compte altéré n’accepte plus aucune ligne tant qu’il n’a pas été examiné', async () => {
      const alice = await asApp((db) => holderWith(db, 1000));
      const bob = await asApp((db) => holderWith(db, 1000));
      // Seul le propriétaire du schéma peut neutraliser la règle — ce que fait ici le test.
      await asOwner(async (owner) => {
        await owner.query('BEGIN');
        await owner.query(
          'ALTER TABLE ledger_accounts DISABLE TRIGGER ledger_accounts_balance_proven',
        );
        await owner.query('UPDATE ledger_accounts SET balance = 999999 WHERE id = $1', [
          alice.account,
        ]);
        await owner.query(
          'ALTER TABLE ledger_accounts ENABLE TRIGGER ledger_accounts_balance_proven',
        );
        await owner.query('COMMIT');
      });
      await asApp(async (db) => {
        expect(await accountState(db, alice.account)).toEqual({ balance: '999999', postings: '1' });
        // Ni débit — même couvert par le vrai solde —, ni crédit.
        expect(await sqlState(() => withdraw(db, alice.account, 1))).toBe(LEDGER_RULE_VIOLATION);
        expect(await sqlState(() => deposit(db, alice.account, 1))).toBe(LEDGER_RULE_VIOLATION);
        expect(
          await sqlState(() => postEntryInSql(db, transfer(bob.account, alice.account, 1))),
        ).toBe(LEDGER_RULE_VIOLATION);
        // Les autres comptes ne sont pas touchés.
        await withdraw(db, bob.account, 1);
        expect(await accountState(db, bob.account)).toEqual({ balance: '999', postings: '2' });
      });
    });
  });

  describe('clôture d’un compte', () => {
    it('rien ne s’écrit sur les comptes d’un titulaire clôturé, et aucun compte ne lui est ouvert', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        const bob = await holderWith(db, 1000);
        await withdraw(db, alice.account, 1000);
        await closeAccountInSql(db, alice.user);

        expect(await sqlState(() => deposit(db, alice.account, 1))).toBe(ACCOUNT_CLOSED);
        expect(
          await sqlState(() => postEntryInSql(db, transfer(bob.account, alice.account, 1))),
        ).toBe(ACCOUNT_CLOSED);
        expect(
          await sqlState(() => openLedgerAccount(db, 'user_available', 'CDF', alice.user)),
        ).toBe(ACCOUNT_CLOSED);
        // Ses comptes et leurs lignes restent, vides.
        expect(await accountState(db, alice.account)).toEqual({ balance: '0', postings: '2' });
        expect(await accountState(db, bob.account)).toEqual({ balance: '1000', postings: '1' });
      });
    });

    it('un compte ne se clôt pas tant qu’il détient des fonds, dans quelque actif que ce soit', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1);
        expect(await sqlState(() => closeAccountInSql(db, alice.user))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        const status = async (): Promise<unknown> =>
          (await db.query('SELECT status::text AS status FROM users WHERE id = $1', [alice.user]))
            .rows;
        expect(await status()).toEqual([{ status: 'ACTIVE' }]);

        // Les dollars retirés, il reste des francs.
        await withdraw(db, alice.account, 1);
        const cdf = await openLedgerAccount(db, 'user_available', 'CDF', alice.user);
        const cdfCustody = await openLedgerAccount(db, 'platform_custody', 'CDF');
        await postEntryInSql(db, [
          { account: cdfCustody, side: 'DEBIT', amount: 5, asset: 'CDF' },
          { account: cdf, side: 'CREDIT', amount: 5, asset: 'CDF' },
        ]);
        expect(await sqlState(() => closeAccountInSql(db, alice.user))).toBe(
          CLOSURE_RULE_VIOLATION,
        );

        await postEntryInSql(db, [
          { account: cdf, side: 'DEBIT', amount: 5, asset: 'CDF' },
          { account: cdfCustody, side: 'CREDIT', amount: 5, asset: 'CDF' },
        ]);
        await closeAccountInSql(db, alice.user);
        expect(await status()).toEqual([{ status: 'CLOSED' }]);
      });
    });

    it('s’il a eu des écritures, la trace de sa clôture garde ses identifiants dix ans', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 1000);
        await withdraw(db, alice.account, 1000);
        const closedAt = new Date();
        const tenYears = tenYearsAfter(closedAt);
        const record = (legalRetentionUntil: Date | null): Promise<string | undefined> =>
          attempt(db, () => insertClosureRecord(db, alice.user, { closedAt, legalRetentionUntil }));

        expect(await record(null)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await record(new Date(closedAt.getTime() + 30 * DAY_MS))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        expect(await record(new Date(tenYears.getTime() - 2 * DAY_MS))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        expect(await record(tenYears)).toBeUndefined();
        expect(await record(new Date(tenYears.getTime() + DAY_MS))).toBeUndefined();

        // L'assistant de clôture des tests compte de même.
        await closeAccountInSql(db, alice.user, { closedAt });
        const { rows } = await db.query<{ until: Date }>(
          'SELECT legal_retention_until AS until FROM account_closures WHERE user_id = $1',
          [alice.user],
        );
        expect(rows).toEqual([{ until: tenYears }]);
      });
    });

    it('sans écriture, rien n’impose de les garder : ni compte jamais ouvert, ni compte resté vide', async () => {
      await asApp(async (db) => {
        const never = await insertUser(db);
        const empty = await holderWith(db, 0);
        for (const user of [never, empty.user]) {
          await closeAccountInSql(db, user, { legalRetentionUntil: null });
          const { rows } = await db.query(
            'SELECT legal_retention_until AS until FROM account_closures WHERE user_id = $1',
            [user],
          );
          expect(rows).toEqual([{ until: null }]);
        }
      });
    });
  });

  describe('écritures simultanées', () => {
    it('deux écritures sur un même compte passent l’une après l’autre : la seconde part du solde laissé par la première', async () => {
      await asApp((first) =>
        asApp((second) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 100);
            const bob = await holderWith(observer, 0);
            const carol = await holderWith(observer, 0);

            await first.query('BEGIN');
            const entry = await insertEntryHeader(first, 2);
            await insertPostings(first, entry, transfer(alice.account, bob.account, 60));

            // Les deux dépensent 60 des 100 d'Alice : la seconde attend l'issue de la première.
            const late = sqlState(() =>
              postEntryInSql(second, transfer(alice.account, carol.account, 60)),
            );
            await untilBlocked(observer);
            await first.query('COMMIT');

            expect(await late).toBe(INSUFFICIENT_FUNDS);
            expect(await accountState(observer, alice.account)).toEqual({
              balance: '40',
              postings: '2',
            });
            expect(await accountState(observer, carol.account)).toEqual({
              balance: '0',
              postings: '0',
            });
          }),
        ),
      );
    });

    it('la première annulée, la seconde passe', async () => {
      await asApp((first) =>
        asApp((second) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 100);
            const bob = await holderWith(observer, 0);
            const carol = await holderWith(observer, 0);

            await first.query('BEGIN');
            const entry = await insertEntryHeader(first, 2);
            await insertPostings(first, entry, transfer(alice.account, bob.account, 60));

            const late = sqlState(() =>
              postEntryInSql(second, transfer(alice.account, carol.account, 60)),
            );
            await untilBlocked(observer);
            await first.query('ROLLBACK');

            expect(await late).toBeUndefined();
            expect(await accountState(observer, alice.account)).toEqual({
              balance: '40',
              postings: '2',
            });
            expect(await accountState(observer, bob.account)).toEqual({
              balance: '0',
              postings: '0',
            });
            expect(await accountState(observer, carol.account)).toEqual({
              balance: '60',
              postings: '1',
            });
          }),
        ),
      );
    });

    it('la seconde, couverte par le solde restant, prend le rang suivant', async () => {
      await asApp((first) =>
        asApp((second) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 100);
            const bob = await holderWith(observer, 0);

            await first.query('BEGIN');
            const entry = await insertEntryHeader(first, 2);
            await insertPostings(first, entry, transfer(alice.account, bob.account, 60));

            const late = (async () => {
              await second.query('BEGIN');
              const other = await insertEntryHeader(second, 2);
              const written = await insertPostings(
                second,
                other,
                transfer(alice.account, bob.account, 40),
              );
              await second.query('COMMIT');
              return written;
            })();
            await untilBlocked(observer);
            await first.query('COMMIT');

            expect(await late).toEqual([
              { line: 1, sequence: '3', balanceAfter: '0' },
              { line: 2, sequence: '2', balanceAfter: '100' },
            ]);
          }),
        ),
      );
    });

    it('une ligne en cours retient la clôture du titulaire, qui voit ensuite les fonds et échoue', async () => {
      await asApp((posting) =>
        asApp((closing) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 0);
            await posting.query('BEGIN');
            const entry = await insertEntryHeader(posting, 2);
            await insertPostings(posting, entry, transfer(custody, alice.account, 50));

            const closure = sqlState(() => closeAccountInSql(closing, alice.user));
            await untilBlocked(observer);
            await posting.query('COMMIT');

            expect(await closure).toBe(CLOSURE_RULE_VIOLATION);
            expect(await accountState(observer, alice.account)).toEqual({
              balance: '50',
              postings: '1',
            });
          }),
        ),
      );
    });

    it('la même course, la ligne annulée : la clôture passe', async () => {
      await asApp((posting) =>
        asApp((closing) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 0);
            await posting.query('BEGIN');
            const entry = await insertEntryHeader(posting, 2);
            await insertPostings(posting, entry, transfer(custody, alice.account, 50));

            const closure = sqlState(() => closeAccountInSql(closing, alice.user));
            await untilBlocked(observer);
            await posting.query('ROLLBACK');

            expect(await closure).toBeUndefined();
            expect(await accountState(observer, alice.account)).toEqual({
              balance: '0',
              postings: '0',
            });
          }),
        ),
      );
    });

    it('une clôture en cours retient la ligne, qui est ensuite refusée — comme l’ouverture d’un compte', async () => {
      await asApp((closing) =>
        asApp((posting) =>
          asApp((opening) =>
            asApp(async (observer) => {
              const alice = await holderWith(observer, 0);
              await closing.query('BEGIN');
              await insertClosureRecord(closing, alice.user);
              await emptyAccount(closing, alice.user);
              await markAccountClosed(closing, alice.user);

              const late = sqlState(() => deposit(posting, alice.account, 50));
              await untilBlocked(observer);
              const account = sqlState(() =>
                openLedgerAccount(opening, 'user_available', 'CDF', alice.user),
              );
              await closeVerificationCases(closing, alice.user);
              await closing.query('COMMIT');

              expect(await late).toBe(ACCOUNT_CLOSED);
              expect(await account).toBe(ACCOUNT_CLOSED);
              expect(await accountState(observer, alice.account)).toEqual({
                balance: '0',
                postings: '0',
              });
            }),
          ),
        ),
      );
    });

    it('la même course, la clôture annulée : la ligne passe', async () => {
      await asApp((closing) =>
        asApp((posting) =>
          asApp(async (observer) => {
            const alice = await holderWith(observer, 0);
            await closing.query('BEGIN');
            await insertClosureRecord(closing, alice.user);

            const late = sqlState(() => deposit(posting, alice.account, 50));
            await untilBlocked(observer);
            await closing.query('ROLLBACK');

            expect(await late).toBeUndefined();
            expect(await accountState(observer, alice.account)).toEqual({
              balance: '50',
              postings: '1',
            });
          }),
        ),
      );
    });
  });

  describe('robustesse des fonctions', () => {
    it('les règles ne résolvent les noms que dans le schéma de l’application', async () => {
      await asOwner(async (owner) => {
        const { rows } = await owner.query<{ proname: string; proconfig: string[] | null }>(
          `SELECT proname, proconfig FROM pg_proc
           WHERE proname IN ('mgx_enforce_asset', 'mgx_enforce_ledger_account',
                             'mgx_check_ledger_account_balance', 'mgx_stamp_ledger_entry',
                             'mgx_apply_ledger_posting', 'mgx_check_ledger_entry',
                             'mgx_forbid_closure_with_funds',
                             'mgx_enforce_closure_ledger_retention')
           ORDER BY proname`,
        );
        expect(rows).toHaveLength(8);
        for (const { proname, proconfig } of rows) {
          expect({ proname, proconfig }).toEqual({
            proname,
            proconfig: ['search_path=public, pg_temp'],
          });
        }
      });
    });

    it('une copie des tables placée sur le chemin de recherche n’habilite pas un intrus, ni ne crée de fonds', async () => {
      await asApp(async (db) => {
        const intruder = await insertUser(db);
        const alice = await holderWith(db, 100);
        const bob = await holderWith(db, 0);

        // Dans son schéma temporaire : l'intrus est administrateur, et Alice est riche.
        await db.query(`CREATE TEMP TABLE users AS SELECT * FROM public.users`);
        await db.query(
          `CREATE TEMP TABLE user_roles AS
           SELECT user_id, role_id, granted_by, granted_at FROM public.user_roles
           UNION ALL
           SELECT $1::uuid, id, NULL::uuid, now() FROM public.roles WHERE key = 'super_admin'`,
          [intruder],
        );
        await db.query(
          `CREATE TEMP TABLE role_permissions AS SELECT * FROM public.role_permissions`,
        );
        await db.query(`CREATE TEMP TABLE ledger_accounts AS SELECT * FROM public.ledger_accounts`);
        await db.query(`UPDATE ledger_accounts SET balance = 1000000 WHERE id = $1`, [
          alice.account,
        ]);
        await db.query(`CREATE TEMP TABLE ledger_postings AS SELECT * FROM public.ledger_postings`);
        await db.query(`UPDATE ledger_postings SET balance_after = 1000000 WHERE account_id = $1`, [
          alice.account,
        ]);
        await db.query(`SET search_path = pg_temp, public`);

        expect(
          await attempt(db, () =>
            db.query(
              `INSERT INTO public.assets (code, name, kind, scale, registered_by)
               VALUES ('XIN', 'Intruder coin', 'CRYPTO', 2, $1)`,
              [intruder],
            ),
          ),
        ).toBe(LEDGER_RULE_VIOLATION);

        const spend = (units: number): Promise<string | undefined> =>
          attempt(db, async () => {
            const { rows } = await db.query<{ id: string }>(
              `INSERT INTO public.ledger_entries (idempotency_key, kind, posting_count, actor_type)
               VALUES ('intruder:' || gen_random_uuid()::text, 'test.entry', 2, 'SYSTEM')
               RETURNING id`,
            );
            await db.query(
              `INSERT INTO public.ledger_postings
                 (entry_id, line_number, account_id, asset_code, side, amount, account_sequence,
                  balance_after)
               VALUES ($1, 1, $2, 'USD', 'DEBIT', $4, 0, 0), ($1, 2, $3, 'USD', 'CREDIT', $4, 0, 0)`,
              [rows[0]!.id, alice.account, bob.account, units],
            );
          });
        expect(await spend(101)).toBe(INSUFFICIENT_FUNDS);
        expect(await spend(100)).toBeUndefined();
        await db.query(`RESET search_path`);
      });
    });
  });
});
