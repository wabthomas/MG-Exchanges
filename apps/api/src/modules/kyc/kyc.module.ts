import { Module, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SystemSettingsModule } from '../system-settings/system-settings.module.js';
import { KycAccountData } from './application/kyc-account-data.js';
import { KycCaseRepository } from './application/kyc-case.repository.js';
import { KycDraftPurge } from './application/kyc-draft-purge.js';
import { KycReviewService } from './application/kyc-review.service.js';
import { KycUploadSlots } from './application/kyc-upload-slots.js';
import { KycVault } from './application/kyc-vault.js';
import { KycService } from './application/kyc.service.js';
import { FilesystemDocumentStorage } from './infrastructure/filesystem-document-storage.js';
import { KycCipher } from './infrastructure/kyc-cipher.js';
import { PrismaKycCaseRepository } from './infrastructure/prisma-kyc-case.repository.js';
import { AdminKycController } from './presentation/admin-kyc.controller.js';
import { KycController } from './presentation/kyc.controller.js';

/**
 * Vérification d'identité (KYC) des particuliers : dossiers par niveau, pièces chiffrées,
 * examen par la conformité.
 *
 * Le module s'appuie sur l'identité (comptes, rôles, purge périodique) ; l'identité ne dépend
 * pas de lui : elle lit ce que les dossiers acceptés établissent, sans rien en écrire. À la
 * clôture d'un compte, c'est ce module qui met fin à ses dossiers, efface ou conserve leurs
 * pièces, puis les efface à l'échéance (`KycAccountData`).
 *
 * Sans `KYC_STORAGE_DIR` ni `KYC_ENCRYPTION_KEY`, le module démarre mais ses opérations
 * répondent `SERVICE_UNAVAILABLE` : aucune pièce n'est jamais conservée en clair.
 */
@Module({
  imports: [AuditModule, OutboxModule, RateLimitModule, SystemSettingsModule, IdentityModule],
  controllers: [KycController, AdminKycController],
  providers: [
    { provide: KycCaseRepository, useClass: PrismaKycCaseRepository },
    {
      provide: KycVault,
      inject: [AppConfig],
      useFactory: (config: AppConfig): KycVault =>
        new KycVault(
          config.kyc === null
            ? null
            : {
                cipher: new KycCipher(config.kyc.encryptionKey),
                storage: new FilesystemDocumentStorage(config.kyc.storageDir),
              },
        ),
    },
    KycService,
    KycReviewService,
    KycDraftPurge,
    KycAccountData,
    KycUploadSlots,
  ],
})
export class KycModule implements OnModuleInit {
  constructor(
    private readonly vault: KycVault,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KycModule.name);
  }

  /**
   * Un stockage configuré mais inutilisable empêche le démarrage, plutôt que chaque envoi. Dans
   * tous les cas, le journal de démarrage dit si la vérification d'identité est utilisable.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.kyc === null) {
      this.logger.info(
        'Identity verification is unavailable: KYC_STORAGE_DIR and KYC_ENCRYPTION_KEY are not set',
      );
      return;
    }
    await this.vault.prepare();
    this.logger.info(
      { storageDir: this.config.kyc.storageDir },
      'Verification document storage is ready',
    );
  }
}
