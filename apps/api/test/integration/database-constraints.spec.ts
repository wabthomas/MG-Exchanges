import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type pg from 'pg';

import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';

/** SQLSTATE levé par les déclencheurs des tables en ajout seul. */
const APPEND_ONLY_VIOLATION = 'MGX01';
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

const INSERT_AUDIT = `
  INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, outcome)
  VALUES ('USER', 'user-1', 'system_setting.updated', 'system_setting', 'SUCCESS')
  RETURNING id`;

describe('Garanties portées par la base de données elle-même', () => {
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

  describe('journal d’audit en ajout seul', () => {
    it('le rôle applicatif peut insérer et lire', async () => {
      await asApp(async (db) => {
        const inserted = await db.query<{ id: string }>(INSERT_AUDIT);
        const read = await db.query('SELECT action FROM audit_logs WHERE id = $1', [
          inserted.rows[0]?.id,
        ]);
        expect(read.rows).toEqual([{ action: 'system_setting.updated' }]);
      });
    });

    it('le rôle applicatif ne peut ni modifier, ni supprimer, ni vider le journal', async () => {
      await asApp(async (db) => {
        await db.query(INSERT_AUDIT);
        const rejected = [APPEND_ONLY_VIOLATION, INSUFFICIENT_PRIVILEGE];
        expect(rejected).toContain(
          await sqlState(() => db.query("UPDATE audit_logs SET action = 'x.y'")),
        );
        expect(rejected).toContain(await sqlState(() => db.query('DELETE FROM audit_logs')));
        expect(rejected).toContain(await sqlState(() => db.query('TRUNCATE audit_logs')));

        const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs');
        expect(count.rows[0]?.n).toBeGreaterThan(0);
      });
    });

    it('les privilèges UPDATE / DELETE / TRUNCATE sont retirés au rôle applicatif', async () => {
      await asApp(async (db) => {
        const privileges = await db.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE table_name = 'audit_logs' AND grantee = current_user ORDER BY 1`,
        );
        expect(privileges.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
      });
    });

    it('même le propriétaire du schéma est bloqué par les déclencheurs', async () => {
      await asOwner(async (db) => {
        await db.query(INSERT_AUDIT);
        expect(await sqlState(() => db.query("UPDATE audit_logs SET action = 'x.y'"))).toBe(
          APPEND_ONLY_VIOLATION,
        );
        expect(await sqlState(() => db.query('DELETE FROM audit_logs'))).toBe(
          APPEND_ONLY_VIOLATION,
        );
        expect(await sqlState(() => db.query('TRUNCATE audit_logs'))).toBe(APPEND_ONLY_VIOLATION);
      });
    });

    it('refuse les entrées incohérentes', async () => {
      await asApp(async (db) => {
        const insert = (columns: string, values: string) => () =>
          db.query(`INSERT INTO audit_logs (${columns}) VALUES (${values})`);
        const base = 'action, resource_type, outcome';

        // Un acteur SYSTEM n'a pas d'identifiant ; tout autre acteur en a un.
        expect(
          await sqlState(
            insert(`actor_type, actor_id, ${base}`, "'SYSTEM', 'x', 'a.b', 'r', 'SUCCESS'"),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(await sqlState(insert(`actor_type, ${base}`, "'USER', 'a.b', 'r', 'SUCCESS'"))).toBe(
          CHECK_VIOLATION,
        );
        // Format de l'action : `ressource.verbe`.
        expect(
          await sqlState(insert(`actor_type, ${base}`, "'SYSTEM', 'Not Valid', 'r', 'SUCCESS'")),
        ).toBe(CHECK_VIOLATION);
        // Les métadonnées sont un objet JSON.
        expect(
          await sqlState(
            insert(
              `actor_type, ${base}, metadata`,
              "'SYSTEM', 'a.b', 'r', 'SUCCESS', '[1]'::jsonb",
            ),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(insert(`actor_type, ${base}`, "'SYSTEM', 'a.b', 'r', 'SUCCESS'")),
        ).toBeUndefined();
      });
    });
  });

  describe('séparation des privilèges', () => {
    it('le rôle applicatif ne peut pas modifier le schéma', async () => {
      await asApp(async (db) => {
        expect(await sqlState(() => db.query('CREATE TABLE intruder (id int)'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await sqlState(() => db.query('DROP TABLE system_settings'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await sqlState(() => db.query('ALTER TABLE audit_logs DISABLE TRIGGER ALL'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await sqlState(() => db.query('TRUNCATE system_settings'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
    });

    it('le rôle applicatif n’a aucun accès à l’historique des migrations', async () => {
      await asApp(async (db) => {
        for (const statement of [
          'SELECT 1 FROM _prisma_migrations',
          `INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('x', 'x', 'x')`,
          `UPDATE _prisma_migrations SET checksum = 'tampered'`,
          'DELETE FROM _prisma_migrations',
        ]) {
          expect(await sqlState(() => db.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
        }
      });

      // Le propriétaire — le rôle qui exécute les migrations — y accède toujours.
      await asOwner(async (db) => {
        const applied = await db.query(
          'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
        );
        expect(applied.rowCount).toBeGreaterThan(0);
      });
    });

    it('le rôle applicatif lit et écrit les données métier', async () => {
      await asApp(async (db) => {
        await db.query(`INSERT INTO system_settings (key, value) VALUES ('features.p2p', 'true')`);
        await db.query(`UPDATE system_settings SET value = 'false' WHERE key = 'features.p2p'`);
        await db.query(`DELETE FROM system_settings WHERE key = 'features.p2p'`);
      });
    });
  });

  describe('contraintes de cohérence', () => {
    it('system_settings : format de clé et version', async () => {
      await asApp(async (db) => {
        const insert =
          (key: string, version = 1) =>
          () =>
            db.query('INSERT INTO system_settings (key, value, version) VALUES ($1, $2, $3)', [
              key,
              'true',
              version,
            ]);
        expect(await sqlState(insert('Features.P2P'))).toBe(CHECK_VIOLATION);
        expect(await sqlState(insert('features..p2p'))).toBe(CHECK_VIOLATION);
        expect(await sqlState(insert('features.ok', 0))).toBe(CHECK_VIOLATION);
        expect(await sqlState(insert('features.ok'))).toBeUndefined();
      });
    });

    it('outbox_events : un événement est publié si et seulement s’il porte une date de publication', async () => {
      await asApp(async (db) => {
        const created = await db.query<{ id: string }>(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('thing', '1', 'thing.happened', '{}') RETURNING id`,
        );
        const id = created.rows[0]?.id;
        expect(
          await sqlState(() =>
            db.query(`UPDATE outbox_events SET status = 'PUBLISHED' WHERE id = $1`, [id]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(() =>
            db.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [id]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(() =>
            db.query(`UPDATE outbox_events SET attempts = -1 WHERE id = $1`, [id]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(() =>
            db.query(
              `UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
              [id],
            ),
          ),
        ).toBeUndefined();
      });
    });

    it('les identifiants UUID v7 générés par la base sont ordonnés dans le temps', async () => {
      await asApp(async (db) => {
        const ids: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          const inserted = await db.query<{ id: string }>(INSERT_AUDIT);
          ids.push(inserted.rows[0]!.id);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(ids.every((id) => id[14] === '7')).toBe(true);
        expect([...ids].sort()).toEqual(ids);
      });
    });

    it('l’index partiel de la file du relais existe', async () => {
      await asApp(async (db) => {
        const index = await db.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_events_pending_idx'`,
        );
        expect(index.rows[0]?.indexdef).toContain("WHERE (status = 'PENDING'::outbox_status)");
      });
    });
  });
});
