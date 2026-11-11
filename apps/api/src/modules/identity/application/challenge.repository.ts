import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { Digest } from './digest.js';

export type ChallengePurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface NewChallenge {
  readonly userId: string;
  readonly purpose: ChallengePurpose;
  /** Adresse à laquelle le code sera envoyé. */
  readonly target: string;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
}

export interface ChallengeRecord {
  readonly id: string;
  readonly userId: string;
  readonly purpose: ChallengePurpose;
  readonly target: string;
  /** `null` tant que le code n'a pas été émis. */
  readonly codeHash: Uint8Array | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
}

/** Port de persistance des codes à usage unique (« défis »). */
export abstract class ChallengeRepository {
  /**
   * Ouvre un nouveau défi en annulant celui qui était en cours pour le même compte et le
   * même usage : un seul code est valable à la fois. Les demandes simultanées sont
   * sérialisées. @returns l'identifiant du défi.
   */
  abstract replaceActive(tx: DbClient, challenge: NewChallenge): Promise<string>;

  /** Défi en cours (ni utilisé, ni annulé) du compte pour cet usage — qu'il soit expiré ou non. */
  abstract findActive(
    db: DbClient,
    userId: string,
    purpose: ChallengePurpose,
  ): Promise<ChallengeRecord | null>;

  /** Défi en cours désigné par son identifiant. */
  abstract findActiveById(db: DbClient, challengeId: string): Promise<ChallengeRecord | null>;

  /** Enregistre l'empreinte du code émis. @returns faux si le défi n'est plus en cours. */
  abstract setCodeHash(db: DbClient, challengeId: string, codeHash: Digest): Promise<boolean>;

  /**
   * Compte un essai, de façon atomique. @returns faux si le défi n'est plus en cours ou si le
   * nombre maximal d'essais est atteint — le code présenté ne doit alors pas être examiné.
   */
  abstract registerAttempt(db: DbClient, challengeId: string): Promise<boolean>;

  /** Marque le défi comme utilisé. @returns faux s'il ne l'était plus (utilisation concurrente). */
  abstract consume(tx: DbClient, challengeId: string, now: Date): Promise<boolean>;
}
