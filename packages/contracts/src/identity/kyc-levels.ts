import { z } from 'zod';

export const KYC_LEVELS = [1, 2, 3] as const;
export type KycLevel = (typeof KYC_LEVELS)[number];

export const kycLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** Niveau vérifié d'un compte : `0` tant qu'aucun niveau n'est vérifié. */
export const kycVerifiedLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type KycVerifiedLevel = z.infer<typeof kycVerifiedLevelSchema>;
