import { Module } from '@nestjs/common';

import { AppConfig } from '../../config/app-config.js';
import { NotificationSender } from './application/notification-sender.js';
import { NotificationService } from './application/notification.service.js';
import { InMemoryNotificationSender } from './infrastructure/in-memory-notification-sender.js';
import { UnconfiguredNotificationSender } from './infrastructure/unconfigured-notification-sender.js';
import { DevMailboxController } from './presentation/dev-mailbox.controller.js';

/**
 * Notifications aux utilisateurs. Le moyen de remise est choisi par la configuration ;
 * les prestataires d'e-mail et de SMS s'ajouteront comme implémentations de `NotificationSender`.
 */
@Module({
  controllers: [DevMailboxController],
  providers: [
    {
      provide: NotificationSender,
      inject: [AppConfig],
      useFactory: (config: AppConfig): NotificationSender =>
        config.notifications.delivery === 'memory'
          ? new InMemoryNotificationSender()
          : new UnconfiguredNotificationSender(),
    },
    NotificationService,
  ],
  exports: [NotificationService, NotificationSender],
})
export class NotificationsModule {}
