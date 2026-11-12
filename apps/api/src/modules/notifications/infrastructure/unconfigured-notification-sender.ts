import type { RenderedNotification } from '../domain/notification.js';
import { NotificationSender } from '../application/notification-sender.js';

/**
 * Aucun prestataire d'envoi n'est configuré. Tant que c'est le cas, les parcours qui exigent
 * un message (inscription, réinitialisation du mot de passe, vérification du téléphone) sont
 * refusés avant toute écriture.
 */
export class UnconfiguredNotificationSender extends NotificationSender {
  supports(): boolean {
    return false;
  }

  deliver(notification: RenderedNotification): Promise<void> {
    return Promise.reject(
      new Error(`No notification delivery is configured (template "${notification.template}").`),
    );
  }
}
