import type { SystemRoleKey } from '@mgx/contracts';
import { emailSchema, passwordSchema } from '@mgx/validation';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { AuditService } from '../../audit/application/audit.service.js';
import { checkPasswordPolicy, PASSWORD_REJECTION_MESSAGES } from '../domain/password-policy.js';
import type { PasswordHasher } from './password-hasher.js';
import type { UserRepository } from './user.repository.js';

export interface NewAdministrator {
  readonly email: string;
  readonly password: string;
  readonly countryCode: string;
}

export interface AdministratorBootstrapDependencies {
  readonly users: UserRepository;
  readonly hasher: PasswordHasher;
  readonly audit: AuditService;
}

/** Erreur de saisie de l'opérateur (adresse invalide, mot de passe refusé, compte existant). */
export class AdministratorBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdministratorBootstrapError';
  }
}

const BOOTSTRAP_ROLE: SystemRoleKey = 'super_admin';

/**
 * Crée le premier compte d'administration — opération d'exploitation, hors de l'API.
 *
 * Elle exige une connexion avec le **rôle propriétaire** de la base : le rôle applicatif
 * de l'API ne peut pas attribuer de rôle. Aucune route ne permet donc d'obtenir des droits
 * d'administration, même si l'API était compromise. L'opération est tracée dans l'audit.
 *
 * @param tx transaction ouverte avec le rôle propriétaire.
 * @returns l'identifiant du compte créé.
 */
export async function createAdministrator(
  tx: DbClient,
  { users, hasher, audit }: AdministratorBootstrapDependencies,
  input: NewAdministrator,
): Promise<string> {
  const email = emailSchema.safeParse(input.email);
  if (!email.success) {
    throw new AdministratorBootstrapError('The email address is not valid.');
  }
  const password = passwordSchema.safeParse(input.password);
  if (!password.success) {
    throw new AdministratorBootstrapError(
      password.error.issues[0]?.message ?? 'The password is not valid.',
    );
  }
  const rejection = checkPasswordPolicy(password.data, { email: email.data });
  if (rejection !== null) {
    throw new AdministratorBootstrapError(PASSWORD_REJECTION_MESSAGES[rejection]);
  }
  if ((await users.findByEmail(tx, email.data)) !== null) {
    throw new AdministratorBootstrapError('An account already exists for this email address.');
  }

  const now = new Date();
  const user = await users.create(tx, {
    email: email.data,
    phone: null,
    countryCode: input.countryCode,
    locale: 'fr',
    accountType: 'INDIVIDUAL',
    // L'opérateur répond de l'adresse : le compte est actif d'emblée.
    status: 'ACTIVE',
    emailVerifiedAt: now,
    termsAcceptedAt: now,
    passwordHash: await hasher.hash(password.data),
  });
  await users.grantRole(tx, user.id, BOOTSTRAP_ROLE, null);
  await audit.record(tx, {
    actor: { type: 'SYSTEM' },
    action: 'user.administrator_created',
    resource: { type: 'user', id: user.id },
    outcome: 'SUCCESS',
    metadata: { role: BOOTSTRAP_ROLE, origin: 'command-line' },
  });
  return user.id;
}
