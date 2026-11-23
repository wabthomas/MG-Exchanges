import type {
  AdminTermsVersion,
  AdminTermsVersionList,
  PublishTermsVersionRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { TERMS_VERSION_LIST_MAX } from '../domain/terms-policy.js';
import type { StaffActor } from './admin-users.service.js';
import { publishTermsVersion } from './terms-publication.js';
import {
  TermsRepository,
  TermsRuleViolationError,
  type TermsVersionHeader,
  TermsVersionOutOfSequenceError,
} from './terms.repository.js';

function toAdminView(
  header: TermsVersionHeader,
  currentNumber: number,
  acceptances: number,
): AdminTermsVersion {
  return {
    number: header.number,
    publishedAt: header.publishedAt.toISOString(),
    publishedBy: header.publishedBy,
    requiresAcceptance: header.requiresAcceptance,
    current: header.number === currentNumber,
    fr: header.fr,
    en: header.en,
    acceptances,
  };
}

function outOfSequence(requested: number, next: number): AppError {
  return new AppError(
    'CONFLICT',
    `Version ${String(requested)} cannot be published: the next version is ${String(next)}.`,
  );
}

/**
 * Back-office : publication des conditions d'utilisation et suivi de leur acceptation.
 *
 * Publier est **définitif** : une version ne se modifie ni ne se retire. La requête désigne
 * donc le numéro qu'elle publie — celui de la version en vigueur, plus un. Une publication
 * envoyée deux fois, ou décidée sur la foi d'un état dépassé, est ainsi refusée au lieu de
 * créer une version de trop.
 */
@Injectable()
export class TermsAdministrationService {
  constructor(
    private readonly terms: TermsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Les versions publiées, de la plus récente à la plus ancienne, et leurs acceptations. */
  async list(): Promise<AdminTermsVersionList> {
    const headers = await this.terms.listHeaders(this.prisma, TERMS_VERSION_LIST_MAX);
    const counts = await this.terms.countAcceptances(
      this.prisma,
      headers.map(({ number }) => number),
    );
    const currentNumber = headers[0]?.number ?? 0;
    return {
      versions: headers.map((header) =>
        toAdminView(header, currentNumber, counts.get(header.number) ?? 0),
      ),
    };
  }

  async publish(
    request: PublishTermsVersionRequest,
    actor: StaffActor,
  ): Promise<AdminTermsVersion> {
    const next = await this.nextNumber();
    if (request.number !== next) {
      throw outOfSequence(request.number, next);
    }

    try {
      return await this.unitOfWork.run(async (tx) => {
        await publishTermsVersion(tx, { terms: this.terms, audit: this.audit }, request, {
          kind: 'STAFF',
          userId: actor.userId,
          client: actor.client,
        });
        // Relue telle que la base la conserve : heure de publication, longueur des textes.
        const published = await this.terms.findCurrentHeader(tx);
        if (published?.number !== request.number) {
          throw new Error('The terms version that was just published cannot be read back.');
        }
        return toAdminView(published, published.number, 0);
      });
    } catch (error) {
      // Une autre publication l'a devancée.
      if (error instanceof TermsVersionOutOfSequenceError) {
        throw outOfSequence(request.number, await this.nextNumber());
      }
      // La base a vérifié elle-même le droit de publier : l'auteur ne l'a plus.
      if (error instanceof TermsRuleViolationError) {
        throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
    }
  }

  private async nextNumber(): Promise<number> {
    const current = await this.terms.findCurrentHeader(this.prisma);
    return (current?.number ?? 0) + 1;
  }
}
