import type { KycVerifiedLevel } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

/** Identité vérifiée sur une pièce (dossier de niveau 1 accepté). */
export interface VerifiedIdentity {
  readonly givenName: string;
  readonly familyName: string;
  readonly additionalName: string | null;
  /** Minuit UTC du jour de naissance. */
  readonly dateOfBirth: Date;
  readonly placeOfBirth: string;
  readonly nationality: string;
}

/**
 * Adresse vérifiée sur un justificatif (dossier de niveau 2 accepté). Elle ne vaut que tant que
 * l'identité est elle-même vérifiée.
 */
export interface VerifiedAddress {
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string | null;
}

export interface VerificationStatus {
  /** Niveau vérifié : de 0 (aucun) à 3. */
  readonly level: KycVerifiedLevel;
  readonly identity: VerifiedIdentity | null;
  readonly address: VerifiedAddress | null;
}

/**
 * Ce que la vérification d'identité a établi pour un compte.
 *
 * Lecture seule : les dossiers de vérification appartiennent au module KYC, qui est seul à les
 * écrire. Ce qu'un dossier accepté établit **prime** sur ce que le titulaire déclare dans son
 * profil, et ne se modifie plus par lui.
 */
export abstract class VerificationStatusReader {
  abstract read(db: DbClient, userId: string): Promise<VerificationStatus>;

  /** Niveau vérifié seul, pour les lectures fréquentes. */
  abstract level(db: DbClient, userId: string): Promise<KycVerifiedLevel>;
}
