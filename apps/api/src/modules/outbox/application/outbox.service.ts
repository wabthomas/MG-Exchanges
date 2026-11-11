import { Injectable } from '@nestjs/common';

import { toJsonObject } from '../../../common/json.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { EVENT_TYPE_PATTERN, type NewDomainEvent } from '../domain/domain-event.js';

/**
 * Boîte d'envoi transactionnelle : enregistre un événement de domaine **dans la transaction
 * de l'opération métier** qui le produit. L'événement est ainsi validé ou annulé avec les
 * données — il n'existe ni événement sans donnée, ni donnée sans événement. La publication
 * est ensuite assurée, de façon asynchrone, par {@link OutboxRelayService}.
 */
@Injectable()
export class OutboxService {
  /** @returns l'identifiant de l'événement enregistré. */
  async append(tx: DbClient, event: NewDomainEvent): Promise<string> {
    if (!EVENT_TYPE_PATTERN.test(event.eventType)) {
      throw new Error(`Invalid event type "${event.eventType}": expected "aggregate.fact".`);
    }

    const created = await tx.outboxEvent.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: toJsonObject(event.payload),
        metadata: toJsonObject(event.metadata ?? {}),
      },
      select: { id: true },
    });
    return created.id;
  }
}
