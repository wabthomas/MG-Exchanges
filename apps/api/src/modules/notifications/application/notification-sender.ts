import type { RenderedNotification } from '../domain/notification.js';

/**
 * Port de remise des messages (e-mail aujourd'hui, SMS et notifications poussées ensuite).
 * Chaque prestataire d'envoi en sera une implémentation ; le reste de l'application l'ignore.
 */
export abstract class NotificationSender {
  /** Faux lorsqu'aucun moyen de remise n'est configuré : aucun message ne peut partir. */
  abstract readonly operational: boolean;

  /** Remet le message, ou lève une exception (l'appelant réessaiera). */
  abstract deliver(notification: RenderedNotification): Promise<void>;
}
