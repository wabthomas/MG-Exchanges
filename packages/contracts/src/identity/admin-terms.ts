import { isoDateTimeSchema, textBlockSchema, uuidSchema } from '@mgx/validation';
import { z } from 'zod';

import { adminActionReasonSchema } from './admin-users.js';
import {
  TERMS_BODY_MAX_LENGTH,
  TERMS_SUMMARY_MAX_LENGTH,
  termsDigestSchema,
  termsVersionNumberSchema,
} from './terms.js';

/** Texte d'une version dans une langue. Il est conservé tel quel, à l'octet près. */
export const termsTextSchema = z.strictObject({
  /** Ce qui change dans cette version, en quelques phrases : affiché avant le texte. */
  summary: textBlockSchema(TERMS_SUMMARY_MAX_LENGTH),
  /** Le texte lui-même, brut ou Markdown. */
  body: textBlockSchema(TERMS_BODY_MAX_LENGTH),
});
export type TermsText = z.infer<typeof termsTextSchema>;

/**
 * Publication d'une version des conditions d'utilisation : **définitive**. Une version publiée
 * ne se modifie ni ne se retire.
 */
export const publishTermsVersionRequestSchema = z
  .strictObject({
    /**
     * Numéro de la version publiée : celui de la version en vigueur, plus un (`1` pour la
     * première). Il garantit qu'une même publication n'est pas faite deux fois, ni décidée sur
     * la foi d'un état dépassé.
     */
    number: termsVersionNumberSchema,
    /**
     * `true` : chaque titulaire doit accepter cette version avant de continuer à utiliser son
     * compte. `false` : elle lui est seulement signalée. La première version l'exige toujours.
     */
    requiresAcceptance: z.boolean(),
    /** Justification, conservée dans le journal d'audit. */
    reason: adminActionReasonSchema,
    /** Texte français : il fait foi. */
    fr: termsTextSchema,
    /** Traduction anglaise, facultative. */
    en: termsTextSchema.optional(),
  })
  // Nul n'a pu accepter un texte qui n'existait pas : la première version s'impose à tous.
  .refine((request) => request.number > 1 || request.requiresAcceptance, {
    path: ['requiresAcceptance'],
    error: 'The first version must require acceptance.',
  });
export type PublishTermsVersionRequest = z.infer<typeof publishTermsVersionRequestSchema>;

const adminTermsTextSchema = z.object({
  summary: z.string(),
  /** Longueur du texte, en caractères. */
  length: z.number().int().positive(),
  /** Empreinte SHA-256 du texte encodé en UTF-8 : celle du fichier qui a été publié. */
  sha256: termsDigestSchema,
});

export const adminTermsVersionSchema = z.object({
  number: termsVersionNumberSchema,
  publishedAt: isoDateTimeSchema,
  /**
   * Membre du personnel qui a publié la version ; `null` si elle l'a été depuis la ligne de
   * commande du serveur (outil d'exploitation `terms:publish`).
   */
  publishedBy: uuidSchema.nullable(),
  requiresAcceptance: z.boolean(),
  /** Vrai pour la version en vigueur. */
  current: z.boolean(),
  fr: adminTermsTextSchema,
  en: adminTermsTextSchema.nullable(),
  /**
   * Nombre de comptes qui ont accepté cette version. Un compte clôturé n'est plus compté — la
   * clôture efface ses acceptations ; une inscription dont l'adresse n'est pas encore vérifiée
   * l'est.
   */
  acceptances: z.number().int().nonnegative(),
});
export type AdminTermsVersion = z.infer<typeof adminTermsVersionSchema>;

export const adminTermsVersionListSchema = z.object({
  /** De la plus récente à la plus ancienne. */
  versions: z.array(adminTermsVersionSchema),
});
export type AdminTermsVersionList = z.infer<typeof adminTermsVersionListSchema>;
