import { emailSchema } from '@mgx/validation';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';

import { Public } from '../../../common/auth/auth.decorators.js';
import { AppError } from '../../../common/errors/app-error.js';
import { AllowDuringMaintenance } from '../../system-settings/presentation/access.decorators.js';
import { NotificationSender } from '../application/notification-sender.js';
import { InMemoryNotificationSender } from '../infrastructure/in-memory-notification-sender.js';

const mailboxQuerySchema = z.strictObject({ recipient: emailSchema });
type MailboxQuery = z.infer<typeof mailboxQuerySchema>;

interface MailboxMessage {
  readonly template: string;
  readonly locale: string;
  readonly subject: string;
  readonly text: string;
  readonly sentAt: string;
}

/**
 * Boîte de réception de développement : les messages que la plateforme aurait envoyés.
 *
 * N'existe que lorsque la remise est en mémoire (`NOTIFICATION_DELIVERY=memory`), ce que la
 * configuration interdit en pré-production et en production. Partout ailleurs : 404.
 */
@ApiExcludeController()
@Public()
@AllowDuringMaintenance()
@Controller({ path: 'dev/mailbox', version: '1' })
export class DevMailboxController {
  constructor(private readonly sender: NotificationSender) {}

  @Get()
  list(@Query({ schema: mailboxQuerySchema }) query: MailboxQuery): {
    messages: MailboxMessage[];
  } {
    if (!(this.sender instanceof InMemoryNotificationSender)) {
      throw new AppError('NOT_FOUND', 'Cannot GET /api/v1/dev/mailbox');
    }
    return {
      messages: this.sender.messagesFor(query.recipient).map((message) => ({
        template: message.template,
        locale: message.locale,
        subject: message.subject,
        text: message.text,
        sentAt: message.sentAt.toISOString(),
      })),
    };
  }
}
