import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SystemSettingsModule } from '../system-settings/system-settings.module.js';
import { LedgerAccountData } from './application/ledger-account-data.js';
import { LedgerAdministrationService } from './application/ledger-administration.service.js';
import { LedgerVerification } from './application/ledger-verification.js';
import { LedgerRepository } from './application/ledger.repository.js';
import { LedgerService } from './application/ledger.service.js';
import { WalletService } from './application/wallet.service.js';
import { PrismaLedgerRepository } from './infrastructure/prisma-ledger.repository.js';
import { AdminLedgerController } from './presentation/admin-ledger.controller.js';
import { WalletController } from './presentation/wallet.controller.js';

/**
 * Grand livre en partie double : actifs, comptes, écritures.
 *
 * C'est le socle des opérations financières à venir — et lui seul : **aucune route ne déplace
 * de fonds**. Le module expose `LedgerService` aux modules qui porteront ces opérations ; il
 * offre au titulaire la lecture de ses portefeuilles, et au back-office celle des comptes, des
 * écritures et de la balance, ainsi que l'enregistrement des actifs.
 *
 * Il s'appuie sur l'identité (comptes, clôture, copie des données, maintenance périodique) ;
 * l'identité ne dépend pas de lui. Les règles du grand livre sont imposées par la base de
 * données elle-même (voir la migration `ledger`).
 */
@Module({
  imports: [AuditModule, SystemSettingsModule, IdentityModule],
  controllers: [WalletController, AdminLedgerController],
  providers: [
    { provide: LedgerRepository, useClass: PrismaLedgerRepository },
    LedgerService,
    WalletService,
    LedgerAdministrationService,
    LedgerVerification,
    LedgerAccountData,
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
