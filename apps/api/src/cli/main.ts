import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { countryCodeSchema } from '@mgx/validation';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';

import { MIN_PASSWORD_HASH_MEMORY_KIB, MIN_PASSWORD_HASH_PASSES } from '../config/env.schema.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { AuditService } from '../modules/audit/application/audit.service.js';
import {
  AdministratorBootstrapError,
  createAdministrator,
} from '../modules/identity/application/administrator-bootstrap.js';
import { Argon2PasswordHasher } from '../modules/identity/infrastructure/argon2-password-hasher.js';
import { PrismaUserRepository } from '../modules/identity/infrastructure/prisma-user.repository.js';

/**
 * Outil d'exploitation en ligne de commande — distinct de l'API, qu'il ne démarre pas.
 *
 * `admin:create` crée le premier compte d'administration. Il se connecte avec le **rôle
 * propriétaire** de la base (`DATABASE_MIGRATION_URL`), seul autorisé à attribuer un rôle :
 * l'API, elle, ne le peut pas.
 */
const USAGE = `Usage: node dist/cli/main.js admin:create --email <address> [--country <ISO code>]

Creates an administrator account (role "super_admin").

Environment:
  DATABASE_MIGRATION_URL   PostgreSQL URL of the schema owner role (required)
  MGX_ADMIN_PASSWORD       password of the new account (required, at least 10 characters)

Example:
  read -rs MGX_ADMIN_PASSWORD && export MGX_ADMIN_PASSWORD
  node dist/cli/main.js admin:create --email admin@example.com
`;

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_FAILURE = 2;

const environmentSchema = z.object({
  DATABASE_MIGRATION_URL: z
    .string({ error: 'DATABASE_MIGRATION_URL is required (schema owner role).' })
    .regex(/^postgres(ql)?:\/\//, { error: 'DATABASE_MIGRATION_URL must be a PostgreSQL URL.' }),
  MGX_ADMIN_PASSWORD: z.string({ error: 'MGX_ADMIN_PASSWORD is required.' }),
  // Jamais en dessous du coût exigé en production, quel que soit l'environnement.
  AUTH_PASSWORD_HASH_MEMORY_KIB: z.coerce
    .number()
    .int()
    .min(MIN_PASSWORD_HASH_MEMORY_KIB)
    .default(MIN_PASSWORD_HASH_MEMORY_KIB),
  AUTH_PASSWORD_HASH_PASSES: z.coerce
    .number()
    .int()
    .min(MIN_PASSWORD_HASH_PASSES)
    .default(MIN_PASSWORD_HASH_PASSES),
});

function fail(message: string, code: number): number {
  process.stderr.write(`${message}\n`);
  return code;
}

async function createAdmin(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' }, country: { type: 'string', default: 'CD' } },
  });
  if (values.email === undefined) {
    return fail(USAGE, EXIT_USAGE);
  }
  const country = countryCodeSchema.safeParse(values.country);
  if (!country.success) {
    return fail('--country must be a two-letter ISO 3166-1 code, e.g. "CD".', EXIT_USAGE);
  }

  const defined = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const environment = environmentSchema.safeParse(defined);
  if (!environment.success) {
    // Les messages ne contiennent jamais la valeur d'une variable.
    return fail(environment.error.issues.map((issue) => issue.message).join('\n'), EXIT_USAGE);
  }
  const env = environment.data;

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_MIGRATION_URL }),
  });
  try {
    const userId = await prisma.$transaction((tx) =>
      createAdministrator(
        tx,
        {
          users: new PrismaUserRepository(),
          hasher: new Argon2PasswordHasher({
            memoryKib: env.AUTH_PASSWORD_HASH_MEMORY_KIB,
            passes: env.AUTH_PASSWORD_HASH_PASSES,
          }),
          audit: new AuditService(),
        },
        { email: values.email ?? '', password: env.MGX_ADMIN_PASSWORD, countryCode: country.data },
      ),
    );
    process.stdout.write(`Administrator account created: ${userId}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof AdministratorBootstrapError) {
      return fail(error.message, EXIT_USAGE);
    }
    // Ni mot de passe ni URL de connexion dans la sortie : seulement la nature de l'erreur.
    const reason = error instanceof Error ? error.name : 'unknown error';
    return fail(`The administrator account could not be created (${reason}).`, EXIT_FAILURE);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'admin:create') {
    return createAdmin(args);
  }
  return fail(USAGE, command === undefined || command === '--help' ? EXIT_OK : EXIT_USAGE);
}

// Développement local uniquement : charge `.env` s'il existe (même règle que l'API).
if (process.env['NODE_ENV'] !== 'production' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

process.exitCode = await main(process.argv.slice(2));
