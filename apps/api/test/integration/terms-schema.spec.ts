import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  closeAccountInSql,
  closeVerificationCases,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
  TABLES_EMPTIED_AT_CLOSURE,
} from '../support/account-closure.js';
import {
  acceptTermsInSql,
  currentTermsNumber,
  insertTermsVersion,
  lengthInCharacters,
  sha256Hex,
} from '../support/terms-sql.js';
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
const RESTRICT_VIOLATION = '23001';
const NOT_NULL_VIOLATION = '23502';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Règle de clôture d'un compte enfreinte (migration account_closure). */
const CLOSURE_RULE_VIOLATION = 'MGX04';
/** Écriture visant un compte clôturé (migration account_closure). */
const ACCOUNT_CLOSED = 'MGX05';
/** Règle des conditions d'utilisation enfreinte (migration terms_of_use). */
const TERMS_RULE_VIOLATION = 'MGX06';
/** Numéro de version qui n'est pas — ou plus — celui attendu (migration terms_of_use). */
const TERMS_VERSION_OUT_OF_SEQUENCE = 'MGX07';

const UNKNOWN_ACCOUNT = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

describe('Conditions d’utilisation — règles portées par la base de données', () => {
  let database: TestDatabase;
  let admin: string;
  let support: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      admin = await insertStaff(db, 'super_admin');
      support = await insertStaff(db, 'support');
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
      email: `terms${String(sequence)}@example.cd`,
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

  const insertPendingUser = (db: pg.Client): Promise<string> =>
    insertUser(db, { status: 'PENDING_VERIFICATION', email_verified_at: null });

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

  /** Code de l'erreur d'une publication tentée par l'administrateur, toujours annulée. */
  const publicationOf = (
    db: pg.Client,
    overrides: Record<string, unknown>,
  ): Promise<string | undefined> =>
    attempt(db, () => insertTermsVersion(db, { published_by: admin, ...overrides }));

  const versionCount = async (db: pg.Client): Promise<number> =>
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM terms_versions')).rows[0]!.n;

  const acceptancesOf = async (db: pg.Client, userId: string): Promise<number[]> =>
    (
      await db.query<{ version_number: number }>(
        'SELECT version_number FROM terms_acceptances WHERE user_id = $1 ORDER BY version_number',
        [userId],
      )
    ).rows.map((row) => row.version_number);

  // Les scénarios s'enchaînent : chacun part du numéro en vigueur laissé par le précédent.

  describe('l’inscription a sa date, distincte de toute acceptation', () => {
    it('la colonne qui date l’inscription s’appelle registered_at ; terms_accepted_at n’existe plus', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users'
             AND column_name IN ('registered_at', 'terms_accepted_at')`,
        );
        expect(rows).toEqual([{ column_name: 'registered_at', is_nullable: 'NO' }]);
        expect(
          await sqlState(() =>
            db.query(`INSERT INTO users (email, country_code) VALUES ('x@example.cd', 'CD')`),
          ),
        ).toBe(NOT_NULL_VIOLATION);
      });
    });
  });

  describe('publication : des versions numérotées 1, 2, 3…', () => {
    it('la première version porte le numéro 1, et aucun autre', async () => {
      await asApp(async (db) => {
        expect(await currentTermsNumber(db)).toBe(0);
        for (const number of [2, 0, -1, 10]) {
          expect(await publicationOf(db, { number })).toBe(TERMS_VERSION_OUT_OF_SEQUENCE);
        }
        expect(await publicationOf(db, { number: null })).toBe(TERMS_VERSION_OUT_OF_SEQUENCE);
        expect(await publicationOf(db, { number: 1 })).toBeUndefined();
        expect(await versionCount(db)).toBe(0);
      });
    });

    it('la version 1 s’impose à tous : elle ne se publie pas « pour information »', async () => {
      await asApp(async (db) => {
        expect(await publicationOf(db, { number: 1, requires_acceptance: false })).toBe(
          CHECK_VIOLATION,
        );
        await insertTermsVersion(db, { number: 1, published_by: admin });
        // Les suivantes, elles, peuvent ne rien exiger.
        await insertTermsVersion(db, {
          number: 2,
          requires_acceptance: false,
          published_by: admin,
        });
        expect(await currentTermsNumber(db)).toBe(2);
      });
    });

    it('ensuite, seule la version suivante se publie : ni doublon, ni trou, ni retour en arrière', async () => {
      await asApp(async (db) => {
        for (const number of [1, 2, 4, 0]) {
          expect(await publicationOf(db, { number })).toBe(TERMS_VERSION_OUT_OF_SEQUENCE);
        }
        expect(await publicationOf(db, { number: 3 })).toBeUndefined();
        expect(await versionCount(db)).toBe(2);
      });
    });

    it('l’heure de publication est celle de la base, quelle que soit celle qu’on lui donne', async () => {
      await asApp(async (db) => {
        const before = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const number = await insertTermsVersion(db, {
          published_by: admin,
          published_at: new Date('2020-01-01T00:00:00Z'),
        });
        const { rows } = await db.query<{ published_at: Date; later: boolean }>(
          `SELECT published_at, published_at <= clock_timestamp() AS later
           FROM terms_versions WHERE number = $1`,
          [number],
        );
        expect(rows[0]!.published_at.getTime()).toBeGreaterThanOrEqual(
          before.rows[0]!.now.getTime(),
        );
        expect(rows[0]!.later).toBe(true);
      });
    });

    it('l’heure de publication croît avec le numéro, même dans une seule transaction', async () => {
      await asApp(async (db) => {
        await db.query('BEGIN');
        const first = await insertTermsVersion(db, { published_by: admin });
        const second = await insertTermsVersion(db, { published_by: admin });
        await db.query('COMMIT');
        const { rows } = await db.query<{ ordered: boolean }>(
          `SELECT a.published_at < b.published_at AS ordered
           FROM terms_versions a, terms_versions b WHERE a.number = $1 AND b.number = $2`,
          [first, second],
        );
        expect(second).toBe(first + 1);
        expect(rows).toEqual([{ ordered: true }]);
      });
    });
  });

  describe('qui publie', () => {
    it('un membre du personnel actif qui détient terms.publish — et lui seul', async () => {
      const [suspended, holder] = await asOwner(async (db) => [
        await insertStaff(db, 'super_admin'),
        await insertUser(db),
      ]);
      await asOwner((db) =>
        db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [suspended]),
      );
      await asApp(async (db) => {
        expect(await publicationOf(db, { published_by: admin })).toBeUndefined();
        // Habilité à autre chose, sans rôle, suspendu, inconnu : refusé.
        for (const publisher of [support, holder, suspended, UNKNOWN_ACCOUNT]) {
          expect(await publicationOf(db, { published_by: publisher })).toBe(TERMS_RULE_VIOLATION);
        }
      });
    });

    it('la permission se lit au moment de publier : retirée, elle ne vaut plus', async () => {
      const former = await asOwner((db) => insertStaff(db, 'super_admin'));
      await asApp(async (db) => {
        expect(await publicationOf(db, { published_by: former })).toBeUndefined();
      });
      await asOwner((db) => db.query(`DELETE FROM user_roles WHERE user_id = $1`, [former]));
      await asApp(async (db) => {
        expect(await publicationOf(db, { published_by: former })).toBe(TERMS_RULE_VIOLATION);
      });
    });

    it('sans auteur : réservé au rôle propriétaire, celui de l’outil d’exploitation', async () => {
      await asApp(async (db) => {
        expect(await publicationOf(db, { published_by: null })).toBe(TERMS_RULE_VIOLATION);
      });
      await asOwner(async (db) => {
        const number = await insertTermsVersion(db);
        const { rows } = await db.query<{ published_by: string | null }>(
          'SELECT published_by FROM terms_versions WHERE number = $1',
          [number],
        );
        expect(rows).toEqual([{ published_by: null }]);
      });
    });

    it('terms.publish figure au catalogue ; seul le rôle super_admin la détient', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string }>(
          `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
           WHERE rp.permission_key = 'terms.publish' ORDER BY r.key`,
        );
        expect(rows).toEqual([{ key: 'super_admin' }]);
      });
    });
  });

  describe('le texte d’une version', () => {
    it.each([
      ['résumé vide', { summary_fr: '' }],
      ['résumé fait d’espaces', { summary_fr: ' \n\t ' }],
      ['résumé de 1 001 caractères', { summary_fr: 'r'.repeat(1001) }],
      ['texte vide', { body_fr: '' }],
      ['texte fait d’espaces', { body_fr: '\n\n   \n' }],
      ['texte de 200 001 caractères', { body_fr: 't'.repeat(200_001) }],
      ['caractère de contrôle (échappement)', { body_fr: 'Article\u001b[31m 1' }],
      ['caractère de contrôle (effacement)', { body_fr: 'Article\u007f 1' }],
      ['caractère de contrôle C1', { body_fr: 'Article\u0085 1' }],
      ['saut de page', { body_fr: 'Article 1\u000cArticle 2' }],
      ['marque d’ordre des octets en tête', { body_fr: '\ufeffArticle 1' }],
      ['marque d’ordre des octets en tête du résumé', { summary_fr: '\ufeffRésumé' }],
      ['traduction sans résumé', { body_en: 'Article 1' }],
      ['traduction sans texte', { summary_en: 'Summary' }],
      ['traduction dont le texte est vide', { summary_en: 'Summary', body_en: ' ' }],
      [
        'traduction contenant un caractère de contrôle',
        { summary_en: 'Summary', body_en: 'Article\u0007 1' },
      ],
      ['traduction trop longue', { summary_en: 'Summary', body_en: 't'.repeat(200_001) }],
      ['résumé de traduction fait d’espaces', { summary_en: ' \n ', body_en: 'Article 1' }],
      [
        'résumé de traduction de 1 001 caractères',
        { summary_en: 'r'.repeat(1001), body_en: 'Article 1' },
      ],
      [
        'résumé de traduction contenant un caractère de contrôle',
        { summary_en: 'Summary\u0007', body_en: 'Article 1' },
      ],
      ['empreinte de traduction sans traduction', { body_en_sha256: sha256Hex('Article 1') }],
      [
        'résumé et empreinte de traduction sans texte',
        { summary_en: 'Summary', body_en_sha256: sha256Hex('Article 1') },
      ],
    ])('%s : refusé', async (_label, overrides) => {
      await asApp(async (db) => {
        expect(await publicationOf(db, overrides)).toBe(CHECK_VIOLATION);
      });
    });

    it('la marque d’ordre des octets n’est refusée qu’en tête : ailleurs, ce caractère appartient au texte', async () => {
      await asApp(async (db) => {
        expect(
          await publicationOf(db, {
            summary_fr: 'Résumé\ufeff.',
            body_fr: 'Article\ufeff 1\n',
            summary_en: 'Summary\ufeff.',
            body_en: 'Article\ufeff 1\n',
          }),
        ).toBeUndefined();
      });
    });

    it('un octet nul ne s’écrit pas dans un texte', async () => {
      await asApp(async (db) => {
        // PostgreSQL le refuse avant toute contrainte : « invalid byte sequence ».
        expect(await publicationOf(db, { body_fr: 'Article\u0000 1' })).toBe('22021');
      });
    });

    it('aux bornes exactes, avec sauts de ligne, tabulations, accents et émojis : accepté, et conservé à l’octet près', async () => {
      const opening = 'Article 1\r\n\tAlinéa — « œuvre » 😀\n';
      const body = opening + 't'.repeat(200_000 - lengthInCharacters(opening));
      expect(lengthInCharacters(body)).toBe(200_000);
      // Un émoji compte pour un caractère, et pour deux unités UTF-16.
      expect(body).toHaveLength(200_001);
      const summary = 'é'.repeat(1000);
      await asApp(async (db) => {
        const number = await insertTermsVersion(db, {
          published_by: admin,
          summary_fr: summary,
          body_fr: body,
          summary_en: 's'.repeat(1000),
          body_en: 'Article 1\n',
        });
        const { rows } = await db.query<{
          summary_fr: string;
          body_fr: string;
          body_fr_sha256: string;
          body_en: string;
          body_en_sha256: string;
        }>(
          `SELECT summary_fr, body_fr, body_fr_sha256, body_en, body_en_sha256
           FROM terms_versions WHERE number = $1`,
          [number],
        );
        expect(rows[0]).toEqual({
          summary_fr: summary,
          body_fr: body,
          body_fr_sha256: sha256Hex(body),
          body_en: 'Article 1\n',
          body_en_sha256: sha256Hex('Article 1\n'),
        });
      });
    });

    it('la longueur se compte en caractères, non en octets ni en unités UTF-16', async () => {
      await asApp(async (db) => {
        // 200 000 émojis : 800 000 octets, 400 000 unités UTF-16 — et 200 000 caractères.
        expect(await publicationOf(db, { body_fr: '😀'.repeat(200_000) })).toBeUndefined();
        expect(await publicationOf(db, { body_fr: '😀'.repeat(200_001) })).toBe(CHECK_VIOLATION);
      });
    });

    it('l’empreinte conservée est celle du texte : toute autre est refusée', async () => {
      await asApp(async (db) => {
        const body = 'Article 1 — Objet.\n';
        const digest = sha256Hex(body);
        for (const wrong of [
          sha256Hex('Article 1 — Objet.'),
          digest.toUpperCase(),
          '0'.repeat(64),
          digest.slice(0, 63),
        ]) {
          expect(await publicationOf(db, { body_fr: body, body_fr_sha256: wrong })).toBe(
            CHECK_VIOLATION,
          );
        }
        expect(await publicationOf(db, { body_fr: body, body_fr_sha256: null })).toBe(
          NOT_NULL_VIOLATION,
        );
        expect(await publicationOf(db, { body_fr: body, body_fr_sha256: digest })).toBeUndefined();

        const translation = { summary_en: 'Summary', body_en: 'Article 1 — Purpose.\n' };
        expect(
          await publicationOf(db, { ...translation, body_en_sha256: sha256Hex('Article 1') }),
        ).toBe(CHECK_VIOLATION);
        // Empreinte de la version française : ce n'est pas celle de la traduction.
        expect(
          await publicationOf(db, {
            ...translation,
            body_fr: body,
            body_en_sha256: digest,
          }),
        ).toBe(CHECK_VIOLATION);
        expect(await publicationOf(db, { ...translation, body_en_sha256: null })).toBe(
          CHECK_VIOLATION,
        );
        expect(await publicationOf(db, translation)).toBeUndefined();
      });
    });
  });

  describe('une version publiée ne change plus', () => {
    it('ni modification, ni suppression, ni vidage — même par le propriétaire du schéma', async () => {
      await asOwner(async (db) => {
        const current = await currentTermsNumber(db);
        for (const statement of [
          `UPDATE terms_versions SET body_fr = 'Autre texte' WHERE number = ${String(current)}`,
          `UPDATE terms_versions SET requires_acceptance = NOT requires_acceptance WHERE number = 1`,
          `UPDATE terms_versions SET number = number + 100 WHERE number = ${String(current)}`,
          `DELETE FROM terms_versions WHERE number = ${String(current)}`,
          `TRUNCATE terms_versions CASCADE`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(FORBIDDEN_MUTATION);
        }
        // Le vidage entraînerait la table des acceptations, protégée elle aussi : même cette
        // protection-là levée, la table des versions le refuse d'elle-même.
        expect(
          await attempt(db, async () => {
            await db.query(
              'ALTER TABLE terms_acceptances DISABLE TRIGGER terms_acceptances_no_truncate',
            );
            await db.query('TRUNCATE terms_versions CASCADE');
          }),
        ).toBe(FORBIDDEN_MUTATION);
        expect(await currentTermsNumber(db)).toBe(current);
      });
    });

    it('le rôle applicatif n’a, sur les versions, que le droit de lire et d’ajouter', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ privileges: string[] }>(
          `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_name = 'terms_versions'`,
          [TEST_APP_ROLE],
        );
        expect(rows).toEqual([{ privileges: ['INSERT', 'SELECT'] }]);
        for (const statement of [
          `UPDATE terms_versions SET body_fr = 'Autre texte'`,
          `DELETE FROM terms_versions`,
          `TRUNCATE terms_versions CASCADE`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });
  });

  describe('publications simultanées', () => {
    it('deux publications du même numéro : la seconde attend la première, puis est refusée', async () => {
      await asApp((first) =>
        asApp((second) =>
          asApp(async (observer) => {
            const next = (await currentTermsNumber(observer)) + 1;
            await first.query('BEGIN');
            await insertTermsVersion(first, { number: next, published_by: admin });

            const late = sqlState(() =>
              insertTermsVersion(second, {
                number: next,
                published_by: admin,
                body_fr: 'Texte du second.',
              }),
            );
            await untilAdvisoryWait(observer);
            await first.query('COMMIT');

            expect(await late).toBe(TERMS_VERSION_OUT_OF_SEQUENCE);
            const { rows } = await observer.query<{ body_fr: string }>(
              'SELECT body_fr FROM terms_versions WHERE number = $1',
              [next],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0]!.body_fr).not.toBe('Texte du second.');
          }),
        ),
      );
    });

    it('la même course, la première annulée : la seconde publie', async () => {
      await asApp((first) =>
        asApp((second) =>
          asApp(async (observer) => {
            const next = (await currentTermsNumber(observer)) + 1;
            await first.query('BEGIN');
            await insertTermsVersion(first, { number: next, published_by: admin });

            const late = sqlState(() =>
              insertTermsVersion(second, {
                number: next,
                published_by: admin,
                body_fr: 'Texte du second.',
              }),
            );
            await untilAdvisoryWait(observer);
            await first.query('ROLLBACK');

            expect(await late).toBeUndefined();
            const { rows } = await observer.query<{ body_fr: string }>(
              'SELECT body_fr FROM terms_versions WHERE number = $1',
              [next],
            );
            expect(rows).toEqual([{ body_fr: 'Texte du second.' }]);
          }),
        ),
      );
    });

    it('deux publications de numéros consécutifs lancées ensemble : aucun trou, aucun doublon', async () => {
      const start = await asApp((db) => currentTermsNumber(db));
      const outcomes = await Promise.all(
        [start + 1, start + 1, start + 2, start + 2, start + 3].map((number) =>
          asApp((db) => sqlState(() => insertTermsVersion(db, { number, published_by: admin }))),
        ),
      );
      await asApp(async (db) => {
        const { rows } = await db.query<{ number: number }>(
          'SELECT number FROM terms_versions WHERE number > $1 ORDER BY number',
          [start],
        );
        const published = rows.map((row) => row.number);
        // Selon l'ordre d'arrivée, une, deux ou trois versions ; toujours contiguës.
        expect(published).toEqual(published.map((_, index) => start + 1 + index));
        expect(published.length).toBeGreaterThanOrEqual(1);
        expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(published.length);
        expect(outcomes.filter((outcome) => outcome !== undefined && outcome !== 'MGX07')).toEqual(
          [],
        );
      });
    });
  });

  describe('accepter', () => {
    it('on n’accepte que la version en vigueur : ni une ancienne, ni une version à venir', async () => {
      await asApp(async (db) => {
        const current = await currentTermsNumber(db);
        const user = await insertUser(db);
        for (const number of [current - 1, 1, current + 1, 0, -1]) {
          expect(await sqlState(() => acceptTermsInSql(db, user, number))).toBe(
            TERMS_VERSION_OUT_OF_SEQUENCE,
          );
        }
        expect(await sqlState(() => acceptTermsInSql(db, user, current))).toBeUndefined();
        expect(await acceptancesOf(db, user)).toEqual([current]);
      });
    });

    it('une version publiée entre-temps rend l’acceptation de la précédente caduque', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const read = await currentTermsNumber(db);
        const published = await insertTermsVersion(db, { published_by: admin });
        expect(await sqlState(() => acceptTermsInSql(db, user, read))).toBe(
          TERMS_VERSION_OUT_OF_SEQUENCE,
        );
        expect(await sqlState(() => acceptTermsInSql(db, user, published))).toBeUndefined();
      });
    });

    it('une acceptation par version et par compte ; l’historique garde les précédentes', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const first = await currentTermsNumber(db);
        await acceptTermsInSql(db, user, first);
        expect(await sqlState(() => acceptTermsInSql(db, user, first))).toBe(UNIQUE_VIOLATION);

        const second = await insertTermsVersion(db, { published_by: admin });
        await acceptTermsInSql(db, user, second);
        expect(await acceptancesOf(db, user)).toEqual([first, second]);
      });
    });

    it('l’heure d’acceptation est celle de la base, quelle que soit celle qu’on lui donne', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const before = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        await db.query(
          `INSERT INTO terms_acceptances (user_id, version_number, accepted_at)
           VALUES ($1, $2, '2020-01-01T00:00:00Z')`,
          [user, await currentTermsNumber(db)],
        );
        const { rows } = await db.query<{ accepted_at: Date; past: boolean }>(
          `SELECT accepted_at, accepted_at <= clock_timestamp() AS past
           FROM terms_acceptances WHERE user_id = $1`,
          [user],
        );
        expect(rows[0]!.accepted_at.getTime()).toBeGreaterThanOrEqual(
          before.rows[0]!.now.getTime(),
        );
        expect(rows[0]!.past).toBe(true);
      });
    });

    it('une acceptation n’est jamais datée d’avant la publication de sa version', async () => {
      // La transaction de l'acceptation s'ouvre avant la publication : l'heure retenue est
      // celle de l'écriture, non celle du début de la transaction.
      await asApp(async (db) => {
        const user = await insertUser(db);
        await db.query('BEGIN');
        try {
          await db.query('SELECT 1');
          const published = await asApp((other) =>
            insertTermsVersion(other, { published_by: admin }),
          );
          await acceptTermsInSql(db, user, published);
          const { rows } = await db.query<{ ordered: boolean }>(
            `SELECT a.accepted_at >= v.published_at AS ordered
             FROM terms_acceptances AS a
             JOIN terms_versions AS v ON v.number = a.version_number
             WHERE a.user_id = $1`,
            [user],
          );
          expect(rows).toEqual([{ ordered: true }]);
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('accepte un compte en cours d’inscription ou actif ; ni suspendu, ni clôturé, ni inconnu', async () => {
      await asApp(async (db) => {
        const pending = await insertPendingUser(db);
        const active = await insertUser(db);
        const suspended = await insertUser(db, { status: 'SUSPENDED' });
        const closed = await insertUser(db);
        await closeAccountInSql(db, closed);

        expect(await sqlState(() => acceptTermsInSql(db, pending))).toBeUndefined();
        expect(await sqlState(() => acceptTermsInSql(db, active))).toBeUndefined();
        expect(await sqlState(() => acceptTermsInSql(db, suspended))).toBe(TERMS_RULE_VIOLATION);
        expect(await sqlState(() => acceptTermsInSql(db, closed))).toBe(ACCOUNT_CLOSED);
        expect(await sqlState(() => acceptTermsInSql(db, UNKNOWN_ACCOUNT))).toBe(
          FOREIGN_KEY_VIOLATION,
        );
        expect(await acceptancesOf(db, suspended)).toEqual([]);
        expect(await acceptancesOf(db, closed)).toEqual([]);
      });
    });
  });

  describe('une acceptation est une preuve', () => {
    it('elle ne se modifie pas, et celle d’un compte en service ne s’efface pas', async () => {
      await asApp(async (db) => {
        const active = await insertUser(db);
        await acceptTermsInSql(db, active);
        const suspended = await insertUser(db);
        await acceptTermsInSql(db, suspended);
        await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);

        for (const user of [active, suspended]) {
          expect(
            await sqlState(() =>
              db.query('DELETE FROM terms_acceptances WHERE user_id = $1', [user]),
            ),
          ).toBe(TERMS_RULE_VIOLATION);
          expect(await acceptancesOf(db, user)).toHaveLength(1);
        }
      });
      await asOwner(async (db) => {
        // Même le propriétaire du schéma ne la réécrit pas.
        for (const statement of [
          `UPDATE terms_acceptances SET accepted_at = accepted_at - interval '1 year'`,
          `UPDATE terms_acceptances SET version_number = 1`,
          `TRUNCATE terms_acceptances`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(FORBIDDEN_MUTATION);
        }
      });
    });

    it('le rôle applicatif n’a, sur les acceptations, que les privilèges dont il a besoin', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ privileges: string[] }>(
          `SELECT array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_name = 'terms_acceptances'`,
          [TEST_APP_ROLE],
        );
        expect(rows).toEqual([{ privileges: ['DELETE', 'INSERT', 'SELECT'] }]);
        for (const statement of [
          `UPDATE terms_acceptances SET accepted_at = now()`,
          `TRUNCATE terms_acceptances`,
        ]) {
          expect(await attempt(db, () => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });
    });

    it('une inscription jamais vérifiée emporte la sienne : elle s’efface, puis le compte', async () => {
      await asApp(async (db) => {
        const pending = await insertPendingUser(db);
        await acceptTermsInSql(db, pending);

        // Le compte ne se supprime pas tant que l'acceptation existe.
        expect(await sqlState(() => db.query('DELETE FROM users WHERE id = $1', [pending]))).toBe(
          RESTRICT_VIOLATION,
        );
        await db.query('DELETE FROM terms_acceptances WHERE user_id = $1', [pending]);
        await db.query('DELETE FROM users WHERE id = $1', [pending]);
        expect(await acceptancesOf(db, pending)).toEqual([]);
      });
    });

    it('une version acceptée ne se retire pas davantage par ce biais', async () => {
      await asOwner(async (db) => {
        const user = await insertUser(db);
        await acceptTermsInSql(db, user);
        // Le déclencheur d'immuabilité parle avant la clé étrangère.
        expect(
          await attempt(db, () =>
            db.query(
              'DELETE FROM terms_versions WHERE number = (SELECT max(number) FROM terms_versions)',
            ),
          ),
        ).toBe(FORBIDDEN_MUTATION);
      });
    });
  });

  describe('clôture d’un compte', () => {
    it('un compte ne se clôt pas en gardant une acceptation', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        await acceptTermsInSql(db, user);

        await db.query('BEGIN');
        await insertClosureRecord(db, user);
        // Tout le reste est retiré au compte : seule l'acceptation demeure.
        for (const table of TABLES_EMPTIED_AT_CLOSURE) {
          if (table !== 'terms_acceptances') {
            await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [user]);
          }
        }
        expect(await sqlState(() => markAccountClosed(db, user))).toBe(CLOSURE_RULE_VIOLATION);
        await db.query('ROLLBACK');

        const { rows } = await db.query<{ status: string }>(
          'SELECT status FROM users WHERE id = $1',
          [user],
        );
        expect(rows).toEqual([{ status: 'ACTIVE' }]);
        expect(await acceptancesOf(db, user)).toHaveLength(1);
      });
    });

    it('la clôture efface les acceptations — une fois sa trace écrite, pas avant', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const first = await currentTermsNumber(db);
        await acceptTermsInSql(db, user, first);
        await acceptTermsInSql(db, user, await insertTermsVersion(db, { published_by: admin }));

        await db.query('BEGIN');
        // Sans trace de clôture, le compte est en service : sa preuve ne s'efface pas.
        await db.query('SAVEPOINT before_record');
        expect(
          await sqlState(() =>
            db.query('DELETE FROM terms_acceptances WHERE user_id = $1', [user]),
          ),
        ).toBe(TERMS_RULE_VIOLATION);
        await db.query('ROLLBACK TO SAVEPOINT before_record');

        await insertClosureRecord(db, user);
        await db.query('DELETE FROM terms_acceptances WHERE user_id = $1', [user]);
        await emptyAccount(db, user);
        await markAccountClosed(db, user);
        await closeVerificationCases(db, user);
        await db.query('COMMIT');

        expect(await acceptancesOf(db, user)).toEqual([]);
        // Clôturé, il n'accepte plus rien.
        expect(await sqlState(() => acceptTermsInSql(db, user))).toBe(ACCOUNT_CLOSED);
      });
    });

    it('l’assistant de clôture des tests fait de même', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        await acceptTermsInSql(db, user);
        await closeAccountInSql(db, user);
        expect(await acceptancesOf(db, user)).toEqual([]);
      });
    });
  });

  describe('écritures simultanées', () => {
    it('une acceptation lancée pendant la clôture du compte attend son issue, puis est refusée', async () => {
      await asApp((closing) =>
        asApp((accepting) =>
          asApp(async (observer) => {
            const user = await insertUser(observer);
            await closing.query('BEGIN');
            await insertClosureRecord(closing, user);
            await emptyAccount(closing, user);
            await markAccountClosed(closing, user);

            const acceptance = sqlState(() => acceptTermsInSql(accepting, user));
            await untilBlocked(observer);
            await closeVerificationCases(closing, user);
            await closing.query('COMMIT');

            expect(await acceptance).toBe(ACCOUNT_CLOSED);
            expect(await acceptancesOf(observer, user)).toEqual([]);
          }),
        ),
      );
    });

    it('une clôture lancée pendant une acceptation attend, puis l’efface avec le reste', async () => {
      await asApp((closing) =>
        asApp((accepting) =>
          asApp(async (observer) => {
            const user = await insertUser(observer);
            await accepting.query('BEGIN');
            await acceptTermsInSql(accepting, user);

            const closure = sqlState(() => closeAccountInSql(closing, user));
            await untilBlocked(observer);
            await accepting.query('COMMIT');

            expect(await closure).toBeUndefined();
            expect(await acceptancesOf(observer, user)).toEqual([]);
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
           WHERE proname IN ('mgx_is_terms_text', 'mgx_enforce_terms_version',
                             'mgx_enforce_terms_acceptance',
                             'mgx_forbid_closure_with_terms_acceptance')
           ORDER BY proname`,
        );
        expect(rows).toHaveLength(4);
        for (const { proname, proconfig } of rows) {
          expect({ proname, proconfig }).toEqual({
            proname,
            proconfig: ['search_path=public, pg_temp'],
          });
        }
      });
    });

    it('une copie des tables placée sur le chemin de recherche n’habilite pas un intrus, ni ne fait accepter une version qui n’existe pas', async () => {
      await asApp(async (db) => {
        const intruder = await insertUser(db);
        const holder = await insertUser(db);
        const current = await currentTermsNumber(db);

        // Dans son schéma temporaire : l'intrus y est administrateur, et la version en vigueur
        // y porte un autre numéro.
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
        await db.query(
          `CREATE TEMP TABLE terms_versions AS
           SELECT number - 1 AS number FROM public.terms_versions`,
        );
        await db.query(`SET search_path = pg_temp, public`);

        const row = [current + 1, 'Résumé.', 'Texte.', sha256Hex('Texte.'), intruder];
        expect(
          await attempt(db, () =>
            db.query(
              `INSERT INTO public.terms_versions
                 (number, requires_acceptance, summary_fr, body_fr, body_fr_sha256, published_by)
               VALUES ($1, true, $2, $3, $4, $5)`,
              row,
            ),
          ),
        ).toBe(TERMS_RULE_VIOLATION);
        // La version « en vigueur » de la copie n'est pas celle de la base.
        expect(
          await sqlState(() =>
            db.query(
              `INSERT INTO public.terms_acceptances (user_id, version_number) VALUES ($1, $2)`,
              [holder, current - 1],
            ),
          ),
        ).toBe(TERMS_VERSION_OUT_OF_SEQUENCE);
        expect(
          await attempt(db, () =>
            db.query(
              `INSERT INTO public.terms_acceptances (user_id, version_number) VALUES ($1, $2)`,
              [holder, current],
            ),
          ),
        ).toBeUndefined();
        await db.query(`RESET search_path`);
      });
    });
  });
});

/** Attend qu'une session soit bloquée sur le verrou consultatif des publications. */
async function untilAdvisoryWait(observer: pg.Client): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await observer.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks
       WHERE NOT granted AND locktype = 'advisory'
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('The second publication never waited for the first.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
