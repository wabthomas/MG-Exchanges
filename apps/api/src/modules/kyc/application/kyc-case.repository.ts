import type {
  AdminKycCaseStatus,
  KycAddressProofType,
  KycCaseStatus,
  KycDocumentContentType,
  KycDocumentKind,
  KycFundsSource,
  KycIdentityDocumentType,
  KycLevel,
  KycRejectionReason,
} from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

type Bytes = Uint8Array<ArrayBuffer>;

export interface AccountReference {
  readonly id: string;
  readonly email: string;
}

export interface KycDocumentRecord {
  readonly id: string;
  readonly caseId: string;
  readonly kind: KycDocumentKind;
  readonly contentType: KycDocumentContentType;
  readonly byteSize: number;
  /** SHA-256 du fichier en clair. */
  readonly sha256: Bytes;
  readonly storageKey: string;
  /** Clé du fichier, chiffrée par la clé maîtresse. */
  readonly wrappedKey: Bytes;
  readonly createdAt: Date;
}

export type NewKycDocument = Omit<KycDocumentRecord, 'createdAt'>;

/** Identité déclarée et pièce présentée (niveau 1). Les dates sont à minuit UTC. */
export interface KycIdentityRecord {
  readonly givenName: string;
  readonly familyName: string;
  readonly additionalName: string | null;
  readonly dateOfBirth: Date;
  readonly placeOfBirth: string;
  readonly nationality: string;
  readonly documentType: KycIdentityDocumentType;
  readonly documentNumberEncrypted: Bytes;
  readonly documentNumberDigest: Bytes;
  readonly documentIssuingCountry: string;
  readonly documentIssuedOn: Date;
  readonly documentIssuedAt: string;
  readonly documentExpiresOn: Date | null;
}

/** Adresse déclarée et justificatif présenté (niveau 2). */
export interface KycAddressRecord {
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly addressCountry: string;
  readonly addressProofType: KycAddressProofType;
  readonly addressProofIssuedOn: Date;
}

/** Origine des fonds déclarée (niveau 3). */
export interface KycFundsRecord {
  readonly fundsSources: readonly KycFundsSource[];
  readonly occupation: string;
  readonly employerName: string | null;
  readonly fundsExplanation: string;
}

/** Ce qu'un dossier déclare : un seul des trois blocs, selon son niveau. */
export type KycDeclaration =
  | { readonly level: 1; readonly identity: KycIdentityRecord }
  | { readonly level: 2; readonly address: KycAddressRecord }
  | { readonly level: 3; readonly funds: KycFundsRecord };

export interface KycCaseRecord {
  readonly id: string;
  readonly userId: string;
  readonly level: KycLevel;
  readonly status: KycCaseStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly submittedAt: Date | null;
  readonly decidedBy: AccountReference | null;
  readonly decidedAt: Date | null;
  readonly rejectionReasons: readonly KycRejectionReason[];
  readonly decisionNote: string | null;
  readonly endedAt: Date | null;
  readonly revokedBy: AccountReference | null;
  readonly revocationReason: string | null;
  readonly identity: KycIdentityRecord | null;
  readonly address: KycAddressRecord | null;
  readonly funds: KycFundsRecord | null;
  /** Dans l'ordre où elles ont été jointes. */
  readonly documents: readonly KycDocumentRecord[];
}

/** Dossier tel qu'il apparaît dans une liste : sans ses déclarations ni ses pièces. */
export interface KycCaseHeader {
  readonly id: string;
  readonly userId: string;
  readonly level: KycLevel;
  readonly status: KycCaseStatus;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly rejectionReasons: readonly KycRejectionReason[];
}

export interface ReviewQueueFilter {
  readonly status: AdminKycCaseStatus;
  readonly level?: KycLevel | undefined;
  readonly userId?: string | undefined;
  readonly limit: number;
  /** Ne retourner que les dossiers déposés après celui-ci (date de dépôt, puis identifiant). */
  readonly after?: { readonly submittedAt: Date; readonly id: string } | undefined;
}

export interface ReviewQueueEntry {
  readonly id: string;
  readonly level: KycLevel;
  readonly status: KycCaseStatus;
  readonly user: AccountReference;
  readonly submittedAt: Date;
  readonly decidedAt: Date | null;
}

export type KycDecision =
  | {
      readonly status: 'APPROVED';
      readonly decidedBy: string;
      readonly decidedAt: Date;
      readonly note: string | null;
    }
  | {
      readonly status: 'REJECTED';
      readonly decidedBy: string;
      readonly decidedAt: Date;
      readonly note: string;
      readonly reasons: readonly KycRejectionReason[];
    };

export interface KycRevocation {
  readonly revokedBy: string;
  readonly endedAt: Date;
  readonly reason: string;
}

/** Dossier verrouillé : ce qu'il faut en relire sous le verrou avant de le modifier. */
export interface LockedKycCase {
  readonly userId: string;
  readonly status: KycCaseStatus;
  readonly updatedAt: Date;
}

/** Un dossier ouvert existe déjà pour ce compte et ce niveau (index unique partiel). */
export class OpenKycCaseExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super('An open verification case already exists for this account and level.', options);
    this.name = 'OpenKycCaseExistsError';
  }
}

/** La base a refusé l'écriture : une règle du parcours des dossiers est enfreinte (MGX03). */
export class KycRuleViolationError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused a write that breaks a verification rule.', options);
    this.name = 'KycRuleViolationError';
  }
}

/** Un autre compte est déjà vérifié avec la même pièce d'identité (index unique partiel). */
export class IdentityDocumentAlreadyVerifiedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Another account is already verified with this identity document.', options);
    this.name = 'IdentityDocumentAlreadyVerifiedError';
  }
}

/**
 * Port de persistance des dossiers de vérification d'identité et de leurs pièces.
 *
 * Les règles du parcours (qui dépose, qui décide, ce qui ne change plus) sont imposées par la
 * base elle-même ; ce port traduit ses refus en erreurs nommées.
 */
export abstract class KycCaseRepository {
  /** Nouvel identifiant (UUID v7), pour une pièce dont l'emplacement doit être connu d'avance. */
  abstract newId(db: DbClient): Promise<string>;

  abstract find(db: DbClient, caseId: string): Promise<KycCaseRecord | null>;

  /** Dossier le plus récent de chaque niveau, quel que soit son statut. */
  abstract latestPerLevel(db: DbClient, userId: string): Promise<KycCaseHeader[]>;

  /** Dossiers acceptés en vigueur du compte : au plus un par niveau. */
  abstract approvedCases(db: DbClient, userId: string): Promise<KycCaseHeader[]>;

  /**
   * Dossier ouvert (en préparation ou déposé) du compte pour ce niveau, **verrouillé** jusqu'à
   * la fin de la transaction ; `null` s'il n'y en a pas.
   */
  abstract lockOpenCase(
    tx: DbClient,
    userId: string,
    level: KycLevel,
  ): Promise<{ readonly id: string; readonly status: KycCaseStatus } | null>;

  /**
   * Verrouille le dossier jusqu'à la fin de la transaction : envois de pièces, retraits et
   * dépôt d'un même dossier s'exécutent l'un après l'autre.
   */
  abstract lockCase(tx: DbClient, caseId: string): Promise<LockedKycCase | null>;

  /** @throws OpenKycCaseExistsError si un dossier ouvert existe déjà pour ce niveau. */
  abstract createDraft(
    tx: DbClient,
    userId: string,
    declaration: KycDeclaration,
    now: Date,
  ): Promise<string>;

  /** Remplace la déclaration d'un dossier en préparation. Faux s'il ne l'est plus. */
  abstract updateDraft(
    tx: DbClient,
    caseId: string,
    declaration: KycDeclaration,
    now: Date,
  ): Promise<boolean>;

  /**
   * Pièces jointes au dossier : identifiant et nature. Une seule requête — à lire sous le
   * verrou du dossier (`lockCase`) pour décider d'un ajout ou d'un remplacement.
   */
  abstract attachedDocuments(
    tx: DbClient,
    caseId: string,
  ): Promise<{ readonly id: string; readonly kind: KycDocumentKind }[]>;

  /** Marque le dossier comme modifié à l'instant donné (une pièce a été jointe ou retirée). */
  abstract touchDraft(tx: DbClient, caseId: string, now: Date): Promise<void>;

  /** @throws KycRuleViolationError si le dossier n'est plus en préparation. */
  abstract insertDocument(tx: DbClient, document: NewKycDocument, now: Date): Promise<void>;

  /**
   * Retire les pièces citées d'un dossier en préparation et retourne l'emplacement de leurs
   * fichiers.
   *
   * @throws KycRuleViolationError si le dossier n'est plus en préparation.
   */
  abstract deleteDocuments(
    tx: DbClient,
    caseId: string,
    documentIds: readonly string[],
  ): Promise<string[]>;

  /**
   * Dépose un dossier en préparation. Faux s'il ne l'était plus.
   *
   * @throws KycRuleViolationError si la base refuse le dépôt (pièce manquante, niveau
   *   précédent non vérifié).
   */
  abstract submit(tx: DbClient, caseId: string, now: Date): Promise<boolean>;

  /**
   * Efface un dossier en préparation et ses pièces ; retourne l'emplacement de leurs fichiers,
   * ou `null` si le dossier n'était plus en préparation.
   */
  abstract deleteDraft(tx: DbClient, caseId: string): Promise<string[] | null>;

  /** Dossiers en préparation restés sans changement depuis `before`, les plus anciens d'abord. */
  abstract findStaleDrafts(db: DbClient, before: Date, limit: number): Promise<string[]>;

  // --- Clôture du compte et effacement ---------------------------------------------------------

  /**
   * Verrouille tous les dossiers du compte jusqu'à la fin de la transaction : envois, dépôts et
   * décisions en cours s'achèvent d'abord ; ceux qui suivent attendent.
   */
  abstract lockCasesOf(tx: DbClient, userId: string): Promise<void>;

  /** Vrai si un dossier du compte est déposé et attend l'examen. */
  abstract hasCaseAwaitingReview(db: DbClient, userId: string): Promise<boolean>;

  /**
   * Vrai si une décision a été prise sur au moins un dossier du compte (accepté, refusé,
   * remplacé, retiré) : ces dossiers sont conservés après la clôture.
   */
  abstract hasDecidedCase(db: DbClient, userId: string): Promise<boolean>;

  /**
   * Le compte vient d'être clôturé : ses vérifications en vigueur prennent fin avec lui, et ses
   * dossiers jamais examinés (en préparation ou déposés) sont effacés avec leurs pièces.
   *
   * @returns l'emplacement des fichiers des pièces effacées.
   * @throws KycRuleViolationError si la base refuse (le compte n'est pas clôturé).
   */
  abstract closeForAccount(tx: DbClient, userId: string, closedAt: Date): Promise<string[]>;

  /** Emplacement des fichiers de toutes les pièces encore rattachées au compte. */
  abstract documentFilesOf(db: DbClient, userId: string): Promise<string[]>;

  /**
   * Efface tous les dossiers du compte et leurs pièces.
   *
   * @returns l'emplacement des fichiers des pièces effacées.
   * @throws KycRuleViolationError si la base refuse — le compte n'est pas clôturé, ou la
   *   conservation légale n'est pas écoulée.
   */
  abstract eraseAllOf(tx: DbClient, userId: string): Promise<string[]>;

  /** Tous les dossiers du compte, du plus récent au plus ancien. */
  abstract allCasesOf(db: DbClient, userId: string): Promise<KycCaseRecord[]>;

  // --- Examen ---

  /** File des dossiers, du dépôt le plus ancien au plus récent. */
  abstract listForReview(db: DbClient, filter: ReviewQueueFilter): Promise<ReviewQueueEntry[]>;

  /**
   * Enregistre la décision prise sur un dossier déposé. Faux si le dossier n'attendait plus.
   *
   * @throws KycRuleViolationError si la base refuse la décision.
   * @throws IdentityDocumentAlreadyVerifiedError si la pièce vérifie déjà un autre compte.
   */
  abstract decide(tx: DbClient, caseId: string, decision: KycDecision): Promise<boolean>;

  /**
   * Retire un dossier accepté. Faux s'il n'était plus en vigueur.
   *
   * @throws KycRuleViolationError si la base refuse le retrait.
   */
  abstract revoke(tx: DbClient, caseId: string, revocation: KycRevocation): Promise<boolean>;

  /** Dossier accepté en vigueur du compte pour ce niveau, s'il y en a un. */
  abstract approvedCaseId(db: DbClient, userId: string, level: KycLevel): Promise<string | null>;

  /**
   * Dossiers déposés par d'autres comptes avec la même pièce d'identité : leur nombre, et les
   * plus récents.
   */
  abstract sameIdentityDocument(
    db: DbClient,
    criteria: {
      readonly userId: string;
      readonly documentType: KycIdentityDocumentType;
      readonly issuingCountry: string;
      readonly numberDigest: Bytes;
    },
    limit: number,
  ): Promise<{ readonly total: number; readonly cases: KycCaseHeader[] }>;

  /**
   * Pour chacune des empreintes données, nombre d'autres comptes ayant déposé un fichier
   * identique. Les empreintes absentes du résultat n'ont été vues nulle part ailleurs.
   */
  abstract fileSightings(
    db: DbClient,
    userId: string,
    sha256: readonly Bytes[],
  ): Promise<Map<string, number>>;

  /** Autres dossiers déposés par le compte, du plus récent au plus ancien. */
  abstract depositedCases(
    db: DbClient,
    userId: string,
    exceptCaseId: string,
    limit: number,
  ): Promise<KycCaseHeader[]>;
}
