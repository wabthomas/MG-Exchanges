import {
  type FieldError,
  KYC_DOCUMENT_MAX_BYTES,
  KYC_LEVELS,
  KYC_SELFIE_CONTENT_TYPES,
  type KycAddressDeclaration,
  type KycCase,
  type KycDocumentContentType,
  type KycDocumentKind,
  type KycDocumentRule,
  kycDocumentRule,
  type KycFundsDeclaration,
  type KycIdentityDeclaration,
  type KycLevel,
  type KycOverview,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import {
  type RateLimitRule,
  RedisRateLimiter,
} from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { ClientContext } from '../../identity/application/client-context.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import { formatCalendarDate, parseCalendarDate } from '../../identity/domain/profile-policy.js';
import type { UserRecord } from '../../identity/domain/user.js';
import { verifiedLevelOf } from '../../identity/domain/verification-level.js';
import { detectContentType } from '../domain/file-signature.js';
import {
  checkAddressDeclaration,
  checkIdentityDeclaration,
  KYC_DOCUMENT_MIN_BYTES,
  KYC_DRAFT_SAVES_PER_ACCOUNT,
  KYC_SUBMISSIONS_PER_ACCOUNT,
  KYC_UPLOADS_PER_ACCOUNT,
  missingDocumentKinds,
} from '../domain/kyc-policy.js';
import {
  type KycCaseRecord,
  KycCaseRepository,
  type KycDeclaration,
  KycRuleViolationError,
  OpenKycCaseExistsError,
} from './kyc-case.repository.js';
import { KycVault } from './kyc-vault.js';
import { caseSummaryOf, caseViewOf } from './kyc-views.js';

/** Titulaire à l'origine d'une action sur ses propres dossiers. */
export interface KycActor {
  readonly userId: string;
  readonly client: ClientContext;
}

/** Fichier reçu : le format annoncé (parmi ceux acceptés) et le contenu. */
export interface DocumentUpload {
  readonly contentType: KycDocumentContentType;
  readonly content: Uint8Array;
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Verification case not found.');
}

function notDraft(status: string): AppError {
  return new AppError(
    'CONFLICT',
    `Only a draft can be changed: this case is ${status.toLowerCase()}.`,
  );
}

function invalid(errors: readonly FieldError[]): AppError {
  return new AppError('VALIDATION_FAILED', 'Request validation failed.', { errors });
}

/** Les dates d'une déclaration ont été validées avant d'arriver ici. */
function dateOf(value: string, path: string): Date {
  const date = parseCalendarDate(value);
  if (date === null) {
    throw invalid([{ path, message: 'Must be a valid calendar date.' }]);
  }
  return date;
}

/**
 * Vérification d'identité, côté titulaire : préparer un dossier par niveau, y joindre ses
 * pièces, le déposer, suivre la décision.
 *
 * Règles communes :
 *  - un titulaire n'accède qu'à ses propres dossiers — celui d'un autre « n'existe pas » ;
 *  - les niveaux s'obtiennent dans l'ordre ;
 *  - seul un dossier en préparation se modifie ; déposé, il est figé ;
 *  - une pièce n'est jamais conservée en clair : elle est chiffrée avant d'être écrite ;
 *  - chaque action est écrite au journal d'audit dans la transaction qui l'applique — le
 *    journal ne reçoit jamais le contenu d'une déclaration.
 *
 * Les contrôles faits ici donnent des réponses claires ; les mêmes règles sont imposées par la
 * base (contraintes et déclencheurs de `kyc_cases` et `kyc_documents`), qui a le dernier mot.
 *
 * Sans stockage chiffré configuré, seule la situation du compte (`overview`) reste lisible :
 * toute autre opération répond `SERVICE_UNAVAILABLE`.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly cases: KycCaseRepository,
    private readonly vault: KycVault,
    private readonly users: UserRepository,
    private readonly limiter: RedisRateLimiter,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycService.name);
  }

  /** Où en est le compte : niveau vérifié, et pour chaque niveau son dernier dossier. */
  async overview(userId: string): Promise<KycOverview> {
    const [user, latest, approved] = await Promise.all([
      this.users.findById(this.prisma, userId),
      this.cases.latestPerLevel(this.prisma, userId),
      this.cases.approvedCases(this.prisma, userId),
    ]);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }
    const verifiedLevel = verifiedLevelOf(approved.map(({ level }) => level));

    return {
      level: verifiedLevel,
      levels: KYC_LEVELS.map((level) => {
        const verifiedBy = approved.find((candidate) => candidate.level === level);
        const current = latest.find((candidate) => candidate.level === level);
        return {
          level,
          verified: verifiedBy !== undefined,
          verifiedAt: verifiedBy?.decidedAt?.toISOString() ?? null,
          available:
            user.accountType === 'INDIVIDUAL' &&
            verifiedLevel >= level - 1 &&
            current?.status !== 'SUBMITTED',
          currentCase: current === undefined ? null : caseSummaryOf(current),
        };
      }),
    };
  }

  async getCase(userId: string, caseId: string): Promise<KycCase> {
    this.vault.assertAvailable();
    return this.view(await this.owned(userId, caseId));
  }

  /** Niveau 1 : enregistre l'identité déclarée et la pièce présentée. */
  async saveIdentity(actor: KycActor, declaration: KycIdentityDeclaration): Promise<KycCase> {
    this.vault.assertAvailable();
    await this.limit(KYC_DRAFT_SAVES_PER_ACCOUNT, `kyc-draft:${actor.userId}`);
    await this.eligibleUser(actor.userId, 1);
    const errors = checkIdentityDeclaration(declaration, this.clock.now());
    if (errors.length > 0) {
      throw invalid(errors);
    }

    const { document } = declaration;
    return this.saveDraft(actor, {
      level: 1,
      identity: {
        givenName: declaration.givenName,
        familyName: declaration.familyName,
        additionalName: declaration.additionalName,
        dateOfBirth: dateOf(declaration.dateOfBirth, 'dateOfBirth'),
        placeOfBirth: declaration.placeOfBirth,
        nationality: declaration.nationality,
        documentType: document.type,
        documentNumberEncrypted: this.vault.encryptDocumentNumber(actor.userId, document.number),
        documentNumberDigest: this.vault.documentNumberDigest(
          document.type,
          document.issuingCountry,
          document.number,
        ),
        documentIssuingCountry: document.issuingCountry,
        documentIssuedOn: dateOf(document.issuedOn, 'document.issuedOn'),
        documentIssuedAt: document.issuedAt,
        documentExpiresOn:
          document.expiresOn === null ? null : dateOf(document.expiresOn, 'document.expiresOn'),
      },
    });
  }

  /** Niveau 2 : enregistre l'adresse déclarée et le justificatif présenté. */
  async saveAddress(actor: KycActor, declaration: KycAddressDeclaration): Promise<KycCase> {
    this.vault.assertAvailable();
    await this.limit(KYC_DRAFT_SAVES_PER_ACCOUNT, `kyc-draft:${actor.userId}`);
    const user = await this.eligibleUser(actor.userId, 2);
    const errors = checkAddressDeclaration(declaration, user.countryCode, this.clock.now());
    if (errors.length > 0) {
      throw invalid(errors);
    }
    return this.saveDraft(actor, {
      level: 2,
      address: {
        addressLine1: declaration.addressLine1,
        addressLine2: declaration.addressLine2,
        city: declaration.city,
        region: declaration.region,
        postalCode: declaration.postalCode,
        addressCountry: declaration.country,
        addressProofType: declaration.proof.type,
        addressProofIssuedOn: dateOf(declaration.proof.issuedOn, 'proof.issuedOn'),
      },
    });
  }

  /** Niveau 3 : enregistre l'origine des fonds déclarée. */
  async saveFunds(actor: KycActor, declaration: KycFundsDeclaration): Promise<KycCase> {
    this.vault.assertAvailable();
    await this.limit(KYC_DRAFT_SAVES_PER_ACCOUNT, `kyc-draft:${actor.userId}`);
    await this.eligibleUser(actor.userId, 3);
    return this.saveDraft(actor, {
      level: 3,
      funds: {
        fundsSources: declaration.sources,
        occupation: declaration.occupation,
        employerName: declaration.employerName,
        fundsExplanation: declaration.explanation,
      },
    });
  }

  /**
   * Contrôles préalables à la réception d'un fichier, faits **avant** de lire le corps de la
   * requête : un envoi qui serait refusé de toute façon ne coûte ni mémoire, ni bande passante.
   * C'est ici que l'envoi est compté.
   */
  async prepareUpload(actor: KycActor, caseId: string, kind: KycDocumentKind): Promise<void> {
    this.vault.assertAvailable();
    await this.limit(KYC_UPLOADS_PER_ACCOUNT, `kyc-upload:${actor.userId}`);
    await this.uploadTarget(actor.userId, caseId, kind);
  }

  /**
   * Joint une pièce à un dossier en préparation. Pour une nature qui n'admet qu'un fichier
   * (recto, verso, autoportrait), le nouvel envoi **remplace** le précédent.
   */
  async addDocument(
    actor: KycActor,
    caseId: string,
    kind: KycDocumentKind,
    upload: DocumentUpload,
  ): Promise<KycCase> {
    this.vault.assertAvailable();
    const rule = await this.uploadTarget(actor.userId, caseId, kind);
    this.assertAcceptable(kind, upload);

    // Le fichier est chiffré et écrit avant la transaction : si celle-ci échoue, il est
    // effacé — et resterait de toute façon indéchiffrable, sa clé n'étant écrite qu'en base.
    const now = this.clock.now();
    const documentId = await this.cases.newId(this.prisma);
    const stored = await this.vault.storeDocument({ id: documentId, caseId, kind }, upload.content);

    let replaced: string[];
    try {
      replaced = await this.unitOfWork.run(async (tx) => {
        const locked = await this.cases.lockCase(tx, caseId);
        if (locked?.userId !== actor.userId) {
          throw notFound();
        }
        if (locked.status !== 'DRAFT') {
          throw notDraft(locked.status);
        }
        // Lu sous le verrou : aucune autre pièce ne s'ajoute ni ne se retire entre-temps.
        const attached = await this.cases.attachedDocuments(tx, caseId);
        const sameKind = attached.filter((document) => document.kind === kind);
        let removed: string[] = [];
        if (rule.max === 1) {
          removed = await this.cases.deleteDocuments(
            tx,
            caseId,
            sameKind.map(({ id }) => id),
          );
        } else if (sameKind.length >= rule.max) {
          throw new AppError(
            'CONFLICT',
            `At most ${String(rule.max)} ${kind} documents can be attached: remove one first.`,
          );
        }
        await this.cases.insertDocument(
          tx,
          {
            id: documentId,
            caseId,
            kind,
            contentType: upload.contentType,
            byteSize: upload.content.length,
            sha256: stored.sha256,
            storageKey: stored.storageKey,
            wrappedKey: stored.wrappedKey,
          },
          now,
        );
        await this.cases.touchDraft(tx, caseId, now);
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'kyc_case.document_added',
          resource: { type: 'kyc_case', id: caseId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: {
            documentId,
            kind,
            contentType: upload.contentType,
            byteSize: upload.content.length,
            replaced: removed.length,
          },
        });
        return removed;
      });
    } catch (error) {
      await this.discardFiles([stored.storageKey]);
      if (error instanceof KycRuleViolationError) {
        throw new AppError('CONFLICT', 'This case can no longer be changed.', { cause: error });
      }
      throw error;
    }
    await this.discardFiles(replaced);
    return this.getCase(actor.userId, caseId);
  }

  /** Retire une pièce d'un dossier en préparation. */
  async removeDocument(actor: KycActor, caseId: string, documentId: string): Promise<KycCase> {
    this.vault.assertAvailable();
    const now = this.clock.now();
    let removed: string[];
    try {
      removed = await this.unitOfWork.run(async (tx) => {
        const locked = await this.cases.lockCase(tx, caseId);
        if (locked?.userId !== actor.userId) {
          throw notFound();
        }
        if (locked.status !== 'DRAFT') {
          throw notDraft(locked.status);
        }
        const keys = await this.cases.deleteDocuments(tx, caseId, [documentId]);
        if (keys.length === 0) {
          throw new AppError('NOT_FOUND', 'Document not found.');
        }
        await this.cases.touchDraft(tx, caseId, now);
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'kyc_case.document_removed',
          resource: { type: 'kyc_case', id: caseId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { documentId },
        });
        return keys;
      });
    } catch (error) {
      if (error instanceof KycRuleViolationError) {
        throw new AppError('CONFLICT', 'This case can no longer be changed.', { cause: error });
      }
      throw error;
    }
    await this.discardFiles(removed);
    return this.getCase(actor.userId, caseId);
  }

  /** Abandonne un dossier en préparation : il est effacé, avec ses pièces. */
  async discardDraft(actor: KycActor, caseId: string): Promise<void> {
    this.vault.assertAvailable();
    let removed: string[];
    try {
      removed = await this.unitOfWork.run(async (tx) => {
        const locked = await this.cases.lockCase(tx, caseId);
        if (locked?.userId !== actor.userId) {
          throw notFound();
        }
        if (locked.status !== 'DRAFT') {
          throw notDraft(locked.status);
        }
        const keys = await this.cases.deleteDraft(tx, caseId);
        if (keys === null) {
          throw notDraft('no longer a draft');
        }
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'kyc_case.discarded',
          resource: { type: 'kyc_case', id: caseId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { documents: keys.length },
        });
        return keys;
      });
    } catch (error) {
      if (error instanceof KycRuleViolationError) {
        throw new AppError('CONFLICT', 'This case can no longer be changed.', { cause: error });
      }
      throw error;
    }
    await this.discardFiles(removed);
  }

  /**
   * Dépose un dossier : il est figé et rejoint la file d'examen. Les contrôles qui dépendent
   * du jour sont refaits — une pièce a pu expirer depuis l'enregistrement.
   */
  async submit(actor: KycActor, caseId: string): Promise<KycCase> {
    this.vault.assertAvailable();
    const now = this.clock.now();
    const record = await this.owned(actor.userId, caseId);
    if (record.status !== 'DRAFT') {
      throw notDraft(record.status);
    }
    const user = await this.eligibleUser(actor.userId, record.level);

    const errors = this.recheck(record, user, now);
    if (errors.length > 0) {
      throw new AppError(
        'UNPROCESSABLE_ENTITY',
        'The declaration is no longer valid: correct it before submitting the case.',
        { errors },
      );
    }
    const missing = missingDocumentKinds(
      record.level,
      record.identity?.documentType ?? null,
      record.documents.map(({ kind }) => kind),
    );
    if (missing.length > 0) {
      throw new AppError('UNPROCESSABLE_ENTITY', `Documents are missing: ${missing.join(', ')}.`);
    }

    // Compté après les contrôles : une tentative refusée ne consomme pas un dépôt.
    await this.limit(KYC_SUBMISSIONS_PER_ACCOUNT, `kyc-submit:${actor.userId}`);

    try {
      await this.unitOfWork.run(async (tx) => {
        if (!(await this.cases.submit(tx, caseId, now))) {
          throw notDraft('no longer a draft');
        }
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'kyc_case.submitted',
          resource: { type: 'kyc_case', id: caseId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { level: record.level, documents: record.documents.length },
        });
      });
    } catch (error) {
      if (error instanceof KycRuleViolationError) {
        throw new AppError(
          'CONFLICT',
          'This case cannot be submitted: a document is missing, or the previous level is no ' +
            'longer verified.',
          { cause: error },
        );
      }
      throw error;
    }
    return this.getCase(actor.userId, caseId);
  }

  /** Crée le dossier en préparation du niveau, ou remplace sa déclaration. */
  private async saveDraft(actor: KycActor, declaration: KycDeclaration): Promise<KycCase> {
    const now = this.clock.now();
    const save = (): Promise<string> =>
      this.unitOfWork.run(async (tx) => {
        const open = await this.cases.lockOpenCase(tx, actor.userId, declaration.level);
        if (open?.status === 'SUBMITTED') {
          throw new AppError('CONFLICT', 'A case is already awaiting review for this level.');
        }
        let caseId: string;
        if (open === null) {
          caseId = await this.cases.createDraft(tx, actor.userId, declaration, now);
        } else {
          if (!(await this.cases.updateDraft(tx, open.id, declaration, now))) {
            throw notDraft('no longer a draft');
          }
          caseId = open.id;
        }
        // Le journal retient qu'une déclaration a été enregistrée, jamais ce qu'elle contient.
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'kyc_case.draft_saved',
          resource: { type: 'kyc_case', id: caseId },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { level: declaration.level, created: open === null },
        });
        return caseId;
      });

    let caseId: string;
    try {
      caseId = await save();
    } catch (error) {
      if (!(error instanceof OpenKycCaseExistsError)) {
        throw error;
      }
      // Deux enregistrements simultanés ont voulu créer le dossier : celui-ci reprend, et
      // trouve cette fois le dossier créé par l'autre.
      try {
        caseId = await save();
      } catch (retryError) {
        if (retryError instanceof OpenKycCaseExistsError) {
          throw new AppError('CONFLICT', 'This case is being changed by another request.', {
            cause: retryError,
          });
        }
        throw retryError;
      }
    }
    return this.getCase(actor.userId, caseId);
  }

  /** Règle applicable à une pièce de cette nature dans ce dossier, s'il peut en recevoir. */
  private async uploadTarget(
    userId: string,
    caseId: string,
    kind: KycDocumentKind,
  ): Promise<KycDocumentRule> {
    const record = await this.owned(userId, caseId);
    if (record.status !== 'DRAFT') {
      throw notDraft(record.status);
    }
    const rule = kycDocumentRule(record.level, kind);
    if (rule === null) {
      throw new AppError(
        'UNPROCESSABLE_ENTITY',
        `A ${kind} document does not belong to a level ${String(record.level)} case.`,
      );
    }
    return rule;
  }

  /** Contrôles de la déclaration enregistrée, refaits au jour du dépôt. */
  private recheck(record: KycCaseRecord, user: UserRecord, now: Date): FieldError[] {
    if (record.identity !== null) {
      const { identity } = record;
      return checkIdentityDeclaration(
        {
          dateOfBirth: formatCalendarDate(identity.dateOfBirth),
          document: {
            type: identity.documentType,
            issuingCountry: identity.documentIssuingCountry,
            issuedOn: formatCalendarDate(identity.documentIssuedOn),
            expiresOn:
              identity.documentExpiresOn === null
                ? null
                : formatCalendarDate(identity.documentExpiresOn),
          },
        },
        now,
      );
    }
    if (record.address !== null) {
      return checkAddressDeclaration(
        {
          country: record.address.addressCountry,
          proof: { issuedOn: formatCalendarDate(record.address.addressProofIssuedOn) },
        },
        user.countryCode,
        now,
      );
    }
    return [];
  }

  /** Le contenu reçu est-il bien ce qu'il annonce, et convient-il à cette nature de pièce ? */
  private assertAcceptable(kind: KycDocumentKind, upload: DocumentUpload): void {
    if (upload.content.length > KYC_DOCUMENT_MAX_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'The file is too large.');
    }
    if (upload.content.length < KYC_DOCUMENT_MIN_BYTES) {
      throw new AppError('UNPROCESSABLE_ENTITY', 'The file is too small to be a document.');
    }
    if (detectContentType(upload.content) !== upload.contentType) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'The content of the file does not match its declared type.',
      );
    }
    const selfieTypes: readonly string[] = KYC_SELFIE_CONTENT_TYPES;
    if (kind === 'SELFIE' && !selfieTypes.includes(upload.contentType)) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'A selfie must be a JPEG or PNG image.');
    }
  }

  /**
   * Compte du titulaire, s'il peut préparer ou déposer un dossier de ce niveau : compte de
   * particulier, niveaux précédents vérifiés.
   */
  private async eligibleUser(userId: string, level: KycLevel): Promise<UserRecord> {
    const [user, approved] = await Promise.all([
      this.users.findById(this.prisma, userId),
      this.cases.approvedCases(this.prisma, userId),
    ]);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }
    if (user.accountType !== 'INDIVIDUAL') {
      throw new AppError(
        'UNPROCESSABLE_ENTITY',
        'Verification of business accounts is not available yet.',
      );
    }
    if (verifiedLevelOf(approved.map((approvedCase) => approvedCase.level)) < level - 1) {
      throw new AppError(
        'CONFLICT',
        `Level ${String(level - 1)} must be verified before level ${String(level)}.`,
      );
    }
    return user;
  }

  /** Dossier du titulaire ; celui d'un autre compte « n'existe pas ». */
  private async owned(userId: string, caseId: string): Promise<KycCaseRecord> {
    const record = await this.cases.find(this.prisma, caseId);
    if (record?.userId !== userId) {
      throw notFound();
    }
    return record;
  }

  private view(record: KycCaseRecord): KycCase {
    return caseViewOf(
      record,
      record.identity === null
        ? null
        : this.vault.decryptDocumentNumber(record.userId, record.identity.documentNumberEncrypted),
    );
  }

  private async limit(rule: RateLimitRule, key: string): Promise<void> {
    const decision = await this.limiter.consume(key, rule);
    if (decision.blocked) {
      throw new AppError('RATE_LIMITED', 'Too many requests. Please try again later.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  }

  /**
   * Efface des fichiers devenus inutiles. Un échec n'annule rien : la ligne qui portait la
   * clé du fichier n'existe plus, et il est donc déjà illisible. Il est signalé pour ménage.
   */
  private async discardFiles(storageKeys: readonly string[]): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.vault.removeDocument(storageKey);
      } catch (error) {
        this.logger.warn({ err: error, storageKey }, 'Verification document file not removed');
      }
    }
  }
}
