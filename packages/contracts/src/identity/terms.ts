import { isoDateTimeSchema, localeSchema } from '@mgx/validation';
import { z } from 'zod';

/**
 * Conditions d'utilisation : versions publiées et acceptations.
 *
 * Chaque version porte un numéro (1, 2, 3…, sans trou), un texte en français — et, s'il a été
 * fourni, sa traduction anglaise — et une règle : `requiresAcceptance`. Une version qui
 * l'exige doit être acceptée par chaque titulaire avant qu'il ne continue à utiliser son
 * compte ; une version qui ne l'exige pas est seulement signalée. Une version publiée ne
 * change plus jamais : corriger un texte, c'est publier la version suivante.
 */

/** Longueur maximale du texte d'une version, par langue (caractères). */
export const TERMS_BODY_MAX_LENGTH = 200_000;

/** Longueur maximale du résumé de ce qui change dans une version, par langue. */
export const TERMS_SUMMARY_MAX_LENGTH = 1000;

/** Taille maximale de la requête de publication d'une version (octets). */
export const TERMS_PUBLICATION_MAX_BYTES = 1_048_576;

/** Numéro d'une version. */
export const termsVersionNumberSchema = z.number().int().min(1).max(999_999_999);

/** Numéro d'une version dans un chemin d'URL : en chiffres, sans zéro de tête. */
export const termsVersionNumberParamSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, { error: 'Must be a version number: 1, 2, 3…' })
  .transform(Number);

/** Empreinte SHA-256 d'un texte encodé en UTF-8, en hexadécimal. */
export const termsDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const termsLocaleQuerySchema = z.strictObject({
  /** Langue souhaitée. Une version sans traduction dans cette langue est servie en français. */
  locale: localeSchema.default('fr'),
});
export type TermsLocaleQuery = z.infer<typeof termsLocaleQuerySchema>;

/** Une version, sans son texte. */
export const termsVersionSummarySchema = z.object({
  number: termsVersionNumberSchema,
  publishedAt: isoDateTimeSchema,
  /** Vrai si les titulaires doivent accepter cette version avant de continuer à utiliser leur compte. */
  requiresAcceptance: z.boolean(),
  /** Vrai pour la version en vigueur : la plus récente. */
  current: z.boolean(),
  /** Langues dans lesquelles cette version a été publiée. */
  locales: z.array(localeSchema),
  /** Langue de `summary` (et de `body`) : celle demandée si elle existe, sinon le français. */
  locale: localeSchema,
  /** Ce qui change dans cette version, en quelques phrases. */
  summary: z.string(),
});
export type TermsVersionSummary = z.infer<typeof termsVersionSummarySchema>;

/** Une version et son texte, tel qu'il a été publié — à l'octet près. */
export const termsDocumentSchema = termsVersionSummarySchema.extend({
  /** Texte brut ou Markdown, selon ce qui a été publié. L'API ne l'interprète pas. */
  body: z.string(),
  /** Empreinte de `body` : la preuve que le texte affiché est celui qui a été publié. */
  sha256: termsDigestSchema,
});
export type TermsDocument = z.infer<typeof termsDocumentSchema>;

export const termsVersionListSchema = z.object({
  /** De la plus récente à la plus ancienne. */
  versions: z.array(termsVersionSummarySchema),
});
export type TermsVersionList = z.infer<typeof termsVersionListSchema>;

/** Où en est un compte vis-à-vis des conditions d'utilisation. */
export const accountTermsSchema = z.object({
  /** Dernière version acceptée par le compte ; `null` s'il n'en a accepté aucune. */
  accepted: z
    .object({ number: termsVersionNumberSchema, acceptedAt: isoDateTimeSchema })
    .nullable(),
  /**
   * Vrai si le compte doit accepter la version en vigueur : tant que c'est le cas, la plupart
   * de ses routes répondent `403 TERMS_ACCEPTANCE_REQUIRED`.
   */
  acceptanceRequired: z.boolean(),
});
export type AccountTerms = z.infer<typeof accountTermsSchema>;

export const termsStatusSchema = accountTermsSchema.extend({
  /** Version en vigueur ; `null` tant qu'aucune n'a été publiée. */
  current: z
    .object({
      number: termsVersionNumberSchema,
      publishedAt: isoDateTimeSchema,
      requiresAcceptance: z.boolean(),
    })
    .nullable(),
});
export type TermsStatus = z.infer<typeof termsStatusSchema>;

/**
 * Acceptation de la version en vigueur. Le numéro est celui du texte que le titulaire a eu
 * sous les yeux : s'il n'est plus celui de la version en vigueur, l'acceptation est refusée
 * (`409 TERMS_VERSION_NOT_CURRENT`) — on n'accepte pas un texte qu'on n'a pas lu.
 */
export const acceptTermsRequestSchema = z.strictObject({ version: termsVersionNumberSchema });
export type AcceptTermsRequest = z.infer<typeof acceptTermsRequestSchema>;

/** Les acceptations d'un compte, dans la copie de ses données. */
export const termsExportSchema = z.object({
  /** De la plus récente à la plus ancienne. */
  acceptances: z.array(
    z.object({ version: termsVersionNumberSchema, acceptedAt: isoDateTimeSchema }),
  ),
});
export type TermsExport = z.infer<typeof termsExportSchema>;
