import type { AccountClosureOrigin, UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

/** Trace de la clôture d'un compte. */
export interface ClosureRecord {
  readonly userId: string;
  readonly closedAt: Date;
  readonly origin: AccountClosureOrigin;
  /** Le titulaire lui-même, ou le membre du personnel. */
  readonly closedBy: string;
  /** Adresse et numéro que portait le compte ; `null` une fois effacés. */
  readonly email: string | null;
  readonly phone: string | null;
  readonly legalRetentionUntil: Date | null;
  readonly erasureDueAt: Date;
  readonly erasedAt: Date | null;
}

/** Compte verrouillé en vue de sa clôture. */
export interface LockedAccount {
  readonly status: UserStatus;
  readonly email: string;
  readonly phone: string | null;
  readonly locale: string;
  /** Vrai si le compte détient au moins un rôle du back-office. */
  readonly holdsRole: boolean;
}

export type NewClosure = Omit<ClosureRecord, 'erasedAt'> & { readonly email: string };

/** La base de données a refusé la clôture ou l'effacement (règle `MGX04`). */
export class ClosureRuleViolationError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the account closure.', options);
    this.name = 'ClosureRuleViolationError';
  }
}

/** Port de persistance de la clôture des comptes. */
export abstract class AccountClosureRepository {
  /**
   * Borne, pour la transaction en cours, l'attente de chaque verrou : au-delà, l'instruction
   * échoue (`isLockContention`) au lieu d'attendre, et la transaction est à refaire.
   */
  abstract boundLockWaits(tx: DbClient, milliseconds: number): Promise<void>;

  /**
   * Verrouille le compte jusqu'à la fin de la transaction : tout ce qui s'y ajouterait attend,
   * puis est refusé. `null` si le compte n'existe pas.
   */
  abstract lockAccount(tx: DbClient, userId: string): Promise<LockedAccount | null>;

  /**
   * Clôt le compte : écrit la trace de la clôture, efface ses secrets, ses sessions, ses codes
   * et son profil, puis lui retire son adresse et son numéro.
   *
   * @returns le nombre de sessions fermées.
   * @throws ClosureRuleViolationError si la base refuse la clôture.
   */
  abstract close(tx: DbClient, closure: NewClosure): Promise<number>;

  abstract find(db: DbClient, userId: string): Promise<ClosureRecord | null>;

  /**
   * Comptes clôturés qui portaient cette adresse ou ce numéro, tant qu'ils n'ont pas été
   * effacés — du plus récemment clôturé au plus ancien.
   */
  abstract findByFormerIdentifier(
    db: DbClient,
    identifier: { readonly email?: string | undefined; readonly phone?: string | undefined },
    limit: number,
  ): Promise<string[]>;

  /** Clôtures dont l'échéance d'effacement est atteinte, les plus anciennes d'abord. */
  abstract findDueForErasure(db: DbClient, now: Date, limit: number): Promise<ClosureRecord[]>;

  /**
   * Constate l'effacement : la trace perd l'adresse et le numéro du compte.
   *
   * @returns faux si l'effacement avait déjà été constaté.
   * @throws ClosureRuleViolationError si la base le refuse (conservation légale en cours,
   *   données encore présentes).
   */
  abstract markErased(tx: DbClient, userId: string, now: Date): Promise<boolean>;
}
