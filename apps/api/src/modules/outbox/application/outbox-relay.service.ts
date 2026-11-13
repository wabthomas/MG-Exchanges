import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { isJsonObject } from '../../../common/json.js';
import { AppConfig } from '../../../config/app-config.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { DOMAIN_EVENTS_QUEUE } from '../../../infrastructure/queue/queue.constants.js';
import type { DomainEventEnvelope } from '../domain/domain-event.js';

interface PendingRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  occurred_at: Date;
}

export interface RelayBatchResult {
  /** Événements réservés par cette exécution. */
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

const LAST_ERROR_MAX_LENGTH = 1024;
/** Délai maximal entre deux tentatives de publication d'un même événement. */
const MAX_BACKOFF_SECONDS = 300;

/**
 * Relais de la boîte d'envoi : publie sur la file `domain-events` les événements validés
 * en base.
 *
 * Garanties
 *  - **au moins une fois** : un événement n'est marqué publié qu'après acceptation par la
 *    file ; en cas d'arrêt brutal entre les deux, il est republié — l'identifiant de
 *    l'événement sert d'identifiant de traitement, ce qui dédoublonne côté file ;
 *  - **concurrence sûre** : plusieurs instances peuvent relayer simultanément, chaque
 *    événement n'étant réservé que par une seule (`FOR UPDATE SKIP LOCKED`) ;
 *  - **pas de perte silencieuse** : un échec est retenté avec un délai exponentiel, puis
 *    l'événement passe à l'état `DEAD`, signalé dans les journaux, après le nombre maximal
 *    de tentatives.
 */
@Injectable()
export class OutboxRelayService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly config: AppConfig,
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxRelayService.name);
  }

  async relayPendingBatch(): Promise<RelayBatchResult> {
    const { batchSize, maxAttempts } = this.config.outbox;

    return this.unitOfWork.run(
      async (tx) => {
        const rows = await tx.$queryRaw<PendingRow[]>(Prisma.sql`
          SELECT id, aggregate_type, aggregate_id, event_type, payload, metadata, occurred_at
          FROM outbox_events
          WHERE status = 'PENDING' AND available_at <= now()
          ORDER BY available_at, id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `);

        const publishedIds: string[] = [];
        let failed = 0;

        for (const row of rows) {
          try {
            await this.queue.add(row.event_type, toEnvelope(row), { jobId: row.id });
            publishedIds.push(row.id);
          } catch (error) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            const [updated] = await tx.$queryRaw<{ status: string; attempts: number }[]>(Prisma.sql`
              UPDATE outbox_events
              SET attempts = attempts + 1,
                  last_error = ${message.slice(0, LAST_ERROR_MAX_LENGTH)},
                  available_at = now() + make_interval(
                    secs => LEAST(power(2, attempts + 1), ${MAX_BACKOFF_SECONDS})
                  ),
                  status = CASE
                    WHEN attempts + 1 >= ${maxAttempts} THEN 'DEAD'::outbox_status
                    ELSE 'PENDING'::outbox_status
                  END
              WHERE id = ${row.id}::uuid
              RETURNING status::text AS status, attempts
            `);
            this.logger[updated?.status === 'DEAD' ? 'error' : 'warn'](
              {
                err: error,
                eventId: row.id,
                eventType: row.event_type,
                attempts: updated?.attempts,
              },
              updated?.status === 'DEAD'
                ? 'Outbox event abandoned after too many failed publications'
                : 'Outbox event publication failed; it will be retried',
            );
          }
        }

        if (publishedIds.length > 0) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE outbox_events
            SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1, last_error = NULL
            WHERE id = ANY(${publishedIds}::uuid[])
          `);
        }

        return { claimed: rows.length, published: publishedIds.length, failed };
      },
      { timeoutMs: 30_000 },
    );
  }
}

function toEnvelope(row: PendingRow): DomainEventEnvelope {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: isJsonObject(row.payload) ? row.payload : {},
    metadata: isJsonObject(row.metadata) ? row.metadata : {},
    occurredAt: row.occurred_at.toISOString(),
  };
}
