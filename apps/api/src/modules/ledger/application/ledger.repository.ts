import type { AssetKind, LedgerAccountTypeKey, LedgerSide } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { AccountKey } from '../domain/ledger-account.js';
import type { LedgerActor } from '../domain/journal-entry.js';

/** Actif tenu par le grand livre. */
export interface AssetRecord {
  readonly code: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly scale: number;
  /** `null` : enregistré avec le rôle propriétaire de la base. */
  readonly registeredBy: string | null;
  readonly registeredAt: Date;
}

export interface NewAsset {
  readonly code: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly scale: number;
  readonly registeredBy: string;
}

/** Compte du grand livre. Les montants sont des entiers d'unités minimales de l'actif. */
export interface AccountRecord {
  readonly id: string;
  readonly type: LedgerAccountTypeKey;
  readonly assetCode: string;
  readonly userId: string | null;
  readonly normalSide: LedgerSide;
  readonly balance: bigint;
  readonly postingCount: bigint;
  readonly createdAt: Date;
}

export interface AccountFilter {
  readonly userId?: string | undefined;
  readonly assetCode?: string | undefined;
  readonly type?: LedgerAccountTypeKey | undefined;
  /** Comptes ouverts après celui-ci (identifiant du dernier compte de la page précédente). */
  readonly afterId?: string | undefined;
  readonly limit: number;
}

export interface NewEntry {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly postingCount: number;
  readonly actor: LedgerActor;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface NewPosting {
  readonly lineNumber: number;
  readonly accountId: string;
  readonly assetCode: string;
  readonly side: LedgerSide;
  readonly units: bigint;
}

/** Ligne telle que la base l'a passée : avec son rang sur le compte et le solde qui en résulte. */
export interface PostingRecord {
  readonly id: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly assetCode: string;
  readonly side: LedgerSide;
  readonly units: bigint;
  readonly accountSequence: bigint;
  readonly balanceAfter: bigint;
}

/** Ligne d'une écriture, avec ce qui désigne son compte. */
export interface EntryPostingRecord extends PostingRecord {
  readonly accountType: LedgerAccountTypeKey;
  readonly accountUserId: string | null;
}

/** Écriture et toutes ses lignes, dans l'ordre. */
export interface EntryRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly actorType: 'USER' | 'SYSTEM' | 'SERVICE';
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly postedAt: Date;
  readonly postings: readonly EntryPostingRecord[];
}

/** Ligne d'un compte, avec le type et l'heure de son écriture : un relevé. */
export interface StatementLine extends PostingRecord {
  readonly entryId: string;
  readonly kind: string;
  readonly postedAt: Date;
}

export interface StatementPage {
  /** Lignes de rang strictement inférieur (page suivante d'un relevé, du plus récent au plus ancien). */
  readonly beforeSequence?: bigint | undefined;
  readonly limit: number;
}

/**
 * Relevé d'un compte : son solde, son nombre de lignes et une page de ses lignes, **lus au même
 * instant** — le solde est celui de la ligne la plus récente du compte.
 */
export interface Statement {
  readonly balance: bigint;
  readonly postingCount: bigint;
  /** De la plus récente à la plus ancienne. */
  readonly lines: readonly StatementLine[];
}

/** Total des soldes des comptes d'un type, dans un actif. */
export interface BalanceTotal {
  readonly assetCode: string;
  readonly type: LedgerAccountTypeKey;
  readonly normalSide: LedgerSide;
  readonly accounts: number;
  readonly balance: bigint;
}

/**
 * Ce qu'une vérification du grand livre peut trouver. Aucune de ces anomalies ne peut naître
 * d'une écriture normale — la base les refuse : en trouver une signale une altération.
 */
export type LedgerAnomalyKind =
  /** Le solde d'un compte n'est pas celui de sa dernière ligne. */
  | 'ACCOUNT_BALANCE_MISMATCH'
  /** Sur un compte, une ligne ne prolonge pas la précédente (rang, ou solde). */
  | 'POSTING_CHAIN_BROKEN'
  /** Une ligne n'est pas dans l'actif de son compte. */
  | 'POSTING_ASSET_MISMATCH'
  /** Une écriture n'a pas toutes ses lignes, ou ses débits et ses crédits diffèrent. */
  | 'ENTRY_UNSOUND'
  /** Dans un actif, les soldes de sens débit et de sens crédit ne s'égalent pas. */
  | 'ASSET_UNBALANCED';

export interface LedgerAnomaly {
  readonly kind: LedgerAnomalyKind;
  /** Identifiant du compte, de la ligne ou de l'écriture — ou code de l'actif. */
  readonly subject: string;
}

export interface LedgerCounts {
  readonly accounts: number;
  readonly entries: number;
  readonly postings: number;
}

/** L'auteur désigné n'est pas — ou plus — habilité à enregistrer un actif : la base a refusé. */
export class AssetRegistrationDeniedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the registration of the asset.', options);
    this.name = 'AssetRegistrationDeniedError';
  }
}

/**
 * Accès aux tables du grand livre. Les montants y circulent en `bigint` d'unités minimales :
 * ils sont lus et écrits en texte, sans passer par un nombre flottant ni par une bibliothèque
 * décimale.
 *
 * Les refus de la base sont traduits : fonds insuffisants → `InsufficientFundsError` ;
 * titulaire clôturé → `HolderClosedError` ; règle du grand livre enfreinte →
 * `LedgerIntegrityError`.
 */
export abstract class LedgerRepository {
  // --- Actifs ---

  /** Tous les actifs, dans l'ordre de leurs codes. */
  abstract listAssets(db: DbClient): Promise<AssetRecord[]>;

  abstract findAssets(db: DbClient, codes: readonly string[]): Promise<AssetRecord[]>;

  /**
   * @returns l'actif enregistré, ou `null` si ce code l'était déjà.
   * @throws AssetRegistrationDeniedError
   */
  abstract insertAsset(db: DbClient, asset: NewAsset): Promise<AssetRecord | null>;

  // --- Comptes ---

  /** Comptes existants parmi ceux que désignent `keys`. */
  abstract findAccounts(db: DbClient, keys: readonly AccountKey[]): Promise<AccountRecord[]>;

  /**
   * Ouvre les comptes désignés, dans l'ordre donné ; un compte déjà ouvert est laissé tel quel.
   *
   * @throws HolderClosedError, LedgerIntegrityError
   */
  abstract openAccounts(db: DbClient, keys: readonly AccountKey[]): Promise<void>;

  /**
   * Verrouille les comptes jusqu'à la fin de la transaction, **dans l'ordre de leurs
   * identifiants**, et rend leur état : c'est celui que la ligne suivante trouvera.
   */
  abstract lockAccounts(tx: DbClient, ids: readonly string[]): Promise<AccountRecord[]>;

  abstract accountsOfUser(db: DbClient, userId: string): Promise<AccountRecord[]>;

  abstract findAccount(db: DbClient, id: string): Promise<AccountRecord | null>;

  /** Comptes, du plus anciennement ouvert au plus récent. */
  abstract listAccounts(db: DbClient, filter: AccountFilter): Promise<AccountRecord[]>;

  // --- Écritures ---

  abstract findEntryByKey(db: DbClient, idempotencyKey: string): Promise<EntryRecord | null>;

  abstract findEntry(db: DbClient, id: string): Promise<EntryRecord | null>;

  /** @returns l'en-tête écrit, ou `null` si une écriture porte déjà cette clé d'idempotence. */
  abstract insertEntry(
    tx: DbClient,
    entry: NewEntry,
  ): Promise<{ readonly id: string; readonly postedAt: Date } | null>;

  /**
   * Passe les lignes, dans l'ordre donné.
   *
   * @throws InsufficientFundsError, HolderClosedError, LedgerIntegrityError
   */
  abstract insertPostings(
    tx: DbClient,
    entryId: string,
    postings: readonly NewPosting[],
  ): Promise<PostingRecord[]>;

  // --- Relevés ---

  /** Relevé d'un compte, ou `null` si le compte n'existe pas. */
  abstract readStatement(
    db: DbClient,
    accountId: string,
    page: StatementPage,
  ): Promise<Statement | null>;

  // --- Balance et vérification ---

  /** Total des soldes par actif et par type de compte. */
  abstract balanceTotals(db: DbClient): Promise<BalanceTotal[]>;

  abstract counts(db: DbClient): Promise<LedgerCounts>;

  /** Relit tout le grand livre ; rend au plus `limit` anomalies. */
  abstract findAnomalies(db: DbClient, limit: number): Promise<LedgerAnomaly[]>;
}
