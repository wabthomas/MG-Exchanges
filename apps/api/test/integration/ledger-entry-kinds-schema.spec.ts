import { LEDGER_ENTRY_KINDS } from '@mgx/contracts';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  accountState,
  insertEntryHeader,
  insertPostings,
  ledgerSize,
  openLedgerAccount,
  registerAssetInSql,
  registerEntryKindsInSql,
  type SqlPosting,
} from '../support/ledger-sql.js';
import { approveInSql, insertAdjustmentRow } from '../support/staff-operations-sql.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE, TEST_OWNER_ROLE, withAdmin } from '../support/test-environment.js';
import { setLimitInSql, transferInSql, verifyUpTo } from '../support/transfers-sql.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const STRING_TOO_LONG = '22001';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';

// Les deux règles de la liste lèvent le même code : c'est le message qui dit laquelle.
const UNKNOWN_KIND = (kind: string): RegExp =>
  new RegExp(
    `^MGX13: ledger entry \\S+ is of kind "${kind.replaceAll('.', '\\.')}", ` +
      'which the database does not know$',
  );
const OWNER_ONLY = /^MGX13: a ledger entry kind can only be registered by the owner role$/;
const KIND_FORMAT = new RegExp(
  `^${CHECK_VIOLATION}: .*violates check constraint "ledger_entries_kind_format_check"$`,
);
// Les règles qui lient un type connu à son opération (migrations internal_transfers et
// staff_ledger_operations).
const TRANSFER_ENTRY_WITHOUT_TRANSFER =
  /^MGX10: ledger entry \S+ is a transfer entry without a transfer$/;
const ADJUSTMENT_ENTRY_WITHOUT_ADJUSTMENT =
  /^MGX11: ledger entry \S+ is an adjustment entry without an approved adjustment$/;

interface Holder {
  readonly user: string;
  /** Compte « fonds disponibles » en dollars. */
  readonly account: string;
}

/**
 * La base est ici **telle que les migrations la laissent** : aucun type d'essai ne lui est
 * déclaré, contrairement aux autres fichiers de test du grand livre. C'est l'état d'une base
 * de production.
 */
describe('Types d’écriture — la liste que la base connaît', () => {
  let database: TestDatabase;
  /** Deux administrateurs (rôle super_admin) : l'un demande un ajustement, l'autre l'approuve. */
  let admin: string;
  let second: string;
  let custody: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      second = await insertStaff(db, 'super_admin');
      await registerAssetInSql(db, 'USD', 2);
      await setLimitInSql(db, 'USD', 1, [1000, 2500, 10_000]);
    });
    custody = await asApp((db) => openLedgerAccount(db, 'platform_custody', 'USD'));
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);
  /** Le superutilisateur de l'instance : ni le rôle applicatif, ni le propriétaire des tables. */
  const asSuperuser = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withAdmin(work, database.name);

  let sequence = 0;
  async function insertUser(db: pg.Client): Promise<string> {
    sequence += 1;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, country_code, registered_at, status, email_verified_at)
       VALUES ($1, 'CD', now(), 'ACTIVE', now()) RETURNING id`,
      [`entry-kinds${String(sequence)}@example.cd`],
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

  /** Une écriture entière de type `kind` : son en-tête, puis ses lignes. */
  const entry = async (
    db: pg.Client,
    kind: string,
    lines: readonly SqlPosting[],
  ): Promise<void> => {
    const entryId = await insertEntryHeader(db, lines.length, { kind });
    await insertPostings(db, entryId, lines);
  };

  /**
   * Un titulaire actif et son compte « fonds disponibles » en dollars, crédité de `units` par
   * la seule voie du produit : un ajustement demandé par l'un, approuvé par l'autre.
   */
  async function holderWith(db: pg.Client, units = 0): Promise<Holder> {
    const user = await insertUser(db);
    const account = await openLedgerAccount(db, 'user_available', 'USD', user);
    if (units > 0) {
      const adjustment = await insertAdjustmentRow(db, {
        user_id: user,
        requested_by: admin,
        amount: units,
      });
      await approveInSql(db, adjustment, second, {
        direction: 'CREDIT',
        holderAccount: account,
        custodyAccount: custody,
        amount: units,
      });
    }
    return { user, account };
  }

  const balanceOf = async (db: pg.Client, account: string): Promise<string> =>
    (await accountState(db, account)).balance;

  const knownKinds = async (db: pg.Client): Promise<string[]> =>
    (await db.query<{ key: string }>(`SELECT key FROM ledger_entry_kinds`)).rows
      .map(({ key }) => key)
      .sort();

  describe('la liste', () => {
    it('est celle de @mgx/contracts : les types des opérations du produit, et eux seuls', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; description: string }>(
          `SELECT key, description FROM ledger_entry_kinds`,
        );
        const byKey = (left: { key: string }, right: { key: string }): number =>
          left.key < right.key ? -1 : 1;
        expect([...rows].sort(byKey)).toEqual(
          Object.entries(LEDGER_ENTRY_KINDS)
            .map(([key, kind]) => ({ key, ...kind }))
            .sort(byKey),
        );
        expect(await knownKinds(db)).toEqual([
          'adjustment.credit',
          'adjustment.debit',
          'transfer.internal',
        ]);
      });
    });

    it('chacun de ses types a sa règle : un contrôle de fin de transaction le nomme, et n’en nomme pas d’autre', async () => {
      await asApp(async (db) => {
        // Les contrôles différés posés sur l'en-tête des écritures, et la condition de chacun.
        const { rows } = await db.query<{ name: string; definition: string }>(
          `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
           FROM pg_trigger AS t
           WHERE t.tgrelid = 'ledger_entries'::regclass
             AND NOT t.tgisinternal AND t.tgdeferrable AND t.tginitdeferred
           ORDER BY t.tgname`,
        );
        const named = new Map<string, string[]>();
        for (const { name, definition } of rows) {
          const condition = /WHEN \((.*)\) EXECUTE FUNCTION/.exec(definition)?.[1] ?? '';
          named.set(name, [...condition.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort());
        }
        expect(Object.fromEntries(named)).toEqual({
          ledger_entries_adjustment_recorded: ['adjustment.credit', 'adjustment.debit'],
          // Celui-ci vaut pour toute écriture : entière et équilibrée.
          ledger_entries_sound: [],
          ledger_entries_transfer_recorded: ['transfer.internal'],
        });
        // Un type connu sans règle rouvrirait le chemin ; une règle pour un type inconnu ne
        // servirait à rien.
        expect([...named.values()].flat().sort()).toEqual(await knownKinds(db));
      });
    });

    it('elle ne change que par migration : le rôle applicatif ne fait que la lire', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ privileges: string[] }>(
          `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_name = 'ledger_entry_kinds'`,
          [TEST_APP_ROLE],
        );
        expect(rows[0]!.privileges).toEqual(['SELECT']);
        for (const statement of [
          `INSERT INTO ledger_entry_kinds (key, description) VALUES ('test.deposit', 'A deposit.')`,
          `UPDATE ledger_entry_kinds SET description = 'Anything.'`,
          `DELETE FROM ledger_entry_kinds`,
          `TRUNCATE ledger_entry_kinds`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: INSUFFICIENT_PRIVILEGE,
          });
        }
        expect(await knownKinds(db)).toHaveLength(3);
      });
    });

    it('le droit d’y écrire lui serait-il rendu, le rôle applicatif n’y ajoute rien : seul le propriétaire des tables le fait', async () => {
      const register = (db: pg.Client): Promise<string | undefined> =>
        refusal(db, () =>
          db.query(
            `INSERT INTO ledger_entry_kinds (key, description)
             VALUES ('test.deposit', 'A deposit.')`,
          ),
        );
      await asOwner((db) => db.query(`GRANT INSERT ON ledger_entry_kinds TO ${TEST_APP_ROLE}`));
      try {
        expect(await asApp(register)).toMatch(OWNER_ONLY);
        // Une table temporaire de même nom, dont le rôle applicatif est propriétaire, n'en fait
        // pas le propriétaire de la liste.
        await asApp(async (db) => {
          await db.query(`CREATE TEMP TABLE ledger_entry_kinds (LIKE public.ledger_entry_kinds)`);
          expect(
            await refusal(db, () =>
              db.query(
                `INSERT INTO public.ledger_entry_kinds (key, description)
                 VALUES ('test.deposit', 'A deposit.')`,
              ),
            ),
          ).toMatch(OWNER_ONLY);
          await db.query(`SET search_path = pg_temp, public`);
          try {
            expect(
              await refusal(db, () =>
                db.query(
                  `INSERT INTO public.ledger_entry_kinds (key, description)
                   VALUES ('test.deposit', 'A deposit.')`,
                ),
              ),
            ).toMatch(OWNER_ONLY);
          } finally {
            await db.query(`RESET search_path`);
          }
        });
      } finally {
        await asOwner((db) =>
          db.query(`REVOKE INSERT ON ledger_entry_kinds FROM ${TEST_APP_ROLE}`),
        );
      }
      // Le superutilisateur lui-même n'est pas le propriétaire : il lui faut en prendre le rôle.
      await asSuperuser(async (db) => {
        expect(await register(db)).toMatch(OWNER_ONLY);
        await db.query(`SET ROLE ${TEST_OWNER_ROLE}`);
        expect(await register(db)).toBeUndefined();
      });
      expect(await asOwner(register)).toBeUndefined();
      expect(await asApp(knownKinds)).toHaveLength(3);
    });

    it('un type ne se modifie ni ne se retire, même par le propriétaire — qui peut en ajouter', async () => {
      await asOwner(async (db) => {
        for (const statement of [
          `UPDATE ledger_entry_kinds SET description = 'Anything.' WHERE key = 'adjustment.credit'`,
          `UPDATE ledger_entry_kinds SET key = 'adjustment.gift' WHERE key = 'adjustment.credit'`,
          `DELETE FROM ledger_entry_kinds WHERE key = 'transfer.internal'`,
          `TRUNCATE ledger_entry_kinds`,
        ]) {
          expect({ statement, outcome: await attempt(db, () => db.query(statement)) }).toEqual({
            statement,
            outcome: FORBIDDEN_MUTATION,
          });
        }
        const added = (key: string): Promise<string | undefined> =>
          attempt(db, () =>
            db.query(
              `INSERT INTO ledger_entry_kinds (key, description) VALUES ($1, 'A new operation.')`,
              [key],
            ),
          );
        // Le format est celui du type d'une écriture.
        for (const key of ['deposit', 'deposit.mobile_money', 'a1.b_2.c', 'a'.repeat(64)]) {
          expect({ key, outcome: await added(key) }).toEqual({ key, outcome: undefined });
        }
        for (const key of [
          '',
          'Deposit',
          'deposit.',
          '.deposit',
          'deposit..bank',
          'deposit-bank',
          'deposit bank',
          'deposit.1bank',
          '1deposit',
          'deposit.bank\n',
        ]) {
          expect({ key, outcome: await added(key) }).toEqual({ key, outcome: CHECK_VIOLATION });
        }
        expect(await added('a'.repeat(65))).toBe(STRING_TOO_LONG);
        expect(await added('transfer.internal')).toBe(UNIQUE_VIOLATION);
        expect(await knownKinds(db)).toHaveLength(3);
      });
    });
  });

  describe('une écriture d’un type que la base ne connaît pas', () => {
    it('est refusée dès son en-tête, quel que soit le rôle qui l’écrit et l’auteur qu’elle désigne', async () => {
      const actors = [
        { actor_type: 'SYSTEM' },
        { actor_type: 'USER', actor_id: admin },
        { actor_type: 'SERVICE', actor_id: 'bank-x' },
      ];
      for (const connected of [asApp, asOwner, asSuperuser]) {
        await connected(async (db) => {
          for (const actor of actors) {
            expect({
              actor,
              outcome: await refusal(db, () =>
                insertEntryHeader(db, 2, { kind: 'test.deposit', ...actor }),
              ),
            }).toEqual({ actor, outcome: expect.stringMatching(UNKNOWN_KIND('test.deposit')) });
          }
        });
      }
      // Témoin : sous chacun de ces auteurs, un en-tête d'un type connu est accepté.
      await asApp(async (db) => {
        for (const actor of actors) {
          expect({
            actor,
            outcome: await refusal(db, () =>
              insertEntryHeader(db, 2, { kind: 'transfer.internal', ...actor }),
            ),
          }).toEqual({ actor, outcome: undefined });
        }
      });
    });

    it('elle ne crédite pas un portefeuille depuis le compte de conservation', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        const before = await ledgerSize(db);

        // Équilibrée, entière, sans solde négatif : rien d'autre ne s'y opposait jusqu'ici.
        expect(
          await refusal(db, () =>
            entry(db, 'test.deposit', [
              { account: custody, side: 'DEBIT', amount: 500 },
              { account: holder.account, side: 'CREDIT', amount: 500 },
            ]),
          ),
        ).toMatch(UNKNOWN_KIND('test.deposit'));

        expect(await balanceOf(db, holder.account)).toBe('0');
        expect(await ledgerSize(db)).toEqual(before);
      });
    });

    it('elle ne déplace pas de fonds d’un portefeuille à un autre, ni vers le compte de conservation', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 500);
        const bob = await holderWith(db);
        const before = await ledgerSize(db);
        const custodyBefore = await balanceOf(db, custody);

        // Hors des règles d'un transfert : ni niveau de vérification, ni plafond.
        expect(
          await refusal(db, () =>
            entry(db, 'test.transfer', [
              { account: alice.account, side: 'DEBIT', amount: 200 },
              { account: bob.account, side: 'CREDIT', amount: 200 },
            ]),
          ),
        ).toMatch(UNKNOWN_KIND('test.transfer'));
        expect(
          await refusal(db, () =>
            entry(db, 'test.withdrawal', [
              { account: alice.account, side: 'DEBIT', amount: 200 },
              { account: custody, side: 'CREDIT', amount: 200 },
            ]),
          ),
        ).toMatch(UNKNOWN_KIND('test.withdrawal'));

        expect(await balanceOf(db, alice.account)).toBe('500');
        expect(await balanceOf(db, bob.account)).toBe('0');
        expect(await balanceOf(db, custody)).toBe(custodyBefore);
        expect(await ledgerSize(db)).toEqual(before);
      });
    });

    it('un type voisin d’un type connu n’est pas ce type', async () => {
      await asApp(async (db) => {
        for (const kind of [
          'transfer',
          'internal',
          'transfer.internal.x',
          'transfer.internalx',
          'transfer.interna',
          'xtransfer.internal',
          'adjustment',
          'adjustment.credit.x',
          'adjustment.creditx',
          'adjustment.debi',
          'adjustment.gift',
          'deposit',
          'test.entry',
        ]) {
          expect({
            kind,
            outcome: await refusal(db, () => insertEntryHeader(db, 2, { kind })),
          }).toEqual({ kind, outcome: expect.stringMatching(UNKNOWN_KIND(kind)) });
        }
      });
    });

    it('un type mal formé est refusé pour sa forme, avant de l’être pour inconnu', async () => {
      await asApp(async (db) => {
        for (const kind of [
          'Transfer.internal',
          'TRANSFER.INTERNAL',
          'transfer.internal ',
          ' transfer.internal',
          'transfer..internal',
          'transfer.internal\n',
        ]) {
          expect({
            kind,
            outcome: await refusal(db, () => insertEntryHeader(db, 2, { kind })),
          }).toEqual({ kind, outcome: expect.stringMatching(KIND_FORMAT) });
        }
      });
    });

    it('une table homonyme placée sur le chemin de recherche ne fait connaître aucun type', async () => {
      await asApp(async (db) => {
        const holder = await holderWith(db);
        // Une table temporaire de même nom, où le type d'essai figure.
        await db.query(
          `CREATE TEMP TABLE ledger_entry_kinds AS
             SELECT 'test.deposit'::varchar AS key, 'A deposit.'::varchar AS description`,
        );
        await db.query(`SET search_path = pg_temp, public`);
        try {
          expect(
            await refusal(db, async () => {
              const { rows } = await db.query<{ id: string }>(
                `INSERT INTO public.ledger_entries
                   (idempotency_key, kind, posting_count, actor_type)
                 VALUES ('test:search-path-kind', 'test.deposit', 2, 'SYSTEM') RETURNING id`,
              );
              await db.query(
                `INSERT INTO public.ledger_postings
                   (entry_id, line_number, account_id, asset_code, side, amount, account_sequence,
                    balance_after)
                 VALUES ($1, 1, $2, 'USD', 'DEBIT', 10, 0, 0), ($1, 2, $3, 'USD', 'CREDIT', 10, 0, 0)`,
                [rows[0]!.id, custody, holder.account],
              );
            }),
          ).toMatch(UNKNOWN_KIND('test.deposit'));
        } finally {
          await db.query(`RESET search_path`);
        }
        expect(await balanceOf(db, holder.account)).toBe('0');
      });
    });

    it('les règles de la liste ne résolvent les noms que dans le schéma de l’application', async () => {
      await asOwner(async (db) => {
        const { rows } = await db.query<{ proname: string; proconfig: string[] | null }>(
          `SELECT proname, proconfig FROM pg_proc
           WHERE proname IN ('mgx_enforce_ledger_entry_kind', 'mgx_check_ledger_entry_kind')
           ORDER BY proname`,
        );
        expect(rows).toEqual([
          { proname: 'mgx_check_ledger_entry_kind', proconfig: ['search_path=public, pg_temp'] },
          { proname: 'mgx_enforce_ledger_entry_kind', proconfig: ['search_path=public, pg_temp'] },
        ]);
      });
    });
  });

  describe('une écriture d’un type connu', () => {
    it('passe la liste, et reste tenue par la règle de son opération', async () => {
      await asApp(async (db) => {
        const alice = await holderWith(db, 500);
        const bob = await holderWith(db);
        const before = await ledgerSize(db);

        // Un transfert sans sa ligne de transfert ; un ajustement sans son ajustement approuvé.
        expect(
          await commitOf(db, () =>
            entry(db, 'transfer.internal', [
              { account: alice.account, side: 'DEBIT', amount: 200 },
              { account: bob.account, side: 'CREDIT', amount: 200 },
            ]),
          ),
        ).toMatch(TRANSFER_ENTRY_WITHOUT_TRANSFER);
        expect(
          await commitOf(db, () =>
            entry(db, 'adjustment.credit', [
              { account: custody, side: 'DEBIT', amount: 200 },
              { account: bob.account, side: 'CREDIT', amount: 200 },
            ]),
          ),
        ).toMatch(ADJUSTMENT_ENTRY_WITHOUT_ADJUSTMENT);
        expect(
          await commitOf(db, () =>
            entry(db, 'adjustment.debit', [
              { account: alice.account, side: 'DEBIT', amount: 200 },
              { account: custody, side: 'CREDIT', amount: 200 },
            ]),
          ),
        ).toMatch(ADJUSTMENT_ENTRY_WITHOUT_ADJUSTMENT);

        expect(await balanceOf(db, alice.account)).toBe('500');
        expect(await balanceOf(db, bob.account)).toBe('0');
        expect(await ledgerSize(db)).toEqual(before);
      });
    });

    it('ne change pas de type après coup : le contrôle de l’en-tête ne se contourne pas par une modification', async () => {
      // La liste n'est consultée qu'à l'écriture de l'en-tête. Cela ne vaut que parce qu'une
      // écriture ne se modifie pas — pas même dans la transaction qui l'écrit.
      const retyped = (db: pg.Client): Promise<string | undefined> =>
        attempt(db, async () => {
          const entryId = await insertEntryHeader(db, 2, { kind: 'transfer.internal' });
          await db.query(`UPDATE ledger_entries SET kind = 'test.deposit' WHERE id = $1`, [
            entryId,
          ]);
        });
      expect(await asApp(retyped)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asOwner(retyped)).toBe(FORBIDDEN_MUTATION);
      expect(await asSuperuser(retyped)).toBe(FORBIDDEN_MUTATION);
    });

    it('un ajustement approuvé et un transfert passent, sans qu’aucun type d’essai soit déclaré', async () => {
      await asApp(async (db) => {
        const before = await ledgerSize(db);
        // Un crédit de 500 ; un transfert de 200 ; un débit de 300.
        const alice = await holderWith(db, 500);
        const bob = await holderWith(db);
        // Les plafonds de l'actif sont fixés pour le niveau 1 : les deux parties y sont portées.
        await verifyUpTo(db, alice.user, 1, admin);
        await verifyUpTo(db, bob.user, 1, admin);
        await transferInSql(db, {
          sender: alice.user,
          senderAccount: alice.account,
          recipient: bob.user,
          recipientAccount: bob.account,
          amount: 200,
        });
        const debit = await insertAdjustmentRow(db, {
          user_id: alice.user,
          requested_by: second,
          direction: 'DEBIT',
          amount: 300,
        });
        await approveInSql(db, debit, admin, {
          direction: 'DEBIT',
          holderAccount: alice.account,
          custodyAccount: custody,
          amount: 300,
        });

        expect(await balanceOf(db, alice.account)).toBe('0');
        expect(await balanceOf(db, bob.account)).toBe('200');
        expect(await ledgerSize(db)).toEqual({
          entries: before.entries + 3,
          postings: before.postings + 6,
        });
        // Tout ce que le grand livre contient est d'un type connu.
        const { rows } = await db.query<{ kind: string }>(
          `SELECT DISTINCT kind FROM ledger_entries ORDER BY kind`,
        );
        expect(rows.map(({ kind }) => kind)).toEqual(await knownKinds(db));
      });
    });
  });

  describe('étendre la liste', () => {
    it('un type déclaré par le propriétaire est connu aussitôt — sans règle qui le lie à une opération, il rouvre le chemin', async () => {
      const holder = await asApp((db) => holderWith(db));
      await asOwner(async (db) => {
        await db.query('BEGIN');
        try {
          await registerEntryKindsInSql(db, ['test.deposit']);
          await entry(db, 'test.deposit', [
            { account: custody, side: 'DEBIT', amount: 500 },
            { account: holder.account, side: 'CREDIT', amount: 500 },
          ]);
          // Les contrôles de fin de transaction, demandés sans attendre : aucun ne s'y oppose.
          await db.query('SET CONSTRAINTS ALL IMMEDIATE');
          expect(await balanceOf(db, holder.account)).toBe('500');
        } finally {
          await db.query('ROLLBACK');
        }
      });
      // La déclaration annulée, la base ne connaît pas davantage ce type.
      await asApp(async (db) => {
        expect(await knownKinds(db)).toHaveLength(3);
        expect(await balanceOf(db, holder.account)).toBe('0');
        expect(await refusal(db, () => insertEntryHeader(db, 2, { kind: 'test.deposit' }))).toMatch(
          UNKNOWN_KIND('test.deposit'),
        );
      });
    });
  });
});
