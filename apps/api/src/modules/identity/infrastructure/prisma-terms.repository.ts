import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import { isUniqueViolation, sqlStateOf } from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type NewTermsVersion,
  type TermsAcceptanceRecord,
  TermsRepository,
  TermsRuleViolationError,
  type TermsStanding,
  type TermsVersionHeader,
  TermsVersionOutOfSequenceError,
  type TermsVersionRecord,
} from '../application/terms.repository.js';

/** SQLSTATE levés par la base (voir la migration `terms_of_use`). */
const TERMS_RULE_VIOLATION = 'MGX06';
const TERMS_VERSION_OUT_OF_SEQUENCE = 'MGX07';

interface HeaderRow {
  number: number;
  requires_acceptance: boolean;
  published_by: string | null;
  published_at: Date;
  summary_fr: string;
  length_fr: number;
  sha256_fr: string;
  summary_en: string | null;
  length_en: number | null;
  sha256_en: string | null;
}

interface StandingRow {
  account_open: boolean;
  current_number: number | null;
  current_published_at: Date | null;
  current_requires_acceptance: boolean | null;
  latest_required: number | null;
  accepted_number: number | null;
  accepted_at: Date | null;
}

type VersionRow = Prisma.TermsVersionGetPayload<object>;

function toRecord(row: VersionRow): TermsVersionRecord {
  return {
    number: row.number,
    requiresAcceptance: row.requiresAcceptance,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    fr: { summary: row.summaryFr, body: row.bodyFr, sha256: row.bodyFrSha256 },
    en:
      row.summaryEn === null || row.bodyEn === null || row.bodyEnSha256 === null
        ? null
        : { summary: row.summaryEn, body: row.bodyEn, sha256: row.bodyEnSha256 },
  };
}

function toHeader(row: HeaderRow): TermsVersionHeader {
  return {
    number: row.number,
    requiresAcceptance: row.requires_acceptance,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    fr: { summary: row.summary_fr, length: row.length_fr, sha256: row.sha256_fr },
    en:
      row.summary_en === null || row.length_en === null || row.sha256_en === null
        ? null
        : { summary: row.summary_en, length: row.length_en, sha256: row.sha256_en },
  };
}

/** Traduit les refus de la base ; toute autre erreur est relancée telle quelle. */
async function refusedByDatabase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === TERMS_VERSION_OUT_OF_SEQUENCE) {
      throw new TermsVersionOutOfSequenceError({ cause: error });
    }
    if (sqlState === TERMS_RULE_VIOLATION) {
      throw new TermsRuleViolationError({ cause: error });
    }
    throw error;
  }
}

@Injectable()
export class PrismaTermsRepository extends TermsRepository {
  async findCurrentHeader(db: DbClient): Promise<TermsVersionHeader | null> {
    const [header] = await this.listHeaders(db, 1);
    return header ?? null;
  }

  async findCurrent(db: DbClient): Promise<TermsVersionRecord | null> {
    const row = await db.termsVersion.findFirst({ orderBy: { number: 'desc' } });
    return row === null ? null : toRecord(row);
  }

  async findVersion(db: DbClient, number: number): Promise<TermsVersionRecord | null> {
    const row = await db.termsVersion.findUnique({ where: { number } });
    return row === null ? null : toRecord(row);
  }

  async listHeaders(db: DbClient, limit: number): Promise<TermsVersionHeader[]> {
    // Les textes ne sont pas lus : seulement leur longueur et leur empreinte.
    const rows = await db.$queryRaw<HeaderRow[]>(Prisma.sql`
      SELECT "number",
             "requires_acceptance",
             "published_by"::text AS "published_by",
             "published_at",
             "summary_fr",
             char_length("body_fr") AS "length_fr",
             "body_fr_sha256"::text AS "sha256_fr",
             "summary_en",
             char_length("body_en") AS "length_en",
             "body_en_sha256"::text AS "sha256_en"
      FROM "terms_versions"
      ORDER BY "number" DESC
      LIMIT ${limit}
    `);
    return rows.map(toHeader);
  }

  async countAcceptances(
    db: DbClient,
    numbers: readonly number[],
  ): Promise<ReadonlyMap<number, number>> {
    if (numbers.length === 0) {
      return new Map();
    }
    const groups = await db.termsAcceptance.groupBy({
      by: ['versionNumber'],
      where: { versionNumber: { in: [...numbers] } },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.versionNumber, group._count._all]));
  }

  publish(tx: DbClient, version: NewTermsVersion): Promise<TermsVersionRecord> {
    return refusedByDatabase(async () => {
      try {
        const row = await tx.termsVersion.create({
          data: {
            number: version.number,
            requiresAcceptance: version.requiresAcceptance,
            publishedBy: version.publishedBy,
            summaryFr: version.fr.summary,
            bodyFr: version.fr.body,
            bodyFrSha256: version.fr.sha256,
            summaryEn: version.en?.summary ?? null,
            bodyEn: version.en?.body ?? null,
            bodyEnSha256: version.en?.sha256 ?? null,
          },
        });
        return toRecord(row);
      } catch (error) {
        // Deux publications du même numéro : la seconde attend la première, puis la trouve.
        if (isUniqueViolation(error)) {
          throw new TermsVersionOutOfSequenceError({ cause: error });
        }
        throw error;
      }
    });
  }

  accept(
    tx: DbClient,
    userId: string,
    versionNumber: number,
  ): Promise<TermsAcceptanceRecord & { readonly created: boolean }> {
    return refusedByDatabase(async () => {
      const inserted = await tx.$queryRaw<{ accepted_at: Date }[]>(Prisma.sql`
        INSERT INTO "terms_acceptances" ("user_id", "version_number")
        VALUES (${userId}::uuid, ${versionNumber})
        ON CONFLICT ("user_id", "version_number") DO NOTHING
        RETURNING "accepted_at"
      `);
      const created = inserted[0];
      if (created !== undefined) {
        return { versionNumber, acceptedAt: created.accepted_at, created: true };
      }
      // Déjà acceptée : la première acceptation fait foi, et sa date ne change pas.
      const existing = await tx.termsAcceptance.findUniqueOrThrow({
        where: { userId_versionNumber: { userId, versionNumber } },
        select: { acceptedAt: true },
      });
      return { versionNumber, acceptedAt: existing.acceptedAt, created: false };
    });
  }

  deleteAcceptances(tx: DbClient, userId: string): Promise<number> {
    return refusedByDatabase(async () => {
      const { count } = await tx.termsAcceptance.deleteMany({ where: { userId } });
      return count;
    });
  }

  async standingOf(db: DbClient, userId: string): Promise<TermsStanding> {
    // Une seule lecture : la garde des conditions d'utilisation l'exécute à chaque requête.
    const rows = await db.$queryRaw<StandingRow[]>(Prisma.sql`
      SELECT EXISTS (
               SELECT 1 FROM "users" AS "u"
               WHERE "u"."id" = ${userId}::uuid AND "u"."status" <> 'CLOSED'
             ) AS "account_open",
             "current"."number" AS "current_number",
             "current"."published_at" AS "current_published_at",
             "current"."requires_acceptance" AS "current_requires_acceptance",
             (SELECT max("v"."number") FROM "terms_versions" AS "v" WHERE "v"."requires_acceptance")
               AS "latest_required",
             "accepted"."version_number" AS "accepted_number",
             "accepted"."accepted_at" AS "accepted_at"
      FROM (SELECT 1) AS "one"
      LEFT JOIN LATERAL (
        SELECT "number", "published_at", "requires_acceptance"
        FROM "terms_versions"
        ORDER BY "number" DESC
        LIMIT 1
      ) AS "current" ON true
      LEFT JOIN LATERAL (
        SELECT "version_number", "accepted_at"
        FROM "terms_acceptances"
        WHERE "user_id" = ${userId}::uuid
        ORDER BY "version_number" DESC
        LIMIT 1
      ) AS "accepted" ON true
    `);
    const row = rows[0];
    const currentNumber = row?.current_number ?? null;
    const acceptedNumber = row?.accepted_number ?? null;
    return {
      accountOpen: row?.account_open === true,
      current:
        row === undefined ||
        currentNumber === null ||
        row.current_published_at === null ||
        row.current_requires_acceptance === null
          ? null
          : {
              number: currentNumber,
              publishedAt: row.current_published_at,
              requiresAcceptance: row.current_requires_acceptance,
            },
      latestRequired: row?.latest_required ?? null,
      lastAccepted:
        row === undefined || acceptedNumber === null || row.accepted_at === null
          ? null
          : { versionNumber: acceptedNumber, acceptedAt: row.accepted_at },
    };
  }

  listAcceptances(db: DbClient, userId: string): Promise<TermsAcceptanceRecord[]> {
    return db.termsAcceptance.findMany({
      where: { userId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true, acceptedAt: true },
    });
  }
}
