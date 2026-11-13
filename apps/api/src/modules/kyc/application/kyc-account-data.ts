import {
  type AccountClosureBlocker,
  type AccountClosureOrigin,
  VERIFICATION_RECORDS_RETENTION_YEARS,
} from '@mgx/contracts';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import {
  type AccountDataHolder,
  AccountDataRegistry,
  type AfterClosure,
  type ExportedSections,
} from '../../identity/application/account-data.registry.js';
import { VerificationStatusReader } from '../../identity/application/verification-status.reader.js';
import { addYearsUtc } from '../../identity/domain/account-closure.js';
import { KycCaseRepository } from './kyc-case.repository.js';
import { KycVault } from './kyc-vault.js';
import { caseViewOf } from './kyc-views.js';

/**
 * Ce que la vérification d'identité fait des dossiers d'un compte qui se clôt, puis s'efface.
 *
 *  - Un dossier **jamais examiné** — en préparation, ou déposé sans qu'une décision ait été
 *    prise — est effacé à la clôture, avec ses pièces : rien n'impose de le garder. Le
 *    personnel, lui, ne clôt pas un compte dont un dossier attend l'examen : il décide d'abord.
 *  - Un dossier **sur lequel une décision a été prise** (accepté, refusé, remplacé, retiré) est
 *    conservé `VERIFICATION_RECORDS_RETENTION_YEARS` ans après la clôture, puis effacé. La base
 *    de données refuse tout effacement avant ce terme.
 *  - Une vérification en vigueur prend fin avec le compte : la pièce d'identité qu'elle
 *    retenait peut de nouveau vérifier un compte.
 */
@Injectable()
export class KycAccountData implements AccountDataHolder, OnModuleInit {
  readonly name = 'kyc';

  constructor(
    private readonly cases: KycCaseRepository,
    private readonly vault: KycVault,
    private readonly verification: VerificationStatusReader,
    private readonly registry: AccountDataRegistry,
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycAccountData.name);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async closureBlockers(
    db: DbClient,
    userId: string,
    origin: AccountClosureOrigin,
  ): Promise<readonly AccountClosureBlocker[]> {
    if (origin === 'STAFF' && (await this.cases.hasCaseAwaitingReview(db, userId))) {
      return ['VERIFICATION_PENDING_REVIEW'];
    }
    return [];
  }

  lockForClosure(tx: DbClient, userId: string): Promise<void> {
    return this.cases.lockCasesOf(tx, userId);
  }

  async legalRetentionUntil(tx: DbClient, userId: string, closedAt: Date): Promise<Date | null> {
    return (await this.cases.hasDecidedCase(tx, userId))
      ? addYearsUtc(closedAt, VERIFICATION_RECORDS_RETENTION_YEARS)
      : null;
  }

  async closeAccount(tx: DbClient, userId: string, closedAt: Date): Promise<AfterClosure | null> {
    const files = await this.cases.closeForAccount(tx, userId, closedAt);
    return files.length === 0 ? null : () => this.removeFiles(files);
  }

  async eraseRetained(userId: string): Promise<void> {
    const files = await this.unitOfWork.run(async (tx) => {
      // Sans stockage configuré, les fichiers ne pourraient pas être effacés : rien ne l'est.
      if (!this.vault.available && (await this.cases.documentFilesOf(tx, userId)).length > 0) {
        throw new Error('Verification documents cannot be erased: storage is not configured.');
      }
      return this.cases.eraseAllOf(tx, userId);
    });
    await this.removeFiles(files);
  }

  async exportData(db: DbClient, userId: string): Promise<ExportedSections> {
    const level = await this.verification.level(db, userId);
    const cases = await this.cases.allCasesOf(db, userId);
    return {
      verification: {
        level,
        cases: cases.map((record) =>
          caseViewOf(
            record,
            record.identity === null
              ? null
              : this.vault.decryptDocumentNumber(
                  record.userId,
                  record.identity.documentNumberEncrypted,
                ),
          ),
        ),
      },
    };
  }

  /**
   * Efface les fichiers des pièces dont les lignes viennent de l'être. Un fichier qui résiste
   * est signalé : sa clé a disparu avec sa ligne, il est illisible, mais il encombre.
   */
  private async removeFiles(storageKeys: readonly string[]): Promise<void> {
    if (!this.vault.available) {
      if (storageKeys.length > 0) {
        this.logger.warn(
          { files: storageKeys.length },
          'Verification document files not removed: storage is not configured',
        );
      }
      return;
    }
    for (const storageKey of storageKeys) {
      try {
        await this.vault.removeDocument(storageKey);
      } catch (error) {
        this.logger.warn({ err: error, storageKey }, 'Verification document file not removed');
      }
    }
  }
}
