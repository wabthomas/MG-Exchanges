import { KYC_LEVELS, type KycVerifiedLevel } from '@mgx/contracts';

/**
 * Niveau de vérification d'identité d'un compte : le plus haut niveau dont tous les précédents
 * sont vérifiés. Un niveau 2 accepté ne compte pas tant que le niveau 1 ne l'est pas — ou ne
 * l'est plus.
 */
export function verifiedLevelOf(approvedLevels: readonly number[]): KycVerifiedLevel {
  let level: KycVerifiedLevel = 0;
  for (const candidate of KYC_LEVELS) {
    if (!approvedLevels.includes(candidate)) {
      break;
    }
    level = candidate;
  }
  return level;
}
