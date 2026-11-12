import type { RenderedNotification } from '../domain/notification.js';
import { NotificationSender } from '../application/notification-sender.js';

export interface StoredNotification extends RenderedNotification {
  readonly sentAt: Date;
}

const CAPACITY = 500;

/**
 * Boîte de réception en mémoire — **outil de développement et de test**. Aucun message ne
 * quitte le processus, e-mail comme SMS : les codes à usage unique s'y lisent directement. Elle est interdite
 * en pré-production et en production par la validation de la configuration.
 */
export class InMemoryNotificationSender extends NotificationSender {
  private readonly messages: StoredNotification[] = [];

  supports(): boolean {
    return true;
  }

  deliver(notification: RenderedNotification): Promise<void> {
    this.messages.push({ ...notification, sentAt: new Date() });
    if (this.messages.length > CAPACITY) {
      this.messages.shift();
    }
    return Promise.resolve();
  }

  /** Messages reçus par un destinataire, du plus récent au plus ancien. */
  messagesFor(recipient: string): readonly StoredNotification[] {
    return this.messages.filter((message) => message.recipient === recipient).reverse();
  }
}
