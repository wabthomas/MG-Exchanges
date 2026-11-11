import type { AccountType, PermissionKey, UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { UserRecord } from '../domain/user.js';

export interface NewUser {
  readonly email: string;
  readonly phone: string | null;
  readonly countryCode: string;
  readonly locale: string;
  readonly accountType: AccountType;
  readonly status: UserStatus;
  readonly emailVerifiedAt: Date | null;
  readonly termsAcceptedAt: Date;
  readonly passwordHash: string;
}

export interface UserWithPasswordHash {
  readonly user: UserRecord;
  /** `null` si le compte n'a pas de mot de passe (cas anormal : la connexion est refusée). */
  readonly passwordHash: string | null;
}

export interface UserAccess {
  readonly roles: readonly string[];
  readonly permissions: readonly PermissionKey[];
}

/**
 * L'adresse e-mail est déjà prise — y compris par une création concurrente. La transaction
 * en cours est alors inutilisable : l'appelant recommence dans une nouvelle transaction.
 */
export class EmailAlreadyTakenError extends Error {
  constructor() {
    super('Email address already taken.');
    this.name = 'EmailAlreadyTakenError';
  }
}

/** Port de persistance des comptes, de leur secret et de leurs droits. */
export abstract class UserRepository {
  abstract findById(db: DbClient, userId: string): Promise<UserRecord | null>;

  abstract findByEmail(db: DbClient, email: string): Promise<UserRecord | null>;

  abstract findByEmailWithPasswordHash(
    db: DbClient,
    email: string,
  ): Promise<UserWithPasswordHash | null>;

  abstract findPasswordHash(db: DbClient, userId: string): Promise<string | null>;

  /**
   * Crée le compte et son secret.
   * @throws EmailAlreadyTakenError si l'adresse e-mail est déjà prise.
   */
  abstract create(tx: DbClient, user: NewUser): Promise<UserRecord>;

  /** Marque l'adresse comme vérifiée ; un compte en attente de vérification devient actif. */
  abstract markEmailVerified(tx: DbClient, userId: string, now: Date): Promise<void>;

  /** Enregistre un **nouveau** mot de passe (date de changement mise à jour). */
  abstract updatePasswordHash(
    db: DbClient,
    userId: string,
    passwordHash: string,
    now: Date,
  ): Promise<void>;

  /** Remplace l'empreinte du **même** mot de passe, recalculée avec des paramètres plus forts. */
  abstract replacePasswordHash(db: DbClient, userId: string, passwordHash: string): Promise<void>;

  /** Rôles du compte et permissions qui en découlent. */
  abstract findAccess(db: DbClient, userId: string): Promise<UserAccess>;

  /** Attribue un rôle système au compte (amorçage : exige le rôle propriétaire de la base). */
  abstract grantRole(
    tx: DbClient,
    userId: string,
    roleKey: string,
    grantedBy: string | null,
  ): Promise<void>;
}
