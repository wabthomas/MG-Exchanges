import {
  assetCodeSchema,
  decimalAmountSchema,
  isoDateTimeSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

// --- Actifs -------------------------------------------------------------------------------------

/** Nature d'un actif : monnaie ayant cours légal, ou cryptoactif. */
export const ASSET_KINDS = ['FIAT', 'CRYPTO'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Nombre maximal de décimales d'un actif tenu par le grand livre (18 : l'ether). Un montant
 * est un entier d'unités minimales d'au plus 38 chiffres : au-delà de 18 décimales, il ne
 * resterait plus de place pour la partie entière.
 */
export const ASSET_SCALE_MAX = 18;

export const ASSET_NAME_MAX_LENGTH = 64;

/**
 * Actif dans lequel la plateforme tient des comptes. `scale` est le nombre de décimales de son
 * unité minimale (2 pour USD et CDF, 8 pour BTC) : les montants de cet actif s'écrivent avec
 * exactement ce nombre de décimales.
 */
export const assetSchema = z.object({
  code: assetCodeSchema,
  name: z.string(),
  kind: z.enum(ASSET_KINDS),
  scale: z.number().int().min(0).max(ASSET_SCALE_MAX),
});
export type AssetView = z.infer<typeof assetSchema>;

// --- Plan de comptes ----------------------------------------------------------------------------

/** Sens d'une ligne d'écriture. */
export const LEDGER_SIDES = ['DEBIT', 'CREDIT'] as const;
export type LedgerSide = (typeof LEDGER_SIDES)[number];

/** À qui appartient un compte du grand livre : un titulaire, ou la plateforme elle-même. */
export const LEDGER_ACCOUNT_OWNERS = ['USER', 'PLATFORM'] as const;
export type LedgerAccountOwner = (typeof LEDGER_ACCOUNT_OWNERS)[number];

/**
 * Plan de comptes : les types de compte du grand livre.
 *
 * `normalSide` est le sens qui **augmente** le solde du compte. Les avoirs des titulaires sont
 * une dette de la plateforme envers eux : un crédit les augmente. Les fonds que la plateforme
 * conserve pour eux hors du grand livre (banque, monnaie mobile, conservation de cryptoactifs)
 * sont un actif : un débit les augmente. Aucun compte ne devient jamais négatif.
 *
 * Le plan est recopié dans la table `ledger_account_types` par les migrations ; un test
 * vérifie que la base et ce fichier sont identiques. Il s'étend avec les opérations.
 */
export const LEDGER_ACCOUNT_TYPES = {
  user_available: {
    owner: 'USER',
    normalSide: 'CREDIT',
    description: 'Funds a holder can use.',
  },
  platform_custody: {
    owner: 'PLATFORM',
    normalSide: 'DEBIT',
    description:
      'Funds held outside the ledger on behalf of holders: bank, mobile money, custody of crypto-assets.',
  },
  platform_fees: {
    owner: 'PLATFORM',
    normalSide: 'CREDIT',
    description: 'Fees earned by the platform.',
  },
} as const satisfies Record<
  string,
  {
    readonly owner: LedgerAccountOwner;
    readonly normalSide: LedgerSide;
    readonly description: string;
  }
>;

export type LedgerAccountTypeKey = keyof typeof LEDGER_ACCOUNT_TYPES;

export const LEDGER_ACCOUNT_TYPE_KEYS = Object.keys(LEDGER_ACCOUNT_TYPES) as [
  LedgerAccountTypeKey,
  ...LedgerAccountTypeKey[],
];

/** Format d'une clé de type de compte. */
export const LEDGER_ACCOUNT_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Format du type d'une écriture (`transfer.internal`, `deposit.confirmed`…) : il dit quelle
 * opération l'a produite. Les types arrivent avec les opérations ; un type publié n'est jamais
 * renommé — les clients s'appuient sur lui pour présenter un mouvement.
 */
export const LEDGER_ENTRY_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const LEDGER_ENTRY_KIND_MAX_LENGTH = 64;

// --- Portefeuilles du titulaire -----------------------------------------------------------------

/**
 * Portefeuille d'un titulaire dans un actif. `available` est ce dont il dispose, en chaîne
 * décimale à `asset.scale` décimales — jamais un nombre JSON.
 */
export const walletSchema = z.object({
  asset: assetSchema,
  available: decimalAmountSchema,
});
export type Wallet = z.infer<typeof walletSchema>;

/** Un portefeuille par actif tenu par la plateforme, dans l'ordre des codes ; à zéro s'il n'a jamais servi. */
export const walletListSchema = z.object({ wallets: z.array(walletSchema) });
export type WalletList = z.infer<typeof walletListSchema>;

/**
 * Mouvement d'un portefeuille : une ligne d'écriture, vue de son titulaire. `CREDIT` : des fonds
 * entrent ; `DEBIT` : des fonds sortent — le sens courant d'un relevé de compte. `amount` est
 * toujours positif ; `balanceAfter` est le solde du portefeuille juste après ce mouvement.
 */
export const walletMovementSchema = z.object({
  id: uuidSchema,
  /** Écriture à laquelle appartient le mouvement : plusieurs mouvements peuvent la partager. */
  entryId: uuidSchema,
  kind: z.string(),
  side: z.enum(LEDGER_SIDES),
  amount: decimalAmountSchema,
  balanceAfter: decimalAmountSchema,
  postedAt: isoDateTimeSchema,
});
export type WalletMovement = z.infer<typeof walletMovementSchema>;

export const LEDGER_PAGE_MAX_SIZE = 100;

export const ledgerPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(LEDGER_PAGE_MAX_SIZE)
  .default(20);

/** Curseur de pagination rendu par la page précédente (`nextCursor`) : opaque. */
export const LEDGER_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ledgerCursorSchema = z
  .string()
  .regex(LEDGER_CURSOR_PATTERN, { error: 'Must be a cursor returned by a previous page.' });

export const walletMovementListQuerySchema = z.strictObject({
  limit: ledgerPageLimitSchema,
  after: ledgerCursorSchema.optional(),
});
export type WalletMovementListQuery = z.infer<typeof walletMovementListQuerySchema>;

/** Mouvements d'un portefeuille, du plus récent au plus ancien. */
export const walletMovementListSchema = z.object({
  wallet: walletSchema,
  movements: z.array(walletMovementSchema),
  nextCursor: z.string().nullable(),
});
export type WalletMovementList = z.infer<typeof walletMovementListSchema>;

// --- Copie des données --------------------------------------------------------------------------

/** Nombre maximal de mouvements par portefeuille inclus dans une copie des données (les plus récents). */
export const DATA_EXPORT_MOVEMENTS_MAX_ENTRIES = 2000;

/** Portefeuille tel qu'il figure dans la copie des données : son solde et ses mouvements. */
export const exportedWalletSchema = walletSchema.extend({
  /** Du plus récent au plus ancien. */
  movements: z.array(walletMovementSchema),
  /** Vrai si le portefeuille compte plus de mouvements que la copie n'en contient. */
  truncated: z.boolean(),
});
export type ExportedWallet = z.infer<typeof exportedWalletSchema>;
