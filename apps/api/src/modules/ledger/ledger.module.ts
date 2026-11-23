import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SystemSettingsModule } from '../system-settings/system-settings.module.js';
import { LedgerAccountData } from './application/ledger-account-data.js';
import { LedgerAdministrationService } from './application/ledger-administration.service.js';
import { LedgerCheckRegistry } from './application/ledger-check.registry.js';
import { LedgerReader } from './application/ledger-reader.js';
import { LedgerVerification } from './application/ledger-verification.js';
import { LedgerRepository } from './application/ledger.repository.js';
import { LedgerService } from './application/ledger.service.js';
import { WalletFreezeRepository } from './application/wallet-freeze.repository.js';
import { WalletFreezeService } from './application/wallet-freeze.service.js';
import { WalletService } from './application/wallet.service.js';
import { PrismaLedgerRepository } from './infrastructure/prisma-ledger.repository.js';
import { PrismaWalletFreezeRepository } from './infrastructure/prisma-wallet-freeze.repository.js';
import { AdminLedgerController } from './presentation/admin-ledger.controller.js';
import { AdminWalletFreezesController } from './presentation/admin-wallet-freezes.controller.js';
import { WalletController } from './presentation/wallet.controller.js';

/**
 * Grand livre en partie double : actifs, comptes, écritures — et gel des portefeuilles.
 *
 * C'est le socle des opérations financières — et lui seul : **aucune de ses routes ne déplace
 * de fonds**. Le module expose aux modules qui portent ces opérations `LedgerService`, par qui
 * passe toute écriture, `LedgerReader`, pour ce qu'elles lisent avant d'écrire, et
 * `LedgerCheckRegistry`, où chacun inscrit le contrôle de ses propres écritures ; il offre au
 * titulaire la lecture de ses portefeuilles, et au back-office celle des comptes, des écritures
 * et de la balance, l'enregistrement des actifs, et le gel d'un portefeuille — qui arrête toute
 * écriture sur lui, quelle que soit l'opération.
 *
 * Il s'appuie sur l'identité (comptes, clôture, copie des données, maintenance périodique) ;
 * l'identité ne dépend pas de lui. Les règles du grand livre sont imposées par la base de
 * données elle-même (voir la migration `ledger`).
 */
@Module({
  imports: [AuditModule, SystemSettingsModule, IdentityModule],
  controllers: [WalletController, AdminLedgerController, AdminWalletFreezesController],
  providers: [
    { provide: LedgerRepository, useClass: PrismaLedgerRepository },
    { provide: WalletFreezeRepository, useClass: PrismaWalletFreezeRepository },
    LedgerService,
    LedgerReader,
    WalletService,
    WalletFreezeService,
    LedgerAdministrationService,
    LedgerCheckRegistry,
    LedgerVerification,
    LedgerAccountData,
  ],
  exports: [LedgerService, LedgerReader, LedgerCheckRegistry],
})
export class LedgerModule {}
