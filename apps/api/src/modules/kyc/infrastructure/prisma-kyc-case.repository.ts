import {
  type KycCaseStatus,
  KYC_DOCUMENT_CONTENT_TYPES,
  type KycDocumentContentType,
  type KycDocumentKind,
  type KycIdentityDocumentType,
  type KycLevel,
  kycLevelSchema,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client.js';
import { isUniqueViolation, sqlStateOf } from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  IdentityDocumentAlreadyVerifiedError,
  type KycCaseHeader,
  type KycCaseRecord,
  KycCaseRepository,
  type KycDecision,
  type KycDeclaration,
  type KycDocumentRecord,
  type KycRevocation,
  KycRuleViolationError,
  type LockedKycCase,
  type NewKycDocument,
  OpenKycCaseExistsError,
  type ReviewQueueEntry,
  type ReviewQueueFilter,
} from '../application/kyc-case.repository.js';

/** SQLSTATE levé par les déclencheurs de `kyc_cases` et `kyc_documents` (voir la migration). */
const KYC_RULE_VIOLATION = 'MGX03';
/** Violation d'une contrainte CHECK — le parcours d'un dossier en compte plusieurs. */
const CHECK_VIOLATION = '23514';

const ACCOUNT_REFERENCE = { select: { id: true, email: true } } as const;

const DOCUMENT_FIELDS = {
  id: true,
  caseId: true,
  kind: true,
  contentType: true,
  byteSize: true,
  sha256: true,
  storageKey: true,
  wrappedKey: true,
  createdAt: true,
} as const satisfies Prisma.KycDocumentSelect;

const HEADER_FIELDS = {
  id: true,
  userId: true,
  level: true,
  status: true,
  submittedAt: true,
  decidedAt: true,
  rejectionReasons: true,
} as const satisfies Prisma.KycCaseSelect;

type DocumentRow = Prisma.KycDocumentGetPayload<{ select: typeof DOCUMENT_FIELDS }>;
type HeaderRow = Prisma.KycCaseGetPayload<{ select: typeof HEADER_FIELDS }>;
type CaseRow = Prisma.KycCaseGetPayload<{
  include: {
    decider: typeof ACCOUNT_REFERENCE;
    revoker: typeof ACCOUNT_REFERENCE;
    documents: { select: typeof DOCUMENT_FIELDS };
  };
}>;

/** La base ne contient que des niveaux 1 à 3 (contrainte CHECK) ; toute autre valeur est une anomalie. */
function levelOf(value: number): KycLevel {
  return kycLevelSchema.parse(value);
}

function contentTypeOf(value: string): KycDocumentContentType {
  const known = KYC_DOCUMENT_CONTENT_TYPES.find((type) => type === value);
  if (known === undefined) {
    throw new Error(`Unexpected content type of a verification document: ${value}`);
  }
  return known;
}

function toDocument(row: DocumentRow): KycDocumentRecord {
  return { ...row, contentType: contentTypeOf(row.contentType) };
}

function toHeader(row: HeaderRow): KycCaseHeader {
  return { ...row, level: levelOf(row.level) };
}

/** Un bloc de déclaration est complet dès l'enregistrement (contraintes CHECK de la table). */
function required<T>(value: T | null, caseId: string, column: string): T {
  if (value === null) {
    throw new Error(`Verification case ${caseId} has no ${column}.`);
  }
  return value;
}

function toRecord(row: CaseRow): KycCaseRecord {
  const level = levelOf(row.level);
  const need = <T>(value: T | null, column: string): T => required(value, row.id, column);
  return {
    id: row.id,
    userId: row.userId,
    level,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    decidedBy: row.decider,
    decidedAt: row.decidedAt,
    rejectionReasons: row.rejectionReasons,
    decisionNote: row.decisionNote,
    endedAt: row.endedAt,
    revokedBy: row.revoker,
    revocationReason: row.revocationReason,
    identity:
      level === 1
        ? {
            givenName: need(row.givenName, 'given name'),
            familyName: need(row.familyName, 'family name'),
            additionalName: row.additionalName,
            dateOfBirth: need(row.dateOfBirth, 'date of birth'),
            placeOfBirth: need(row.placeOfBirth, 'place of birth'),
            nationality: need(row.nationality, 'nationality'),
            documentType: need(row.documentType, 'document type'),
            documentNumberEncrypted: need(row.documentNumberEncrypted, 'document number'),
            documentNumberDigest: need(row.documentNumberDigest, 'document number digest'),
            documentIssuingCountry: need(row.documentIssuingCountry, 'issuing country'),
            documentIssuedOn: need(row.documentIssuedOn, 'date of issue'),
            documentIssuedAt: need(row.documentIssuedAt, 'place of issue'),
            documentExpiresOn: row.documentExpiresOn,
          }
        : null,
    address:
      level === 2
        ? {
            addressLine1: need(row.addressLine1, 'address'),
            addressLine2: row.addressLine2,
            city: need(row.city, 'city'),
            region: row.region,
            postalCode: row.postalCode,
            addressCountry: need(row.addressCountry, 'country'),
            addressProofType: need(row.addressProofType, 'type of proof'),
            addressProofIssuedOn: need(row.addressProofIssuedOn, 'date of proof'),
          }
        : null,
    funds:
      level === 3
        ? {
            fundsSources: row.fundsSources,
            occupation: need(row.occupation, 'occupation'),
            employerName: row.employerName,
            fundsExplanation: need(row.fundsExplanation, 'explanation'),
          }
        : null,
    documents: row.documents.map(toDocument),
  };
}

/** Colonnes d'une déclaration : celles du niveau du dossier, et elles seules. */
function declarationColumns(declaration: KycDeclaration): Prisma.KycCaseUncheckedUpdateManyInput {
  switch (declaration.level) {
    case 1:
      return { ...declaration.identity };
    case 2:
      return { ...declaration.address };
    case 3:
      return { ...declaration.funds, fundsSources: [...declaration.funds.fundsSources] };
  }
}

function isRuleViolation(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  return sqlState === KYC_RULE_VIOLATION || sqlState === CHECK_VIOLATION;
}

const INCLUDE_ALL = {
  decider: ACCOUNT_REFERENCE,
  revoker: ACCOUNT_REFERENCE,
  documents: { select: DOCUMENT_FIELDS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.KycCaseInclude;

@Injectable()
export class PrismaKycCaseRepository extends KycCaseRepository {
  async newId(db: DbClient): Promise<string> {
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT uuidv7() AS "id"`;
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('The database returned no identifier.');
    }
    return id;
  }

  async find(db: DbClient, caseId: string): Promise<KycCaseRecord | null> {
    const row = await db.kycCase.findUnique({ where: { id: caseId }, include: INCLUDE_ALL });
    return row === null ? null : toRecord(row);
  }

  async latestPerLevel(db: DbClient, userId: string): Promise<KycCaseHeader[]> {
    // Les identifiants (UUID v7) suivent l'ordre de création : le premier de chaque niveau
    // est le plus récent.
    const rows = await db.kycCase.findMany({
      where: { userId },
      orderBy: [{ level: 'asc' }, { id: 'desc' }],
      distinct: ['level'],
      select: HEADER_FIELDS,
    });
    return rows.map(toHeader);
  }

  async approvedCases(db: DbClient, userId: string): Promise<KycCaseHeader[]> {
    const rows = await db.kycCase.findMany({
      where: { userId, status: 'APPROVED' },
      orderBy: { level: 'asc' },
      select: HEADER_FIELDS,
    });
    return rows.map(toHeader);
  }

  async lockOpenCase(
    tx: DbClient,
    userId: string,
    level: KycLevel,
  ): Promise<{ readonly id: string; readonly status: KycCaseStatus } | null> {
    const rows = await tx.$queryRaw<{ id: string; status: KycCaseStatus }[]>`
      SELECT "id", "status"::text AS "status"
      FROM "kyc_cases"
      WHERE "user_id" = ${userId}::uuid
        AND "level" = ${level}
        AND "status" IN ('DRAFT', 'SUBMITTED')
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  async lockCase(tx: DbClient, caseId: string): Promise<LockedKycCase | null> {
    const rows = await tx.$queryRaw<LockedKycCase[]>`
      SELECT "user_id" AS "userId", "status"::text AS "status", "updated_at" AS "updatedAt"
      FROM "kyc_cases"
      WHERE "id" = ${caseId}::uuid
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  async createDraft(
    tx: DbClient,
    userId: string,
    declaration: KycDeclaration,
    now: Date,
  ): Promise<string> {
    try {
      const created = await tx.kycCase.create({
        data: {
          ...(declarationColumns(declaration) as Prisma.KycCaseUncheckedCreateInput),
          userId,
          level: declaration.level,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      // Index unique partiel `kyc_cases_open_key`.
      if (isUniqueViolation(error)) {
        throw new OpenKycCaseExistsError({ cause: error });
      }
      throw error;
    }
  }

  async updateDraft(
    tx: DbClient,
    caseId: string,
    declaration: KycDeclaration,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.kycCase.updateMany({
      where: { id: caseId, status: 'DRAFT', level: declaration.level },
      data: { ...declarationColumns(declaration), updatedAt: now },
    });
    return count === 1;
  }

  attachedDocuments(
    tx: DbClient,
    caseId: string,
  ): Promise<{ readonly id: string; readonly kind: KycDocumentKind }[]> {
    return tx.kycDocument.findMany({
      where: { caseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true },
    });
  }

  async touchDraft(tx: DbClient, caseId: string, now: Date): Promise<void> {
    await tx.kycCase.updateMany({
      where: { id: caseId, status: 'DRAFT' },
      data: { updatedAt: now },
    });
  }

  async insertDocument(tx: DbClient, document: NewKycDocument, now: Date): Promise<void> {
    try {
      await tx.kycDocument.create({ data: { ...document, createdAt: now } });
    } catch (error) {
      // Déclencheur de `kyc_documents`, ou index `kyc_documents_single_kind_key`.
      if (isRuleViolation(error) || isUniqueViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async deleteDocuments(
    tx: DbClient,
    caseId: string,
    documentIds: readonly string[],
  ): Promise<string[]> {
    if (documentIds.length === 0) {
      return [];
    }
    const where = { caseId, id: { in: [...documentIds] } };
    const found = await tx.kycDocument.findMany({ where, select: { storageKey: true } });
    try {
      await tx.kycDocument.deleteMany({ where });
    } catch (error) {
      if (isRuleViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
    return found.map(({ storageKey }) => storageKey);
  }

  async submit(tx: DbClient, caseId: string, now: Date): Promise<boolean> {
    try {
      // La condition et l'écriture sont une seule instruction : de deux dépôts simultanés, un
      // seul s'applique. Le déclencheur de la table vérifie les pièces et l'ordre des niveaux.
      const { count } = await tx.kycCase.updateMany({
        where: { id: caseId, status: 'DRAFT' },
        data: { status: 'SUBMITTED', submittedAt: now, updatedAt: now },
      });
      return count === 1;
    } catch (error) {
      if (isRuleViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async deleteDraft(tx: DbClient, caseId: string): Promise<string[] | null> {
    // Chaque écriture porte la condition : d'un dossier qui n'est plus en préparation, rien
    // n'est retiré — ni lui, ni ses pièces.
    const draft = { status: 'DRAFT' } as const;
    const documents = await tx.kycDocument.findMany({
      where: { caseId, case: draft },
      select: { storageKey: true },
    });
    try {
      await tx.kycDocument.deleteMany({ where: { caseId, case: draft } });
      const { count } = await tx.kycCase.deleteMany({ where: { id: caseId, ...draft } });
      return count === 1 ? documents.map(({ storageKey }) => storageKey) : null;
    } catch (error) {
      if (isRuleViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async findStaleDrafts(db: DbClient, before: Date, limit: number): Promise<string[]> {
    const rows = await db.kycCase.findMany({
      where: { status: 'DRAFT', updatedAt: { lt: before } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map(({ id }) => id);
  }

  async listForReview(db: DbClient, filter: ReviewQueueFilter): Promise<ReviewQueueEntry[]> {
    const rows = await db.kycCase.findMany({
      where: {
        status: filter.status,
        ...(filter.level === undefined ? {} : { level: filter.level }),
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
        ...(filter.after === undefined
          ? {}
          : {
              OR: [
                { submittedAt: { gt: filter.after.submittedAt } },
                { submittedAt: filter.after.submittedAt, id: { gt: filter.after.id } },
              ],
            }),
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: filter.limit,
      select: {
        id: true,
        level: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        user: ACCOUNT_REFERENCE,
      },
    });
    return rows.map((row) => ({
      ...row,
      level: levelOf(row.level),
      submittedAt: required(row.submittedAt, row.id, 'submission date'),
    }));
  }

  async decide(tx: DbClient, caseId: string, decision: KycDecision): Promise<boolean> {
    try {
      // La condition et l'écriture sont une seule instruction : de deux décisions simultanées,
      // une seule s'applique. Le déclencheur de la table vérifie la qualité de l'auteur et
      // remplace le dossier accepté précédent.
      const { count } = await tx.kycCase.updateMany({
        where: { id: caseId, status: 'SUBMITTED' },
        data: {
          status: decision.status,
          decidedBy: decision.decidedBy,
          decidedAt: decision.decidedAt,
          decisionNote: decision.note,
          rejectionReasons: decision.status === 'REJECTED' ? [...decision.reasons] : [],
          updatedAt: decision.decidedAt,
        },
      });
      return count === 1;
    } catch (error) {
      // Seul l'index `kyc_cases_verified_document_key` peut être enfreint ici : le dossier
      // accepté précédent du même compte est remplacé avant l'écriture.
      if (isUniqueViolation(error)) {
        throw new IdentityDocumentAlreadyVerifiedError({ cause: error });
      }
      if (isRuleViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async revoke(tx: DbClient, caseId: string, revocation: KycRevocation): Promise<boolean> {
    try {
      const { count } = await tx.kycCase.updateMany({
        where: { id: caseId, status: 'APPROVED' },
        data: {
          status: 'REVOKED',
          endedAt: revocation.endedAt,
          revokedBy: revocation.revokedBy,
          revocationReason: revocation.reason,
          updatedAt: revocation.endedAt,
        },
      });
      return count === 1;
    } catch (error) {
      if (isRuleViolation(error)) {
        throw new KycRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async approvedCaseId(db: DbClient, userId: string, level: KycLevel): Promise<string | null> {
    const row = await db.kycCase.findFirst({
      where: { userId, level, status: 'APPROVED' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async sameIdentityDocument(
    db: DbClient,
    criteria: {
      readonly userId: string;
      readonly documentType: KycIdentityDocumentType;
      readonly issuingCountry: string;
      readonly numberDigest: Uint8Array<ArrayBuffer>;
    },
    limit: number,
  ): Promise<{ readonly total: number; readonly cases: KycCaseHeader[] }> {
    const where = {
      userId: { not: criteria.userId },
      level: 1,
      status: { not: 'DRAFT' },
      documentType: criteria.documentType,
      documentIssuingCountry: criteria.issuingCountry,
      documentNumberDigest: criteria.numberDigest,
    } as const satisfies Prisma.KycCaseWhereInput;
    const [accounts, cases] = await Promise.all([
      db.kycCase.findMany({ where, distinct: ['userId'], select: { userId: true } }),
      db.kycCase.findMany({ where, orderBy: { id: 'desc' }, take: limit, select: HEADER_FIELDS }),
    ]);
    return { total: accounts.length, cases: cases.map(toHeader) };
  }

  async fileSightings(
    db: DbClient,
    userId: string,
    sha256: readonly Uint8Array<ArrayBuffer>[],
  ): Promise<Map<string, number>> {
    if (sha256.length === 0) {
      return new Map();
    }
    const rows = await db.kycDocument.findMany({
      where: {
        sha256: { in: [...sha256] },
        case: { userId: { not: userId }, status: { not: 'DRAFT' } },
      },
      select: { sha256: true, case: { select: { userId: true } } },
    });
    const accountsByDigest = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = Buffer.from(row.sha256).toString('hex');
      const accounts = accountsByDigest.get(key) ?? new Set<string>();
      accounts.add(row.case.userId);
      accountsByDigest.set(key, accounts);
    }
    return new Map([...accountsByDigest].map(([key, accounts]) => [key, accounts.size]));
  }

  async depositedCases(
    db: DbClient,
    userId: string,
    exceptCaseId: string,
    limit: number,
  ): Promise<KycCaseHeader[]> {
    const rows = await db.kycCase.findMany({
      where: { userId, id: { not: exceptCaseId }, status: { not: 'DRAFT' } },
      orderBy: { id: 'desc' },
      take: limit,
      select: HEADER_FIELDS,
    });
    return rows.map(toHeader);
  }
}
