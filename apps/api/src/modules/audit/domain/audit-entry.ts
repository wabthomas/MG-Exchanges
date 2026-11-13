/** Auteur d'une action auditée. */
export type AuditActor =
  { readonly type: 'SYSTEM' } | { readonly type: 'USER' | 'SERVICE'; readonly id: string };

export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';

/** Format des actions : `ressource.verbe` en minuscules (`system_setting.updated`). */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Entrée du journal d'audit : qui a fait quoi, sur quoi, avec quel résultat. */
export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly outcome: AuditOutcome;
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
  /** Contexte libre (valeurs avant/après…). Les données sensibles en sont expurgées à l'écriture. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}
