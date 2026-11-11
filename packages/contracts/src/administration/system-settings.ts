import { isoDateTimeSchema } from '@mgx/validation';
import { z } from 'zod';

import { maintenanceStatusSchema } from '../system/system-status.js';

/** Valeur d'un paramètre : booléen (fonctionnalité) ou état de maintenance. */
export const systemSettingValueSchema = z.union([z.boolean(), maintenanceStatusSchema]);
export type SystemSettingValue = z.infer<typeof systemSettingValueSchema>;

export const systemSettingViewSchema = z.object({
  key: z.string(),
  /** Valeur en vigueur. */
  value: systemSettingValueSchema,
  /** Vrai tant qu'aucune décision n'a été enregistrée : la valeur par défaut s'applique. */
  isDefault: z.boolean(),
  /** Numéro de version de la valeur enregistrée (`null` pour une valeur par défaut). */
  version: z.number().int().positive().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type SystemSettingView = z.infer<typeof systemSettingViewSchema>;

export const systemSettingListSchema = z.object({ settings: z.array(systemSettingViewSchema) });
export type SystemSettingList = z.infer<typeof systemSettingListSchema>;

export const SETTING_CHANGE_REASON_MIN_LENGTH = 10;

export const updateSystemSettingRequestSchema = z.strictObject({
  value: systemSettingValueSchema,
  /** Justification de la décision, conservée dans le journal d'audit. */
  reason: z.string().trim().min(SETTING_CHANGE_REASON_MIN_LENGTH).max(500),
});
export type UpdateSystemSettingRequest = z.infer<typeof updateSystemSettingRequestSchema>;
