import type { KycVerifiedLevel, UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { TransferCeilings, TransferUsage } from '../domain/transfer-policy.js';

/** Transfert tel que la base l'a conservé. Le montant est un entier d'unités minimales de l'actif. */
export interface TransferRecord {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly assetCode: string;
  readonly units: bigint;
  /** Écriture du grand livre qui réalise le transfert. */
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: Buffer;
  /** Niveau de vérification de l'émetteur au moment du transfert. */
  readonly senderLevel: KycVerifiedLevel;
  /** Heure du transfert, lue à l'horloge de la base. */
  readonly createdAt: Date;
}

export interface NewTransfer {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly assetCode: string;
  readonly units: bigint;
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: Buffer;
  readonly senderLevel: KycVerifiedLevel;
}

/** Plafonds d'un niveau de vérification dans un actif, tels qu'ils sont fixés. */
export interface LimitRecord extends TransferCeilings {
  readonly assetCode: string;
  readonly level: KycVerifiedLevel;
  /** `null` : fixés avec le rôle propriétaire de la base. */
  readonly setBy: string | null;
  readonly setAt: Date;
}

export interface NewLimit extends TransferCeilings {
  readonly assetCode: string;
  readonly level: KycVerifiedLevel;
  readonly setBy: string;
}

/** Ce qu'un compte peut envoyer dans un actif : son niveau, ses plafonds, ce qu'il a déjà envoyé. */
export interface Allowance {
  readonly level: KycVerifiedLevel;
  /** `null` : aucun plafond n'est fixé pour ce niveau dans cet actif. */
  readonly ceilings: LimitRecord | null;
  readonly usage: TransferUsage;
}

export interface TransferPage {
  /** Transferts antérieurs à celui-ci (identifiant du dernier de la page précédente). */
  readonly beforeId?: string | undefined;
  readonly limit: number;
}

/**
 * La base de données a refusé le transfert : une de ses règles aurait été enfreinte. Les
 * contrôles de l'application l'avaient pourtant admis — le niveau de vérification d'une des
 * parties, son statut ou les plafonds ont changé entre-temps. Rien n'a été écrit.
 */
export class TransferRefusedByDatabaseError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the transfer: one of its rules would have been broken.', options);
    this.name = 'TransferRefusedByDatabaseError';
  }
}

/** L'auteur désigné n'est pas — ou plus — habilité à fixer des plafonds : la base a refusé. */
export class LimitChangeDeniedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the change of transfer limits.', options);
    this.name = 'LimitChangeDeniedError';
  }
}

/**
 * Accès aux transferts et à leurs plafonds. Les montants y circulent en `bigint` d'unités
 * minimales : lus et écrits en texte, sans passer par un nombre flottant ni par une
 * bibliothèque décimale.
 */
export abstract class TransferRepository {
  // --- Émetteur ---

  /**
   * Verrouille le compte de l'émetteur jusqu'à la fin de la transaction, et rend son statut :
   * ses transferts passent un à un, chacun comptant les précédents dans ses cumuls. Ce verrou
   * se prend **avant** de passer l'écriture au grand livre, jamais après.
   *
   * @returns `null` si le compte n'existe pas.
   */
  abstract lockSender(tx: DbClient, senderId: string): Promise<UserStatus | null>;

  /**
   * Niveau de vérification du compte, plafonds de ce niveau dans l'actif et cumuls de ses
   * envois — calculés par la base, comme elle le fera en dernier ressort.
   */
  abstract allowance(db: DbClient, userId: string, assetCode: string): Promise<Allowance>;

  /** La même chose pour chacun des actifs que tient la plateforme. */
  abstract allowances(
    db: DbClient,
    userId: string,
  ): Promise<{
    readonly level: KycVerifiedLevel;
    readonly byAsset: ReadonlyMap<string, Allowance>;
  }>;

  // --- Transferts ---

  /** Identifiant d'un transfert à venir, ordonné dans le temps. */
  abstract newId(db: DbClient): Promise<string>;

  /** Transfert qu'un émetteur a fait sous cette clé d'idempotence, ou `null`. */
  abstract findByKey(
    db: DbClient,
    senderId: string,
    idempotencyKey: string,
  ): Promise<TransferRecord | null>;

  abstract findById(db: DbClient, transferId: string): Promise<TransferRecord | null>;

  /** Le transfert, si ce compte en est l'émetteur ou le destinataire ; sinon `null`. */
  abstract findForParty(
    db: DbClient,
    transferId: string,
    userId: string,
  ): Promise<TransferRecord | null>;

  /** Transferts envoyés ou reçus par un compte, du plus récent au plus ancien. */
  abstract listForParty(
    db: DbClient,
    userId: string,
    page: TransferPage,
  ): Promise<TransferRecord[]>;

  /**
   * Écrit le transfert. La base vérifie elle-même les plafonds, les deux comptes et — à la
   * validation de la transaction — que l'écriture désignée est bien celle de ce transfert.
   *
   * @throws TransferRefusedByDatabaseError
   */
  abstract insert(tx: DbClient, transfer: NewTransfer): Promise<TransferRecord>;

  // --- Plafonds ---

  /** Tous les plafonds fixés, dans l'ordre des actifs puis des niveaux. */
  abstract listLimits(db: DbClient): Promise<LimitRecord[]>;

  /**
   * Fixe, ou remplace, les plafonds d'un niveau dans un actif.
   *
   * @returns les plafonds en vigueur avant (ou `null`) et après.
   * @throws LimitChangeDeniedError
   */
  abstract setLimit(
    tx: DbClient,
    limit: NewLimit,
  ): Promise<{ readonly before: LimitRecord | null; readonly after: LimitRecord }>;
}
