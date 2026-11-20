import { Module } from '@nestjs/common';

import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SystemSettingsModule } from '../system-settings/system-settings.module.js';
import { TransferAccountData } from './application/transfer-account-data.js';
import { TransferLimitsService } from './application/transfer-limits.service.js';
import { TransferNoticeDispatcher } from './application/transfer-notice.dispatcher.js';
import { TransferRepository } from './application/transfer.repository.js';
import { TransferService } from './application/transfer.service.js';
import { PrismaTransferRepository } from './infrastructure/prisma-transfer.repository.js';
import { AdminTransferLimitsController } from './presentation/admin-transfer-limits.controller.js';
import { TransferController } from './presentation/transfer.controller.js';

/**
 * Transferts entre titulaires : la première opération qui déplace des fonds.
 *
 * Un transfert est immédiat et définitif. Il passe par le grand livre — et par lui seul — pour
 * modifier les soldes ; il exige la preuve du titulaire et une clé d'idempotence ; il respecte
 * les plafonds du niveau de vérification de l'émetteur, que le back-office fixe actif par
 * actif. La fonctionnalité est fermée par défaut (`internalTransfers`), et rien ne part tant
 * qu'aucun plafond n'est fixé.
 *
 * Le module s'appuie sur le grand livre (écritures, actifs, soldes) et sur l'identité (comptes,
 * preuve du titulaire, clôture, copie des données) ; ni l'un ni l'autre ne dépend de lui. Les
 * règles essentielles sont aussi imposées par la base (voir la migration `internal_transfers`).
 */
@Module({
  imports: [
    AuditModule,
    OutboxModule,
    RateLimitModule,
    SystemSettingsModule,
    NotificationsModule,
    IdentityModule,
    LedgerModule,
  ],
  controllers: [TransferController, AdminTransferLimitsController],
  providers: [
    { provide: TransferRepository, useClass: PrismaTransferRepository },
    TransferService,
    TransferLimitsService,
    TransferNoticeDispatcher,
    TransferAccountData,
  ],
})
export class TransfersModule {}
