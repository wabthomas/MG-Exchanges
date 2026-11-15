import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SystemSettingsModule } from '../system-settings/system-settings.module.js';
import { AdjustmentExpiry } from './application/adjustment-expiry.js';
import { AdjustmentNoticeDispatcher } from './application/adjustment-notice.dispatcher.js';
import { AdjustmentRepository } from './application/adjustment.repository.js';
import { AdjustmentService } from './application/adjustment.service.js';
import { PrismaAdjustmentRepository } from './infrastructure/prisma-adjustment.repository.js';
import { AdminAdjustmentsController } from './presentation/admin-adjustments.controller.js';

/**
 * Ajustements manuels des portefeuilles par le personnel : crédit et débit, sous double
 * validation. C'est la première opération qui fait entrer des fonds dans un portefeuille —
 * constatés hors de l'API —, et le moyen d'en faire sortir d'un compte suspendu, d'un
 * portefeuille gelé ou d'un compte à clôturer.
 *
 * Un ajustement passe par le grand livre — et par lui seul — pour modifier un solde ; il exige
 * deux personnes distinctes, dont aucune n'est le titulaire, et la preuve de celle qui
 * approuve. La fonctionnalité est fermée par défaut (`manualAdjustments`).
 *
 * Le module s'appuie sur le grand livre (écritures, actifs, soldes) et sur l'identité (comptes,
 * preuve du titulaire, maintenance périodique) ; ni l'un ni l'autre ne dépend de lui. Les
 * règles essentielles sont aussi imposées par la base (voir la migration
 * `staff_ledger_operations`).
 */
@Module({
  imports: [
    AuditModule,
    OutboxModule,
    SystemSettingsModule,
    NotificationsModule,
    IdentityModule,
    LedgerModule,
  ],
  controllers: [AdminAdjustmentsController],
  providers: [
    { provide: AdjustmentRepository, useClass: PrismaAdjustmentRepository },
    AdjustmentService,
    AdjustmentNoticeDispatcher,
    AdjustmentExpiry,
  ],
})
export class AdjustmentsModule {}
