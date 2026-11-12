import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

/** Champs du profil ; `null` signifie « non renseigné ». */
export interface ProfileFields {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly additionalName: string | null;
  /** Minuit UTC du jour de naissance. */
  readonly dateOfBirth: Date | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly timeZone: string | null;
}

export interface ProfileRecord extends ProfileFields {
  readonly updatedAt: Date;
}

/** Port de persistance du profil déclaré par l'utilisateur. */
export abstract class ProfileRepository {
  abstract find(db: DbClient, userId: string): Promise<ProfileRecord | null>;

  /** Applique les seuls champs fournis, en créant le profil s'il n'existe pas. */
  abstract save(tx: DbClient, userId: string, changes: Partial<ProfileFields>): Promise<void>;
}
