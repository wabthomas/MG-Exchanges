/** Format des types d'événement : `agrégat.fait_accompli` en minuscules (`system_setting.changed`). */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Événement de domaine à enregistrer dans la boîte d'envoi. */
export interface NewDomainEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Corrélation (identifiant de requête, acteur…). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Événement tel que remis aux consommateurs. */
export interface DomainEventEnvelope {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/**
 * Consommateur d'un type d'événement.
 *
 * La remise est « au moins une fois » : un même événement peut être présenté plusieurs
 * fois (nouvelle tentative, redémarrage). `handle` doit donc être idempotent.
 */
export interface DomainEventHandler {
  /** Nom stable du consommateur (journaux, diagnostics). */
  readonly name: string;
  readonly eventType: string;
  handle(event: DomainEventEnvelope): Promise<void>;
}
