import type { UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { UserRecord } from '../domain/user.js';

/** Compte tel que le présente l'annuaire du back-office. */
export interface DirectoryEntry extends UserRecord {
  readonly termsAcceptedAt: Date;
  readonly updatedAt: Date;
  /** Rôles du back-office détenus par le compte. */
  readonly roles: readonly string[];
  readonly secondFactorEnabled: boolean;
}

export interface DirectoryFilter {
  /** Identifiants complets : au plus un. */
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly id?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly limit: number;
  /** Curseur : ne retourner que les comptes créés avant celui-ci. */
  readonly before?: string | undefined;
}

/**
 * Annuaire des comptes, à l'usage du back-office : recherche par identifiant complet et
 * parcours. Lecture seule ; ne donne jamais accès à un secret d'authentification.
 */
export abstract class UserDirectory {
  /** Comptes correspondant au filtre, du plus récent au plus ancien. */
  abstract search(db: DbClient, filter: DirectoryFilter): Promise<DirectoryEntry[]>;

  abstract find(db: DbClient, userId: string): Promise<DirectoryEntry | null>;
}
