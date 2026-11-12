/** File sur laquelle le relais publie les événements de domaine issus de la boîte d'envoi. */
export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/** File technique cadençant le relais de la boîte d'envoi. */
export const OUTBOX_RELAY_QUEUE = 'outbox-relay';

/** File technique cadençant la purge des données d'identité devenues inutiles. */
export const ACCOUNT_MAINTENANCE_QUEUE = 'account-maintenance';
