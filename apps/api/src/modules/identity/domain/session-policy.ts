/**
 * Règles de vie d'une session, sans aucune dépendance : entrées et sorties sont des dates.
 *
 * Une session expire de deux façons : par **inactivité** (échéance repoussée à chaque
 * renouvellement des jetons) et **dans l'absolu** (échéance fixée à la connexion, jamais
 * repoussée). Elle peut aussi être révoquée à tout moment.
 */

export interface SessionState {
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export function isSessionUsable(session: SessionState, now: Date): boolean {
  return session.revokedAt === null && session.idleExpiresAt > now && session.expiresAt > now;
}

/** Échéance d'inactivité après une utilisation : jamais au-delà de l'échéance absolue. */
export function nextIdleExpiry(now: Date, absoluteExpiry: Date, idleTtlMs: number): Date {
  return new Date(Math.min(now.getTime() + idleTtlMs, absoluteExpiry.getTime()));
}

export type RefreshDecision =
  /** Jeton jamais utilisé : le consommer et émettre une nouvelle paire. */
  | 'ROTATE'
  /**
   * Jeton utilisé il y a quelques secondes : la réponse s'est vraisemblablement perdue
   * (réseau instable, requêtes concurrentes). Émettre une nouvelle paire.
   */
  | 'REISSUE_WITHIN_GRACE'
  /** Jeton utilisé depuis plus longtemps : il a été copié. Révoquer la session. */
  | 'REUSE_DETECTED';

/**
 * Que faire d'un jeton de renouvellement présenté, selon qu'il a déjà servi ou non.
 *
 * Chaque renouvellement remplace le jeton. Si un jeton déjà remplacé réapparaît, deux
 * détenteurs existent — le titulaire et un voleur — et rien ne permet de les distinguer :
 * la session entière est révoquée.
 */
export function decideRefresh(
  token: { readonly consumedAt: Date | null },
  now: Date,
  reuseGraceMs: number,
): RefreshDecision {
  if (token.consumedAt === null) {
    return 'ROTATE';
  }
  // Un délai nul signifie « aucune tolérance » : la comparaison des dates ne doit alors rien
  // excuser, pas même deux requêtes traitées dans la même milliseconde.
  const withinGrace =
    reuseGraceMs > 0 && now.getTime() - token.consumedAt.getTime() <= reuseGraceMs;
  return withinGrace ? 'REISSUE_WITHIN_GRACE' : 'REUSE_DETECTED';
}
