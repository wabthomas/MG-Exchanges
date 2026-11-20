import {
  LEDGER_ACCOUNT_TYPES,
  type LedgerAccountOwner,
  type LedgerAccountTypeKey,
  type LedgerSide,
} from '@mgx/contracts';

type TypeOwnedBy<Owner extends LedgerAccountOwner> = {
  [Key in LedgerAccountTypeKey]: (typeof LEDGER_ACCOUNT_TYPES)[Key]['owner'] extends Owner
    ? Key
    : never;
}[LedgerAccountTypeKey];

/** Types de compte ouverts au nom d'un titulaire. */
export type UserAccountType = TypeOwnedBy<'USER'>;
/** Types de compte de la plateforme elle-même. */
export type PlatformAccountType = TypeOwnedBy<'PLATFORM'>;

/**
 * Désigne un compte du grand livre sans connaître son identifiant : son type et, pour un compte
 * de titulaire, son titulaire. L'actif est celui du montant passé sur le compte. Le compte est
 * ouvert à la première écriture qui le désigne.
 */
export type AccountRef =
  | { readonly owner: 'USER'; readonly type: UserAccountType; readonly userId: string }
  | { readonly owner: 'PLATFORM'; readonly type: PlatformAccountType };

/** Compte que le titulaire voit comme son portefeuille : les fonds dont il dispose. */
export const WALLET_ACCOUNT_TYPE = 'user_available' satisfies UserAccountType;

/** Compte d'un titulaire — par défaut, son portefeuille. */
export function userAccount(
  userId: string,
  type: UserAccountType = WALLET_ACCOUNT_TYPE,
): AccountRef {
  return { owner: 'USER', type, userId };
}

/** Compte de la plateforme. */
export function platformAccount(type: PlatformAccountType): AccountRef {
  return { owner: 'PLATFORM', type };
}

/** Ce qui rend un compte unique : son type, son actif et son titulaire (`null` : la plateforme). */
export interface AccountKey {
  readonly type: LedgerAccountTypeKey;
  readonly assetCode: string;
  readonly userId: string | null;
}

export function accountKeyOf(ref: AccountRef, assetCode: string): AccountKey {
  return { type: ref.type, assetCode, userId: ref.owner === 'USER' ? ref.userId : null };
}

/** Forme textuelle d'une clé de compte : deux clés égales ont le même texte. */
export function accountKeyText(key: AccountKey): string {
  return `${key.assetCode}|${key.type}|${key.userId ?? ''}`;
}

/**
 * Ordre unique des clés de compte. Deux écritures qui ouvrent les mêmes comptes le font dans
 * cet ordre : elles s'attendent l'une l'autre, sans jamais s'interbloquer.
 */
export function compareAccountKeys(left: AccountKey, right: AccountKey): number {
  const a = accountKeyText(left);
  const b = accountKeyText(right);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Vrai si le type de compte appartient bien à qui la référence le dit. */
export function isConsistentAccountRef(ref: AccountRef): boolean {
  const definition = (
    LEDGER_ACCOUNT_TYPES as Readonly<Record<string, { readonly owner: LedgerAccountOwner }>>
  )[ref.type];
  return definition?.owner === ref.owner;
}

/**
 * Solde d'un compte après une ligne : le sens normal du compte l'augmente, l'autre le diminue.
 * Même calcul que la base de données (`mgx_apply_ledger_posting`), qui a le dernier mot.
 */
export function balanceAfterPosting(
  balance: bigint,
  normalSide: LedgerSide,
  side: LedgerSide,
  units: bigint,
): bigint {
  return side === normalSide ? balance + units : balance - units;
}
