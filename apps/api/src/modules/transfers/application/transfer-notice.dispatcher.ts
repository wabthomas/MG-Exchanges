import { localeSchema } from '@mgx/validation';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import { LedgerReader } from '../../ledger/application/ledger-reader.js';
import { amountText } from '../../ledger/application/ledger-views.js';
import { NotificationService } from '../../notifications/application/notification.service.js';
import { DomainEventHandlerRegistry } from '../../outbox/application/domain-event-handler.registry.js';
import type { DomainEventEnvelope, DomainEventHandler } from '../../outbox/domain/domain-event.js';
import { TRANSFER_NOTICE_REQUESTED_EVENT, TRANSFER_PARTIES } from '../domain/transfer-events.js';
import { TransferRepository } from './transfer.repository.js';

const payloadSchema = z.object({
  transferId: z.uuid(),
  party: z.enum(TRANSFER_PARTIES),
});

/**
 * Informe par e-mail une partie d'un transfert : l'émetteur, que des fonds ont quitté son
 * compte — un transfert qu'il n'aurait pas fait ne doit pas lui échapper ; le destinataire,
 * qu'il en a reçu, et de qui.
 *
 * Le message est rédigé à partir du transfert relu en base : son montant, l'adresse que porte
 * aujourd'hui l'autre partie. Une partie dont le compte a été clôturé entre-temps n'est plus
 * prévenue : elle n'a plus d'adresse.
 */
@Injectable()
export class TransferNoticeDispatcher implements DomainEventHandler, OnModuleInit {
  readonly name = 'transfers.send-transfer-notice';
  readonly eventType = TRANSFER_NOTICE_REQUESTED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly transfers: TransferRepository,
    private readonly users: UserRepository,
    private readonly reader: LedgerReader,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const { party, transferId } = payloadSchema.parse(event.payload);

    // Ces messages informent, ils ne conditionnent rien : sans moyen de remise configuré,
    // l'événement est abandonné plutôt que retenté indéfiniment.
    if (!this.notifications.canDeliver('EMAIL')) {
      return;
    }
    const transfer = await this.transfers.findById(this.prisma, transferId);
    if (transfer === null) {
      return;
    }
    const sent = party === 'SENDER';
    const user = await this.users.findById(
      this.prisma,
      sent ? transfer.senderId : transfer.recipientId,
    );
    if (user === null || user.status === 'CLOSED') {
      return;
    }
    const asset = await this.reader.asset(this.prisma, transfer.assetCode);
    if (asset === null) {
      throw new Error(`Asset ${transfer.assetCode} of transfer ${transfer.id} is not registered.`);
    }
    const counterpartyId = sent ? transfer.recipientId : transfer.senderId;
    const emails = await this.users.findEmails(this.prisma, [counterpartyId]);

    await this.notifications.send({
      channel: 'EMAIL',
      recipient: user.email,
      locale: localeSchema.catch('fr').parse(user.locale),
      content: {
        template: sent ? 'transfer_sent' : 'transfer_received',
        amount: amountText(transfer.units, asset),
        assetCode: asset.code,
        counterparty: emails.get(counterpartyId) ?? null,
        occurredAt: transfer.createdAt.toISOString(),
      },
    });
  }
}
