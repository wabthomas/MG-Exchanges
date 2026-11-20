import { Injectable, type OnModuleInit } from '@nestjs/common';

import {
  type MaintenanceStep,
  MaintenanceStepRegistry,
} from '../../identity/application/maintenance-step.registry.js';
import { AdjustmentService } from './adjustment.service.js';

/**
 * Clôt les demandes d'ajustement restées sans décision jusqu'à leur échéance. Le service le
 * fait déjà avant chaque lecture et chaque décision ; cette étape de la maintenance périodique
 * le fait aussi quand personne ne consulte les demandes.
 */
@Injectable()
export class AdjustmentExpiry implements MaintenanceStep, OnModuleInit {
  readonly name = 'expire-ledger-adjustments';

  constructor(
    private readonly adjustments: AdjustmentService,
    private readonly registry: MaintenanceStepRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  run(): Promise<number> {
    return this.adjustments.closeOverdue();
  }
}
