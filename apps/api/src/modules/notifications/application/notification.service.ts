import { Injectable } from '@nestjs/common';

import type { NotificationChannel, NotificationMessage } from '../domain/notification.js';
import { renderNotification } from '../domain/templates.js';
import { NotificationSender } from './notification-sender.js';

/** Envoi des messages aux utilisateurs : rédaction dans leur langue, puis remise. */
@Injectable()
export class NotificationService {
  constructor(private readonly sender: NotificationSender) {}

  /**
   * Faux tant qu'aucun moyen de remise n'est configuré pour ce canal. Les parcours qui
   * dépendent d'un message (inscription, réinitialisation, vérification du téléphone) doivent
   * alors être refusés d'emblée.
   */
  canDeliver(channel: NotificationChannel): boolean {
    return this.sender.supports(channel);
  }

  async send(message: NotificationMessage): Promise<void> {
    await this.sender.deliver(renderNotification(message));
  }
}
