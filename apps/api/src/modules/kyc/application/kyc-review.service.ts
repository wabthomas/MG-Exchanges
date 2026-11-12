import {
  ADMIN_KYC_DUPLICATES_MAX,
  ADMIN_KYC_HISTORY_MAX,
  type AdminKycCase,
  type AdminKycCaseList,
  type AdminKycCaseListQuery,
  type AdminKycCaseStatus,
  type ApproveKycCaseRequest,
  type KycCaseStatus,
  type KycDocumentContentType,
  type KycLevel,
  type KycRejectionReason,
  type RejectKycCaseRequest,
  type RevokeKycCaseRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import type { ClientContext } from '../../identity/application/client-context.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { VerificationStatusReader } from '../../identity/application/verification-status.reader.js';
import {
  SECURITY_NOTICE_REQUESTED_EVENT,
  type SecurityNotice,
} from '../../identity/domain/identity-events.js';
import { fileExtensionOf } from '../domain/file-signature.js';
import {
  IdentityDocumentAlreadyVerifiedError,
  type KycCaseHeader,
  type KycCaseRecord,
  KycCaseRepository,
  KycRuleViolationError,
} from './kyc-case.repository.js';
import { DocumentUnreadableError, KycVault } from './kyc-vault.js';
import { addressViewOf, documentViewOf, fundsViewOf, identityViewOf } from './kyc-views.js';

/** Membre du personnel à l'origine d'une action sur un dossier de vérification. */
export interface KycReviewer {
  readonly userId: string;
  readonly client: ClientContext;
}

/** Pièce rendue à un examinateur, en clair. */
export interface ReviewedDocument {
  readonly content: Buffer;
  readonly contentType: KycDocumentContentType;
  readonly fileName: string;
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Verification case not found.');
}

/** Un examinateur ne voit que des dossiers déposés : un dossier en préparation « n'existe pas ». */
function depositedStatus(status: KycCaseStatus): AdminKycCaseStatus {
  if (status === 'DRAFT') {
    throw notFound();
  }
  return status;
}

function submissionDateOf(record: {
  readonly id: string;
  readonly submittedAt: Date | null;
}): Date {
  if (record.submittedAt === null) {
    throw new Error(`Verification case ${record.id} is deposited but has no submission date.`);
  }
  return record.submittedAt;
}

/** Curseur de la file : date de dépôt et identifiant du dernier dossier de la page. */
function encodeCursor(entry: { readonly submittedAt: Date; readonly id: string }): string {
  return Buffer.from(`${entry.submittedAt.toISOString()}|${entry.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { readonly submittedAt: Date; readonly id: string } {
  const [timestamp, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const submittedAt = new Date(timestamp ?? '');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    rest.length > 0 ||
    id === undefined ||
    !UUID.test(id) ||
    Number.isNaN(submittedAt.getTime())
  ) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
      errors: [{ path: 'after', message: 'Must be a cursor returned by a previous page.' }],
    });
  }
  return { submittedAt, id };
}

function historyEntryOf(header: KycCaseHeader): AdminKycCase['history'][number] {
  return {
    id: header.id,
    level: header.level,
    status: depositedStatus(header.status),
    submittedAt: submissionDateOf(header).toISOString(),
    decidedAt: header.decidedAt?.toISOString() ?? null,
  };
}

/**
 * Vérification d'identité, côté conformité : file des dossiers déposés, examen, décision.
 *
 * Règles communes :
 *  - un examinateur ne voit que des dossiers déposés ;
 *  - nul n'examine son propre dossier : ni consultation, ni décision ;
 *  - toute consultation — file, dossier, pièce — est écrite au journal d'audit, comme toute
 *    décision, dans la transaction qui l'applique ;
 *  - une décision est définitive : un dossier refusé ne se rouvre pas, le titulaire en dépose
 *    un autre ; une acceptation ne s'annule que par un retrait motivé ;
 *  - le titulaire est prévenu de chaque décision ; il ne connaît ni l'examinateur, ni la note
 *    interne, ni le motif d'un retrait.
 */
@Injectable()
export class KycReviewService {
  constructor(
    private readonly cases: KycCaseRepository,
    private readonly vault: KycVault,
    private readonly directory: UserDirectory,
    private readonly verification: VerificationStatusReader,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycReviewService.name);
  }

  /** File des dossiers, du dépôt le plus ancien au plus récent. Chaque page est journalisée. */
  async list(query: AdminKycCaseListQuery, reviewer: KycReviewer): Promise<AdminKycCaseList> {
    const found = await this.cases.listForReview(this.prisma, {
      status: query.status,
      level: query.level,
      userId: query.userId,
      limit: query.limit + 1,
      after: query.after === undefined ? undefined : decodeCursor(query.after),
    });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: reviewer.userId },
      action: 'kyc_case.listed_by_admin',
      resource: { type: 'kyc_case' },
      outcome: 'SUCCESS',
      ...reviewer.client,
      metadata: {
        status: query.status,
        ...(query.level === undefined ? {} : { level: query.level }),
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        limit: query.limit,
        results: page.length,
      },
    });

    return {
      cases: page.map((entry) => ({
        id: entry.id,
        level: entry.level,
        status: depositedStatus(entry.status),
        user: entry.user,
        submittedAt: entry.submittedAt.toISOString(),
        decidedAt: entry.decidedAt?.toISOString() ?? null,
      })),
      nextCursor: found.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** Dossier complet, avec ce qui aide à le juger. La consultation est journalisée. */
  async get(caseId: string, reviewer: KycReviewer): Promise<AdminKycCase> {
    this.vault.assertAvailable();
    const record = await this.reviewable(caseId, reviewer, 'kyc_case.view_denied');
    const view = await this.describe(record);
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: reviewer.userId },
      action: 'kyc_case.viewed_by_admin',
      resource: { type: 'kyc_case', id: caseId },
      outcome: 'SUCCESS',
      ...reviewer.client,
      metadata: { userId: record.userId, level: record.level },
    });
    return view;
  }

  /**
   * Rend une pièce en clair à un examinateur. L'accès est journalisé **avant** que le contenu
   * ne soit rendu : aucune pièce ne sort sans trace.
   */
  async document(
    caseId: string,
    documentId: string,
    reviewer: KycReviewer,
  ): Promise<ReviewedDocument> {
    this.vault.assertAvailable();
    const record = await this.reviewable(caseId, reviewer, 'kyc_document.view_denied');
    const document = record.documents.find((candidate) => candidate.id === documentId);
    if (document === undefined) {
      throw new AppError('NOT_FOUND', 'Document not found.');
    }

    let content: Buffer;
    try {
      content = await this.vault.loadDocument(
        { id: document.id, caseId: record.id, kind: document.kind },
        document,
      );
    } catch (error) {
      if (!(error instanceof DocumentUnreadableError)) {
        throw error;
      }
      // Une pièce déposée qui ne se relit plus est un incident : il est tracé et signalé.
      this.logger.error({ err: error, caseId, documentId }, 'Verification document unreadable');
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: reviewer.userId },
        action: 'kyc_document.viewed_by_admin',
        resource: { type: 'kyc_case', id: caseId },
        outcome: 'FAILURE',
        ...reviewer.client,
        metadata: { userId: record.userId, documentId, kind: document.kind },
      });
      throw new AppError('INTERNAL_ERROR', 'This document cannot be read.', { cause: error });
    }

    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: reviewer.userId },
      action: 'kyc_document.viewed_by_admin',
      resource: { type: 'kyc_case', id: caseId },
      outcome: 'SUCCESS',
      ...reviewer.client,
      metadata: { userId: record.userId, documentId, kind: document.kind },
    });
    return {
      content,
      contentType: document.contentType,
      fileName: `${document.kind.toLowerCase()}-${document.id}.${fileExtensionOf(document.contentType)}`,
    };
  }

  /**
   * Accepte un dossier déposé : le niveau est vérifié. S'il remplace un dossier accepté du
   * même niveau, celui-ci cesse d'être en vigueur au même instant.
   */
  async approve(
    caseId: string,
    request: ApproveKycCaseRequest,
    reviewer: KycReviewer,
  ): Promise<AdminKycCase> {
    this.vault.assertAvailable();
    const record = await this.awaitingDecision(caseId, reviewer, 'kyc_case.approval_denied');
    // Le niveau précédent a pu être retiré depuis le dépôt. La base refuserait l'acceptation
    // (déclencheur de `kyc_cases`) ; ce contrôle en donne la raison.
    const verifiedLevel = await this.verification.level(this.prisma, record.userId);
    if (verifiedLevel < record.level - 1) {
      throw new AppError(
        'CONFLICT',
        `Level ${String(record.level - 1)} is no longer verified for this account: this case ` +
          'cannot be approved.',
      );
    }
    const now = this.clock.now();
    const note = request.note ?? null;

    try {
      await this.unitOfWork.run(async (tx) => {
        const replaced = await this.cases.approvedCaseId(tx, record.userId, record.level);
        const decided = await this.cases.decide(tx, caseId, {
          status: 'APPROVED',
          decidedBy: reviewer.userId,
          decidedAt: now,
          note,
        });
        if (!decided) {
          throw new AppError('CONFLICT', 'This case has already been decided.');
        }
        await this.recordDecision(tx, reviewer, record, {
          action: 'approved',
          metadata: { ...(note === null ? {} : { note }), replacedCaseId: replaced },
          notice: 'IDENTITY_VERIFICATION_APPROVED',
          details: { level: record.level },
        });
      });
    } catch (error) {
      if (error instanceof IdentityDocumentAlreadyVerifiedError) {
        throw new AppError(
          'CONFLICT',
          'Another account is already verified with this identity document.',
          { cause: error },
        );
      }
      throw this.translated(error);
    }
    return this.describeById(caseId);
  }

  /**
   * Refuse un dossier déposé. Les motifs sont communiqués au titulaire, qui peut déposer un
   * nouveau dossier ; la note interne ne l'est jamais.
   */
  async reject(
    caseId: string,
    request: RejectKycCaseRequest,
    reviewer: KycReviewer,
  ): Promise<AdminKycCase> {
    this.vault.assertAvailable();
    const record = await this.awaitingDecision(caseId, reviewer, 'kyc_case.rejection_denied');
    const now = this.clock.now();

    try {
      await this.unitOfWork.run(async (tx) => {
        const decided = await this.cases.decide(tx, caseId, {
          status: 'REJECTED',
          decidedBy: reviewer.userId,
          decidedAt: now,
          note: request.note,
          reasons: request.reasons,
        });
        if (!decided) {
          throw new AppError('CONFLICT', 'This case has already been decided.');
        }
        await this.recordDecision(tx, reviewer, record, {
          action: 'rejected',
          metadata: { reasons: request.reasons, note: request.note },
          notice: 'IDENTITY_VERIFICATION_REJECTED',
          details: { level: record.level, reasons: request.reasons },
        });
      });
    } catch (error) {
      throw this.translated(error);
    }
    return this.describeById(caseId);
  }

  /**
   * Retire une vérification acceptée (pièce reconnue fausse, usurpation…). Le niveau vérifié
   * du compte retombe sous ce niveau : les niveaux supérieurs, toujours acceptés, ne comptent
   * plus tant que celui-ci n'est pas de nouveau vérifié.
   */
  async revoke(
    caseId: string,
    request: RevokeKycCaseRequest,
    reviewer: KycReviewer,
  ): Promise<AdminKycCase> {
    this.vault.assertAvailable();
    const record = await this.reviewable(caseId, reviewer, 'kyc_case.revocation_denied');
    if (record.status !== 'APPROVED') {
      throw new AppError(
        'CONFLICT',
        `Only an approved case in force can be revoked: this one is ${record.status.toLowerCase()}.`,
      );
    }
    const now = this.clock.now();

    try {
      await this.unitOfWork.run(async (tx) => {
        const revoked = await this.cases.revoke(tx, caseId, {
          revokedBy: reviewer.userId,
          endedAt: now,
          reason: request.reason,
        });
        if (!revoked) {
          throw new AppError('CONFLICT', 'This case is no longer in force.');
        }
        await this.recordDecision(tx, reviewer, record, {
          action: 'revoked',
          metadata: { reason: request.reason },
          notice: 'IDENTITY_VERIFICATION_REVOKED',
          details: { level: record.level },
        });
      });
    } catch (error) {
      throw this.translated(error);
    }
    return this.describeById(caseId);
  }

  /**
   * Trace d'une décision, dans la transaction qui l'applique : une entrée sur le dossier, avec
   * les motifs internes ; une entrée sur le compte, qui alimente l'historique du titulaire et
   * ne porte que ce qu'il peut connaître ; et l'avis qui lui sera envoyé.
   */
  private async recordDecision(
    tx: DbClient,
    reviewer: KycReviewer,
    record: KycCaseRecord,
    decision: {
      readonly action: 'approved' | 'rejected' | 'revoked';
      readonly metadata: Record<string, unknown>;
      readonly notice: SecurityNotice;
      readonly details: {
        readonly level: KycLevel;
        readonly reasons?: readonly KycRejectionReason[];
      };
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'USER', id: reviewer.userId },
      action: `kyc_case.${decision.action}`,
      resource: { type: 'kyc_case', id: record.id },
      outcome: 'SUCCESS',
      ...reviewer.client,
      metadata: { userId: record.userId, level: record.level, ...decision.metadata },
    });
    await this.audit.record(tx, {
      actor: { type: 'USER', id: reviewer.userId },
      action: `user.verification_${decision.action}`,
      resource: { type: 'user', id: record.userId },
      outcome: 'SUCCESS',
      ...reviewer.client,
      metadata: { caseId: record.id, level: record.level },
    });
    await this.outbox.append(tx, {
      aggregateType: 'user',
      aggregateId: record.userId,
      eventType: SECURITY_NOTICE_REQUESTED_EVENT,
      payload: { userId: record.userId, notice: decision.notice, details: decision.details },
      metadata: { requestId: reviewer.client.requestId },
    });
  }

  /** Refus de la base : la décision n'est plus possible (dossier déjà décidé, droits retirés). */
  private translated(error: unknown): unknown {
    if (error instanceof KycRuleViolationError) {
      return new AppError('CONFLICT', 'This decision is no longer possible on this case.', {
        cause: error,
      });
    }
    return error;
  }

  /** Dossier déposé en attente de décision, que cet examinateur peut juger. */
  private async awaitingDecision(
    caseId: string,
    reviewer: KycReviewer,
    deniedAction: string,
  ): Promise<KycCaseRecord> {
    const record = await this.reviewable(caseId, reviewer, deniedAction);
    if (record.status !== 'SUBMITTED') {
      throw new AppError(
        'CONFLICT',
        `Only a case awaiting review can be decided: this one is ${record.status.toLowerCase()}.`,
      );
    }
    return record;
  }

  /** Dossier déposé, d'un autre compte que celui de l'examinateur. */
  private async reviewable(
    caseId: string,
    reviewer: KycReviewer,
    deniedAction: string,
  ): Promise<KycCaseRecord> {
    const record = await this.cases.find(this.prisma, caseId);
    if (record === null || record.status === 'DRAFT') {
      throw notFound();
    }
    if (record.userId === reviewer.userId) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: reviewer.userId },
        action: deniedAction,
        resource: { type: 'kyc_case', id: caseId },
        outcome: 'DENIED',
        ...reviewer.client,
        metadata: { reason: 'OWN_CASE' },
      });
      throw new AppError(
        'FORBIDDEN',
        'You cannot review your own verification case from the back office.',
      );
    }
    return record;
  }

  private async describeById(caseId: string): Promise<AdminKycCase> {
    const record = await this.cases.find(this.prisma, caseId);
    if (record === null) {
      throw notFound();
    }
    return this.describe(record);
  }

  private async describe(record: KycCaseRecord): Promise<AdminKycCase> {
    const { identity } = record;
    const [user, verificationLevel, sightings, sameIdentityDocument, history, approvedCaseId] =
      await Promise.all([
        this.directory.find(this.prisma, record.userId),
        this.verification.level(this.prisma, record.userId),
        this.cases.fileSightings(
          this.prisma,
          record.userId,
          record.documents.map(({ sha256 }) => sha256),
        ),
        identity === null
          ? Promise.resolve({ total: 0, cases: [] })
          : this.cases.sameIdentityDocument(
              this.prisma,
              {
                userId: record.userId,
                documentType: identity.documentType,
                issuingCountry: identity.documentIssuingCountry,
                numberDigest: identity.documentNumberDigest,
              },
              ADMIN_KYC_DUPLICATES_MAX,
            ),
        this.cases.depositedCases(this.prisma, record.userId, record.id, ADMIN_KYC_HISTORY_MAX),
        this.cases.approvedCaseId(this.prisma, record.userId, record.level),
      ]);
    if (user === null) {
      throw notFound();
    }

    let identityView: AdminKycCase['identity'] = null;
    if (identity !== null) {
      const view = identityViewOf(identity);
      identityView = {
        ...view,
        document: {
          ...view.document,
          number: this.vault.decryptDocumentNumber(record.userId, identity.documentNumberEncrypted),
        },
      };
    }

    return {
      id: record.id,
      level: record.level,
      status: depositedStatus(record.status),
      createdAt: record.createdAt.toISOString(),
      submittedAt: submissionDateOf(record).toISOString(),
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        accountType: user.accountType,
        countryCode: user.countryCode,
        createdAt: user.createdAt.toISOString(),
        verificationLevel,
      },
      identity: identityView,
      address: record.address === null ? null : addressViewOf(record.address),
      sourceOfFunds: record.funds === null ? null : fundsViewOf(record.funds),
      documents: record.documents.map((document) => ({
        ...documentViewOf(document),
        seenOnOtherAccounts: sightings.get(Buffer.from(document.sha256).toString('hex')) ?? 0,
      })),
      decision:
        record.decidedBy === null || record.decidedAt === null
          ? null
          : {
              decidedBy: record.decidedBy,
              decidedAt: record.decidedAt.toISOString(),
              note: record.decisionNote,
              rejectionReasons: [...record.rejectionReasons],
            },
      ending:
        record.endedAt === null
          ? null
          : {
              endedAt: record.endedAt.toISOString(),
              revokedBy: record.revokedBy,
              revocationReason: record.revocationReason,
            },
      replacesCaseId:
        record.status === 'SUBMITTED' && approvedCaseId !== record.id ? approvedCaseId : null,
      sameIdentityDocument: {
        total: sameIdentityDocument.total,
        cases: sameIdentityDocument.cases.map((other) => ({
          caseId: other.id,
          userId: other.userId,
          status: depositedStatus(other.status),
        })),
      },
      history: history.map(historyEntryOf),
    };
  }
}
