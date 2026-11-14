import type {
  AcceptTermsRequest,
  AccountTerms,
  TermsDocument,
  TermsExport,
  TermsStatus,
  TermsVersionList,
  TermsVersionSummary,
} from '@mgx/contracts';
import type { SupportedLocale } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import {
  isAcceptanceRequired,
  localesOf,
  TERMS_VERSION_LIST_MAX,
  textIn,
} from '../domain/terms-policy.js';
import type { ClientContext } from './client-context.js';
import {
  TermsRepository,
  TermsRuleViolationError,
  type TermsStanding,
  type TermsVersionHeader,
  TermsVersionOutOfSequenceError,
  type TermsVersionRecord,
} from './terms.repository.js';

function notCurrent(): AppError {
  return new AppError(
    'TERMS_VERSION_NOT_CURRENT',
    'This is not the version of the terms of use in force. Read the current version, then try again.',
  );
}

/** Ce qu'un en-tête et une version entière ont en commun. */
interface SummarizedVersion {
  readonly number: number;
  readonly publishedAt: Date;
  readonly requiresAcceptance: boolean;
  readonly fr: { readonly summary: string };
  readonly en: { readonly summary: string } | null;
}

function toSummary(
  version: SummarizedVersion,
  locale: SupportedLocale,
  currentNumber: number,
): TermsVersionSummary {
  const { locale: served, text } = textIn(version, locale);
  return {
    number: version.number,
    publishedAt: version.publishedAt.toISOString(),
    requiresAcceptance: version.requiresAcceptance,
    current: version.number === currentNumber,
    locales: localesOf(version),
    locale: served,
    summary: text.summary,
  };
}

function toDocument(
  version: TermsVersionRecord,
  locale: SupportedLocale,
  currentNumber: number,
): TermsDocument {
  const { text } = textIn(version, locale);
  return { ...toSummary(version, locale, currentNumber), body: text.body, sha256: text.sha256 };
}

/**
 * Où en est un compte, à partir de ce que la base en dit. Un compte clôturé n'a plus rien à
 * accepter — ni plus aucune acceptation : une requête qui croise la clôture de son compte
 * n'est donc pas refusée au titre des conditions d'utilisation, mais traitée comme avant.
 */
export function toAccountTerms(standing: TermsStanding): AccountTerms {
  const { lastAccepted } = standing;
  return {
    accepted:
      lastAccepted === null
        ? null
        : { number: lastAccepted.versionNumber, acceptedAt: lastAccepted.acceptedAt.toISOString() },
    acceptanceRequired:
      standing.accountOpen &&
      isAcceptanceRequired(standing.latestRequired, lastAccepted?.versionNumber ?? null),
  };
}

/**
 * Conditions d'utilisation : lecture des versions publiées, et acceptation par les comptes.
 *
 * Une version exige d'être acceptée, ou est seulement signalée — c'est la règle choisie à sa
 * publication. Tant qu'un compte n'a pas accepté la dernière version qui l'exige (ou une
 * version publiée depuis), la plupart de ses routes lui sont fermées : voir
 * `TermsAcceptanceGuard`.
 */
@Injectable()
export class TermsService {
  constructor(
    private readonly terms: TermsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** La version en vigueur et son texte. */
  async current(locale: SupportedLocale): Promise<TermsDocument> {
    const version = await this.terms.findCurrent(this.prisma);
    if (version === null) {
      throw new AppError('NOT_FOUND', 'No terms of use have been published yet.');
    }
    return toDocument(version, locale, version.number);
  }

  /** Une version, en vigueur ou passée, et son texte. */
  async version(number: number, locale: SupportedLocale): Promise<TermsDocument> {
    const version = await this.terms.findVersion(this.prisma, number);
    if (version === null) {
      throw new AppError('NOT_FOUND', 'This version of the terms of use does not exist.');
    }
    // Lue après la version : celle en vigueur porte un numéro au moins égal, même si la version
    // demandée vient d'être publiée.
    const current = await this.terms.findCurrentHeader(this.prisma);
    return toDocument(version, locale, current?.number ?? version.number);
  }

  /** Les versions publiées, sans leur texte, de la plus récente à la plus ancienne. */
  async list(locale: SupportedLocale): Promise<TermsVersionList> {
    const headers = await this.terms.listHeaders(this.prisma, TERMS_VERSION_LIST_MAX);
    const currentNumber = headers[0]?.number ?? 0;
    return { versions: headers.map((header) => toSummary(header, locale, currentNumber)) };
  }

  /** Où en est un compte : version en vigueur, dernière version acceptée, obligation. */
  async status(userId: string): Promise<TermsStatus> {
    const standing = await this.terms.standingOf(this.prisma, userId);
    return {
      ...toAccountTerms(standing),
      current:
        standing.current === null
          ? null
          : {
              number: standing.current.number,
              publishedAt: standing.current.publishedAt.toISOString(),
              requiresAcceptance: standing.current.requiresAcceptance,
            },
    };
  }

  /** Ce qu'un compte a accepté et ce qu'il lui reste à accepter (fiche du back-office, `GET /me`). */
  async accountTerms(db: DbClient, userId: string): Promise<AccountTerms> {
    return toAccountTerms(await this.terms.standingOf(db, userId));
  }

  /** Les acceptations d'un compte, pour la copie de ses données. */
  async exportOf(db: DbClient, userId: string): Promise<TermsExport> {
    const acceptances = await this.terms.listAcceptances(db, userId);
    return {
      acceptances: acceptances.map(({ versionNumber, acceptedAt }) => ({
        version: versionNumber,
        acceptedAt: acceptedAt.toISOString(),
      })),
    };
  }

  /**
   * Vérifie, avant une inscription, que la version désignée est celle en vigueur. Ne dépend
   * que du numéro présenté : la réponse ne dit rien de l'existence d'un compte.
   *
   * @returns l'en-tête de la version en vigueur.
   */
  async assertCurrent(versionNumber: number): Promise<TermsVersionHeader> {
    const current = await this.terms.findCurrentHeader(this.prisma);
    if (current === null) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Registration is not available yet: the terms of use have not been published.',
      );
    }
    if (current.number !== versionNumber) {
      throw notCurrent();
    }
    return current;
  }

  /**
   * Vérifie, dans la transaction d'une inscription, que la version présentée est toujours celle
   * en vigueur.
   *
   * Une inscription qui écrit une acceptation est refusée par la base si une version vient
   * d'être publiée. Celle qui n'en écrit aucune — l'adresse appartient déjà à un compte — passe
   * par ce contrôle : les deux reçoivent alors la même réponse, qui ne dit rien de l'existence
   * d'un compte, même à l'instant d'une publication.
   */
  async assertStillCurrent(tx: DbClient, version: TermsVersionHeader): Promise<void> {
    const current = await this.terms.findCurrentHeader(tx);
    if (current?.number !== version.number) {
      throw notCurrent();
    }
  }

  /**
   * Enregistre, dans la transaction de l'appelant, l'acceptation de la version en vigueur par
   * un compte, et l'inscrit au journal d'audit. Une acceptation déjà enregistrée ne l'est pas
   * une seconde fois.
   *
   * @throws AppError `TERMS_VERSION_NOT_CURRENT` si une autre version vient d'être publiée.
   */
  async recordAcceptance(
    tx: DbClient,
    userId: string,
    version: TermsVersionHeader,
    client: ClientContext,
  ): Promise<void> {
    const acceptance = await this.terms.accept(tx, userId, version.number);
    if (!acceptance.created) {
      return;
    }
    await this.audit.record(tx, {
      actor: { type: 'USER', id: userId },
      action: 'terms.accepted',
      resource: { type: 'user', id: userId },
      outcome: 'SUCCESS',
      ...client,
      // L'empreinte lie l'acceptation au texte exact qui était en vigueur.
      metadata: {
        version: version.number,
        fr: { sha256: version.fr.sha256 },
        en: version.en === null ? null : { sha256: version.en.sha256 },
      },
    });
  }

  /**
   * Efface, dans la transaction de l'appelant, les acceptations d'une inscription restée
   * inachevée : la nouvelle inscription la remplace entièrement.
   */
  async discardAcceptances(tx: DbClient, userId: string): Promise<void> {
    await this.terms.deleteAcceptances(tx, userId);
  }

  /**
   * Acceptation de la version en vigueur par le titulaire d'un compte. Le numéro est celui du
   * texte qu'il a eu sous les yeux : on n'accepte pas un texte qu'on n'a pas pu lire.
   */
  async accept(
    user: AuthenticatedUser,
    request: AcceptTermsRequest,
    client: ClientContext,
  ): Promise<TermsStatus> {
    const current = await this.terms.findCurrentHeader(this.prisma);
    if (current?.number !== request.version) {
      throw notCurrent();
    }
    try {
      await this.unitOfWork.run((tx) => this.recordAcceptance(tx, user.userId, current, client));
    } catch (error) {
      throw translateRefusal(error);
    }
    return this.status(user.userId);
  }

  /** Vrai si le compte doit accepter la version en vigueur avant de continuer. */
  async isAcceptanceRequired(userId: string): Promise<boolean> {
    return (await this.accountTerms(this.prisma, userId)).acceptanceRequired;
  }
}

/** Traduit un refus de la base en erreur de l'API ; toute autre erreur est rendue telle quelle. */
export function translateRefusal(error: unknown): unknown {
  // Une autre version a été publiée entre la lecture et l'écriture.
  if (error instanceof TermsVersionOutOfSequenceError) {
    return notCurrent();
  }
  // Le compte a été suspendu entre-temps.
  if (error instanceof TermsRuleViolationError) {
    return new AppError('CONFLICT', 'The terms of use cannot be accepted by this account.');
  }
  return error;
}
