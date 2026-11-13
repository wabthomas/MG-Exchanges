import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * Environnement des tests d'intégration et de bout en bout.
 *
 * Une seule information externe est requise : `TEST_DATABASE_ADMIN_URL`, l'URL d'un
 * superutilisateur d'une instance PostgreSQL 18 **jetable**. Le harnais y crée lui-même les
 * rôles de test, une base modèle migrée par les **vraies migrations** (`prisma migrate
 * deploy`), puis une base par fichier de test — avec la même séparation de privilèges
 * qu'en production (rôle propriétaire des migrations / rôle applicatif restreint).
 */
export const TEST_OWNER_ROLE = 'mgx_test_owner';
export const TEST_APP_ROLE = 'mgx_test_app';
/** Identifiants de test uniquement : ces rôles n'existent que sur l'instance jetable. */
const TEST_OWNER_PASSWORD = 'mgx-test-owner-password';
const TEST_APP_PASSWORD = 'mgx-test-app-password';

export const TEMPLATE_DATABASE = 'mgx_test_template';

const API_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIRECTORY = join(API_DIRECTORY, 'prisma', 'migrations');
/** Verrou consultatif : une seule préparation de la base modèle à la fois. */
const TEMPLATE_LOCK_ID = 720_011;

const GRANT_SQL_PATH = fileURLToPath(
  new URL(
    '../../../../infrastructure/docker/postgres/sql/grant-app-privileges.sql',
    import.meta.url,
  ),
);

export function adminUrl(): string {
  const url = process.env['TEST_DATABASE_ADMIN_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is required to run integration and e2e tests ' +
        '(superuser URL of a disposable PostgreSQL 18 instance). See README.md.',
    );
  }
  return url;
}

export function redisUrl(): string {
  return process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15';
}

function urlFor(database: string, role: string, password: string): string {
  const url = new URL(adminUrl());
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export const ownerUrl = (database: string): string =>
  urlFor(database, TEST_OWNER_ROLE, TEST_OWNER_PASSWORD);
export const appUrl = (database: string): string =>
  urlFor(database, TEST_APP_ROLE, TEST_APP_PASSWORD);

/** Exécute `work` avec une connexion superutilisateur, toujours refermée. */
export async function withAdmin<T>(
  work: (client: pg.Client) => Promise<T>,
  database?: string,
): Promise<T> {
  const url = new URL(adminUrl());
  if (database !== undefined) {
    url.pathname = `/${database}`;
  }
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Crée les rôles de test (propriétaire / applicatif) s'ils n'existent pas. */
async function ensureTestRoles(admin: pg.Client): Promise<void> {
  for (const [role, password] of [
    [TEST_OWNER_ROLE, TEST_OWNER_PASSWORD],
    [TEST_APP_ROLE, TEST_APP_PASSWORD],
  ] as const) {
    const existing = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
  }
}

/** Applique à `database` la séparation de privilèges utilisée en production. */
async function grantAppPrivileges(database: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(`SET mgx.owner_role = '${TEST_OWNER_ROLE}'`);
    await admin.query(`SET mgx.app_role = '${TEST_APP_ROLE}'`);
    await admin.query(readFileSync(GRANT_SQL_PATH, 'utf8'));
  }, database);
}

/** Empreinte de tout ce qui définit le schéma : migrations et script de privilèges. */
function schemaFingerprint(): string {
  const hash = createHash('sha256').update(readFileSync(GRANT_SQL_PATH));
  const files = (readdirSync(MIGRATIONS_DIRECTORY, { recursive: true }) as string[])
    .map((file) => join(MIGRATIONS_DIRECTORY, file))
    .filter((file) => statSync(file).isFile())
    .sort();
  for (const file of files) {
    hash.update(file.slice(MIGRATIONS_DIRECTORY.length)).update(readFileSync(file));
  }
  return hash.digest('hex');
}

let templateReady: Promise<void> | undefined;

/**
 * Prépare la base modèle si elle est absente ou si les migrations ont changé : rôles,
 * privilèges, puis schéma créé par `prisma migrate deploy` avec le rôle propriétaire.
 * Chaque fichier de test en obtient ensuite une copie instantanée (CREATE DATABASE … TEMPLATE).
 */
export function ensureTemplateDatabase(): Promise<void> {
  templateReady ??= withAdmin(async (admin) => {
    const fingerprint = schemaFingerprint();
    await admin.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_ID]);
    try {
      const current = await admin.query<{ fingerprint: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS fingerprint
         FROM pg_database WHERE datname = $1`,
        [TEMPLATE_DATABASE],
      );
      if (current.rows[0]?.fingerprint === fingerprint) {
        return;
      }

      await ensureTestRoles(admin);
      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE} OWNER ${TEST_OWNER_ROLE}`);
      await grantAppPrivileges(TEMPLATE_DATABASE);

      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: API_DIRECTORY,
        env: { ...process.env, DATABASE_MIGRATION_URL: ownerUrl(TEMPLATE_DATABASE) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      await admin.query(`COMMENT ON DATABASE ${TEMPLATE_DATABASE} IS '${fingerprint}'`);
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_ID]);
    }
  });
  return templateReady;
}
