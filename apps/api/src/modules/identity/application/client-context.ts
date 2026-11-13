/** Contexte technique de la requête à l'origine d'une action (journal d'audit, sessions). */
export interface ClientContext {
  readonly requestId: string;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
}
