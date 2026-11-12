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

/** Ce qu'un demandeur déclare en s'inscrivant, et qui remplace une inscription inachevée. */
export interface PendingRegistration {
  readonly phone: string | null;
  readonly countryCode: string;
  readonly locale: string;
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

/**
 * Le numéro de téléphone est déjà vérifié sur un autre compte. La transaction en cours est
 * alors inutilisable.
 */
export class PhoneAlreadyVerifiedError extends Error {
  constructor() {
    super('Phone number already verified on another account.');
    this.name = 'PhoneAlreadyVerifiedError';
  }
}

/** Port de persistance des comptes, de leur secret et de leurs droits. */
export abstract class UserRepository {
  abstract findById(db: DbClient, userId: string): Promise<UserRecord | null>;

  /**
   * Compte qui porte cette adresse. Un compte clôturé n'en porte plus : il n'est jamais trouvé
   * ainsi — ni par son ancienne adresse, ni par l'adresse factice qui la remplace.
   */
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

  /**
   * Remplace l'inscription **inachevée** d'un compte par une nouvelle : mot de passe et
   * informations déclarées sont ceux du dernier demandeur — rien de ce qu'un précédent
   * demandeur a saisi ne subsiste.
   * @returns faux si le compte n'est plus en attente de vérification (rien n'est modifié).
   */
  abstract replacePendingRegistration(
    tx: DbClient,
    userId: string,
    registration: PendingRegistration,
  ): Promise<boolean>;

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

  /** Change la langue des messages adressés au titulaire du compte. */
  abstract updateLocale(tx: DbClient, userId: string, locale: string): Promise<void>;

  /**
   * Enregistre le numéro de téléphone du compte comme **vérifié**.
   * @throws PhoneAlreadyVerifiedError si ce numéro est déjà vérifié sur un autre compte.
   */
  abstract setVerifiedPhone(tx: DbClient, userId: string, phone: string, now: Date): Promise<void>;

  /**
   * Fait passer le compte d'un statut à un autre.
   * @returns faux si le compte n'avait pas (ou plus) le statut attendu : rien n'est modifié.
   */
  abstract changeStatus(
    tx: DbClient,
    userId: string,
    from: UserStatus,
    to: UserStatus,
  ): Promise<boolean>;

  /** Inscriptions dont l'adresse n'a jamais été vérifiée, antérieures à `registeredBefore`. */
  abstract findUnverifiedRegistrations(
    db: DbClient,
    registeredBefore: Date,
    limit: number,
  ): Promise<string[]>;

  /**
   * Supprime une inscription restée sans vérification — ce n'est pas encore un compte —, avec
   * son secret et ses codes.
   * @returns faux si elle n'existe plus, a été vérifiée ou renouvelée entre-temps.
   */
  abstract deleteUnverifiedRegistration(
    tx: DbClient,
    userId: string,
    registeredBefore: Date,
  ): Promise<boolean>;

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
