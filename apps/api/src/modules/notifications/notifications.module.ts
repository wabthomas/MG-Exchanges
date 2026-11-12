import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config.js';
import { NotificationSender } from './application/notification-sender.js';
import { NotificationService } from './application/notification.service.js';
import { InMemoryNotificationSender } from './infrastructure/in-memory-notification-sender.js';
import { SmtpNotificationSender } from './infrastructure/smtp-notification-sender.js';
import { UnconfiguredNotificationSender } from './infrastructure/unconfigured-notification-sender.js';
import { DevMailboxController } from './presentation/dev-mailbox.controller.js';

/**
 * Notifications aux utilisateurs. Le moyen de remise est choisi par la configuration : boîte
 * en mémoire (développement), serveur SMTP d'un prestataire d'e-mail, ou aucun. Un prestataire
 * SMS s'ajoutera comme une autre implémentation de `NotificationSender`.
 */
@Module({
  controllers: [DevMailboxController],
  providers: [
    {
      provide: NotificationSender,
      inject: [AppConfig, PinoLogger],
      useFactory: (config: AppConfig, logger: PinoLogger): NotificationSender => {
        const { delivery, smtp } = config.notifications;
        if (delivery === 'memory') {
          return new InMemoryNotificationSender();
        }
        if (delivery === 'smtp' && smtp !== null) {
          logger.setContext(SmtpNotificationSender.name);
          return new SmtpNotificationSender(smtp, logger);
        }
        return new UnconfiguredNotificationSender();
      },
    },
    NotificationService,
  ],
  exports: [NotificationService, NotificationSender],
})
export class NotificationsModule {}
