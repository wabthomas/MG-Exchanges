import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

// Configuration de la CLI Prisma (generate, migrate). L'application, elle, ne lit jamais ce fichier.
//
// DATABASE_MIGRATION_URL : les migrations s'exécutent avec un rôle PostgreSQL distinct de celui
// de l'application (le propriétaire du schéma). À défaut, DATABASE_URL est utilisée, ce qui
// convient au développement local.
//
// SHADOW_DATABASE_URL : base « fantôme » jetable, distincte de la base principale. Prisma la
// vide puis y rejoue les migrations pour en déduire le schéma. Elle est exigée par
// `pnpm db:check-drift` et utilisée par `prisma migrate dev` lorsqu'elle est définie.
//
// Voir docs/DATABASE.md.
if (process.env['NODE_ENV'] !== 'production' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

/** Valeur d'une variable d'environnement ; une valeur vide équivaut à une variable absente. */
function setting(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

const url = setting('DATABASE_MIGRATION_URL') ?? setting('DATABASE_URL');
const shadowDatabaseUrl = setting('SHADOW_DATABASE_URL');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` n'a besoin d'aucune connexion : le bloc n'apparaît que s'il est renseigné.
  ...(url === undefined && shadowDatabaseUrl === undefined
    ? {}
    : {
        datasource: {
          ...(url === undefined ? {} : { url }),
          ...(shadowDatabaseUrl === undefined ? {} : { shadowDatabaseUrl }),
        },
      }),
});
