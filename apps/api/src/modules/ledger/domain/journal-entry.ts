import {
  LEDGER_ENTRY_KIND_MAX_LENGTH,
  LEDGER_ENTRY_KIND_PATTERN,
  type LedgerSide,
} from '@mgx/contracts';
import type { Money } from '@mgx/shared';

import {
  accountKeyOf,
  accountKeyText,
  type AccountRef,
  isConsistentAccountRef,
} from './ledger-account.js';
import { LedgerRuleError } from './ledger-errors.js';

/**
 * Clé d'idempotence d'une écriture : 8 à 160 caractères — lettres, chiffres, `.`, `_`, `:`,
 * `-` — dont le premier est une lettre ou un chiffre. L'opération qui passe l'écriture la
 * construit à partir de ce qui la rend unique (`transfer:<identifiant du transfert>`). La base
 * de données impose le même format.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

/** Nombre maximal de lignes d'une écriture ; la base de données impose le même plafond. */
export const LEDGER_ENTRY_MAX_POSTINGS = 100;

/**
 * Plus grand montant — et plus grand solde — que le grand livre sait tenir : un entier de 38
 * chiffres d'unités minimales (`NUMERIC(38,0)`).
 */
export const LEDGER_AMOUNT_MAX_UNITS = 10n ** 38n - 1n;

/**
 * Taille maximale des références d'une écriture, en octets de JSON compact. La base en accepte
 * le double, dans sa propre mise en forme — qui ajoute une espace après chaque séparateur.
 */
export const LEDGER_ENTRY_METADATA_MAX_BYTES = 2048;

/** Nom d'une référence : une lettre, puis des lettres, des chiffres ou `_` — 64 caractères au plus. */
export const LEDGER_METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Texte d'une référence : des caractères ASCII imprimables, 255 au plus. */
export const LEDGER_METADATA_TEXT_PATTERN = /^[\x20-\x7E]{0,255}$/;

/**
 * Valeur d'une référence : un identifiant, un code, un entier, un booléen. Ni texte libre, ni
 * structure imbriquée — une écriture ne s'efface jamais, et ses références ne sont pas un
 * endroit où ranger des données.
 */
export type LedgerMetadataValue = string | number | boolean | null;

const ACTOR_ID_MAX_LENGTH = 64;
const REQUEST_ID_MAX_LENGTH = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Auteur d'une écriture : un compte, la plateforme elle-même, ou un système tiers. */
export type LedgerActor =
  { readonly type: 'SYSTEM' } | { readonly type: 'USER' | 'SERVICE'; readonly id: string };

/** Ligne d'une écriture à passer : elle débite ou crédite un compte d'un montant positif. */
export interface PostingDraft {
  readonly account: AccountRef;
  readonly side: LedgerSide;
  readonly amount: Money;
}

/** Écriture à passer. */
export interface JournalEntryDraft {
  /** Voir {@link IDEMPOTENCY_KEY_PATTERN}. Repasser la même écriture sous la même clé est sans effet. */
  readonly idempotencyKey: string;
  /** Type de l'écriture : l'opération qui la produit (`transfer.internal`…). */
  readonly kind: string;
  readonly actor: LedgerActor;
  readonly requestId?: string | undefined;
  /**
   * Références techniques de l'opération (identifiant du transfert…). **Aucune donnée
   * personnelle** : une écriture ne s'efface jamais.
   */
  readonly metadata?: Readonly<Record<string, LedgerMetadataValue>> | undefined;
  /** Dans l'ordre où elles seront passées — et où chaque solde sera vérifié. */
  readonly postings: readonly PostingDraft[];
}

/** Ligne passée : son compte, son rang sur ce compte et le solde qui en résulte. */
export interface PostedPosting {
  readonly id: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly account: AccountRef;
  readonly side: LedgerSide;
  readonly amount: Money;
  readonly balanceAfter: Money;
}

/** Écriture passée. */
export interface PostedEntry {
  readonly id: string;
  readonly kind: string;
  /** Heure de l'écriture, lue à l'horloge de la base. */
  readonly postedAt: Date;
  /**
   * Vrai si l'écriture existait déjà sous cette clé d'idempotence : rien n'a été écrit, et ce
   * qui est rendu est l'écriture d'origine.
   */
  readonly replayed: boolean;
  readonly postings: readonly PostedPosting[];
}

function encodedLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isMetadataValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return LEDGER_METADATA_TEXT_PATTERN.test(value);
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value);
  }
  return typeof value === 'boolean' || value === null;
}

/**
 * Vérifie qu'une écriture est bien formée, avant toute lecture ou écriture en base :
 * clé, type et auteur valides ; deux lignes au moins, sur deux comptes au moins ; montants
 * strictement positifs ; et, **pour chaque actif, total des débits égal au total des crédits**.
 *
 * La base de données vérifie l'essentiel à son tour ; ce contrôle-ci rend l'erreur lisible et
 * évite d'ouvrir une transaction pour rien.
 *
 * @throws LedgerRuleError
 */
export function assertValidJournalEntry(draft: JournalEntryDraft): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(draft.idempotencyKey)) {
    throw new LedgerRuleError(
      'INVALID_IDEMPOTENCY_KEY',
      'An idempotency key is 8 to 160 letters, digits, ".", "_", ":" or "-".',
    );
  }
  if (
    draft.kind.length > LEDGER_ENTRY_KIND_MAX_LENGTH ||
    !LEDGER_ENTRY_KIND_PATTERN.test(draft.kind)
  ) {
    throw new LedgerRuleError('INVALID_KIND', 'Invalid ledger entry kind.');
  }
  if (
    draft.actor.type !== 'SYSTEM' &&
    (draft.actor.id.length === 0 || draft.actor.id.length > ACTOR_ID_MAX_LENGTH)
  ) {
    throw new LedgerRuleError('INVALID_ACTOR', 'The author of a ledger entry must be identified.');
  }
  if (draft.requestId !== undefined && draft.requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw new LedgerRuleError('INVALID_REQUEST_ID', 'The request identifier is too long.');
  }
  if (draft.metadata !== undefined) {
    const references: [string, unknown][] = Object.entries(draft.metadata);
    if (
      references.some(
        ([name, value]) => !LEDGER_METADATA_KEY_PATTERN.test(name) || !isMetadataValue(value),
      )
    ) {
      throw new LedgerRuleError(
        'INVALID_METADATA',
        'The references of a ledger entry are identifiers, codes, integers or booleans.',
      );
    }
    if (encodedLength(JSON.stringify(draft.metadata)) > LEDGER_ENTRY_METADATA_MAX_BYTES) {
      throw new LedgerRuleError(
        'METADATA_TOO_LARGE',
        'The references of a ledger entry are too large.',
      );
    }
  }

  if (draft.postings.length < 2) {
    throw new LedgerRuleError('TOO_FEW_POSTINGS', 'A ledger entry has at least two postings.');
  }
  if (draft.postings.length > LEDGER_ENTRY_MAX_POSTINGS) {
    throw new LedgerRuleError(
      'TOO_MANY_POSTINGS',
      `A ledger entry has at most ${LEDGER_ENTRY_MAX_POSTINGS} postings.`,
    );
  }

  const accounts = new Set<string>();
  const scales = new Map<string, number>();
  // Par actif : débits moins crédits, en unités minimales.
  const imbalances = new Map<string, bigint>();
  for (const posting of draft.postings) {
    const { account, amount, side } = posting;
    if (
      !isConsistentAccountRef(account) ||
      (account.owner === 'USER' && !UUID_PATTERN.test(account.userId))
    ) {
      throw new LedgerRuleError('INVALID_ACCOUNT', 'A posting designates an invalid account.');
    }
    if (!amount.isPositive()) {
      throw new LedgerRuleError(
        'NON_POSITIVE_AMOUNT',
        'The amount of a posting is strictly positive: its side says which way funds move.',
      );
    }
    if (amount.units > LEDGER_AMOUNT_MAX_UNITS) {
      throw new LedgerRuleError('AMOUNT_TOO_LARGE', 'An amount exceeds what the ledger can hold.');
    }
    const { code, scale } = amount.asset;
    if ((scales.get(code) ?? scale) !== scale) {
      throw new LedgerRuleError(
        'ASSET_MISMATCH',
        `Amounts in ${code} do not all have the same number of decimals.`,
      );
    }
    scales.set(code, scale);
    accounts.add(accountKeyText(accountKeyOf(account, code)));
    imbalances.set(
      code,
      (imbalances.get(code) ?? 0n) + (side === 'DEBIT' ? amount.units : -amount.units),
    );
  }

  if (accounts.size < 2) {
    throw new LedgerRuleError(
      'SINGLE_ACCOUNT',
      'A ledger entry moves funds between at least two accounts.',
    );
  }
  for (const [code, imbalance] of imbalances) {
    if (imbalance !== 0n) {
      throw new LedgerRuleError(
        'UNBALANCED',
        `The entry is not balanced in ${code}: its debits and credits differ.`,
      );
    }
  }
}
