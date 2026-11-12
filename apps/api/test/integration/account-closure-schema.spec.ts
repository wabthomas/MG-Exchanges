import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  ageClosure,
  closeAccountInSql,
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
  TABLES_EMPTIED_AT_CLOSURE,
} from '../support/account-closure.js';
import {
  approve,
  completeDraft,
  insertCase,
  reject,
  revoke,
  submitted,
} from '../support/kyc-sql.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE } from '../support/test-environment.js';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Règle du parcours d'un dossier de vérification enfreinte (migration kyc). */
const KYC_RULE_VIOLATION = 'MGX03';
/** Règle de clôture d'un compte enfreinte (migration account_closure). */
const CLOSURE_RULE_VIOLATION = 'MGX04';
/** Écriture visant un compte clôturé (migration account_closure). */
const ACCOUNT_CLOSED = 'MGX05';

const ARGON2_HASH = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${'A'.repeat(43)}`;
const UNKNOWN_ACCOUNT = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

/** Une ligne valide de chacune des tables où rien ne s'ajoute à un compte clôturé. */
const ROWS: Record<string, (db: pg.Client, userId: string) => Promise<unknown>> = {
  user_credentials: (db, userId) =>
    db.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
      userId,
      ARGON2_HASH,
    ]),
  user_totp_credentials: (db, userId) =>
    db.query(`INSERT INTO user_totp_credentials (user_id, secret_ciphertext) VALUES ($1, $2)`, [
      userId,
      Buffer.concat([Buffer.from([1]), randomBytes(48)]),
    ]),
  user_recovery_codes: (db, userId) =>
    db.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
      userId,
      randomBytes(32),
    ]),
  user_sessions: (db, userId) =>
    db.query(
      `INSERT INTO user_sessions (user_id, idle_expires_at, expires_at)
       VALUES ($1, now() + interval '1 day', now() + interval '2 days')`,
      [userId],
    ),
  verification_challenges: (db, userId) =>
    db.query(
      `INSERT INTO verification_challenges (user_id, purpose, target, max_attempts, expires_at)
       VALUES ($1, 'PASSWORD_RESET', 'someone@example.cd', 5, now() + interval '15 minutes')`,
      [userId],
    ),
  user_profiles: (db, userId) =>
    db.query(
      `INSERT INTO user_profiles (user_id, given_name, updated_at) VALUES ($1, 'Jean', now())`,
      [userId],
    ),
  // Écrit par le propriétaire du schéma, comme le fait l'outil d'amorçage.
  user_roles: (db, userId) =>
    db.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'support'`,
      [userId],
    ),
  kyc_cases: (db, userId) => insertCase(db, userId, 1),
};

describe('Clôture d’un compte — règles portées par la base de données', () => {
  let database: TestDatabase;
  /** Agents créés une fois : conformité (deux), support, administrateur. */
  let claire: string;
  let david: string;
  let support: string;
  let admin: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      claire = await insertStaff(db, 'compliance');
      david = await insertStaff(db, 'compliance');
      support = await insertStaff(db, 'support');
      admin = await insertStaff(db, 'super_admin');
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
      email: `closure${String(sequence)}@example.cd`,
      country_code: 'CD',
      terms_accepted_at: new Date(),
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

  /** Code de l'erreur levée à la validation d'une transaction qui a exécuté `work`. */
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
    const state = await sqlState(() => db.query('COMMIT'));
    if (state !== undefined) {
      await db.query('ROLLBACK');
    }
    return state;
  }

  const accountOf = async (db: pg.Client, id: string) =>
    (
      await db.query<{
        status: string;
        email: string;
        phone: string | null;
        email_verified_at: Date | null;
      }>('SELECT status, email, phone, email_verified_at FROM users WHERE id = $1', [id])
    ).rows[0]!;

  const closureOf = async (db: pg.Client, id: string) =>
    (
      await db.query<{
        origin: string;
        closed_by: string;
        email: string | null;
        phone: string | null;
        legal_retention_until: Date | null;
        erasure_due_at: Date;
        erased_at: Date | null;
      }>(
        `SELECT origin, closed_by, email, phone, legal_retention_until, erasure_due_at, erased_at
         FROM account_closures WHERE user_id = $1`,
        [id],
      )
    ).rows[0];

  const count = async (db: pg.Client, table: string, userId: string): Promise<number> =>
    (
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
        userId,
      ])
    ).rows[0]!.n;

  /** Écrit la trace d'une clôture avec les colonnes données (les autres : valides). */
  function insertRecord(
    db: pg.Client,
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<unknown> {
    const row: Record<string, unknown> = {
      user_id: userId,
      closed_at: new Date(),
      origin: 'HOLDER',
      closed_by: userId,
      legal_retention_until: null,
      erasure_due_at: new Date(Date.now() + 30 * 86_400_000),
      ...overrides,
    };
    const columns = Object.keys(row);
    const values = columns.map((_, index) => `$${String(index + 1)}`);
    // L'adresse et le numéro sont ceux du compte, sauf mention contraire.
    const identifiers = ['email', 'phone'].filter((column) => !(column in row));
    return db.query(
      `INSERT INTO account_closures (${[...columns, ...identifiers].join(', ')})
       SELECT ${[...values, ...identifiers.map((column) => `u.${column}`)].join(', ')}
       FROM users u WHERE u.id = $1`,
      Object.values(row),
    );
  }

  describe('clôture : une trace, puis un compte sans identifiant', () => {
    it('la clôture garde l’adresse et le numéro dans sa trace, et n’en laisse aucun au compte', async () => {
      await asApp(async (db) => {
        const phone = '+243990001001';
        const user = await insertUser(db, { phone, phone_verified_at: new Date() });
        const { email } = await accountOf(db, user);
        for (const [table, insert] of Object.entries(ROWS)) {
          if ((TABLES_EMPTIED_AT_CLOSURE as readonly string[]).includes(table)) {
            await insert(db, user);
          }
        }

        await closeAccountInSql(db, user);

        expect(await accountOf(db, user)).toEqual({
          status: 'CLOSED',
          email: `closed-${user}@closed.invalid`,
          phone: null,
          email_verified_at: null,
        });
        expect(await closureOf(db, user)).toMatchObject({
          origin: 'HOLDER',
          closed_by: user,
          email,
          phone,
          legal_retention_until: null,
          erased_at: null,
        });
        for (const table of TABLES_EMPTIED_AT_CLOSURE) {
          expect({ table, rows: await count(db, table, user) }).toEqual({ table, rows: 0 });
        }

        // L'adresse et le numéro sont libres : un nouveau compte les prend aussitôt.
        const successor = await insertUser(db, { email, phone, phone_verified_at: new Date() });
        expect(successor).not.toBe(user);
        // Et ce compte peut à son tour être clôturé : deux traces portent la même adresse.
        await closeAccountInSql(db, successor);
        expect((await closureOf(db, successor))?.email).toBe(email);
      });
    });

    it('un compte ne se clôt pas sans sa trace, ne naît pas clôturé, et sa trace ne reste pas sans clôture', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        expect(await attempt(db, () => markAccountClosed(db, user))).toBe(CLOSURE_RULE_VIOLATION);
        expect(await sqlState(() => insertUser(db, { status: 'CLOSED' }))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        // La trace seule : refusée à la validation de la transaction.
        expect(await commitOf(db, () => insertClosureRecord(db, user))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        expect(await closureOf(db, user)).toBeUndefined();
        expect((await accountOf(db, user)).status).toBe('ACTIVE');
      });
    });

    it('seul un compte actif ou suspendu se clôt, une seule fois', async () => {
      await asApp(async (db) => {
        const pending = await insertUser(db, {
          status: 'PENDING_VERIFICATION',
          email_verified_at: null,
        });
        expect(await attempt(db, () => insertClosureRecord(db, pending))).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        expect(await attempt(db, () => insertRecord(db, UNKNOWN_ACCOUNT))).toBeUndefined();

        // Même avec sa trace, un compte qui n'est plus actif ni suspendu ne se clôt pas.
        const reverted = await insertUser(db);
        await db.query('BEGIN');
        try {
          await insertClosureRecord(db, reverted);
          await db.query(`UPDATE users SET status = 'PENDING_VERIFICATION' WHERE id = $1`, [
            reverted,
          ]);
          expect(await sqlState(() => markAccountClosed(db, reverted))).toBe(
            CLOSURE_RULE_VIOLATION,
          );
        } finally {
          await db.query('ROLLBACK');
        }

        const suspended = await insertUser(db, { status: 'SUSPENDED' });
        await closeAccountInSql(db, suspended);
        expect((await accountOf(db, suspended)).status).toBe('CLOSED');
        // Déjà clôturé : ni seconde trace, ni seconde clôture.
        expect(await attempt(db, () => insertRecord(db, suspended))).toBe(CLOSURE_RULE_VIOLATION);
      });
    });

    it.each(TABLES_EMPTIED_AT_CLOSURE.map((table) => [table] as const))(
      'un compte qui garde une ligne de %s ne se clôt pas',
      async (table) => {
        await asApp(async (db) => {
          const user = await insertUser(db);
          await ROWS[table]!(db, user);
          await db.query('BEGIN');
          try {
            await insertClosureRecord(db, user);
            expect(await sqlState(() => markAccountClosed(db, user))).toBe(CLOSURE_RULE_VIOLATION);
          } finally {
            await db.query('ROLLBACK');
          }
          expect((await accountOf(db, user)).status).toBe('ACTIVE');
        });
      },
    );

    it('un compte qui détient un rôle ne se clôt pas : le rôle lui est d’abord retiré', async () => {
      const agent = await asOwner((owner) => insertStaff(owner, 'support'));
      await asApp(async (db) => {
        await db.query('BEGIN');
        try {
          await insertClosureRecord(db, agent);
          expect(await sqlState(() => markAccountClosed(db, agent))).toBe(CLOSURE_RULE_VIOLATION);
        } finally {
          await db.query('ROLLBACK');
        }
      });
      await asOwner((owner) => owner.query('DELETE FROM user_roles WHERE user_id = $1', [agent]));
      await asApp(async (db) => {
        await closeAccountInSql(db, agent);
        expect((await accountOf(db, agent)).status).toBe('CLOSED');
      });
    });

    it('clôturé, un compte ne porte que son adresse factice — et nul autre ne s’inscrit dans ce domaine', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db, { phone: '+243990001002' });
        const close = (assignments: string) =>
          attempt(db, async () => {
            await insertClosureRecord(db, user);
            await db.query(`UPDATE users SET status = 'CLOSED', ${assignments} WHERE id = $1`, [
              user,
            ]);
          });
        const anonymous = `email = 'closed-' || id::text || '@closed.invalid'`;

        // Chaque identifiant laissé au compte est refusé.
        expect(await close(`email_verified_at = NULL, phone = NULL`)).toBe(CHECK_VIOLATION);
        expect(await close(`${anonymous}, phone = NULL`)).toBe(CHECK_VIOLATION);
        expect(await close(`${anonymous}, email_verified_at = NULL`)).toBe(CHECK_VIOLATION);
        expect(
          await close(
            `${anonymous}, email_verified_at = NULL, phone = NULL, phone_verified_at = now()`,
          ),
        ).toBe(CHECK_VIOLATION);
        // L'adresse factice d'un autre compte n'est pas la sienne.
        expect(
          await close(
            `email = 'closed-${UNKNOWN_ACCOUNT}@closed.invalid', email_verified_at = NULL, phone = NULL`,
          ),
        ).toBe(CHECK_VIOLATION);
        expect(await close(`${anonymous}, email_verified_at = NULL, phone = NULL`)).toBeUndefined();

        // Le domaine est réservé : un compte ouvert n'y prend pas d'adresse.
        expect(await sqlState(() => insertUser(db, { email: 'someone@closed.invalid' }))).toBe(
          CHECK_VIOLATION,
        );
        expect(
          await sqlState(() =>
            db.query(`UPDATE users SET email = $2 WHERE id = $1`, [
              user,
              `closed-${user}@closed.invalid`,
            ]),
          ),
        ).toBe(CHECK_VIOLATION);
      });
    });

    it('un compte clôturé ne change plus jamais, et ne se supprime pas', async () => {
      const user = await asApp(async (db) => {
        const id = await insertUser(db);
        await closeAccountInSql(db, id);
        return id;
      });
      for (const as of [asApp, asOwner]) {
        await as(async (db) => {
          for (const assignment of [
            `status = 'ACTIVE', email = 'back@example.cd'`,
            `status = 'SUSPENDED'`,
            `locale = 'en'`,
            `updated_at = now()`,
          ]) {
            expect({
              assignment,
              state: await sqlState(() =>
                db.query(`UPDATE users SET ${assignment} WHERE id = $1`, [user]),
              ),
            }).toEqual({ assignment, state: ACCOUNT_CLOSED });
          }
          expect(await sqlState(() => db.query('DELETE FROM users WHERE id = $1', [user]))).toBe(
            RESTRICT_VIOLATION,
          );
        });
      }
    });
  });

  describe('la trace d’une clôture', () => {
    it('porte l’adresse et le numéro du compte, n’est pas antidatée, et naît sans effacement', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db, { phone: '+243990001003' });
        const refused = (overrides: Record<string, unknown>) =>
          attempt(db, () => insertRecord(db, user, overrides));

        expect(await refused({ email: 'other@example.cd' })).toBe(CLOSURE_RULE_VIOLATION);
        expect(await refused({ phone: '+243990009999' })).toBe(CLOSURE_RULE_VIOLATION);
        expect(await refused({ phone: null })).toBe(CLOSURE_RULE_VIOLATION);
        expect(await refused({ email: null })).toBe(CLOSURE_RULE_VIOLATION);
        expect(await refused({ erased_at: new Date() })).toBe(CLOSURE_RULE_VIOLATION);
        expect(await refused({ erased_at: new Date(), email: null, phone: null })).toBe(
          CLOSURE_RULE_VIOLATION,
        );

        // Une clôture antidatée avancerait le terme de la conservation.
        const dated = (hoursAgo: number) => {
          const closedAt = new Date(Date.now() - hoursAgo * 3_600_000);
          return refused({
            closed_at: closedAt,
            erasure_due_at: new Date(closedAt.getTime() + 30 * 86_400_000),
          });
        };
        expect(await dated(25)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await dated(23)).toBeUndefined();

        // L'effacement suit la clôture, et jamais avant le terme de la conservation légale.
        const now = new Date();
        expect(await refused({ closed_at: now, erasure_due_at: now })).toBe(CHECK_VIOLATION);
        const tenYears = new Date(now.getTime() + 3653 * 86_400_000);
        expect(
          await refused({
            legal_retention_until: tenYears,
            erasure_due_at: new Date(tenYears.getTime() - 1000),
          }),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refused({ legal_retention_until: tenYears, erasure_due_at: tenYears }),
        ).toBeUndefined();
      });
    });

    it('le titulaire clôt son compte ; un membre du personnel actif et habilité, celui d’un autre', async () => {
      const suspendedOfficer = await asOwner(async (owner) => {
        const id = await insertStaff(owner, 'compliance');
        await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [id]);
        return id;
      });
      await asApp(async (db) => {
        const user = await insertUser(db);
        const other = await insertUser(db);
        const by = (origin: string, closedBy: string) =>
          attempt(db, () => insertRecord(db, user, { origin, closed_by: closedBy }));

        expect(await by('HOLDER', other)).toBe(CHECK_VIOLATION);
        expect(await by('HOLDER', claire)).toBe(CHECK_VIOLATION);
        // Un membre du personnel, même habilité, ne clôt pas ainsi son propre compte.
        expect(
          await attempt(db, () => insertRecord(db, claire, { origin: 'STAFF', closed_by: claire })),
        ).toBe(CHECK_VIOLATION);
        expect(await by('STAFF', user)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await by('STAFF', UNKNOWN_ACCOUNT)).toBe(CLOSURE_RULE_VIOLATION);
        // Sans rôle, avec un rôle qui ne détient pas users.close, ou suspendu : refusé.
        expect(await by('STAFF', other)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await by('STAFF', support)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await by('STAFF', suspendedOfficer)).toBe(CLOSURE_RULE_VIOLATION);
        expect(await by('STAFF', claire)).toBeUndefined();
        expect(await by('STAFF', admin)).toBeUndefined();

        await closeAccountInSql(db, user, { closedBy: david });
        expect(await closureOf(db, user)).toMatchObject({ origin: 'STAFF', closed_by: david });
      });
    });

    it('ne se supprime pas, ne se vide pas, et ne change qu’une fois : pour constater l’effacement', async () => {
      const user = await asApp(async (db) => {
        const id = await insertUser(db, { phone: '+243990001004' });
        await closeAccountInSql(db, id);
        return id;
      });

      await asApp(async (db) => {
        expect(
          await sqlState(() => db.query('DELETE FROM account_closures WHERE user_id = $1', [user])),
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect(await sqlState(() => db.query('TRUNCATE account_closures'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
      await asOwner(async (owner) => {
        expect(
          await sqlState(() =>
            owner.query('DELETE FROM account_closures WHERE user_id = $1', [user]),
          ),
        ).toBe(CLOSURE_RULE_VIOLATION);
        expect(await sqlState(() => owner.query('TRUNCATE account_closures'))).toBe(
          FORBIDDEN_MUTATION,
        );
      });

      await asApp(async (db) => {
        const update = (assignments: string) =>
          attempt(db, () =>
            db.query(`UPDATE account_closures SET ${assignments} WHERE user_id = $1`, [user]),
          );
        const erased = `erased_at = now(), email = NULL, phone = NULL`;

        // Rien d'autre que l'effacement ne s'écrit — et il emporte l'adresse et le numéro.
        for (const assignment of [
          `email = 'other@example.cd'`,
          `phone = NULL`,
          `closed_at = closed_at - interval '1 hour'`,
          `origin = 'STAFF', closed_by = '${claire}'`,
          `erasure_due_at = erasure_due_at - interval '1 day'`,
          `legal_retention_until = now() + interval '1 day'`,
          // Constater l'effacement ne permet de rien réécrire d'autre.
          `${erased}, closed_at = closed_at + interval '1 second'`,
          `${erased}, origin = 'STAFF', closed_by = '${claire}'`,
          // Chaque colonne compte pour elle-même : c'est la règle de la trace qui refuse, avant
          // même la contrainte qui lie l'origine à l'auteur.
          `${erased}, origin = 'STAFF'`,
          `${erased}, closed_by = '${claire}'`,
          `${erased}, erasure_due_at = now() + interval '40 days'`,
          `${erased}, legal_retention_until = now()`,
        ]) {
          expect({ assignment, state: await update(assignment) }).toEqual({
            assignment,
            state: CLOSURE_RULE_VIOLATION,
          });
        }
        expect(await update(`erased_at = now(), phone = NULL`)).toBe(CHECK_VIOLATION);
        expect(await update(`erased_at = now(), email = NULL`)).toBe(CHECK_VIOLATION);
        expect(
          await update(`erased_at = closed_at - interval '1 second', email = NULL, phone = NULL`),
        ).toBe(CHECK_VIOLATION);

        await db.query(`UPDATE account_closures SET ${erased} WHERE user_id = $1`, [user]);
        expect(await closureOf(db, user)).toMatchObject({ email: null, phone: null });
        expect((await closureOf(db, user))?.erased_at).toBeInstanceOf(Date);
        // Effacée, la trace ne change plus : ni retour en arrière, ni nouvelle date.
        expect(await update(`erased_at = NULL, email = 'back@example.cd'`)).toBe(
          CLOSURE_RULE_VIOLATION,
        );
        expect(await update(`erased_at = now()`)).toBe(CLOSURE_RULE_VIOLATION);
      });
    });

    it('le rôle applicatif n’a, sur la trace, que les privilèges dont il a besoin', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ privileges: string[] }>(
          `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_name = 'account_closures'`,
          [TEST_APP_ROLE],
        );
        expect(rows).toEqual([{ privileges: ['INSERT', 'SELECT', 'UPDATE'] }]);
      });
    });
  });

  describe('rien ne s’ajoute à un compte clôturé', () => {
    it.each(Object.keys(ROWS).map((table) => [table] as const))(
      '%s : l’écriture est refusée (MGX05) ; sur un compte inconnu, c’est la clé étrangère qui parle',
      async (table) => {
        const closed = await asApp(async (db) => {
          const id = await insertUser(db);
          await closeAccountInSql(db, id);
          return id;
        });
        const open = await asApp((db) => insertUser(db));
        // Les rôles ne s'écrivent directement qu'avec le rôle propriétaire.
        await (table === 'user_roles' ? asOwner : asApp)(async (db) => {
          expect(await sqlState(() => ROWS[table]!(db, closed))).toBe(ACCOUNT_CLOSED);
          expect(await sqlState(() => ROWS[table]!(db, UNKNOWN_ACCOUNT))).toBe(
            FOREIGN_KEY_VIOLATION,
          );
          // La même écriture sur un compte ouvert aboutit.
          expect(await sqlState(() => ROWS[table]!(db, open))).toBeUndefined();
          expect(await count(db, table, closed)).toBe(0);
        });
      },
    );
  });

  describe('écritures simultanées', () => {
    it('une session ouverte pendant la clôture attend son issue, puis est refusée', async () => {
      const user = await asApp((db) => insertUser(db));
      await asApp(async (closer) => {
        await asApp(async (login) => {
          await asApp(async (observer) => {
            await closer.query('BEGIN');
            await insertClosureRecord(closer, user);
            await emptyAccount(closer, user);

            // La clôture n'est pas validée : la connexion attend de savoir si elle aboutit.
            const session = sqlState(() => ROWS['user_sessions']!(login, user));
            await untilBlocked(observer);
            await markAccountClosed(closer, user);
            await closer.query('COMMIT');

            expect(await session).toBe(ACCOUNT_CLOSED);
            expect(await count(observer, 'user_sessions', user)).toBe(0);
            expect((await accountOf(observer, user)).status).toBe('CLOSED');
          });
        });
      });
    });

    it('la même clôture, annulée cette fois : la session s’ouvre', async () => {
      const user = await asApp((db) => insertUser(db));
      await asApp(async (closer) => {
        await asApp(async (login) => {
          await asApp(async (observer) => {
            await closer.query('BEGIN');
            await insertClosureRecord(closer, user);

            const session = sqlState(() => ROWS['user_sessions']!(login, user));
            await untilBlocked(observer);
            await closer.query('ROLLBACK');

            expect(await session).toBeUndefined();
            expect(await count(observer, 'user_sessions', user)).toBe(1);
            expect((await accountOf(observer, user)).status).toBe('ACTIVE');
          });
        });
      });
    });

    it('une clôture lancée pendant l’ouverture d’une session attend, puis l’emporte avec le reste', async () => {
      const user = await asApp((db) => insertUser(db));
      await asApp(async (login) => {
        await asApp(async (closer) => {
          await asApp(async (observer) => {
            await login.query('BEGIN');
            await ROWS['user_sessions']!(login, user);

            // La session n'est pas validée : la clôture attend, dès l'écriture de sa trace.
            const closure = sqlState(() => closeAccountInSql(closer, user));
            await untilBlocked(observer);
            await login.query('COMMIT');

            expect(await closure).toBeUndefined();
            expect(await count(observer, 'user_sessions', user)).toBe(0);
            expect((await accountOf(observer, user)).status).toBe('CLOSED');
          });
        });
      });
    });

    it('deux transactions qui ajoutent une ligne puis modifient le compte ne s’interbloquent pas', async () => {
      const user = await asApp((db) => insertUser(db));
      await asApp(async (first) => {
        await asApp(async (second) => {
          await asApp(async (observer) => {
            await first.query('BEGIN');
            await second.query('BEGIN');
            // Les deux ajouts passent sans s'attendre : le verrou pris sur le compte est partagé.
            await ROWS['user_sessions']!(first, user);
            await ROWS['user_sessions']!(second, user);

            // La première modification du compte n'attend pas l'autre transaction…
            await first.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [user]);
            // … et la seconde attend seulement que la première soit validée.
            const update = sqlState(() =>
              second.query(`UPDATE users SET locale = 'fr' WHERE id = $1`, [user]),
            );
            await untilBlocked(observer);
            await first.query('COMMIT');
            expect(await update).toBeUndefined();
            await second.query('COMMIT');

            expect(await count(observer, 'user_sessions', user)).toBe(2);
          });
        });
      });
    });
  });

  describe('conservation légale des dossiers de vérification', () => {
    const TEN_YEARS = `((now() AT TIME ZONE 'UTC') + INTERVAL '10 years') AT TIME ZONE 'UTC'`;

    /** Compte dont un dossier de niveau 1 a reçu la décision donnée. */
    async function withDecidedCase(
      db: pg.Client,
      decision: 'APPROVED' | 'REJECTED' | 'REVOKED' | 'SUPERSEDED',
    ): Promise<{ user: string; caseId: string }> {
      const user = await insertUser(db);
      const caseId = await submitted(db, user, 1);
      if (decision === 'REJECTED') {
        await reject(db, caseId, claire);
        return { user, caseId };
      }
      await approve(db, caseId, claire);
      if (decision === 'REVOKED') {
        await revoke(db, caseId, david);
      }
      if (decision === 'SUPERSEDED') {
        await approve(db, await submitted(db, user, 1), david);
      }
      return { user, caseId };
    }

    it.each([['APPROVED'], ['REJECTED'], ['REVOKED'], ['SUPERSEDED']] as const)(
      'un dossier %s impose dix ans de conservation après la clôture — pas un jour de moins',
      async (decision) => {
        await asApp(async (db) => {
          const { user, caseId } = await withDecidedCase(db, decision);
          const closing = (retention: string) =>
            attempt(db, () =>
              db.query(
                `INSERT INTO account_closures
                   (user_id, closed_at, origin, closed_by, email, phone, legal_retention_until, erasure_due_at)
                 SELECT id, now(), 'HOLDER', id, email, phone, ${retention},
                        GREATEST(now() + INTERVAL '30 days', ${retention})
                 FROM users WHERE id = $1`,
                [user],
              ),
            );

          expect(await closing('NULL::timestamptz')).toBe(CLOSURE_RULE_VIOLATION);
          expect(await closing(`${TEN_YEARS} - INTERVAL '1 second'`)).toBe(CLOSURE_RULE_VIOLATION);
          expect(await closing(`now() + INTERVAL '9 years 364 days'`)).toBe(CLOSURE_RULE_VIOLATION);
          expect(await closing(TEN_YEARS)).toBeUndefined();
          expect(await closing(`now() + INTERVAL '25 years'`)).toBeUndefined();

          await closeAccountInSql(db, user);
          const closure = await closureOf(db, user);
          expect(closure?.legal_retention_until).toBeInstanceOf(Date);
          expect(closure?.erasure_due_at).toEqual(closure?.legal_retention_until);
          // Le dossier accepté a pris fin avec le compte ; les autres n'ont pas changé.
          const { rows } = await db.query<{ status: string }>(
            'SELECT status FROM kyc_cases WHERE id = $1',
            [caseId],
          );
          expect(rows[0]?.status).toBe(decision === 'APPROVED' ? 'ACCOUNT_CLOSED' : decision);
        });
      },
    );

    it('un dossier jamais examiné n’impose rien : il s’efface avec la clôture', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        await completeDraft(db, user, 1);
        const other = await insertUser(db);
        await submitted(db, other, 1);

        for (const account of [user, other]) {
          await closeAccountInSql(db, account);
          expect((await closureOf(db, account))?.legal_retention_until).toBeNull();
          expect(await count(db, 'kyc_cases', account)).toBe(0);
        }
      });
    });

    it('les dix ans se comptent en UTC, quel que soit le fuseau de la session', async () => {
      await asApp(async (db) => {
        const { user } = await withDecidedCase(db, 'REJECTED');
        // Le 28 mars 2027 est en heure d'été à Amsterdam ; le 28 mars 2037 ne l'est pas encore.
        // Comptés dans ce fuseau, les dix ans tomberaient une heure plus tard qu'en UTC.
        await db.query(`SET TIME ZONE 'Europe/Amsterdam'`);
        const closing = (retention: string) =>
          attempt(db, () =>
            insertRecord(db, user, {
              closed_at: '2027-03-28T10:30:00Z',
              legal_retention_until: retention,
              erasure_due_at: '2037-03-28T12:00:00Z',
            }),
          );
        expect(await closing('2037-03-28T10:29:59Z')).toBe(CLOSURE_RULE_VIOLATION);
        expect(await closing('2037-03-28T10:30:00Z')).toBeUndefined();
        await db.query(`RESET TIME ZONE`);
      });
    });

    it('avant le terme, lu à l’horloge de la base, ni les dossiers ni la trace ne s’effacent', async () => {
      const { user, caseId } = await asApp(async (db) => {
        const account = await withDecidedCase(db, 'APPROVED');
        await closeAccountInSql(db, account.user);
        return account;
      });
      const eraseCase = async (db: pg.Client) => {
        await db.query('DELETE FROM kyc_documents WHERE case_id = $1', [caseId]);
        await db.query('DELETE FROM kyc_cases WHERE id = $1', [caseId]);
      };
      const markErased = (db: pg.Client) =>
        db.query(
          `UPDATE account_closures SET erased_at = now(), email = NULL, phone = NULL
           WHERE user_id = $1`,
          [user],
        );

      // Neuf ans et onze mois plus tard : toujours rien, pas même pour le propriétaire.
      await asOwner((owner) => ageClosure(owner, user, '9 years 11 months'));
      for (const as of [asApp, asOwner]) {
        await as(async (db) => {
          expect(await attempt(db, () => eraseCase(db))).toBe(KYC_RULE_VIOLATION);
          expect(
            await attempt(db, () => db.query('DELETE FROM kyc_cases WHERE id = $1', [caseId])),
          ).toBe(KYC_RULE_VIOLATION);
          expect(await attempt(db, () => markErased(db))).toBe(CLOSURE_RULE_VIOLATION);
        });
      }

      // Un autre compte, clôturé aujourd'hui : son terme à lui est dans dix ans.
      const later = await asApp(async (db) => {
        const account = await withDecidedCase(db, 'REJECTED');
        await closeAccountInSql(db, account.user);
        return account;
      });

      // Le terme passé : les pièces et le dossier d'abord, la trace ensuite.
      await asOwner((owner) => ageClosure(owner, user, '2 months'));
      await asApp(async (db) => {
        expect(await attempt(db, () => markErased(db))).toBe(CLOSURE_RULE_VIOLATION);
        await eraseCase(db);
        expect(await count(db, 'kyc_cases', user)).toBe(0);
        await markErased(db);
        expect(await closureOf(db, user)).toMatchObject({ email: null, phone: null });

        // Le terme échu d'un compte ne libère pas les dossiers d'un autre.
        expect(
          await attempt(db, async () => {
            await db.query('DELETE FROM kyc_documents WHERE case_id = $1', [later.caseId]);
            await db.query('DELETE FROM kyc_cases WHERE id = $1', [later.caseId]);
          }),
        ).toBe(KYC_RULE_VIOLATION);
        expect(await count(db, 'kyc_cases', later.user)).toBe(1);
      });
    });

    it('un terme légal vaut aussi sans dossier : la trace ne s’efface pas avant lui', async () => {
      // La base n'impose qu'un plancher : l'application peut retenir un terme pour une autre
      // raison que les dossiers de vérification. Il est respecté de la même façon.
      const user = await asApp(async (db) => {
        const id = await insertUser(db);
        await closeAccountInSql(db, id, {
          legalRetentionUntil: new Date(Date.now() + 400 * 86_400_000),
        });
        return id;
      });
      const markErased = (db: pg.Client) =>
        db.query(
          `UPDATE account_closures SET erased_at = now(), email = NULL, phone = NULL
           WHERE user_id = $1`,
          [user],
        );

      await asApp(async (db) => {
        expect((await closureOf(db, user))?.erasure_due_at).toEqual(
          (await closureOf(db, user))?.legal_retention_until,
        );
        expect(await attempt(db, () => markErased(db))).toBe(CLOSURE_RULE_VIOLATION);
      });
      await asOwner((owner) => ageClosure(owner, user, '401 days'));
      await asApp(async (db) => {
        await markErased(db);
        expect(await closureOf(db, user)).toMatchObject({ email: null });
      });
    });
  });

  describe('une clôture est entière', () => {
    it.each([
      ['en préparation', 'DRAFT'],
      ['en attente d’examen', 'SUBMITTED'],
      ['en vigueur', 'APPROVED'],
    ] as const)('un compte ne se clôt pas en gardant un dossier %s', async (_label, status) => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const caseId =
          status === 'DRAFT' ? await completeDraft(db, user, 1) : await submitted(db, user, 1);
        if (status === 'APPROVED') {
          await approve(db, caseId, claire);
        }

        // Tout est fait, sauf mettre fin aux dossiers : la validation est refusée.
        expect(
          await commitOf(db, async () => {
            await insertClosureRecord(db, user);
            await emptyAccount(db, user);
            await markAccountClosed(db, user);
          }),
        ).toBe(CLOSURE_RULE_VIOLATION);
        expect((await accountOf(db, user)).status).toBe('ACTIVE');
        expect(await closureOf(db, user)).toBeUndefined();

        expect(
          await commitOf(db, async () => {
            await insertClosureRecord(db, user);
            await emptyAccount(db, user);
            await markAccountClosed(db, user);
            await closeVerificationCases(db, user);
          }),
        ).toBeUndefined();
        expect((await accountOf(db, user)).status).toBe('CLOSED');
      });
    });
  });

  describe('dernier rempart : les contraintes', () => {
    it('même déclencheurs neutralisés, une trace ne porte ni adresse mal formée, ni numéro hors format, ni clôture sans adresse', async () => {
      await asOwner(async (owner) => {
        const user = await insertUser(owner, { phone: '+243990001005' });

        // Les déclencheurs ne sont neutralisés que dans cette transaction, annulée à la fin.
        await owner.query('BEGIN');
        try {
          await owner.query('ALTER TABLE account_closures DISABLE TRIGGER USER');
          const refused = async (overrides: Record<string, unknown>) => {
            await owner.query('SAVEPOINT attempt');
            const state = await sqlState(() => insertRecord(owner, user, overrides));
            await owner.query('ROLLBACK TO SAVEPOINT attempt');
            return state;
          };

          for (const email of [
            'Jean@Example.cd',
            ' jean@example.cd',
            'not an address',
            'a@b',
            '',
          ]) {
            expect({ email, state: await refused({ email }) }).toEqual({
              email,
              state: CHECK_VIOLATION,
            });
          }
          for (const phone of ['0812345678', '+0243812345678', '+24381', '243812345678']) {
            expect({ phone, state: await refused({ phone }) }).toEqual({
              phone,
              state: CHECK_VIOLATION,
            });
          }
          // Tant que rien n'est effacé, la trace garde l'adresse du compte.
          expect(await refused({ email: null })).toBe(CHECK_VIOLATION);
          expect(await refused({ email: null, phone: null })).toBe(CHECK_VIOLATION);
          // Les déclencheurs étaient bien neutralisés : ce qu'eux seuls interdisent passe.
          expect(await refused({ email: 'someone-else@example.cd' })).toBeUndefined();
          expect(await refused({ phone: null })).toBeUndefined();
        } finally {
          await owner.query('ROLLBACK');
        }

        // Transaction annulée : les déclencheurs sont de nouveau en place.
        expect(
          await attempt(owner, () =>
            insertRecord(owner, user, { email: 'someone-else@example.cd' }),
          ),
        ).toBe(CLOSURE_RULE_VIOLATION);
      });
    });
  });

  describe('robustesse des fonctions', () => {
    it('les règles ne résolvent les noms que dans le schéma de l’application', async () => {
      await asOwner(async (owner) => {
        const { rows } = await owner.query<{ proname: string; proconfig: string[] | null }>(
          `SELECT proname, proconfig FROM pg_proc
           WHERE proname IN ('mgx_enforce_user_closure', 'mgx_forbid_closed_account_rows',
                             'mgx_kyc_case_erasable', 'mgx_enforce_account_closure',
                             'mgx_check_closure_applied', 'mgx_enforce_kyc_case',
                             'mgx_enforce_kyc_document')
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

    it('une copie des tables placée sur le chemin de recherche ne rouvre pas un compte clôturé, ni n’habilite un intrus', async () => {
      await asApp(async (db) => {
        const closed = await insertUser(db);
        await closeAccountInSql(db, closed);
        const target = await insertUser(db);
        const intruder = await insertUser(db);

        // Dans son schéma temporaire : le compte clôturé y est actif, l'intrus y est habilité.
        await db.query(`CREATE TEMP TABLE users AS SELECT * FROM public.users`);
        await db.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [closed]);
        await db.query(
          `CREATE TEMP TABLE user_roles AS
           SELECT user_id, role_id, granted_by, granted_at FROM public.user_roles
           UNION ALL
           SELECT $1::uuid, id, NULL::uuid, now() FROM public.roles WHERE key = 'compliance'`,
          [intruder],
        );
        await db.query(`SET search_path = pg_temp, public`);

        expect(
          await sqlState(() =>
            db.query(
              `INSERT INTO public.user_sessions (user_id, idle_expires_at, expires_at)
               VALUES ($1, now() + interval '1 day', now() + interval '2 days')`,
              [closed],
            ),
          ),
        ).toBe(ACCOUNT_CLOSED);
        expect(
          await attempt(db, () =>
            db.query(
              `INSERT INTO public.account_closures
                 (user_id, closed_at, origin, closed_by, email, phone, erasure_due_at)
               SELECT id, now(), 'STAFF', $2, email, phone, now() + interval '30 days'
               FROM public.users WHERE id = $1`,
              [target, intruder],
            ),
          ),
        ).toBe(CLOSURE_RULE_VIOLATION);
        await db.query(`RESET search_path`);
      });
    });
  });
});
