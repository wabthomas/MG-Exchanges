import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type LedgerCheck,
  LedgerCheckRegistry,
} from '../../ledger/application/ledger-check.registry.js';
import type { LedgerAnomaly } from '../../ledger/application/ledger.repository.js';
import { AdjustmentRepository } from './adjustment.repository.js';

/**
 * Ce que les ajustements apportent à la vérification périodique du grand livre : chaque
 * ajustement approuvé a l'écriture qui lui correspond, et chaque écriture d'ajustement a son
 * ajustement approuvé.
 *
 * La base le garantit à l'écriture (migration `staff_ledger_operations`) ; ce contrôle le relit
 * après coup. Un ajustement est la seule opération qui fait entrer des fonds dans un
 * portefeuille : une écriture de ce type sans son ajustement serait un crédit que personne n'a
 * demandé ni approuvé.
 *
 * N'est pas relu ce qui dépendait du moment : les permissions de celui qui a demandé et de
 * celui qui a approuvé, à l'heure de la décision.
 */
@Injectable()
export class AdjustmentLedgerCheck implements LedgerCheck, OnModuleInit {
  readonly name = 'adjustments';

  constructor(
    private readonly adjustments: AdjustmentRepository,
    private readonly registry: LedgerCheckRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  findAnomalies(db: DbClient, limit: number): Promise<LedgerAnomaly[]> {
    return this.adjustments.findEntryAnomalies(db, limit);
  }
}
