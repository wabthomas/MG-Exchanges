import { Injectable } from '@nestjs/common';

import { toJsonObject } from '../../../common/json.js';
import { redactSensitive } from '../../../common/security/redaction.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { AUDIT_ACTION_PATTERN, type AuditEntry } from '../domain/audit-entry.js';

const USER_AGENT_MAX_LENGTH = 512;

/**
 * Écriture du journal d'audit.
 *
 * L'entrée est écrite avec le client de base de données fourni par l'appelant : passée
 * dans la transaction de l'opération auditée, elle est validée ou annulée avec elle — une
 * action sensible ne peut donc pas aboutir sans laisser de trace. La table est en ajout
 * seul (la base refuse UPDATE, DELETE et TRUNCATE).
 */
@Injectable()
export class AuditService {
  async record(db: DbClient, entry: AuditEntry): Promise<void> {
    if (!AUDIT_ACTION_PATTERN.test(entry.action)) {
      throw new Error(`Invalid audit action "${entry.action}": expected "resource.verb".`);
    }

    await db.auditLog.create({
      data: {
        actorType: entry.actor.type,
        actorId: entry.actor.type === 'SYSTEM' ? null : entry.actor.id,
        action: entry.action,
        resourceType: entry.resource.type,
        resourceId: entry.resource.id ?? null,
        outcome: entry.outcome,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
        metadata: toJsonObject(redactSensitive(entry.metadata ?? {})),
      },
    });
  }
}
