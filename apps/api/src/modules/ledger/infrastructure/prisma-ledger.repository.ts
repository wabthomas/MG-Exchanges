import type { AssetKind, LedgerAccountTypeKey, LedgerSide } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import {
  ACCOUNT_CLOSED_SQLSTATE,
  sqlStateOf,
} from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type AccountFilter,
  type AccountRecord,
  type AssetRecord,
  AssetRegistrationDeniedError,
  type BalanceTotal,
  type EntryPostingRecord,
  type EntryRecord,
  type LedgerAnomaly,
  type LedgerAnomalyKind,
  type LedgerCounts,
  LedgerRepository,
  type NewAsset,
  type NewEntry,
  type NewPosting,
  type PostingRecord,
  type Statement,
  type StatementLine,
  type StatementPage,
} from '../application/ledger.repository.js';
import type { AccountKey } from '../domain/ledger-account.js';
import {
  HolderClosedError,
  InsufficientFundsError,
  LedgerIntegrityError,
} from '../domain/ledger-errors.js';

/** SQLSTATE levés par la base (voir la migration `ledger`). */
const LEDGER_RULE_VIOLATION = 'MGX08';
const INSUFFICIENT_FUNDS = 'MGX09';

interface AssetRow {
  code: string;
  name: string;
  kind: AssetKind;
  scale: number;
  registered_by: string | null;
  registered_at: Date;
}

interface AccountRow {
  id: string;
  type_key: string;
  asset_code: string;
  user_id: string | null;
  normal_side: LedgerSide;
  balance: string;
  posting_count: string;
  created_at: Date;
}

interface PostingRow {
  id: string;
  line_number: number;
  account_id: string;
  asset_code: string;
  side: LedgerSide;
  amount: string;
  account_sequence: string;
  balance_after: string;
}

interface EntryPostingRow extends PostingRow {
  account_type: string;
  account_user_id: string | null;
}

interface StatementRow extends PostingRow {
  entry_id: string;
  kind: string;
  posted_at: Date;
}

/** Ligne d'un relevé : le compte, et une de ses lignes — absente si le compte n'en a aucune. */
type StatementPageRow = { account_balance: string; account_posting_count: string } & (
  StatementRow | { [Column in keyof StatementRow]: null }
);

interface EntryRow {
  id: string;
  idempotency_key: string;
  kind: string;
  actor_type: 'USER' | 'SYSTEM' | 'SERVICE';
  actor_id: string | null;
  request_id: string | null;
  metadata: unknown;
  posted_at: Date;
}

// Les montants et les compteurs sont lus en texte : ils ne passent ni par un nombre flottant,
// ni par une bibliothèque décimale.
const ASSET_COLUMNS = Prisma.sql`
  "code", "name", "kind"::text AS "kind", "scale",
  "registered_by"::text AS "registered_by", "registered_at"`;

const ACCOUNT_COLUMNS = Prisma.sql`
  a."id"::text AS "id", a."type_key", a."asset_code", a."user_id"::text AS "user_id",
  a."normal_side"::text AS "normal_side", a."balance"::text AS "balance",
  a."posting_count"::text AS "posting_count", a."created_at"`;

const POSTING_COLUMNS = Prisma.sql`
  p."id"::text AS "id", p."line_number", p."account_id"::text AS "account_id", p."asset_code",
  p."side"::text AS "side", p."amount"::text AS "amount",
  p."account_sequence"::text AS "account_sequence", p."balance_after"::text AS "balance_after"`;

function toAsset(row: AssetRow): AssetRecord {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    scale: row.scale,
    registeredBy: row.registered_by,
    registeredAt: row.registered_at,
  };
}

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    type: row.type_key as LedgerAccountTypeKey,
    assetCode: row.asset_code,
    userId: row.user_id,
    normalSide: row.normal_side,
    balance: BigInt(row.balance),
    postingCount: BigInt(row.posting_count),
    createdAt: row.created_at,
  };
}

function toPosting(row: PostingRow): PostingRecord {
  return {
    id: row.id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    assetCode: row.asset_code,
    side: row.side,
    units: BigInt(row.amount),
    accountSequence: BigInt(row.account_sequence),
    balanceAfter: BigInt(row.balance_after),
  };
}

function toEntryPosting(row: EntryPostingRow): EntryPostingRecord {
  return {
    ...toPosting(row),
    accountType: row.account_type as LedgerAccountTypeKey,
    accountUserId: row.account_user_id,
  };
}

function toStatementLine(row: StatementRow): StatementLine {
  return { ...toPosting(row), entryId: row.entry_id, kind: row.kind, postedAt: row.posted_at };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Traduit les refus de la base ; toute autre erreur est relancée telle quelle. */
async function refusedByDatabase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === INSUFFICIENT_FUNDS) {
      throw new InsufficientFundsError(null, { cause: error });
    }
    if (sqlState === ACCOUNT_CLOSED_SQLSTATE) {
      throw new HolderClosedError({ cause: error });
    }
    if (sqlState === LEDGER_RULE_VIOLATION) {
      throw new LedgerIntegrityError({ cause: error });
    }
    throw error;
  }
}

const uuid = (value: string): Prisma.Sql => Prisma.sql`${value}::uuid`;

@Injectable()
export class PrismaLedgerRepository extends LedgerRepository {
  // --- Actifs ---

  async listAssets(db: DbClient): Promise<AssetRecord[]> {
    const rows = await db.$queryRaw<AssetRow[]>(
      Prisma.sql`SELECT ${ASSET_COLUMNS} FROM "assets" ORDER BY "code"`,
    );
    return rows.map(toAsset);
  }

  async findAssets(db: DbClient, codes: readonly string[]): Promise<AssetRecord[]> {
    if (codes.length === 0) {
      return [];
    }
    const rows = await db.$queryRaw<AssetRow[]>(
      Prisma.sql`SELECT ${ASSET_COLUMNS} FROM "assets"
                 WHERE "code" IN (${Prisma.join([...codes])}) ORDER BY "code"`,
    );
    return rows.map(toAsset);
  }

  async insertAsset(db: DbClient, asset: NewAsset): Promise<AssetRecord | null> {
    try {
      const rows = await db.$queryRaw<AssetRow[]>(Prisma.sql`
        INSERT INTO "assets" ("code", "name", "kind", "scale", "registered_by")
        VALUES (${asset.code}, ${asset.name}, ${asset.kind}::"asset_kind", ${asset.scale},
                ${uuid(asset.registeredBy)})
        ON CONFLICT ("code") DO NOTHING
        RETURNING ${ASSET_COLUMNS}
      `);
      const [row] = rows;
      return row === undefined ? null : toAsset(row);
    } catch (error) {
      if (sqlStateOf(error) === LEDGER_RULE_VIOLATION) {
        throw new AssetRegistrationDeniedError({ cause: error });
      }
      throw error;
    }
  }

  // --- Comptes ---

  async findAccounts(db: DbClient, keys: readonly AccountKey[]): Promise<AccountRecord[]> {
    if (keys.length === 0) {
      return [];
    }
    // Une recherche par clé, chacune servie par l'index unique du titulaire ou de la plateforme.
    const lookups = keys.map((key) =>
      key.userId === null
        ? Prisma.sql`(SELECT ${ACCOUNT_COLUMNS} FROM "ledger_accounts" AS a
                      WHERE a."user_id" IS NULL
                        AND a."asset_code" = ${key.assetCode} AND a."type_key" = ${key.type})`
        : Prisma.sql`(SELECT ${ACCOUNT_COLUMNS} FROM "ledger_accounts" AS a
                      WHERE a."user_id" = ${uuid(key.userId)}
                        AND a."asset_code" = ${key.assetCode} AND a."type_key" = ${key.type})`,
    );
    const rows = await db.$queryRaw<AccountRow[]>(Prisma.join(lookups, ' UNION ALL '));
    return rows.map(toAccount);
  }

  async openAccounts(db: DbClient, keys: readonly AccountKey[]): Promise<void> {
    for (const key of keys) {
      // Le sens normal du compte et l'heure de son ouverture sont fixés par la base.
      await refusedByDatabase(
        () => db.$executeRaw`
          INSERT INTO "ledger_accounts" ("type_key", "asset_code", "user_id")
          VALUES (${key.type}, ${key.assetCode}, ${key.userId}::uuid)
          ON CONFLICT DO NOTHING
        `,
      );
    }
  }

  async lockAccounts(tx: DbClient, ids: readonly string[]): Promise<AccountRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await tx.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT ${ACCOUNT_COLUMNS}
      FROM "ledger_accounts" AS a
      WHERE a."id" IN (${Prisma.join(ids.map(uuid))})
      ORDER BY a."id"
      FOR UPDATE
    `);
    return rows.map(toAccount);
  }

  async accountsOfUser(db: DbClient, userId: string): Promise<AccountRecord[]> {
    const rows = await db.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT ${ACCOUNT_COLUMNS}
      FROM "ledger_accounts" AS a
      WHERE a."user_id" = ${uuid(userId)}
      ORDER BY a."asset_code", a."type_key"
    `);
    return rows.map(toAccount);
  }

  async findAccount(db: DbClient, id: string): Promise<AccountRecord | null> {
    const rows = await db.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT ${ACCOUNT_COLUMNS} FROM "ledger_accounts" AS a WHERE a."id" = ${uuid(id)}
    `);
    const [row] = rows;
    return row === undefined ? null : toAccount(row);
  }

  async listAccounts(db: DbClient, filter: AccountFilter): Promise<AccountRecord[]> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.userId !== undefined) {
      conditions.push(Prisma.sql`a."user_id" = ${uuid(filter.userId)}`);
    }
    if (filter.assetCode !== undefined) {
      conditions.push(Prisma.sql`a."asset_code" = ${filter.assetCode}`);
    }
    if (filter.type !== undefined) {
      conditions.push(Prisma.sql`a."type_key" = ${filter.type}`);
    }
    if (filter.afterId !== undefined) {
      conditions.push(Prisma.sql`a."id" > ${uuid(filter.afterId)}`);
    }
    // L'identifiant d'un compte (UUID v7) croît avec l'heure de son ouverture.
    const rows = await db.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT ${ACCOUNT_COLUMNS}
      FROM "ledger_accounts" AS a
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY a."id"
      LIMIT ${filter.limit}
    `);
    return rows.map(toAccount);
  }

  // --- Écritures ---

  findEntryByKey(db: DbClient, idempotencyKey: string): Promise<EntryRecord | null> {
    return this.readEntry(db, Prisma.sql`e."idempotency_key" = ${idempotencyKey}`);
  }

  findEntry(db: DbClient, id: string): Promise<EntryRecord | null> {
    return this.readEntry(db, Prisma.sql`e."id" = ${uuid(id)}`);
  }

  async insertEntry(
    tx: DbClient,
    entry: NewEntry,
  ): Promise<{ readonly id: string; readonly postedAt: Date } | null> {
    const actorId = entry.actor.type === 'SYSTEM' ? null : entry.actor.id;
    // L'heure de l'écriture est lue à l'horloge de la base.
    const rows = await refusedByDatabase(() =>
      tx.$queryRaw<{ id: string; posted_at: Date }[]>(Prisma.sql`
        INSERT INTO "ledger_entries"
          ("idempotency_key", "kind", "posting_count", "actor_type", "actor_id", "request_id",
           "metadata")
        VALUES (${entry.idempotencyKey}, ${entry.kind}, ${entry.postingCount},
                ${entry.actor.type}::"audit_actor_type", ${actorId}, ${entry.requestId},
                ${JSON.stringify(entry.metadata)}::jsonb)
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"::text AS "id", "posted_at"
      `),
    );
    const [row] = rows;
    return row === undefined ? null : { id: row.id, postedAt: row.posted_at };
  }

  async insertPostings(
    tx: DbClient,
    entryId: string,
    postings: readonly NewPosting[],
  ): Promise<PostingRecord[]> {
    // Une seule instruction, dans l'ordre des lignes. Le rang de chaque ligne sur son compte et
    // le solde qui en résulte sont calculés par la base : les zéros fournis ici sont ignorés.
    const values = postings.map(
      (posting) => Prisma.sql`(
        ${uuid(entryId)}, ${posting.lineNumber}, ${uuid(posting.accountId)}, ${posting.assetCode},
        ${posting.side}::"ledger_side", ${posting.units.toString()}::numeric, 0, 0)`,
    );
    const rows = await refusedByDatabase(() =>
      tx.$queryRaw<PostingRow[]>(Prisma.sql`
        INSERT INTO "ledger_postings" AS p
          ("entry_id", "line_number", "account_id", "asset_code", "side", "amount",
           "account_sequence", "balance_after")
        VALUES ${Prisma.join(values)}
        RETURNING ${POSTING_COLUMNS}
      `),
    );
    return rows.map(toPosting).sort((left, right) => left.lineNumber - right.lineNumber);
  }

  // --- Relevés ---

  async readStatement(
    db: DbClient,
    accountId: string,
    page: StatementPage,
  ): Promise<Statement | null> {
    const before =
      page.beforeSequence === undefined
        ? Prisma.empty
        : Prisma.sql`AND l."account_sequence" < ${page.beforeSequence.toString()}::bigint`;
    // Une seule instruction : le solde du compte et ses lignes sont lus au même instant.
    const rows = await db.$queryRaw<StatementPageRow[]>(Prisma.sql`
      SELECT a."balance"::text AS "account_balance",
             a."posting_count"::text AS "account_posting_count",
             ${POSTING_COLUMNS}, p."entry_id"::text AS "entry_id", e."kind", e."posted_at"
      FROM "ledger_accounts" AS a
      LEFT JOIN LATERAL (
        SELECT l.*
        FROM "ledger_postings" AS l
        WHERE l."account_id" = a."id" ${before}
        ORDER BY l."account_sequence" DESC
        LIMIT ${page.limit}
      ) AS p ON TRUE
      LEFT JOIN "ledger_entries" AS e ON e."id" = p."entry_id"
      WHERE a."id" = ${uuid(accountId)}
      ORDER BY p."account_sequence" DESC NULLS LAST
    `);
    const [first] = rows;
    if (first === undefined) {
      return null;
    }
    return {
      balance: BigInt(first.account_balance),
      postingCount: BigInt(first.account_posting_count),
      lines: rows.flatMap((row) => (row.id === null ? [] : [toStatementLine(row)])),
    };
  }

  // --- Balance et vérification ---

  async balanceTotals(db: DbClient): Promise<BalanceTotal[]> {
    const rows = await db.$queryRaw<
      {
        asset_code: string;
        type_key: string;
        normal_side: LedgerSide;
        accounts: number;
        balance: string;
      }[]
    >(Prisma.sql`
      SELECT a."asset_code", a."type_key", a."normal_side"::text AS "normal_side",
             count(*)::int AS "accounts", sum(a."balance")::text AS "balance"
      FROM "ledger_accounts" AS a
      GROUP BY a."asset_code", a."type_key", a."normal_side"
      ORDER BY a."asset_code", a."type_key"
    `);
    return rows.map((row) => ({
      assetCode: row.asset_code,
      type: row.type_key as LedgerAccountTypeKey,
      normalSide: row.normal_side,
      accounts: row.accounts,
      balance: BigInt(row.balance),
    }));
  }

  async counts(db: DbClient): Promise<LedgerCounts> {
    const rows = await db.$queryRaw<{ accounts: number; entries: number; postings: number }[]>(
      Prisma.sql`
        SELECT (SELECT count(*)::int FROM "ledger_accounts") AS "accounts",
               (SELECT count(*)::int FROM "ledger_entries") AS "entries",
               (SELECT count(*)::int FROM "ledger_postings") AS "postings"
      `,
    );
    return rows[0] ?? { accounts: 0, entries: 0, postings: 0 };
  }

  async findAnomalies(db: DbClient, limit: number): Promise<LedgerAnomaly[]> {
    // Une seule instruction : toutes les vérifications lisent le même état du grand livre, même
    // si des écritures sont passées pendant ce temps.
    const rows = await db.$queryRaw<{ kind: LedgerAnomalyKind; subject: string }[]>(Prisma.sql`
      (
        -- Le solde d'un compte et son nombre de lignes sont ceux de sa dernière ligne.
        SELECT 'ACCOUNT_BALANCE_MISMATCH' AS "kind", a."id"::text AS "subject"
        FROM "ledger_accounts" AS a
        LEFT JOIN LATERAL (
          SELECT p."account_sequence", p."balance_after"
          FROM "ledger_postings" AS p
          WHERE p."account_id" = a."id"
          ORDER BY p."account_sequence" DESC
          LIMIT 1
        ) AS "last" ON TRUE
        WHERE coalesce("last"."account_sequence", 0) <> a."posting_count"
           OR coalesce("last"."balance_after", 0) <> a."balance"
      )
      UNION ALL
      (
        -- Sur un compte, chaque ligne prolonge la précédente : rang suivant, solde recalculé.
        SELECT 'POSTING_CHAIN_BROKEN', "chain"."id"::text
        FROM (
          SELECT p."id", p."account_sequence", p."balance_after",
                 lag(p."account_sequence", 1, 0::bigint) OVER "by_account" AS "previous_sequence",
                 lag(p."balance_after", 1, 0::numeric) OVER "by_account" AS "previous_balance",
                 CASE WHEN p."side" = a."normal_side" THEN p."amount" ELSE -p."amount" END
                   AS "delta"
          FROM "ledger_postings" AS p
          JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
          WINDOW "by_account" AS (PARTITION BY p."account_id" ORDER BY p."account_sequence")
        ) AS "chain"
        WHERE "chain"."account_sequence" <> "chain"."previous_sequence" + 1
           OR "chain"."balance_after" <> "chain"."previous_balance" + "chain"."delta"
      )
      UNION ALL
      (
        -- Une ligne est dans l'actif de son compte.
        SELECT 'POSTING_ASSET_MISMATCH', p."id"::text
        FROM "ledger_postings" AS p
        JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
        WHERE p."asset_code" <> a."asset_code"
      )
      UNION ALL
      (
        -- Une écriture a toutes ses lignes, sur deux comptes au moins, et s'équilibre par actif.
        SELECT 'ENTRY_UNSOUND', e."id"::text
        FROM "ledger_entries" AS e
        LEFT JOIN (
          SELECT p."entry_id", count(*) AS "lines", max(p."line_number") AS "last_line",
                 count(DISTINCT p."account_id") AS "accounts"
          FROM "ledger_postings" AS p
          GROUP BY p."entry_id"
        ) AS "written" ON "written"."entry_id" = e."id"
        WHERE coalesce("written"."lines", 0) <> e."posting_count"
           OR coalesce("written"."last_line", 0) <> e."posting_count"
           OR coalesce("written"."accounts", 0) < 2
           OR EXISTS (
             SELECT 1
             FROM "ledger_postings" AS p
             WHERE p."entry_id" = e."id"
             GROUP BY p."asset_code"
             HAVING sum(CASE p."side" WHEN 'DEBIT' THEN p."amount" ELSE -p."amount" END) <> 0
           )
      )
      UNION ALL
      (
        -- Dans chaque actif, les soldes de sens débit égalent les soldes de sens crédit.
        SELECT 'ASSET_UNBALANCED', a."asset_code"::text
        FROM "ledger_accounts" AS a
        GROUP BY a."asset_code"
        HAVING sum(CASE a."normal_side" WHEN 'DEBIT' THEN a."balance" ELSE -a."balance" END) <> 0
      )
      LIMIT ${limit}
    `);
    return rows.map((row) => ({ kind: row.kind, subject: row.subject }));
  }

  private async readEntry(db: DbClient, condition: Prisma.Sql): Promise<EntryRecord | null> {
    const headers = await db.$queryRaw<EntryRow[]>(Prisma.sql`
      SELECT e."id"::text AS "id", e."idempotency_key", e."kind",
             e."actor_type"::text AS "actor_type", e."actor_id", e."request_id", e."metadata",
             e."posted_at"
      FROM "ledger_entries" AS e
      WHERE ${condition}
    `);
    const [header] = headers;
    if (header === undefined) {
      return null;
    }
    const postings = await db.$queryRaw<EntryPostingRow[]>(Prisma.sql`
      SELECT ${POSTING_COLUMNS}, a."type_key" AS "account_type",
             a."user_id"::text AS "account_user_id"
      FROM "ledger_postings" AS p
      JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
      WHERE p."entry_id" = ${uuid(header.id)}
      ORDER BY p."line_number"
    `);
    return {
      id: header.id,
      idempotencyKey: header.idempotency_key,
      kind: header.kind,
      actorType: header.actor_type,
      actorId: header.actor_id,
      requestId: header.request_id,
      metadata: isJsonObject(header.metadata) ? header.metadata : {},
      postedAt: header.posted_at,
      postings: postings.map(toEntryPosting),
    };
  }
}
