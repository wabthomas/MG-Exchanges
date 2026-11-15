import type { LedgerAdjustmentDirection, LedgerAdjustmentStatus } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import {
  ACCOUNT_CLOSED_SQLSTATE,
  isUniqueViolation,
  sqlStateOf,
} from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { HolderClosedError } from '../../ledger/domain/ledger-errors.js';
import {
  type AdjustmentApproval,
  type AdjustmentClosure,
  type AdjustmentFilter,
  type AdjustmentRecord,
  AdjustmentRefusedByDatabaseError,
  AdjustmentRepository,
  type NewAdjustment,
  PendingAdjustmentExistsError,
} from '../application/adjustment.repository.js';

/** SQLSTATE levé par la base lorsqu'une règle des opérations du personnel est enfreinte. */
export const STAFF_OPERATION_RULE_VIOLATION = 'MGX11';

interface AdjustmentRow {
  id: string;
  user_id: string;
  asset_code: string;
  direction: LedgerAdjustmentDirection;
  amount: string;
  reason: string;
  status: LedgerAdjustmentStatus;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  entry_id: string | null;
}

// Le montant est lu en texte : il ne passe ni par un nombre flottant, ni par une bibliothèque
// décimale.
const ADJUSTMENT_COLUMNS = Prisma.sql`
  j."id"::text AS "id", j."user_id"::text AS "user_id", j."asset_code",
  j."direction"::text AS "direction", j."amount"::text AS "amount", j."reason",
  j."status"::text AS "status", j."requested_by"::text AS "requested_by", j."requested_at",
  j."expires_at", j."decided_by"::text AS "decided_by", j."decided_at", j."decision_note",
  j."entry_id"::text AS "entry_id"`;

const uuid = (value: string): Prisma.Sql => Prisma.sql`${value}::uuid`;

function toAdjustment(row: AdjustmentRow): AdjustmentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetCode: row.asset_code,
    direction: row.direction,
    units: BigInt(row.amount),
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    entryId: row.entry_id,
  };
}

/** Traduit le refus d'une règle par la base ; toute autre erreur est relancée telle quelle. */
async function refusedByDatabase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (sqlStateOf(error) === STAFF_OPERATION_RULE_VIOLATION) {
      throw new AdjustmentRefusedByDatabaseError({ cause: error });
    }
    throw error;
  }
}

@Injectable()
export class PrismaAdjustmentRepository extends AdjustmentRepository {
  async create(tx: DbClient, adjustment: NewAdjustment): Promise<AdjustmentRecord> {
    try {
      // L'heure de la demande et son échéance sont fixées par la base.
      const rows = await tx.$queryRaw<AdjustmentRow[]>(Prisma.sql`
        INSERT INTO "ledger_adjustments" AS j
          ("user_id", "asset_code", "direction", "amount", "reason", "requested_by")
        VALUES
          (${uuid(adjustment.userId)}, ${adjustment.assetCode},
           ${adjustment.direction}::"ledger_side", ${adjustment.units.toString()}::numeric,
           ${adjustment.reason}, ${uuid(adjustment.requestedBy)})
        RETURNING ${ADJUSTMENT_COLUMNS}
      `);
      const [row] = rows;
      if (row === undefined) {
        throw new Error('The ledger adjustment was not written.');
      }
      return toAdjustment(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PendingAdjustmentExistsError();
      }
      const sqlState = sqlStateOf(error);
      if (sqlState === ACCOUNT_CLOSED_SQLSTATE) {
        throw new HolderClosedError({ cause: error });
      }
      if (sqlState === STAFF_OPERATION_RULE_VIOLATION) {
        throw new AdjustmentRefusedByDatabaseError({ cause: error });
      }
      throw error;
    }
  }

  async find(db: DbClient, id: string): Promise<AdjustmentRecord | null> {
    const rows = await db.$queryRaw<AdjustmentRow[]>(Prisma.sql`
      SELECT ${ADJUSTMENT_COLUMNS} FROM "ledger_adjustments" AS j WHERE j."id" = ${uuid(id)}
    `);
    const [row] = rows;
    return row === undefined ? null : toAdjustment(row);
  }

  async lock(tx: DbClient, id: string): Promise<AdjustmentRecord | null> {
    const rows = await tx.$queryRaw<AdjustmentRow[]>(Prisma.sql`
      SELECT ${ADJUSTMENT_COLUMNS}
      FROM "ledger_adjustments" AS j
      WHERE j."id" = ${uuid(id)}
      FOR UPDATE
    `);
    const [row] = rows;
    return row === undefined ? null : toAdjustment(row);
  }

  async list(db: DbClient, filter: AdjustmentFilter): Promise<AdjustmentRecord[]> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.status !== undefined) {
      conditions.push(Prisma.sql`j."status" = ${filter.status}::"ledger_adjustment_status"`);
    }
    if (filter.userId !== undefined) {
      conditions.push(Prisma.sql`j."user_id" = ${uuid(filter.userId)}`);
    }
    if (filter.beforeId !== undefined) {
      conditions.push(Prisma.sql`j."id" < ${uuid(filter.beforeId)}`);
    }
    // L'identifiant d'un ajustement (UUID v7) croît avec l'heure de sa demande.
    const rows = await db.$queryRaw<AdjustmentRow[]>(Prisma.sql`
      SELECT ${ADJUSTMENT_COLUMNS}
      FROM "ledger_adjustments" AS j
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY j."id" DESC
      LIMIT ${filter.limit}
    `);
    return rows.map(toAdjustment);
  }

  async approve(
    tx: DbClient,
    id: string,
    approval: AdjustmentApproval,
  ): Promise<AdjustmentRecord | null> {
    // Écriture conditionnelle : de deux décisions simultanées, une seule s'applique. L'heure de
    // la décision est fixée par la base.
    const rows = await refusedByDatabase(() =>
      tx.$queryRaw<AdjustmentRow[]>(Prisma.sql`
        UPDATE "ledger_adjustments" AS j
        SET "status" = 'APPROVED', "decided_by" = ${uuid(approval.decidedBy)},
            "decision_note" = ${approval.note}, "entry_id" = ${uuid(approval.entryId)}
        WHERE j."id" = ${uuid(id)} AND j."status" = 'PENDING'
        RETURNING ${ADJUSTMENT_COLUMNS}
      `),
    );
    const [row] = rows;
    return row === undefined ? null : toAdjustment(row);
  }

  async close(
    tx: DbClient,
    id: string,
    closure: AdjustmentClosure,
  ): Promise<AdjustmentRecord | null> {
    const rows = await refusedByDatabase(() =>
      tx.$queryRaw<AdjustmentRow[]>(Prisma.sql`
        UPDATE "ledger_adjustments" AS j
        SET "status" = ${closure.status}::"ledger_adjustment_status",
            "decided_by" = ${uuid(closure.decidedBy)}, "decision_note" = ${closure.note}
        WHERE j."id" = ${uuid(id)} AND j."status" = 'PENDING'
        RETURNING ${ADJUSTMENT_COLUMNS}
      `),
    );
    const [row] = rows;
    return row === undefined ? null : toAdjustment(row);
  }

  async expireOverdue(db: DbClient): Promise<number> {
    // L'échéance se lit à l'horloge de la base, qui l'a fixée — et qui la vérifie de nouveau.
    return db.$executeRaw`
      UPDATE "ledger_adjustments"
      SET "status" = 'EXPIRED'
      WHERE "status" = 'PENDING' AND "expires_at" <= clock_timestamp()
    `;
  }
}
