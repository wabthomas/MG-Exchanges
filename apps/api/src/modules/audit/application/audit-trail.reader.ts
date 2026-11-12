import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { AuditOutcome } from '../domain/audit-entry.js';

/** Entrée du journal d'audit telle que relue. */
export interface AuditRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: 'USER' | 'SYSTEM' | 'SERVICE';
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: unknown;
}

export interface AuditTrailPage {
  /** Nombre maximal d'entrées. */
  readonly limit: number;
  /** Curseur : ne retourner que les entrées antérieures à celle-ci. */
  readonly before?: string | undefined;
  /** Restreint aux actions citées. */
  readonly actions?: readonly string[] | undefined;
}

/**
 * Lecture du journal d'audit. Le journal ne se lit jamais « en vrac » : chaque lecture est
 * bornée et porte sur un sujet précis.
 */
@Injectable()
export class AuditTrailReader {
  /**
   * Entrées concernant un compte — celles dont il est l'auteur et celles dont il est l'objet —,
   * de la plus récente à la plus ancienne. Les identifiants (UUID v7) suivent l'ordre du
   * temps : ils servent de curseur.
   */
  listForUser(db: DbClient, userId: string, page: AuditTrailPage): Promise<AuditRecord[]> {
    return db.auditLog.findMany({
      where: {
        OR: [
          { actorType: 'USER', actorId: userId },
          { resourceType: 'user', resourceId: userId },
        ],
        ...(page.actions === undefined ? {} : { action: { in: [...page.actions] } }),
        ...(page.before === undefined ? {} : { id: { lt: page.before } }),
      },
      orderBy: { id: 'desc' },
      take: page.limit,
    });
  }
}
