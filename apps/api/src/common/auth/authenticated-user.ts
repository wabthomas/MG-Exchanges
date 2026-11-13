import type { Request } from 'express';

/** Identité établie par la garde d'authentification pour la requête en cours. */
export interface AuthenticatedUser {
  readonly userId: string;
  /** Session à laquelle appartient le jeton d'accès présenté. */
  readonly sessionId: string;
}

// Clé privée : seule la garde d'authentification peut inscrire une identité sur la requête.
const AUTHENTICATED_USER = Symbol('mgx.authenticatedUser');

type RequestWithIdentity = Request & { [AUTHENTICATED_USER]?: AuthenticatedUser };

export function setAuthenticatedUser(request: Request, user: AuthenticatedUser): void {
  (request as RequestWithIdentity)[AUTHENTICATED_USER] = user;
}

export function getAuthenticatedUser(request: Request): AuthenticatedUser | undefined {
  return (request as RequestWithIdentity)[AUTHENTICATED_USER];
}
