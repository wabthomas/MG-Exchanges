import { randomBytes } from 'node:crypto';

import pg from 'pg';

import {
  appUrl,
  ensureTemplateDatabase,
  ownerUrl,
  TEMPLATE_DATABASE,
  TEST_OWNER_ROLE,
  withAdmin,
} from './test-environment.js';

export interface TestDatabase {
  readonly name: string;
  /** URL du rôle applicatif (celui de l'API à l'exécution). */
  readonly appUrl: string;
  /** URL du rôle propriétaire (celui des migrations). */
  readonly ownerUrl: string;
  drop(): Promise<void>;
}

/** Crée une base isolée, copie de la base modèle migrée. */
export async function createTestDatabase(): Promise<TestDatabase> {
  await ensureTemplateDatabase();

  const name = `mgx_test_${randomBytes(6).toString('hex')}`;
  await withAdmin((admin) =>
    admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE} OWNER ${TEST_OWNER_ROLE}`),
  );

  return {
    name,
    appUrl: appUrl(name),
    ownerUrl: ownerUrl(name),
    drop: async () => {
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Exécute `work` avec une connexion SQL directe, toujours refermée. */
export async function withConnection<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Code SQLSTATE de l'erreur levée par `action`, ou `undefined` si elle réussit. */
export async function sqlState(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

/**
 * Attend qu'une session de la base soit bloquée sur un verrou de ligne : la preuve qu'une
 * écriture attend l'issue d'une autre, et non qu'elle a simplement pris du temps.
 */
export async function untilBlocked(observer: pg.Client): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await observer.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks
       WHERE NOT granted AND locktype IN ('transactionid', 'tuple')
         AND database IS NOT DISTINCT FROM
           CASE WHEN locktype = 'tuple'
             THEN (SELECT oid FROM pg_database WHERE datname = current_database())
           END`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('The second transaction never waited for the first.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
