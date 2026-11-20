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
import { ADJUSTMENT_NOTICE_REQUESTED_EVENT } from '../domain/adjustment-events.js';
import { AdjustmentRepository } from './adjustment.repository.js';

const payloadSchema = z.object({ adjustmentId: z.uuid() });

/**
 * Informe par e-mail le titulaire d'un portefeuille que la plateforme vient de le créditer ou
 * de le débiter : des fonds ne bougent pas sur son portefeuille à son insu.
 *
 * Le message est rédigé à partir de l'ajustement relu en base — son sens, son montant —, et ne
 * donne **jamais** la justification, qui reste interne. Un titulaire dont le compte a été
 * clôturé entre-temps n'est plus prévenu : il n'a plus d'adresse.
 */
@Injectable()
export class AdjustmentNoticeDispatcher implements DomainEventHandler, OnModuleInit {
  readonly name = 'adjustments.send-adjustment-notice';
  readonly eventType = ADJUSTMENT_NOTICE_REQUESTED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly adjustments: AdjustmentRepository,
    private readonly users: UserRepository,
    private readonly reader: LedgerReader,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const { adjustmentId } = payloadSchema.parse(event.payload);

    // Ce message informe, il ne conditionne rien : sans moyen de remise configuré, l'événement
    // est abandonné plutôt que retenté indéfiniment.
    if (!this.notifications.canDeliver('EMAIL')) {
      return;
    }
    const adjustment = await this.adjustments.find(this.prisma, adjustmentId);
    if (adjustment?.status !== 'APPROVED' || adjustment.decidedAt === null) {
      return;
    }
    const user = await this.users.findById(this.prisma, adjustment.userId);
    if (user === null || user.status === 'CLOSED') {
      return;
    }
    const asset = await this.reader.asset(this.prisma, adjustment.assetCode);
    if (asset === null) {
      throw new Error(
        `Asset ${adjustment.assetCode} of ledger adjustment ${adjustment.id} is not registered.`,
      );
    }

    await this.notifications.send({
      channel: 'EMAIL',
      recipient: user.email,
      locale: localeSchema.catch('fr').parse(user.locale),
      content: {
        template: 'wallet_adjusted',
        direction: adjustment.direction,
        amount: amountText(adjustment.units, asset),
        assetCode: asset.code,
        occurredAt: adjustment.decidedAt.toISOString(),
      },
    });
  }
}
