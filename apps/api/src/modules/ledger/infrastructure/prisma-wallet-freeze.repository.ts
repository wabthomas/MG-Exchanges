import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import {
  ACCOUNT_CLOSED_SQLSTATE,
  isUniqueViolation,
  sqlStateOf,
} from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type NewWalletFreeze,
  WalletAlreadyFrozenError,
  type WalletFreezeFilter,
  type WalletFreezeLift,
  type WalletFreezeRecord,
  WalletFreezeRefusedByDatabaseError,
  WalletFreezeRepository,
} from '../application/wallet-freeze.repository.js';
import { HolderClosedError } from '../domain/ledger-errors.js';
import type { WalletRef } from '../domain/wallet-freeze.js';

/** SQLSTATE levé par la base lorsqu'une règle des opérations du personnel est enfreinte. */
export const STAFF_OPERATION_RULE_VIOLATION = 'MGX11';

interface FreezeRow {
  id: string;
  user_id: string;
  asset_code: string;
  reason: string;
  frozen_by: string;
  frozen_at: Date;
  lifted_by: string | null;
  lifted_at: Date | null;
  lift_reason: string | null;
}

const FREEZE_COLUMNS = Prisma.sql`
  f."id"::text AS "id", f."user_id"::text AS "user_id", f."asset_code", f."reason",
  f."frozen_by"::text AS "frozen_by", f."frozen_at", f."lifted_by"::text AS "lifted_by",
  f."lifted_at", f."lift_reason"`;

const uuid = (value: string): Prisma.Sql => Prisma.sql`${value}::uuid`;

function toFreeze(row: FreezeRow): WalletFreezeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetCode: row.asset_code,
    reason: row.reason,
    frozenBy: row.frozen_by,
    frozenAt: row.frozen_at,
    liftedBy: row.lifted_by,
    liftedAt: row.lifted_at,
    liftReason: row.lift_reason,
  };
}

@Injectable()
export class PrismaWalletFreezeRepository extends WalletFreezeRepository {
  async frozenAssetsOf(db: DbClient, userId: string): Promise<string[]> {
    const rows = await db.$queryRaw<{ asset_code: string }[]>(Prisma.sql`
      SELECT f."asset_code"
      FROM "wallet_freezes" AS f
      WHERE f."user_id" = ${uuid(userId)} AND f."lifted_at" IS NULL
      ORDER BY f."asset_code"
    `);
    return rows.map((row) => row.asset_code);
  }

  async frozenAmong(db: DbClient, wallets: readonly WalletRef[]): Promise<WalletRef[]> {
    if (wallets.length === 0) {
      return [];
    }
    // Une recherche par portefeuille, chacune servie par l'index des gels en vigueur.
    const lookups = wallets.map(
      (wallet) => Prisma.sql`(
        SELECT f."user_id"::text AS "user_id", f."asset_code"
        FROM "wallet_freezes" AS f
        WHERE f."user_id" = ${uuid(wallet.userId)} AND f."asset_code" = ${wallet.assetCode}
          AND f."lifted_at" IS NULL)`,
    );
    const rows = await db.$queryRaw<{ user_id: string; asset_code: string }[]>(
      Prisma.join(lookups, ' UNION ALL '),
    );
    return rows.map((row) => ({ userId: row.user_id, assetCode: row.asset_code }));
  }

  async insert(tx: DbClient, freeze: NewWalletFreeze): Promise<WalletFreezeRecord> {
    try {
      // L'heure du gel est fixée par la base, une fois obtenus les verrous du portefeuille.
      const rows = await tx.$queryRaw<FreezeRow[]>(Prisma.sql`
        INSERT INTO "wallet_freezes" AS f ("user_id", "asset_code", "reason", "frozen_by")
        VALUES (${uuid(freeze.userId)}, ${freeze.assetCode}, ${freeze.reason},
                ${uuid(freeze.frozenBy)})
        RETURNING ${FREEZE_COLUMNS}
      `);
      const [row] = rows;
      if (row === undefined) {
        throw new Error('The wallet freeze was not written.');
      }
      return toFreeze(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyFrozenError();
      }
      const sqlState = sqlStateOf(error);
      if (sqlState === ACCOUNT_CLOSED_SQLSTATE) {
        throw new HolderClosedError({ cause: error });
      }
      if (sqlState === STAFF_OPERATION_RULE_VIOLATION) {
        throw new WalletFreezeRefusedByDatabaseError({ cause: error });
      }
      throw error;
    }
  }

  async lift(tx: DbClient, id: string, lift: WalletFreezeLift): Promise<WalletFreezeRecord | null> {
    try {
      // Écriture conditionnelle : de deux levées simultanées, une seule s'applique. L'heure de
      // la levée est fixée par la base.
      const rows = await tx.$queryRaw<FreezeRow[]>(Prisma.sql`
        UPDATE "wallet_freezes" AS f
        SET "lifted_by" = ${uuid(lift.liftedBy)}, "lift_reason" = ${lift.reason}
        WHERE f."id" = ${uuid(id)} AND f."lifted_at" IS NULL
        RETURNING ${FREEZE_COLUMNS}
      `);
      const [row] = rows;
      return row === undefined ? null : toFreeze(row);
    } catch (error) {
      if (sqlStateOf(error) === STAFF_OPERATION_RULE_VIOLATION) {
        throw new WalletFreezeRefusedByDatabaseError({ cause: error });
      }
      throw error;
    }
  }

  async find(db: DbClient, id: string): Promise<WalletFreezeRecord | null> {
    const rows = await db.$queryRaw<FreezeRow[]>(Prisma.sql`
      SELECT ${FREEZE_COLUMNS} FROM "wallet_freezes" AS f WHERE f."id" = ${uuid(id)}
    `);
    const [row] = rows;
    return row === undefined ? null : toFreeze(row);
  }

  async list(db: DbClient, filter: WalletFreezeFilter): Promise<WalletFreezeRecord[]> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.userId !== undefined) {
      conditions.push(Prisma.sql`f."user_id" = ${uuid(filter.userId)}`);
    }
    if (filter.status === 'ACTIVE') {
      conditions.push(Prisma.sql`f."lifted_at" IS NULL`);
    }
    if (filter.status === 'LIFTED') {
      conditions.push(Prisma.sql`f."lifted_at" IS NOT NULL`);
    }
    if (filter.beforeId !== undefined) {
      conditions.push(Prisma.sql`f."id" < ${uuid(filter.beforeId)}`);
    }
    // L'identifiant d'un gel (UUID v7) croît avec le temps.
    const rows = await db.$queryRaw<FreezeRow[]>(Prisma.sql`
      SELECT ${FREEZE_COLUMNS}
      FROM "wallet_freezes" AS f
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY f."id" DESC
      LIMIT ${filter.limit}
    `);
    return rows.map(toFreeze);
  }
}
