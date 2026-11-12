import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** Suppression refusée par une clé étrangère `ON DELETE RESTRICT`. */
const RESTRICT_VIOLATION = '23001';

/** Forme d'un secret chiffré : version (1) ‖ nonce (12) ‖ secret chiffré (20) ‖ sceau (16). */
const ciphertext = (): Buffer => Buffer.concat([Buffer.from([1]), randomBytes(48)]);

describe('Sécurité des comptes — garanties portées par la base de données', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);

  let sequence = 0;
  const insertUser = async (db: pg.Client): Promise<string> => {
    sequence += 1;
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, country_code, terms_accepted_at)
       VALUES ($1, 'CD', now()) RETURNING id`,
      [`security${String(sequence)}@example.cd`],
    );
    return result.rows[0]!.id;
  };

  describe('second facteur', () => {
    const insertTotp = (db: pg.Client, userId: string, secret: Buffer) =>
      db.query('INSERT INTO user_totp_credentials (user_id, secret_ciphertext) VALUES ($1, $2)', [
        userId,
        secret,
      ]);

    it.each([
      ['un secret en clair (20 octets)', randomBytes(20)],
      ['un secret chiffré tronqué', Buffer.concat([Buffer.from([1]), randomBytes(47)])],
      ['un secret chiffré trop long', Buffer.concat([Buffer.from([1]), randomBytes(49)])],
      ['une version de chiffrement inconnue', Buffer.concat([Buffer.from([2]), randomBytes(48)])],
      ['une valeur vide', Buffer.alloc(0)],
    ])('refuse %s', async (_label, secret) => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        expect(await sqlState(() => insertTotp(db, userId, secret))).toBe(CHECK_VIOLATION);
      });
    });

    it('accepte un secret chiffré, un seul par compte, et ne retient un pas utilisé qu’après confirmation', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        await insertTotp(db, userId, ciphertext());
        expect(await sqlState(() => insertTotp(db, userId, ciphertext()))).toBe(UNIQUE_VIOLATION);

        const setStep = (step: number) =>
          db.query('UPDATE user_totp_credentials SET last_used_step = $2 WHERE user_id = $1', [
            userId,
            step,
          ]);
        // Enrôlement non confirmé : aucun code n'a pu être accepté.
        expect(await sqlState(() => setStep(58_000_000))).toBe(CHECK_VIOLATION);

        await db.query('UPDATE user_totp_credentials SET confirmed_at = now() WHERE user_id = $1', [
          userId,
        ]);
        await setStep(58_000_000);
        expect(await sqlState(() => setStep(-1))).toBe(CHECK_VIOLATION);
        // Revenir à « non confirmé » en gardant un pas utilisé n'a pas de sens.
        expect(
          await sqlState(() =>
            db.query('UPDATE user_totp_credentials SET confirmed_at = NULL WHERE user_id = $1', [
              userId,
            ]),
          ),
        ).toBe(CHECK_VIOLATION);
      });
    });

    it('n’accepte que l’empreinte d’un code de secours, une fois par compte', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const insertCode = (hash: Buffer, owner = userId) =>
          db.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
            owner,
            hash,
          ]);

        // Un code en clair (10 caractères), une empreinte tronquée ou d'un autre algorithme.
        for (const invalid of [Buffer.from('ABCDE12345'), randomBytes(31), randomBytes(64)]) {
          expect(await sqlState(() => insertCode(invalid))).toBe(CHECK_VIOLATION);
        }
        const hash = randomBytes(32);
        await insertCode(hash);
        expect(await sqlState(() => insertCode(hash))).toBe(UNIQUE_VIOLATION);
        // La même empreinte pour un autre compte n'est pas un doublon.
        await insertCode(hash, await insertUser(db));
      });
    });

    it('le second facteur et ses codes appartiennent à un compte existant, qui ne se supprime pas tant qu’ils existent', async () => {
      await asApp(async (db) => {
        const orphan = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';
        expect(await sqlState(() => insertTotp(db, orphan, ciphertext()))).toBe(
          FOREIGN_KEY_VIOLATION,
        );

        const userId = await insertUser(db);
        await insertTotp(db, userId, ciphertext());
        expect(await sqlState(() => db.query('DELETE FROM users WHERE id = $1', [userId]))).toBe(
          RESTRICT_VIOLATION,
        );
        await db.query('DELETE FROM user_totp_credentials WHERE user_id = $1', [userId]);
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
      });
    });
  });

  describe('profil', () => {
    const insertProfile = (db: pg.Client, userId: string, fields: Record<string, unknown>) => {
      const columns = Object.keys(fields);
      return db.query(
        `INSERT INTO user_profiles (user_id${columns.map((column) => `, ${column}`).join('')}, updated_at)
         VALUES ($1${columns.map((_, index) => `, $${String(index + 2)}`).join('')}, now())`,
        [userId, ...Object.values(fields)],
      );
    };

    it.each([
      ['un prénom vide', { given_name: '' }],
      ['un nom fait d’espaces', { family_name: '   ' }],
      ['un postnom vide', { additional_name: '' }],
      ['une naissance antérieure à 1900', { date_of_birth: '1899-12-31' }],
    ])('refuse %s', async (_label, fields) => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        expect(await sqlState(() => insertProfile(db, userId, fields))).toBe(CHECK_VIOLATION);
      });
    });

    it('accepte un profil partiel, un seul par compte', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        await insertProfile(db, userId, { given_name: 'Jean', date_of_birth: '1900-01-01' });
        expect(await sqlState(() => insertProfile(db, userId, { given_name: 'Paul' }))).toBe(
          UNIQUE_VIOLATION,
        );
        const stored = await db.query<{ family_name: string | null; date_of_birth: string }>(
          `SELECT family_name, date_of_birth::text FROM user_profiles WHERE user_id = $1`,
          [userId],
        );
        expect(stored.rows[0]).toEqual({ family_name: null, date_of_birth: '1900-01-01' });
      });
    });
  });

  describe('sessions et téléphone', () => {
    it('l’empreinte d’appareil d’une session est un SHA-256 ou rien — jamais l’identifiant lui-même', async () => {
      await asApp(async (db) => {
        const userId = await insertUser(db);
        const insertSession = (fingerprint: Buffer | null) =>
          db.query(
            `INSERT INTO user_sessions (user_id, idle_expires_at, expires_at, device_fingerprint)
             VALUES ($1, now() + interval '1 day', now() + interval '2 days', $2)`,
            [userId, fingerprint],
          );

        await insertSession(null);
        await insertSession(randomBytes(32));
        for (const invalid of [
          Buffer.from('device-phone-0000-0001'),
          randomBytes(16),
          Buffer.alloc(0),
        ]) {
          expect(await sqlState(() => insertSession(invalid))).toBe(CHECK_VIOLATION);
        }
      });
    });

    it('un numéro vérifié n’appartient qu’à un compte ; non vérifié, il peut être déclaré par plusieurs', async () => {
      await asApp(async (db) => {
        const [first, second, third] = [
          await insertUser(db),
          await insertUser(db),
          await insertUser(db),
        ];
        const phone = '+243899123456';
        const setPhone = (userId: string, verified: boolean) =>
          db.query('UPDATE users SET phone = $2, phone_verified_at = $3 WHERE id = $1', [
            userId,
            phone,
            verified ? new Date() : null,
          ]);

        await setPhone(first, true);
        await setPhone(second, false);
        expect(await sqlState(() => setPhone(third, true))).toBe(UNIQUE_VIOLATION);
        expect(await sqlState(() => setPhone(second, true))).toBe(UNIQUE_VIOLATION);

        // Le premier compte change de numéro : celui-ci redevient disponible.
        await db.query('UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = $1', [
          first,
        ]);
        await setPhone(second, true);
      });
    });

    it('les nouveaux motifs existent : vérification du téléphone, fermeture pour changement de second facteur', async () => {
      await asApp(async (db) => {
        const purposes = await db.query<{ value: string }>(
          `SELECT unnest(enum_range(NULL::challenge_purpose))::text AS value`,
        );
        expect(purposes.rows.map((row) => row.value)).toContain('PHONE_VERIFICATION');
        const reasons = await db.query<{ value: string }>(
          `SELECT unnest(enum_range(NULL::session_revocation_reason))::text AS value`,
        );
        expect(reasons.rows.map((row) => row.value)).toEqual(
          expect.arrayContaining(['SECOND_FACTOR_CHANGED', 'ADMIN_REVOKED', 'ACCOUNT_DISABLED']),
        );
      });
    });
  });
});
