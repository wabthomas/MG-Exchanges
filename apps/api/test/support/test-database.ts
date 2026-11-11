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
