import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { Digest } from './digest.js';

export interface TotpCredential {
  readonly userId: string;
  /** Secret chiffré : seul `SecretCipher` sait le lire. */
  readonly secretCiphertext: Uint8Array;
  /** `null` tant que l'enrôlement n'est pas confirmé. */
  readonly confirmedAt: Date | null;
  readonly lastUsedStep: number | null;
  /** Date de l'enrôlement (du dernier, s'il a été recommencé). */
  readonly createdAt: Date;
}

/** Port de persistance du second facteur : secret TOTP et codes de secours. */
export abstract class MfaRepository {
  abstract findTotp(db: DbClient, userId: string): Promise<TotpCredential | null>;

  /** Vrai si le compte a un second facteur **confirmé** : la connexion l'exige alors. */
  abstract isTotpEnabled(db: DbClient, userId: string): Promise<boolean>;

  /**
   * Enregistre un secret en attente de confirmation, en remplaçant un enrôlement resté inachevé.
   * @returns faux si le compte a déjà un second facteur confirmé (rien n'est modifié).
   */
  abstract savePendingTotp(
    db: DbClient,
    userId: string,
    secretCiphertext: Digest,
  ): Promise<boolean>;

  /**
   * Confirme l'enrôlement et retient le pas de temps du code qui l'a confirmé.
   * @returns faux s'il n'y avait pas d'enrôlement en attente (confirmation concurrente).
   */
  abstract confirmTotp(tx: DbClient, userId: string, step: number, now: Date): Promise<boolean>;

  /**
   * Retient le pas de temps d'un code accepté — s'il est postérieur au dernier retenu.
   * @returns faux si un code de ce pas, ou d'un pas ultérieur, a déjà été accepté (rejeu).
   */
  abstract markTotpStepUsed(db: DbClient, userId: string, step: number): Promise<boolean>;

  /** Supprime le second facteur et ses codes de secours. @returns faux s'il n'y en avait pas. */
  abstract deleteTotp(tx: DbClient, userId: string): Promise<boolean>;

  /** Remplace tous les codes de secours du compte par ceux dont voici les empreintes. */
  abstract replaceRecoveryCodes(
    tx: DbClient,
    userId: string,
    codeHashes: readonly Digest[],
  ): Promise<void>;

  /**
   * Consomme un code de secours, de façon atomique.
   * @returns faux si le code est inconnu ou déjà utilisé.
   */
  abstract useRecoveryCode(
    db: DbClient,
    userId: string,
    codeHash: Digest,
    now: Date,
  ): Promise<boolean>;

  abstract countUnusedRecoveryCodes(db: DbClient, userId: string): Promise<number>;

  /** Supprime les enrôlements restés sans confirmation depuis `startedBefore`. @returns leur nombre. */
  abstract deleteStalePendingTotp(db: DbClient, startedBefore: Date): Promise<number>;
}
