import { kycVerifiedLevelSchema, type KycVerifiedLevel, type UserStatus } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import { sqlStateOf } from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type Allowance,
  LimitChangeDeniedError,
  type LimitRecord,
  type NewLimit,
  type NewTransfer,
  type TransferPage,
  type TransferRecord,
  TransferRefusedByDatabaseError,
  TransferRepository,
} from '../application/transfer.repository.js';

/** SQLSTATE levé par la base lorsqu'une règle des transferts est enfreinte (migration `internal_transfers`). */
export const TRANSFER_RULE_VIOLATION = 'MGX10';

interface TransferRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  asset_code: string;
  amount: string;
  entry_id: string;
  idempotency_key: string;
  request_digest: string;
  sender_level: number;
  created_at: Date;
}

interface LimitRow {
  asset_code: string;
  kyc_level: number;
  per_transfer_max: string;
  daily_max: string;
  monthly_max: string;
  set_by: string | null;
  set_at: Date;
}

/** Plafonds d'un niveau dans un actif — ou rien, s'il n'en a pas. */
type OptionalLimitRow = LimitRow | { [Column in keyof LimitRow]: null };

/** Niveau du compte, cumuls de ses envois dans un actif et — s'ils existent — plafonds de ce niveau. */
type AllowanceRow = OptionalLimitRow & {
  level: number;
  last_24_hours: string;
  last_31_days: string;
};

/** La même chose pour un actif tenu — ou le niveau seul, si la plateforme n'en tient aucun. */
type AllowanceOfAssetRow = OptionalLimitRow & {
  level: number;
  code: string | null;
  last_24_hours: string | null;
  last_31_days: string | null;
};

type ChangedLimitRow = LimitRow & {
  before_per_transfer_max: string | null;
  before_daily_max: string | null;
  before_monthly_max: string | null;
  before_set_by: string | null;
  before_set_at: Date | null;
};

// Les montants sont lus en texte : ils ne passent ni par un nombre flottant, ni par une
// bibliothèque décimale. L'empreinte de la requête est lue en hexadécimal.
const TRANSFER_COLUMNS = Prisma.sql`
  t."id"::text AS "id", t."sender_id"::text AS "sender_id",
  t."recipient_id"::text AS "recipient_id", t."asset_code", t."amount"::text AS "amount",
  t."entry_id"::text AS "entry_id", t."idempotency_key",
  encode(t."request_digest", 'hex') AS "request_digest", t."sender_level", t."created_at"`;

const LIMIT_COLUMNS = Prisma.sql`
  l."asset_code", l."kyc_level", l."per_transfer_max"::text AS "per_transfer_max",
  l."daily_max"::text AS "daily_max", l."monthly_max"::text AS "monthly_max",
  l."set_by"::text AS "set_by", l."set_at"`;

const uuid = (value: string): Prisma.Sql => Prisma.sql`${value}::uuid`;

function toLevel(value: number): KycVerifiedLevel {
  return kycVerifiedLevelSchema.parse(value);
}

function toTransfer(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    assetCode: row.asset_code,
    units: BigInt(row.amount),
    entryId: row.entry_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: Buffer.from(row.request_digest, 'hex'),
    senderLevel: toLevel(row.sender_level),
    createdAt: row.created_at,
  };
}

function toLimit(row: LimitRow): LimitRecord {
  return {
    assetCode: row.asset_code,
    level: toLevel(row.kyc_level),
    perTransferMax: BigInt(row.per_transfer_max),
    dailyMax: BigInt(row.daily_max),
    monthlyMax: BigInt(row.monthly_max),
    setBy: row.set_by,
    setAt: row.set_at,
  };
}

function toAllowance(row: AllowanceRow): Allowance {
  return {
    level: toLevel(row.level),
    ceilings: row.asset_code === null ? null : toLimit(row),
    usage: { last24Hours: BigInt(row.last_24_hours), last31Days: BigInt(row.last_31_days) },
  };
}

@Injectable()
export class PrismaTransferRepository extends TransferRepository {
  // --- Émetteur ---

  async lockSender(tx: DbClient, senderId: string): Promise<UserStatus | null> {
    // FOR NO KEY UPDATE : exclut un autre transfert du même émetteur, sa suspension et sa
    // clôture — pas le verrou qu'une écriture du grand livre prend sur ses titulaires.
    const rows = await tx.$queryRaw<{ status: UserStatus }[]>(Prisma.sql`
      SELECT u."status"::text AS "status"
      FROM "users" AS u
      WHERE u."id" = ${uuid(senderId)}
      FOR NO KEY UPDATE
    `);
    return rows[0]?.status ?? null;
  }

  async allowance(db: DbClient, userId: string, assetCode: string): Promise<Allowance> {
    const rows = await db.$queryRaw<AllowanceRow[]>(Prisma.sql`
      SELECT account."level", used."last_24_hours"::text AS "last_24_hours",
             used."last_31_days"::text AS "last_31_days", ${LIMIT_COLUMNS}
      FROM (SELECT "mgx_verified_level"(${uuid(userId)}) AS "level") AS account
      CROSS JOIN LATERAL "mgx_transfer_usage"(${uuid(userId)}, ${assetCode}::varchar) AS used
      LEFT JOIN "transfer_limits" AS l
        ON l."asset_code" = ${assetCode} AND l."kyc_level" = account."level"
    `);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('The allowance of an account could not be read.');
    }
    return toAllowance(row);
  }

  async allowances(
    db: DbClient,
    userId: string,
  ): Promise<{
    readonly level: KycVerifiedLevel;
    readonly byAsset: ReadonlyMap<string, Allowance>;
  }> {
    // Une ligne par actif tenu ; une seule, sans actif, si la plateforme n'en tient aucun.
    const rows = await db.$queryRaw<AllowanceOfAssetRow[]>(Prisma.sql`
      SELECT account."level", a."code", used."last_24_hours"::text AS "last_24_hours",
             used."last_31_days"::text AS "last_31_days", ${LIMIT_COLUMNS}
      FROM (SELECT "mgx_verified_level"(${uuid(userId)}) AS "level") AS account
      LEFT JOIN "assets" AS a ON TRUE
      LEFT JOIN LATERAL "mgx_transfer_usage"(${uuid(userId)}, a."code") AS used
        ON a."code" IS NOT NULL
      LEFT JOIN "transfer_limits" AS l
        ON l."asset_code" = a."code" AND l."kyc_level" = account."level"
      ORDER BY a."code"
    `);
    const [first] = rows;
    if (first === undefined) {
      throw new Error('The allowances of an account could not be read.');
    }
    const byAsset = new Map<string, Allowance>();
    for (const row of rows) {
      const { code, last_24_hours, last_31_days } = row;
      if (code !== null && last_24_hours !== null && last_31_days !== null) {
        byAsset.set(code, toAllowance({ ...row, last_24_hours, last_31_days }));
      }
    }
    return { level: toLevel(first.level), byAsset };
  }

  // --- Transferts ---

  async newId(db: DbClient): Promise<string> {
    const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT uuidv7()::text AS "id"`);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('The database did not return an identifier.');
    }
    return row.id;
  }

  async findByKey(
    db: DbClient,
    senderId: string,
    idempotencyKey: string,
  ): Promise<TransferRecord | null> {
    const rows = await db.$queryRaw<TransferRow[]>(Prisma.sql`
      SELECT ${TRANSFER_COLUMNS}
      FROM "transfers" AS t
      WHERE t."sender_id" = ${uuid(senderId)} AND t."idempotency_key" = ${idempotencyKey}
    `);
    const [row] = rows;
    return row === undefined ? null : toTransfer(row);
  }

  async findById(db: DbClient, transferId: string): Promise<TransferRecord | null> {
    const rows = await db.$queryRaw<TransferRow[]>(Prisma.sql`
      SELECT ${TRANSFER_COLUMNS} FROM "transfers" AS t WHERE t."id" = ${uuid(transferId)}
    `);
    const [row] = rows;
    return row === undefined ? null : toTransfer(row);
  }

  async findForParty(
    db: DbClient,
    transferId: string,
    userId: string,
  ): Promise<TransferRecord | null> {
    const rows = await db.$queryRaw<TransferRow[]>(Prisma.sql`
      SELECT ${TRANSFER_COLUMNS}
      FROM "transfers" AS t
      WHERE t."id" = ${uuid(transferId)}
        AND (t."sender_id" = ${uuid(userId)} OR t."recipient_id" = ${uuid(userId)})
    `);
    const [row] = rows;
    return row === undefined ? null : toTransfer(row);
  }

  async listForParty(db: DbClient, userId: string, page: TransferPage): Promise<TransferRecord[]> {
    const { beforeId } = page;
    const before = (alias: 's' | 'r'): Prisma.Sql =>
      beforeId === undefined
        ? Prisma.sql`TRUE`
        : Prisma.sql`${Prisma.raw(alias)}."id" < ${uuid(beforeId)}`;
    // L'identifiant d'un transfert (UUID v7) croît avec le temps. Deux parcours d'index — les
    // envois, les réceptions — puis les plus récents des deux.
    const rows = await db.$queryRaw<TransferRow[]>(Prisma.sql`
      SELECT ${TRANSFER_COLUMNS}
      FROM (
        (SELECT s.* FROM "transfers" AS s
         WHERE s."sender_id" = ${uuid(userId)} AND ${before('s')}
         ORDER BY s."id" DESC LIMIT ${page.limit})
        UNION ALL
        (SELECT r.* FROM "transfers" AS r
         WHERE r."recipient_id" = ${uuid(userId)} AND ${before('r')}
         ORDER BY r."id" DESC LIMIT ${page.limit})
      ) AS t
      ORDER BY t."id" DESC
      LIMIT ${page.limit}
    `);
    return rows.map(toTransfer);
  }

  async insert(tx: DbClient, transfer: NewTransfer): Promise<TransferRecord> {
    try {
      // L'heure du transfert est fixée par la base.
      const rows = await tx.$queryRaw<TransferRow[]>(Prisma.sql`
        INSERT INTO "transfers" AS t
          ("id", "sender_id", "recipient_id", "asset_code", "amount", "entry_id",
           "idempotency_key", "request_digest", "sender_level")
        VALUES
          (${uuid(transfer.id)}, ${uuid(transfer.senderId)}, ${uuid(transfer.recipientId)},
           ${transfer.assetCode}, ${transfer.units.toString()}::numeric, ${uuid(transfer.entryId)},
           ${transfer.idempotencyKey}, decode(${transfer.requestDigest.toString('hex')}, 'hex'),
           ${transfer.senderLevel}::smallint)
        RETURNING ${TRANSFER_COLUMNS}
      `);
      const [row] = rows;
      if (row === undefined) {
        throw new Error('The transfer was not written.');
      }
      return toTransfer(row);
    } catch (error) {
      if (sqlStateOf(error) === TRANSFER_RULE_VIOLATION) {
        throw new TransferRefusedByDatabaseError({ cause: error });
      }
      throw error;
    }
  }

  // --- Plafonds ---

  async listLimits(db: DbClient): Promise<LimitRecord[]> {
    const rows = await db.$queryRaw<LimitRow[]>(Prisma.sql`
      SELECT ${LIMIT_COLUMNS}
      FROM "transfer_limits" AS l
      ORDER BY l."asset_code", l."kyc_level"
    `);
    return rows.map(toLimit);
  }

  async setLimit(
    tx: DbClient,
    limit: NewLimit,
  ): Promise<{ readonly before: LimitRecord | null; readonly after: LimitRecord }> {
    try {
      // Une seule instruction : les plafonds remplacés et les nouveaux sont lus au même instant
      // (clause RETURNING de PostgreSQL 18, qui rend l'ancienne ligne avec la nouvelle). L'heure
      // de la modification est fixée par la base.
      const rows = await tx.$queryRaw<ChangedLimitRow[]>(Prisma.sql`
        INSERT INTO "transfer_limits" AS l
          ("asset_code", "kyc_level", "per_transfer_max", "daily_max", "monthly_max", "set_by")
        VALUES
          (${limit.assetCode}, ${limit.level}::smallint, ${limit.perTransferMax.toString()}::numeric,
           ${limit.dailyMax.toString()}::numeric, ${limit.monthlyMax.toString()}::numeric,
           ${uuid(limit.setBy)})
        ON CONFLICT ("asset_code", "kyc_level") DO UPDATE SET
          "per_transfer_max" = EXCLUDED."per_transfer_max",
          "daily_max" = EXCLUDED."daily_max",
          "monthly_max" = EXCLUDED."monthly_max",
          "set_by" = EXCLUDED."set_by"
        RETURNING
          new."asset_code", new."kyc_level",
          new."per_transfer_max"::text AS "per_transfer_max",
          new."daily_max"::text AS "daily_max", new."monthly_max"::text AS "monthly_max",
          new."set_by"::text AS "set_by", new."set_at",
          old."per_transfer_max"::text AS "before_per_transfer_max",
          old."daily_max"::text AS "before_daily_max",
          old."monthly_max"::text AS "before_monthly_max",
          old."set_by"::text AS "before_set_by", old."set_at" AS "before_set_at"
      `);
      const [row] = rows;
      if (row === undefined) {
        throw new Error('The transfer limits were not written.');
      }
      const before =
        row.before_per_transfer_max === null ||
        row.before_daily_max === null ||
        row.before_monthly_max === null ||
        row.before_set_at === null
          ? null
          : toLimit({
              asset_code: row.asset_code,
              kyc_level: row.kyc_level,
              per_transfer_max: row.before_per_transfer_max,
              daily_max: row.before_daily_max,
              monthly_max: row.before_monthly_max,
              set_by: row.before_set_by,
              set_at: row.before_set_at,
            });
      return { before, after: toLimit(row) };
    } catch (error) {
      if (sqlStateOf(error) === TRANSFER_RULE_VIOLATION) {
        throw new LimitChangeDeniedError({ cause: error });
      }
      throw error;
    }
  }
}
