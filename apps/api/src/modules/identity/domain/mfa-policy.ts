/**
 * Règles du second facteur (validation en deux étapes).
 */

/** Durée de validité d'une connexion en attente du second facteur. */
export const MFA_LOGIN_TTL_SECONDS = 300;

/** Codes pouvant être essayés pour une même connexion en attente ; au-delà, il faut la recommencer. */
export const MFA_LOGIN_MAX_ATTEMPTS = 5;

/** Preuve du second facteur : code de l'application d'authentification, ou code de secours. */
export type SecondFactorProof =
  | { readonly method: 'TOTP'; readonly code: string }
  | { readonly method: 'RECOVERY_CODE'; readonly code: string };

/** Lit la preuve dans une requête qui porte soit `code`, soit `recoveryCode` (jamais les deux). */
export function toSecondFactorProof(request: {
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
}): SecondFactorProof | null {
  if (request.code !== undefined && request.recoveryCode === undefined) {
    return { method: 'TOTP', code: request.code };
  }
  if (request.recoveryCode !== undefined && request.code === undefined) {
    return { method: 'RECOVERY_CODE', code: request.recoveryCode };
  }
  return null;
}
