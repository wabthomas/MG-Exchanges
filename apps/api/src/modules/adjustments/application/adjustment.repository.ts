import type { LedgerAdjustmentDirection, LedgerAdjustmentStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

/** Ajustement tel que la base l'a conservé. Le montant est un entier d'unités minimales de l'actif. */
export interface AdjustmentRecord {
  readonly id: string;
  /** Titulaire du portefeuille. */
  readonly userId: string;
  readonly assetCode: string;
  readonly direction: LedgerAdjustmentDirection;
  readonly units: bigint;
  readonly reason: string;
  readonly status: LedgerAdjustmentStatus;
  readonly requestedBy: string;
  /** Heure de la demande et échéance, fixées par la base. */
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  /** `null` pour une demande en attente ou échue. */
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  /** Écriture du grand livre ; `null` tant que l'ajustement n'est pas approuvé. */
  readonly entryId: string | null;
}

export interface NewAdjustment {
  readonly userId: string;
  readonly assetCode: string;
  readonly direction: LedgerAdjustmentDirection;
  readonly units: bigint;
  readonly reason: string;
  readonly requestedBy: string;
}

/** Approbation : l'écriture qui réalise l'ajustement vient d'être passée. */
export interface AdjustmentApproval {
  readonly decidedBy: string;
  readonly note: string | null;
  readonly entryId: string;
}

/** Refus par un second membre du personnel, ou retrait par l'auteur. */
export interface AdjustmentClosure {
  readonly status: 'REJECTED' | 'CANCELLED';
  readonly decidedBy: string;
  readonly note: string | null;
}

export interface AdjustmentFilter {
  readonly status?: LedgerAdjustmentStatus | undefined;
  readonly userId?: string | undefined;
  /** Ajustements antérieurs à celui-ci (identifiant du dernier de la page précédente). */
  readonly beforeId?: string | undefined;
  readonly limit: number;
}

/**
 * Une demande identique — même portefeuille, même sens, même montant — est déjà en attente. La
 * transaction est inutilisable.
 */
export class PendingAdjustmentExistsError extends Error {
  constructor() {
    super('An identical adjustment is already pending for this wallet.');
    this.name = 'PendingAdjustmentExistsError';
  }
}

/**
 * La base de données a refusé la demande ou la décision : une règle de la double validation
 * n'est pas (ou plus) respectée — demande échue, intervenant qui n'a plus qualité, écriture
 * qui n'est pas celle de l'ajustement. La transaction est inutilisable.
 */
export class AdjustmentRefusedByDatabaseError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the ledger adjustment.', options);
    this.name = 'AdjustmentRefusedByDatabaseError';
  }
}

/**
 * Port de persistance des ajustements manuels.
 *
 * Il ne passe aucune écriture : l'écriture d'un ajustement approuvé passe par le grand livre,
 * dans la transaction de l'approbation, et la base vérifie à sa validation que l'une va bien
 * avec l'autre (voir la migration `staff_ledger_operations`).
 */
export abstract class AdjustmentRepository {
  /**
   * Enregistre une demande en attente. L'heure de la demande et son échéance sont fixées par la
   * base.
   *
   * @throws PendingAdjustmentExistsError, AdjustmentRefusedByDatabaseError, HolderClosedError
   */
  abstract create(tx: DbClient, adjustment: NewAdjustment): Promise<AdjustmentRecord>;

  abstract find(db: DbClient, id: string): Promise<AdjustmentRecord | null>;

  /**
   * Verrouille la demande jusqu'à la fin de la transaction, et la rend dans l'état où elle est
   * alors : deux décisions simultanées passent l'une après l'autre.
   */
  abstract lock(tx: DbClient, id: string): Promise<AdjustmentRecord | null>;

  /** Ajustements, du plus récent au plus ancien. */
  abstract list(db: DbClient, filter: AdjustmentFilter): Promise<AdjustmentRecord[]>;

  /**
   * Approuve une demande **en attente**, en désignant l'écriture qui la réalise.
   *
   * @returns l'ajustement approuvé, ou `null` si la demande n'était plus en attente.
   * @throws AdjustmentRefusedByDatabaseError si la base refuse l'approbation.
   */
  abstract approve(
    tx: DbClient,
    id: string,
    approval: AdjustmentApproval,
  ): Promise<AdjustmentRecord | null>;

  /**
   * Refuse ou retire une demande **en attente**.
   *
   * @returns l'ajustement, ou `null` si la demande n'était plus en attente.
   * @throws AdjustmentRefusedByDatabaseError si la base refuse la décision.
   */
  abstract close(
    tx: DbClient,
    id: string,
    closure: AdjustmentClosure,
  ): Promise<AdjustmentRecord | null>;

  /**
   * Clôt les demandes restées sans décision jusqu'à leur échéance, lue à l'horloge de la base.
   *
   * @returns leur nombre.
   */
  abstract expireOverdue(db: DbClient): Promise<number>;
}
