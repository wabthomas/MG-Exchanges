import type { AccountClosureBlocker } from '@mgx/contracts';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type AccountDataHolder,
  AccountDataRegistry,
  type AfterClosure,
  type ExportedSections,
} from '../../identity/application/account-data.registry.js';
import { TransferService } from './transfer.service.js';

/**
 * Ce que deviennent les transferts d'un titulaire qui se clôt.
 *
 *  - **Rien ne s'oppose à la clôture** de leur fait : ce sont les fonds restants qui la
 *    retiennent, et c'est le grand livre qui le dit.
 *  - **Rien n'est effacé** : un transfert est la trace d'une écriture, qui ne s'efface pas. Il
 *    ne porte que des identifiants de compte — l'adresse de l'autre partie est lue au moment
 *    de l'afficher, et un compte clôturé n'en a plus.
 *  - La durée pendant laquelle la trace de la clôture garde l'adresse du titulaire est celle
 *    que fixe le grand livre dès qu'une écriture a été passée sur ses comptes : un transfert en
 *    passe toujours une.
 */
@Injectable()
export class TransferAccountData implements AccountDataHolder, OnModuleInit {
  readonly name = 'transfers';

  constructor(
    private readonly transfers: TransferService,
    private readonly registry: AccountDataRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  closureBlockers(): Promise<readonly AccountClosureBlocker[]> {
    return Promise.resolve([]);
  }

  /**
   * Rien à verrouiller. Un transfert en cours tient le compte de son émetteur, que la clôture
   * verrouille à son tour : elle l'attend, puis voit les fonds qu'il a laissés.
   */
  lockForClosure(): Promise<void> {
    return Promise.resolve();
  }

  /** Voir le grand livre, qui fixe la durée dès qu'une écriture existe. */
  legalRetentionUntil(): Promise<Date | null> {
    return Promise.resolve(null);
  }

  /** Rien à clore : un transfert est immédiat, aucun n'est jamais en attente. */
  closeAccount(): Promise<AfterClosure | null> {
    return Promise.resolve(null);
  }

  /** Rien à effacer : un transfert ne s'efface pas, et ne porte aucune adresse. */
  eraseRetained(): Promise<void> {
    return Promise.resolve();
  }

  async exportData(db: DbClient, userId: string): Promise<ExportedSections> {
    return { transfers: await this.transfers.exportOf(db, userId) };
  }
}
