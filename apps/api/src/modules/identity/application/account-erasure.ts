import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { AccountClosureRepository } from './account-closure.repository.js';
import { AccountDataRegistry } from './account-data.registry.js';
import {
  type MaintenanceStep,
  MaintenanceStepIncompleteError,
  MaintenanceStepRegistry,
} from './maintenance-step.registry.js';

/** Nombre maximal de comptes effacés par passage : le reste attend le passage suivant. */
export const ACCOUNT_ERASURE_BATCH_SIZE = 200;

/**
 * Efface ce qui reste des comptes clôturés dont l'échéance est atteinte : d'abord ce que les
 * autres modules avaient conservé (dossiers de vérification et leurs pièces), puis l'adresse
 * et le numéro que gardait la trace de la clôture. Il n'en reste que cette trace, sans
 * identifiant, et le journal d'audit.
 *
 * L'échéance est lue à l'horloge de l'application ; lorsque la loi impose une conservation,
 * la base de données la relit à la sienne et refuse tout effacement prématuré.
 *
 * Étape de la purge périodique des données d'identité (même cadence, mêmes journaux).
 */
@Injectable()
export class AccountErasure implements MaintenanceStep, OnModuleInit {
  readonly name = 'erase-closed-accounts';

  constructor(
    private readonly closures: AccountClosureRepository,
    private readonly holders: AccountDataRegistry,
    private readonly registry: MaintenanceStepRegistry,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountErasure.name);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<number> {
    const due = await this.closures.findDueForErasure(this.prisma, now, ACCOUNT_ERASURE_BATCH_SIZE);

    let erased = 0;
    let failed = 0;
    for (const closure of due) {
      const { userId } = closure;
      try {
        // Un compte à la fois : celui qui ne peut pas être effacé ne bloque pas les autres.
        for (const holder of this.holders.holders()) {
          await holder.eraseRetained(userId, now);
        }
        const done = await this.unitOfWork.run(async (tx) => {
          if (!(await this.closures.markErased(tx, userId, now))) {
            return false;
          }
          await this.audit.record(tx, {
            actor: { type: 'SYSTEM' },
            action: 'user.data_erased',
            resource: { type: 'user', id: userId },
            outcome: 'SUCCESS',
            metadata: {
              closedAt: closure.closedAt.toISOString(),
              legalRetentionUntil: closure.legalRetentionUntil?.toISOString() ?? null,
              erasureDueAt: closure.erasureDueAt.toISOString(),
            },
          });
          return true;
        });
        erased += done ? 1 : 0;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: error, userId }, 'Closed account not erased');
      }
    }
    if (failed > 0) {
      throw new MaintenanceStepIncompleteError(erased, failed, 'closed account(s)');
    }
    return erased;
  }
}
