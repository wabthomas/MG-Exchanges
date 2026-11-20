import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { TermsText } from '../domain/terms-policy.js';

/** Une version, sans ses textes — qui peuvent peser plusieurs centaines de kilo-octets. */
export interface TermsVersionHeader {
  readonly number: number;
  readonly requiresAcceptance: boolean;
  /** `null` : publiée par l'outil d'exploitation en ligne de commande. */
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
  readonly fr: TermsTextHeader;
  readonly en: TermsTextHeader | null;
}

export interface TermsTextHeader {
  readonly summary: string;
  /** Longueur du texte, en caractères. */
  readonly length: number;
  readonly sha256: string;
}

/** Une version et ses textes. */
export interface TermsVersionRecord {
  readonly number: number;
  readonly requiresAcceptance: boolean;
  readonly publishedBy: string | null;
  readonly publishedAt: Date;
  readonly fr: TermsText;
  readonly en: TermsText | null;
}

export interface NewTermsVersion {
  readonly number: number;
  readonly requiresAcceptance: boolean;
  /** `null` : réservé au rôle propriétaire de la base (outil d'exploitation). */
  readonly publishedBy: string | null;
  readonly fr: TermsText;
  readonly en: TermsText | null;
}

export interface TermsAcceptanceRecord {
  readonly versionNumber: number;
  readonly acceptedAt: Date;
}

/** Où en est un compte vis-à-vis des versions publiées. */
export interface TermsStanding {
  /** Faux si le compte est clôturé, ou n'existe pas : il n'a plus rien à accepter. */
  readonly accountOpen: boolean;
  /** Version en vigueur ; `null` tant qu'aucune n'a été publiée. */
  readonly current: {
    readonly number: number;
    readonly publishedAt: Date;
    readonly requiresAcceptance: boolean;
  } | null;
  /** Numéro de la dernière version qui exige d'être acceptée ; `null` s'il n'y en a aucune. */
  readonly latestRequired: number | null;
  /** Dernière version acceptée par le compte ; `null` s'il n'en a accepté aucune. */
  readonly lastAccepted: TermsAcceptanceRecord | null;
}

/**
 * Le numéro désigné n'est pas — ou n'est plus — celui attendu : pour une publication, celui de
 * la version suivante ; pour une acceptation, celui de la version en vigueur.
 */
export class TermsVersionOutOfSequenceError extends Error {
  constructor(options?: ErrorOptions) {
    super('The terms version number is not the expected one.', options);
    this.name = 'TermsVersionOutOfSequenceError';
  }
}

/** La base a refusé l'écriture : une règle des conditions d'utilisation est enfreinte. */
export class TermsRuleViolationError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the operation: a rule of the terms of use is violated.', options);
    this.name = 'TermsRuleViolationError';
  }
}

/**
 * Versions des conditions d'utilisation et acceptations. Les règles — numérotation, version
 * en vigueur, immuabilité, droit de publier — sont imposées par la base elle-même (migration
 * `terms_of_use`) ; ce dépôt traduit ses refus.
 */
export abstract class TermsRepository {
  /** En-tête de la version en vigueur ; `null` tant qu'aucune n'a été publiée. */
  abstract findCurrentHeader(db: DbClient): Promise<TermsVersionHeader | null>;

  /** La version en vigueur, avec ses textes. */
  abstract findCurrent(db: DbClient): Promise<TermsVersionRecord | null>;

  abstract findVersion(db: DbClient, number: number): Promise<TermsVersionRecord | null>;

  /** En-têtes des versions, de la plus récente à la plus ancienne (au plus `limit`). */
  abstract listHeaders(db: DbClient, limit: number): Promise<TermsVersionHeader[]>;

  /** Nombre d'acceptations de chacune des versions citées (absente : aucune). */
  abstract countAcceptances(
    db: DbClient,
    numbers: readonly number[],
  ): Promise<ReadonlyMap<number, number>>;

  /**
   * Publie une version. La base fixe l'heure de la publication.
   *
   * @throws TermsVersionOutOfSequenceError si `number` n'est pas celui de la version suivante.
   * @throws TermsRuleViolationError si l'auteur n'a pas — ou plus — le droit de publier.
   */
  abstract publish(tx: DbClient, version: NewTermsVersion): Promise<TermsVersionRecord>;

  /**
   * Enregistre l'acceptation d'une version par un compte. La base fixe l'heure. Accepter une
   * seconde fois la même version ne change rien : `created` vaut alors `false`.
   *
   * @throws TermsVersionOutOfSequenceError si la version n'est pas celle en vigueur.
   * @throws TermsRuleViolationError si le compte ne peut pas accepter (compte suspendu).
   */
  abstract accept(
    tx: DbClient,
    userId: string,
    versionNumber: number,
  ): Promise<TermsAcceptanceRecord & { readonly created: boolean }>;

  /**
   * Efface les acceptations d'un compte : inscription jamais vérifiée, ou clôture en cours.
   * La base le refuse dans tout autre cas.
   *
   * @returns le nombre d'acceptations effacées.
   */
  abstract deleteAcceptances(tx: DbClient, userId: string): Promise<number>;

  abstract standingOf(db: DbClient, userId: string): Promise<TermsStanding>;

  /** Acceptations d'un compte, de la plus récente à la plus ancienne. */
  abstract listAcceptances(db: DbClient, userId: string): Promise<TermsAcceptanceRecord[]>;
}
