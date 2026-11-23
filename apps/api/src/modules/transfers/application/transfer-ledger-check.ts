import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type LedgerCheck,
  LedgerCheckRegistry,
} from '../../ledger/application/ledger-check.registry.js';
import type { LedgerAnomaly } from '../../ledger/application/ledger.repository.js';
import { TransferRepository } from './transfer.repository.js';

/**
 * Ce que les transferts apportent à la vérification périodique du grand livre : chaque
 * transfert a l'écriture qui lui correspond, et chaque écriture de transfert a son transfert.
 *
 * La base le garantit à l'écriture (migration `internal_transfers`) ; ce contrôle le relit après
 * coup. Les cumuls qui font respecter les plafonds se calculent sur les transferts : un
 * transfert qui ne dit plus ce que son écriture a déplacé les fausserait.
 *
 * N'est pas relu ce qui dépendait du moment : les plafonds et le niveau de vérification de
 * l'émetteur à l'heure du transfert.
 */
@Injectable()
export class TransferLedgerCheck implements LedgerCheck, OnModuleInit {
  readonly name = 'transfers';

  constructor(
    private readonly transfers: TransferRepository,
    private readonly registry: LedgerCheckRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  findAnomalies(db: DbClient, limit: number): Promise<LedgerAnomaly[]> {
    return this.transfers.findEntryAnomalies(db, limit);
  }
}
