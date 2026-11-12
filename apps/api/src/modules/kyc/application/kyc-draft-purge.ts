import { KYC_DRAFT_RETENTION_DAYS } from '@mgx/contracts';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import {
  type MaintenanceStep,
  MaintenanceStepRegistry,
} from '../../identity/application/maintenance-step.registry.js';
import { KycCaseRepository } from './kyc-case.repository.js';
import { KycVault } from './kyc-vault.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nombre maximal de dossiers effacés par passage : le reste attend le passage suivant. */
export const KYC_DRAFT_PURGE_BATCH_SIZE = 200;

/**
 * Efface les dossiers restés **en préparation** sans changement depuis
 * `KYC_DRAFT_RETENTION_DAYS` jours, avec leurs pièces : des pièces d'identité ne sont pas
 * conservées pour un dossier que son titulaire n'a jamais déposé. Un dossier déposé n'est
 * jamais concerné.
 *
 * Étape de la purge périodique des données d'identité (même cadence, mêmes journaux).
 */
@Injectable()
export class KycDraftPurge implements MaintenanceStep, OnModuleInit {
  readonly name = 'purge-stale-kyc-drafts';

  constructor(
    private readonly cases: KycCaseRepository,
    private readonly vault: KycVault,
    private readonly registry: MaintenanceStepRegistry,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycDraftPurge.name);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<number> {
    // Sans stockage configuré, les fichiers ne peuvent pas être effacés : rien n'est purgé.
    if (!this.vault.available) {
      return 0;
    }
    const untouchedSince = new Date(now.getTime() - KYC_DRAFT_RETENTION_DAYS * DAY_MS);
    const candidates = await this.cases.findStaleDrafts(
      this.prisma,
      untouchedSince,
      KYC_DRAFT_PURGE_BATCH_SIZE,
    );

    let purged = 0;
    let failed = 0;
    for (const caseId of candidates) {
      try {
        // Un dossier par transaction : celui qui ne peut pas être effacé ne bloque pas les autres.
        const files = await this.unitOfWork.run(async (tx) => {
          // Relu sous verrou : le titulaire a pu le reprendre ou le déposer entre-temps.
          const locked = await this.cases.lockCase(tx, caseId);
          if (locked?.status !== 'DRAFT' || locked.updatedAt >= untouchedSince) {
            return null;
          }
          const removed = await this.cases.deleteDraft(tx, caseId);
          if (removed === null) {
            return null;
          }
          await this.audit.record(tx, {
            actor: { type: 'SYSTEM' },
            action: 'kyc_case.draft_purged',
            resource: { type: 'kyc_case', id: caseId },
            outcome: 'SUCCESS',
            metadata: {
              userId: locked.userId,
              reason: 'NEVER_SUBMITTED',
              documents: removed.length,
              untouchedSince: locked.updatedAt.toISOString(),
            },
          });
          return removed;
        });
        if (files === null) {
          continue;
        }
        purged += 1;
        for (const storageKey of files) {
          try {
            await this.vault.removeDocument(storageKey);
          } catch (error) {
            // La clé du fichier a disparu avec le dossier : il est illisible, mais encombre.
            this.logger.warn({ err: error, storageKey }, 'Verification document file not removed');
          }
        }
      } catch (error) {
        failed += 1;
        this.logger.error({ err: error, caseId }, 'Stale verification draft not purged');
      }
    }
    if (failed > 0) {
      throw new Error(
        `${String(failed)} stale verification draft(s) could not be purged (${String(purged)} purged).`,
      );
    }
    return purged;
  }
}
