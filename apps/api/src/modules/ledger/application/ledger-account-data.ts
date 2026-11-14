import { type AccountClosureBlocker, FINANCIAL_RECORDS_RETENTION_YEARS } from '@mgx/contracts';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type AccountDataHolder,
  AccountDataRegistry,
  type AfterClosure,
  type ExportedSections,
} from '../../identity/application/account-data.registry.js';
import { addYearsUtc } from '../../identity/domain/account-closure.js';
import { LedgerRepository } from './ledger.repository.js';
import { WalletService } from './wallet.service.js';

/**
 * Ce que le grand livre fait des comptes d'un titulaire qui se clôt.
 *
 *  - Un compte **ne se clôt pas tant qu'il détient des fonds** : ils sont d'abord retirés ou
 *    transférés. La base de données le refuse elle aussi.
 *  - **Rien n'est effacé, jamais** : une écriture a toujours deux côtés, et l'effacer
 *    déséquilibrerait le grand livre. Les comptes et leurs lignes restent, rattachés à une
 *    ligne de compte qui ne porte plus aucun identifiant.
 *  - Dès lors qu'une écriture a été passée sur un de ses comptes, la trace de la clôture garde
 *    l'adresse et le numéro du titulaire `FINANCIAL_RECORDS_RETENTION_YEARS` ans : c'est ce qui
 *    permet, pendant ce temps, de rattacher une opération à une personne.
 */
@Injectable()
export class LedgerAccountData implements AccountDataHolder, OnModuleInit {
  readonly name = 'ledger';

  constructor(
    private readonly ledger: LedgerRepository,
    private readonly wallets: WalletService,
    private readonly registry: AccountDataRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async closureBlockers(db: DbClient, userId: string): Promise<readonly AccountClosureBlocker[]> {
    const accounts = await this.ledger.accountsOfUser(db, userId);
    return accounts.some(({ balance }) => balance !== 0n) ? ['FUNDS_REMAINING'] : [];
  }

  /**
   * Rien à verrouiller. Une ligne ne passe sur un compte du titulaire qu'en tenant un verrou
   * sur le titulaire lui-même, que la clôture exclut : une fois le compte verrouillé par la
   * clôture, ses soldes ne bougent plus — toute écriture en cours s'est achevée, toute écriture
   * à venir attend, puis est refusée.
   */
  lockForClosure(): Promise<void> {
    return Promise.resolve();
  }

  async legalRetentionUntil(tx: DbClient, userId: string, closedAt: Date): Promise<Date | null> {
    const accounts = await this.ledger.accountsOfUser(tx, userId);
    return accounts.some(({ postingCount }) => postingCount > 0n)
      ? addYearsUtc(closedAt, FINANCIAL_RECORDS_RETENTION_YEARS)
      : null;
  }

  /** Rien à clore : les comptes sont vides, et le restent — la base refuse toute ligne. */
  closeAccount(): Promise<AfterClosure | null> {
    return Promise.resolve(null);
  }

  /** Rien à effacer : le grand livre ne s'efface pas. */
  eraseRetained(): Promise<void> {
    return Promise.resolve();
  }

  async exportData(db: DbClient, userId: string): Promise<ExportedSections> {
    return { wallets: await this.wallets.exportOf(db, userId) };
  }
}
