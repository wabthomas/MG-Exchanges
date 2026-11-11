import { Injectable } from '@nestjs/common';

import type { NotificationMessage } from '../domain/notification.js';
import { renderNotification } from '../domain/templates.js';
import { NotificationSender } from './notification-sender.js';

/** Envoi des messages aux utilisateurs : rédaction dans leur langue, puis remise. */
@Injectable()
export class NotificationService {
  constructor(private readonly sender: NotificationSender) {}

  /**
   * Faux tant qu'aucun moyen de remise n'est configuré. Les parcours qui dépendent d'un
   * message (inscription, réinitialisation) doivent alors être refusés d'emblée.
   */
  get operational(): boolean {
    return this.sender.operational;
  }

  async send(message: NotificationMessage): Promise<void> {
    await this.sender.deliver(renderNotification(message));
  }
}
