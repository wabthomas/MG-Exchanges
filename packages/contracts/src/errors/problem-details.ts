import { isoDateTimeSchema, requestIdSchema } from '@mgx/validation';
import { z } from 'zod';

import { ERROR_CODE_VALUES } from './error-codes.js';

/** Type de média des réponses d'erreur (RFC 9457). */
export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/** Détail d'un champ invalide (erreurs de validation). */
export const fieldErrorSchema = z.object({
  /** Chemin du champ fautif (`"body.amount"`, `"query.limit"`), vide pour l'objet racine. */
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * Corps de toute réponse d'erreur de l'API — « Problem Details » (RFC 9457) étendu.
 *
 * Membres standards : `type`, `title`, `status`, `detail`, `instance`.
 * Extensions MG-Exchange : `code` (identifiant stable), `requestId` (corrélation avec les
 * journaux et le support), `timestamp`, `errors` (détail par champ).
 */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.enum(ERROR_CODE_VALUES),
  detail: z.string(),
  instance: z.string(),
  requestId: requestIdSchema,
  timestamp: isoDateTimeSchema,
  errors: z.array(fieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
