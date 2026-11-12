import {
  countryCodeSchema,
  identityDocumentNumberSchema,
  isoDateSchema,
  isoDateTimeSchema,
  personNameSchema,
  textLineSchema,
  uuidSchema,
} from '@mgx/validation';
import { z } from 'zod';

import { ADMIN_PAGE_MAX_SIZE, adminActionReasonSchema } from './admin-users.js';
import { ACCOUNT_TYPES, USER_STATUSES } from './auth.js';
import { type KycLevel, kycLevelSchema, kycVerifiedLevelSchema } from './kyc-levels.js';

/**
 * Vérification d'identité (KYC).
 *
 * Trois niveaux, obtenus dans l'ordre :
 *  1. identité — une pièce officielle en cours de validité, avec photographie, et un
 *     autoportrait ;
 *  2. adresse — un justificatif de domicile ;
 *  3. origine des fonds — déclaration et pièces à l'appui.
 *
 * Pour chaque niveau, le titulaire prépare un **dossier** : il déclare des informations, joint
 * ses pièces une à une, puis dépose le dossier. Un dossier déposé ne se modifie plus ; il est
 * examiné par l'équipe de conformité, qui l'accepte ou le refuse en donnant ses motifs.
 */

// --- Niveaux et parcours ------------------------------------------------------------------------

/**
 * `DRAFT` est en préparation, modifiable ; `SUBMITTED` est déposé et attend l'examen ;
 * `APPROVED` est accepté : le niveau est vérifié ; `REJECTED` est refusé, avec ses motifs ;
 * `SUPERSEDED` a été accepté puis remplacé par un dossier plus récent ; `REVOKED` a été accepté
 * puis retiré par la conformité.
 */
export const KYC_CASE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
  'REVOKED',
] as const;
export type KycCaseStatus = (typeof KYC_CASE_STATUSES)[number];

/** Pièces d'identité acceptées. En RDC, la carte d'électeur tient lieu de pièce d'identité. */
export const KYC_IDENTITY_DOCUMENT_TYPES = [
  'NATIONAL_ID_CARD',
  'VOTER_CARD',
  'PASSPORT',
  'DRIVING_LICENCE',
] as const;
export type KycIdentityDocumentType = (typeof KYC_IDENTITY_DOCUMENT_TYPES)[number];

export const KYC_ADDRESS_PROOF_TYPES = [
  'UTILITY_BILL',
  'BANK_STATEMENT',
  'RESIDENCE_CERTIFICATE',
  'LEASE_AGREEMENT',
  'TAX_DOCUMENT',
  'OTHER',
] as const;
export type KycAddressProofType = (typeof KYC_ADDRESS_PROOF_TYPES)[number];

export const KYC_FUNDS_SOURCES = [
  'EMPLOYMENT',
  'BUSINESS',
  'SAVINGS',
  'INVESTMENTS',
  'INHERITANCE',
  'SALE_OF_PROPERTY',
  'FAMILY_SUPPORT',
  'PENSION',
  'OTHER',
] as const;
export type KycFundsSource = (typeof KYC_FUNDS_SOURCES)[number];

/** Motifs d'un refus. Ils sont communiqués au titulaire ; la note interne ne l'est jamais. */
export const KYC_REJECTION_REASONS = [
  'DOCUMENT_UNREADABLE',
  'DOCUMENT_EXPIRED',
  'DOCUMENT_NOT_ACCEPTED',
  'DOCUMENT_INCOMPLETE',
  'INFORMATION_MISMATCH',
  'SELFIE_UNUSABLE',
  'SELFIE_MISMATCH',
  'PROOF_TOO_OLD',
  'INSUFFICIENT_EVIDENCE',
  'OTHER',
] as const;
export type KycRejectionReason = (typeof KYC_REJECTION_REASONS)[number];

export const KYC_REJECTION_REASONS_MAX = 5;

// --- Pièces -------------------------------------------------------------------------------------

export const KYC_DOCUMENT_KINDS = [
  'IDENTITY_FRONT',
  'IDENTITY_BACK',
  'SELFIE',
  'PROOF_OF_ADDRESS',
  'SOURCE_OF_FUNDS',
] as const;
export type KycDocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];

/** Formats acceptés. Le contenu du fichier doit correspondre au type annoncé. */
export const KYC_DOCUMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type KycDocumentContentType = (typeof KYC_DOCUMENT_CONTENT_TYPES)[number];

/** Un autoportrait est une image : le PDF n'est pas accepté. */
export const KYC_SELFIE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
] as const satisfies readonly KycDocumentContentType[];

/** Taille maximale d'une pièce : 5 Mio. */
export const KYC_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export interface KycDocumentRule {
  /** Nombre de fichiers exigé pour déposer le dossier. */
  readonly min: number;
  /** Nombre de fichiers accepté ; au-delà de un, un envoi s'ajoute au lieu de remplacer. */
  readonly max: number;
}

/** Pièces attendues à chaque niveau. */
export const KYC_DOCUMENT_RULES = {
  1: {
    IDENTITY_FRONT: { min: 1, max: 1 },
    IDENTITY_BACK: { min: 0, max: 1 },
    SELFIE: { min: 1, max: 1 },
  },
  2: { PROOF_OF_ADDRESS: { min: 1, max: 3 } },
  3: { SOURCE_OF_FUNDS: { min: 1, max: 5 } },
} as const satisfies Record<KycLevel, Partial<Record<KycDocumentKind, KycDocumentRule>>>;

/** Pièces d'identité à deux faces : leur verso est exigé. Un passeport n'en a pas. */
export const KYC_TWO_SIDED_IDENTITY_DOCUMENTS = [
  'NATIONAL_ID_CARD',
  'VOTER_CARD',
  'DRIVING_LICENCE',
] as const satisfies readonly KycIdentityDocumentType[];

/**
 * Règle applicable à une nature de pièce pour un dossier donné, ou `null` si cette nature n'a
 * pas sa place dans un dossier de ce niveau.
 */
export function kycDocumentRule(
  level: KycLevel,
  kind: KycDocumentKind,
  identityDocumentType?: KycIdentityDocumentType | null,
): KycDocumentRule | null {
  const rules: Partial<Record<KycDocumentKind, KycDocumentRule>> = KYC_DOCUMENT_RULES[level];
  const rule = rules[kind];
  if (rule === undefined) {
    return null;
  }
  const twoSided: readonly string[] = KYC_TWO_SIDED_IDENTITY_DOCUMENTS;
  if (
    kind === 'IDENTITY_BACK' &&
    identityDocumentType !== undefined &&
    identityDocumentType !== null &&
    twoSided.includes(identityDocumentType)
  ) {
    return { min: 1, max: rule.max };
  }
  return rule;
}

/** Âge maximal d'un justificatif de domicile, en jours (trois mois). */
export const KYC_ADDRESS_PROOF_MAX_AGE_DAYS = 92;

/** Un dossier resté en préparation sans changement pendant ce nombre de jours est effacé. */
export const KYC_DRAFT_RETENTION_DAYS = 30;

export const kycDocumentUploadQuerySchema = z.strictObject({ kind: z.enum(KYC_DOCUMENT_KINDS) });
export type KycDocumentUploadQuery = z.infer<typeof kycDocumentUploadQuerySchema>;

export const kycDocumentSchema = z.object({
  id: uuidSchema,
  kind: z.enum(KYC_DOCUMENT_KINDS),
  contentType: z.enum(KYC_DOCUMENT_CONTENT_TYPES),
  /** Taille du fichier, en octets. */
  byteSize: z.number().int().positive(),
  uploadedAt: isoDateTimeSchema,
});
export type KycDocument = z.infer<typeof kycDocumentSchema>;

// --- Déclarations -------------------------------------------------------------------------------

function withoutDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Niveau 1 — identité déclarée et pièce présentée. Les noms suivent l'usage congolais : prénom
 * (`givenName`), nom (`familyName`) et postnom (`additionalName`). Tout doit correspondre à ce
 * qui figure sur la pièce.
 */
export const kycIdentityDeclarationSchema = z.strictObject({
  givenName: personNameSchema,
  familyName: personNameSchema,
  additionalName: personNameSchema.nullable().default(null),
  /** Date de naissance : `1990-05-17`. */
  dateOfBirth: isoDateSchema,
  placeOfBirth: textLineSchema(100),
  /** Nationalité (ISO 3166-1 alpha-2). */
  nationality: countryCodeSchema,
  document: z.strictObject({
    type: z.enum(KYC_IDENTITY_DOCUMENT_TYPES),
    /** Numéro de la pièce ; espaces, points, barres et traits d'union sont ignorés. */
    number: identityDocumentNumberSchema,
    /** Pays qui a délivré la pièce (ISO 3166-1 alpha-2). */
    issuingCountry: countryCodeSchema,
    /** Date de délivrance. */
    issuedOn: isoDateSchema,
    /** Lieu de délivrance. */
    issuedAt: textLineSchema(100),
    /** Date d'expiration ; exigée pour un passeport, `null` si la pièce n'en porte pas. */
    expiresOn: isoDateSchema.nullable().default(null),
  }),
});
export type KycIdentityDeclaration = z.infer<typeof kycIdentityDeclarationSchema>;

/** Niveau 2 — adresse de résidence et justificatif présenté. */
export const kycAddressDeclarationSchema = z.strictObject({
  addressLine1: textLineSchema(200),
  addressLine2: textLineSchema(200).nullable().default(null),
  city: textLineSchema(100),
  /** Province ou région. */
  region: textLineSchema(100).nullable().default(null),
  postalCode: textLineSchema(20).nullable().default(null),
  /** Pays de résidence (ISO 3166-1 alpha-2) : celui du compte. */
  country: countryCodeSchema,
  proof: z.strictObject({
    type: z.enum(KYC_ADDRESS_PROOF_TYPES),
    /** Date du justificatif : il doit dater de moins de trois mois. */
    issuedOn: isoDateSchema,
  }),
});
export type KycAddressDeclaration = z.infer<typeof kycAddressDeclarationSchema>;

export const KYC_FUNDS_EXPLANATION_MIN_LENGTH = 20;

/** Niveau 3 — origine des fonds. */
export const kycFundsDeclarationSchema = z.strictObject({
  sources: z
    .array(z.enum(KYC_FUNDS_SOURCES))
    .min(1)
    .max(KYC_FUNDS_SOURCES.length)
    .refine(withoutDuplicates, { error: 'Must not contain duplicates.' }),
  occupation: textLineSchema(100),
  /** Employeur ou entreprise, le cas échéant. */
  employerName: textLineSchema(200).nullable().default(null),
  /** D'où viennent les fonds, en quelques phrases. */
  explanation: textLineSchema(1000).min(KYC_FUNDS_EXPLANATION_MIN_LENGTH),
});
export type KycFundsDeclaration = z.infer<typeof kycFundsDeclarationSchema>;

// --- Dossier, vu par son titulaire --------------------------------------------------------------

const identityFields = {
  givenName: z.string(),
  familyName: z.string(),
  additionalName: z.string().nullable(),
  dateOfBirth: isoDateSchema,
  placeOfBirth: z.string(),
  nationality: z.string(),
};

const identityDocumentFields = {
  type: z.enum(KYC_IDENTITY_DOCUMENT_TYPES),
  issuingCountry: z.string(),
  issuedOn: isoDateSchema,
  issuedAt: z.string(),
  expiresOn: isoDateSchema.nullable(),
};

export const kycIdentitySchema = z.object({
  ...identityFields,
  document: z.object({
    ...identityDocumentFields,
    /** Numéro masqué : seuls ses derniers caractères sont lisibles. */
    numberMasked: z.string(),
  }),
});
export type KycIdentity = z.infer<typeof kycIdentitySchema>;

export const kycAddressSchema = z.object({
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  proof: z.object({ type: z.enum(KYC_ADDRESS_PROOF_TYPES), issuedOn: isoDateSchema }),
});
export type KycAddress = z.infer<typeof kycAddressSchema>;

export const kycFundsSchema = z.object({
  sources: z.array(z.enum(KYC_FUNDS_SOURCES)),
  occupation: z.string(),
  employerName: z.string().nullable(),
  explanation: z.string(),
});
export type KycFunds = z.infer<typeof kycFundsSchema>;

export const kycCaseSchema = z.object({
  id: uuidSchema,
  level: kycLevelSchema,
  status: z.enum(KYC_CASE_STATUSES),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  /** Motifs du refus ; vide pour tout autre statut. */
  rejectionReasons: z.array(z.enum(KYC_REJECTION_REASONS)),
  /** Fin de validité d'un dossier accepté, s'il a été remplacé ou retiré. */
  endedAt: isoDateTimeSchema.nullable(),
  /** Renseigné pour un dossier de niveau 1. */
  identity: kycIdentitySchema.nullable(),
  /** Renseigné pour un dossier de niveau 2. */
  address: kycAddressSchema.nullable(),
  /** Renseigné pour un dossier de niveau 3. */
  sourceOfFunds: kycFundsSchema.nullable(),
  documents: z.array(kycDocumentSchema),
  /** Pièces qu'il reste à joindre avant de déposer ; vide une fois le dossier déposé. */
  missingDocuments: z.array(z.enum(KYC_DOCUMENT_KINDS)),
});
export type KycCase = z.infer<typeof kycCaseSchema>;

export const kycCaseSummarySchema = z.object({
  id: uuidSchema,
  status: z.enum(KYC_CASE_STATUSES),
  submittedAt: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  rejectionReasons: z.array(z.enum(KYC_REJECTION_REASONS)),
});
export type KycCaseSummary = z.infer<typeof kycCaseSummarySchema>;

export const kycLevelOverviewSchema = z.object({
  level: kycLevelSchema,
  /** Vrai si un dossier accepté est en vigueur pour ce niveau. */
  verified: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
  /**
   * Vrai si le titulaire peut, aujourd'hui, préparer un dossier pour ce niveau ou continuer
   * celui qui est en préparation : le niveau précédent est vérifié et aucun dossier n'attend
   * d'être examiné.
   */
  available: z.boolean(),
  /** Dossier le plus récent de ce niveau, quel que soit son statut. */
  currentCase: kycCaseSummarySchema.nullable(),
});
export type KycLevelOverview = z.infer<typeof kycLevelOverviewSchema>;

export const kycOverviewSchema = z.object({
  /** Niveau vérifié du compte : le plus haut niveau dont tous les précédents sont vérifiés. */
  level: kycVerifiedLevelSchema,
  levels: z.array(kycLevelOverviewSchema),
});
export type KycOverview = z.infer<typeof kycOverviewSchema>;

// --- Examen par la conformité (back-office) -----------------------------------------------------

/** Un dossier en préparation appartient à son titulaire : la conformité ne le voit pas. */
export const ADMIN_KYC_CASE_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
  'REVOKED',
] as const satisfies readonly KycCaseStatus[];
export type AdminKycCaseStatus = (typeof ADMIN_KYC_CASE_STATUSES)[number];

export const KYC_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * File des dossiers, **du dépôt le plus ancien au plus récent** : le premier de la liste est
 * celui qui attend depuis le plus longtemps.
 */
export const adminKycCaseListQuerySchema = z.strictObject({
  status: z.enum(ADMIN_KYC_CASE_STATUSES).default('SUBMITTED'),
  level: z.coerce.number().pipe(kycLevelSchema).optional(),
  /** Restreint aux dossiers d'un compte. */
  userId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX_SIZE).default(20),
  /** Curseur : `nextCursor` de la page précédente. */
  after: z.string().regex(KYC_CURSOR_PATTERN, { error: 'Must be a cursor.' }).optional(),
});
export type AdminKycCaseListQuery = z.infer<typeof adminKycCaseListQuerySchema>;

const accountReferenceSchema = z.object({ id: uuidSchema, email: z.string() });

export const adminKycCaseSummarySchema = z.object({
  id: uuidSchema,
  level: kycLevelSchema,
  status: z.enum(ADMIN_KYC_CASE_STATUSES),
  user: accountReferenceSchema,
  submittedAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
});
export type AdminKycCaseSummary = z.infer<typeof adminKycCaseSummarySchema>;

export const adminKycCaseListSchema = z.object({
  cases: z.array(adminKycCaseSummarySchema),
  nextCursor: z.string().nullable(),
});
export type AdminKycCaseList = z.infer<typeof adminKycCaseListSchema>;

/** Nombre maximal de comptes cités lorsqu'une même pièce d'identité apparaît ailleurs. */
export const ADMIN_KYC_DUPLICATES_MAX = 10;

/** Nombre maximal d'autres dossiers du compte rappelés dans la fiche d'un dossier. */
export const ADMIN_KYC_HISTORY_MAX = 20;

export const adminKycCaseSchema = z.object({
  id: uuidSchema,
  level: kycLevelSchema,
  status: z.enum(ADMIN_KYC_CASE_STATUSES),
  createdAt: isoDateTimeSchema,
  submittedAt: isoDateTimeSchema,
  user: z.object({
    id: uuidSchema,
    email: z.string(),
    status: z.enum(USER_STATUSES),
    accountType: z.enum(ACCOUNT_TYPES),
    countryCode: z.string(),
    createdAt: isoDateTimeSchema,
    /** Niveau vérifié du compte à l'instant de la consultation. */
    verificationLevel: kycVerifiedLevelSchema,
  }),
  identity: z
    .object({
      ...identityFields,
      document: z.object({
        ...identityDocumentFields,
        /** Numéro complet, à comparer à la pièce. */
        number: z.string(),
      }),
    })
    .nullable(),
  address: kycAddressSchema.nullable(),
  sourceOfFunds: kycFundsSchema.nullable(),
  documents: z.array(
    kycDocumentSchema.extend({
      /** Nombre d'autres comptes ayant déposé exactement le même fichier. */
      seenOnOtherAccounts: z.number().int().nonnegative(),
    }),
  ),
  /** Décision prise ; `null` tant que le dossier attend. */
  decision: z
    .object({
      decidedBy: accountReferenceSchema,
      decidedAt: isoDateTimeSchema,
      /** Note interne. */
      note: z.string().nullable(),
      rejectionReasons: z.array(z.enum(KYC_REJECTION_REASONS)),
    })
    .nullable(),
  /** Fin de validité d'un dossier accepté : remplacement (`revokedBy` nul) ou retrait. */
  ending: z
    .object({
      endedAt: isoDateTimeSchema,
      revokedBy: accountReferenceSchema.nullable(),
      revocationReason: z.string().nullable(),
    })
    .nullable(),
  /**
   * Dossier accepté, en vigueur pour le même compte et le même niveau, que l'acceptation de
   * celui-ci remplacerait ; `null` s'il n'y en a pas.
   */
  replacesCaseId: uuidSchema.nullable(),
  /**
   * Autres comptes ayant présenté la même pièce d'identité dans un dossier déposé (niveau 1).
   * `total` les compte tous ; `cases` en cite au plus `ADMIN_KYC_DUPLICATES_MAX`.
   */
  sameIdentityDocument: z.object({
    total: z.number().int().nonnegative(),
    cases: z.array(
      z.object({
        caseId: uuidSchema,
        userId: uuidSchema,
        status: z.enum(ADMIN_KYC_CASE_STATUSES),
      }),
    ),
  }),
  /** Autres dossiers déposés par le même compte, du plus récent au plus ancien. */
  history: z.array(
    z.object({
      id: uuidSchema,
      level: kycLevelSchema,
      status: z.enum(ADMIN_KYC_CASE_STATUSES),
      submittedAt: isoDateTimeSchema,
      decidedAt: isoDateTimeSchema.nullable(),
    }),
  ),
});
export type AdminKycCase = z.infer<typeof adminKycCaseSchema>;

/** Acceptation : une note interne est facultative, et le corps de la requête aussi. */
export const approveKycCaseRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(500).optional() })
  .default({});
export type ApproveKycCaseRequest = z.infer<typeof approveKycCaseRequestSchema>;

/**
 * Refus : au moins un motif, communiqué au titulaire, et une note interne qui l'explique.
 * La note n'est jamais communiquée.
 */
export const rejectKycCaseRequestSchema = z.strictObject({
  reasons: z
    .array(z.enum(KYC_REJECTION_REASONS))
    .min(1)
    .max(KYC_REJECTION_REASONS_MAX)
    .refine(withoutDuplicates, { error: 'Must not contain duplicates.' }),
  note: adminActionReasonSchema,
});
export type RejectKycCaseRequest = z.infer<typeof rejectKycCaseRequestSchema>;

/** Retrait d'une vérification acceptée : il est motivé. */
export const revokeKycCaseRequestSchema = z.strictObject({ reason: adminActionReasonSchema });
export type RevokeKycCaseRequest = z.infer<typeof revokeKycCaseRequestSchema>;
