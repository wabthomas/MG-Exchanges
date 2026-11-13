import type { NotificationChannel, RenderedNotification } from '../domain/notification.js';

/**
 * Port de remise des messages (e-mail, SMS ; notifications poussées ensuite).
 * Chaque prestataire d'envoi en sera une implémentation ; le reste de l'application l'ignore.
 */
export abstract class NotificationSender {
  /** Faux lorsqu'aucun moyen de remise n'est configuré pour ce canal : aucun message ne peut partir. */
  abstract supports(channel: NotificationChannel): boolean;

  /** Remet le message, ou lève une exception (l'appelant réessaiera). */
  abstract deliver(notification: RenderedNotification): Promise<void>;
}
