import type { WalletFreezeStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { WalletRef } from '../domain/wallet-freeze.js';

/** Gel d'un portefeuille, tel que la base l'a conservé. */
export interface WalletFreezeRecord {
  readonly id: string;
  readonly userId: string;
  readonly assetCode: string;
  readonly reason: string;
  readonly frozenBy: string;
  /** Heure du gel, lue à l'horloge de la base. */
  readonly frozenAt: Date;
  /** `null` tant que le gel est en vigueur. */
  readonly liftedBy: string | null;
  readonly liftedAt: Date | null;
  readonly liftReason: string | null;
}

export interface NewWalletFreeze {
  readonly userId: string;
  readonly assetCode: string;
  readonly reason: string;
  readonly frozenBy: string;
}

export interface WalletFreezeLift {
  readonly liftedBy: string;
  readonly reason: string;
}

export interface WalletFreezeFilter {
  readonly userId?: string | undefined;
  readonly status?: WalletFreezeStatus | undefined;
  /** Gels antérieurs à celui-ci (identifiant du dernier de la page précédente). */
  readonly beforeId?: string | undefined;
  readonly limit: number;
}

/** Ce portefeuille est déjà gelé — y compris par un gel concurrent. La transaction est inutilisable. */
export class WalletAlreadyFrozenError extends Error {
  constructor() {
    super('This wallet is already frozen.');
    this.name = 'WalletAlreadyFrozenError';
  }
}

/**
 * La base de données a refusé le gel ou sa levée : son auteur n'est pas — ou plus — habilité,
 * ou le compte visé n'a pas de portefeuille. La transaction est inutilisable.
 */
export class WalletFreezeRefusedByDatabaseError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the wallet freeze.', options);
    this.name = 'WalletFreezeRefusedByDatabaseError';
  }
}

/**
 * Accès aux gels des portefeuilles.
 *
 * Le gel lui-même est appliqué par la base : elle fait attendre au gel l'écriture en cours sur
 * le portefeuille, puis refuse toute ligne qui le suit (voir la migration
 * `staff_ledger_operations`).
 */
export abstract class WalletFreezeRepository {
  /** Codes des actifs dans lesquels le portefeuille du titulaire est gelé. */
  abstract frozenAssetsOf(db: DbClient, userId: string): Promise<string[]>;

  /** Ceux des portefeuilles désignés qui sont gelés. */
  abstract frozenAmong(db: DbClient, wallets: readonly WalletRef[]): Promise<WalletRef[]>;

  /**
   * Gèle un portefeuille. L'instruction attend la fin de toute écriture en cours sur lui.
   *
   * @throws WalletAlreadyFrozenError, WalletFreezeRefusedByDatabaseError, HolderClosedError
   */
  abstract insert(tx: DbClient, freeze: NewWalletFreeze): Promise<WalletFreezeRecord>;

  /**
   * Lève un gel **en vigueur**.
   *
   * @returns le gel levé, ou `null` s'il ne l'était plus (levée concurrente).
   * @throws WalletFreezeRefusedByDatabaseError
   */
  abstract lift(
    tx: DbClient,
    id: string,
    lift: WalletFreezeLift,
  ): Promise<WalletFreezeRecord | null>;

  abstract find(db: DbClient, id: string): Promise<WalletFreezeRecord | null>;

  /** Gels, du plus récent au plus ancien. */
  abstract list(db: DbClient, filter: WalletFreezeFilter): Promise<WalletFreezeRecord[]>;
}
