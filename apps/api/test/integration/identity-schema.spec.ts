import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '@mgx/contracts';
import type pg from 'pg';

import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
/** Suppression refusée par une clé étrangère `ON DELETE RESTRICT`. */
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';

const ARGON2_HASH = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${'A'.repeat(43)}`;

describe('Identité — garanties portées par la base de données', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);

  let sequence = 0;
  const insertUser = async (
    db: pg.Client,
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    sequence += 1;
    const row = {
      email: `user${sequence}@example.cd`,
      country_code: 'CD',
      terms_accepted_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return result.rows[0]!.id;
  };

  describe('comptes', () => {
    it.each([
      ['adresse non normalisée', { email: 'Jean@Example.cd' }],
      ['adresse entourée d’espaces', { email: ' jean@example.cd' }],
      ['adresse sans domaine', { email: 'jean@' }],
      ['téléphone hors format E.164', { phone: '0812345678' }],
      ['code pays en minuscules', { country_code: 'cd' }],
      ['compte actif sans adresse vérifiée', { status: 'ACTIVE' }],
      ['téléphone vérifié sans téléphone', { phone_verified_at: new Date() }],
    ])('refuse : %s', async (_label, overrides) => {
      await asApp(async (db) => {
        expect(await sqlState(() => insertUser(db, overrides))).toBe(CHECK_VIOLATION);
      });
    });

    it('accepte un compte en attente, puis son activation une fois l’adresse vérifiée', async () => {
      await asApp(async (db) => {
        const id = await insertUser(db, { phone: '+243812345678' });
        expect(
          await sqlState(() => db.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [id])),
        ).toBe(CHECK_VIOLATION);
        await db.query(
          `UPDATE users SET status = 'ACTIVE', email_verified_at = now() WHERE id = $1`,
          [id],
        );
      });
    });

    it('une adresse e-mail n’appartient qu’à un compte', async () => {
      await asApp(async (db) => {
        await insertUser(db, { email: 'unique@example.cd' });
        expect(await sqlState(() => insertUser(db, { email: 'unique@example.cd' }))).toBe(
          UNIQUE_VIOLATION,
        );
      });
    });

    it('un numéro simplement déclaré peut l’être par plusieurs comptes ; vérifié, par un seul', async () => {
      await asApp(async (db) => {
        const phone = '+243990000001';
        const first = await insertUser(db, { phone });
        const second = await insertUser(db, { phone });

        await db.query(`UPDATE users SET phone_verified_at = now() WHERE id = $1`, [first]);
        expect(
          await sqlState(() =>
            db.query(`UPDATE users SET phone_verified_at = now() WHERE id = $1`, [second]),
          ),
        ).toBe(UNIQUE_VIOLATION);
      });
    });

    it('un compte ne se supprime pas tant que des données s’y rattachent', async () => {
      await asApp(async (db) => {
        const id = await insertUser(db);
        await db.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
          id,
          ARGON2_HASH,
        ]);
        expect(await sqlState(() => db.query(`DELETE FROM users WHERE id = $1`, [id]))).toBe(
          RESTRICT_VIOLATION,
        );
      });
    });

    it('seule une empreinte Argon2id peut être enregistrée comme mot de passe', async () => {
      await asApp(async (db) => {
        const id = await insertUser(db);
        for (const value of ['plaintext-password', '$2b$12$abcdefghijklmnopqrstuv', '']) {
          expect(
            await sqlState(() =>
              db.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
                id,
                value,
              ]),
            ),
          ).toBe(CHECK_VIOLATION);
        }
      });
    });
  });

  describe('codes à usage unique', () => {
    const insertChallenge = (
      db: pg.Client,
      userId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = {
        user_id: userId,
        purpose: 'EMAIL_VERIFICATION',
        target: 'someone@example.cd',
        max_attempts: 5,
        expires_at: new Date(Date.now() + 900_000),
        ...overrides,
      };
      const columns = Object.keys(row);
      return db.query<{ id: string }>(
        `INSERT INTO verification_challenges (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
    };

    it('un seul code en cours par compte et par usage', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const first = await insertChallenge(db, userId);
        expect(await sqlState(() => insertChallenge(db, userId))).toBe(UNIQUE_VIOLATION);

        // Un autre usage, ou l'annulation du premier, lève l'interdiction.
        await insertChallenge(db, userId, { purpose: 'PASSWORD_RESET' });
        await db.query(`UPDATE verification_challenges SET invalidated_at = now() WHERE id = $1`, [
          first.rows[0]!.id,
        ]);
        await insertChallenge(db, userId);
      });
    });

    it('le nombre d’essais ne peut pas dépasser le maximum, même par une écriture directe', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const { rows } = await insertChallenge(db, userId, { max_attempts: 2 });
        const bump = () =>
          db.query(`UPDATE verification_challenges SET attempts = attempts + 1 WHERE id = $1`, [
            rows[0]!.id,
          ]);
        await bump();
        await bump();
        expect(await sqlState(bump)).toBe(CHECK_VIOLATION);
      });
    });

    it.each([
      ['empreinte de mauvaise taille', { code_hash: Buffer.alloc(6, 1) }],
      ['aucun essai autorisé', { max_attempts: 0 }],
      ['à la fois utilisé et annulé', { consumed_at: new Date(), invalidated_at: new Date() }],
      ['déjà expiré à sa création', { expires_at: new Date(Date.now() - 1000) }],
    ])('refuse : %s', async (_label, overrides) => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        expect(await sqlState(() => insertChallenge(db, userId, overrides))).toBe(CHECK_VIOLATION);
      });
    });
  });

  describe('sessions', () => {
    const insertSession = (
      db: pg.Client,
      userId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = {
        user_id: userId,
        idle_expires_at: new Date(Date.now() + 3600_000),
        expires_at: new Date(Date.now() + 7200_000),
        ...overrides,
      };
      const columns = Object.keys(row);
      return db.query<{ id: string }>(
        `INSERT INTO user_sessions (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
    };

    it.each([
      ['révoquée sans motif', { revoked_at: new Date() }],
      ['motif sans révocation', { revocation_reason: 'LOGOUT' }],
      [
        'échéance d’inactivité au-delà de l’échéance absolue',
        { idle_expires_at: new Date(Date.now() + 9000_000) },
      ],
    ])('refuse une session %s', async (_label, overrides) => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        expect(await sqlState(() => insertSession(db, userId, overrides))).toBe(CHECK_VIOLATION);
      });
    });

    it('n’accepte que des empreintes de 32 octets, uniques', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const session = (await insertSession(db, userId)).rows[0]!.id;
        const insertToken = (access: Buffer, refresh: Buffer) =>
          db.query(
            `INSERT INTO session_tokens (session_id, access_token_hash, access_expires_at, refresh_token_hash)
             VALUES ($1, $2, now() + interval '10 minutes', $3)`,
            [session, access, refresh],
          );

        expect(
          await sqlState(() =>
            insertToken(Buffer.from('mgx_at_a-token-in-clear'), Buffer.alloc(32, 2)),
          ),
        ).toBe(CHECK_VIOLATION);
        await insertToken(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
        expect(await sqlState(() => insertToken(Buffer.alloc(32, 1), Buffer.alloc(32, 3)))).toBe(
          UNIQUE_VIOLATION,
        );
        expect(await sqlState(() => insertToken(Buffer.alloc(32, 4), Buffer.alloc(32, 2)))).toBe(
          UNIQUE_VIOLATION,
        );
      });
    });
  });

  describe('rôles et permissions', () => {
    it('le catalogue en base est identique à celui du code', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; description: string }>(
          'SELECT key, description FROM permissions ORDER BY key',
        );
        expect(Object.fromEntries(rows.map((row) => [row.key, row.description]))).toEqual(
          PERMISSIONS,
        );
      });
    });

    it('les rôles système existent et super_admin détient toutes les permissions', async () => {
      await asApp(async (db) => {
        const roles = await db.query<{ key: string; is_system: boolean }>(
          'SELECT key, is_system FROM roles ORDER BY key',
        );
        expect(roles.rows).toEqual(SYSTEM_ROLE_KEYS.map((key) => ({ key, is_system: true })));

        const granted = await db.query<{ permission_key: string }>(
          `SELECT rp.permission_key FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id WHERE r.key = 'super_admin' ORDER BY 1`,
        );
        expect(granted.rows.map((row) => row.permission_key)).toEqual(
          Object.keys(PERMISSIONS).sort(),
        );
      });
    });

    it('le rôle applicatif lit les droits mais ne peut ni en créer, ni s’en attribuer', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const role = await db.query<{ id: string }>(
          `SELECT id FROM roles WHERE key = 'super_admin'`,
        );
        const roleId = role.rows[0]!.id;

        const forbidden = [
          () =>
            db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]),
          () => db.query(`DELETE FROM user_roles`),
          () =>
            db.query(`INSERT INTO permissions (key, description) VALUES ('wallets.drain', 'x')`),
          () =>
            db.query(`INSERT INTO roles (key, name, description) VALUES ('intruder', 'x', 'x')`),
          () => db.query(`UPDATE roles SET is_system = false`),
          () =>
            db.query(
              `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'system_settings.write')`,
              [roleId],
            ),
          () => db.query(`DELETE FROM role_permissions`),
          () => db.query(`TRUNCATE user_roles`),
        ];
        for (const statement of forbidden) {
          expect(await sqlState(statement)).toBe(INSUFFICIENT_PRIVILEGE);
        }
        expect((await db.query('SELECT count(*)::int AS n FROM user_roles')).rows[0]).toEqual({
          n: 0,
        });
      });
    });

    it('le rôle propriétaire — migrations et outil d’amorçage — peut attribuer un rôle', async () => {
      await asOwner(async (db) => {
        const userId = await insertUser(db);
        await db.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'super_admin'`,
          [userId],
        );
        expect(
          await sqlState(() =>
            db.query(`INSERT INTO permissions (key, description) VALUES ('Bad Key', 'x')`),
          ),
        ).toBe(CHECK_VIOLATION);
      });
    });
  });
});
