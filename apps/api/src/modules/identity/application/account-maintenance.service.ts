import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { Clock } from '../../../common/clock.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { ChallengeRepository } from './challenge.repository.js';
import { MAINTENANCE_BATCH_SIZE, RETENTION } from './identity-policy.js';
import {
  MaintenanceStepIncompleteError,
  MaintenanceStepRegistry,
} from './maintenance-step.registry.js';
import { MfaRepository } from './mfa.repository.js';
import { RoleChangeRepository } from './role-change.repository.js';
import { SessionRepository } from './session.repository.js';
import { UserRepository } from './user.repository.js';

/** Nombre de lignes traitées par catégorie ; `failures` compte les étapes en échec. */
export interface MaintenanceReport {
  readonly unverifiedRegistrations: number;
  readonly endedSessions: number;
  readonly expiredChallenges: number;
  readonly unconfirmedTotpEnrollments: number;
  readonly expiredRoleChanges: number;
  /** Étapes fournies par les autres modules (voir `MaintenanceStepRegistry`), par nom. */
  readonly otherSteps: Readonly<Record<string, number>>;
  readonly failures: number;
}

/**
 * Purge périodique des données d'identité devenues inutiles : inscriptions jamais vérifiées,
 * sessions terminées, codes expirés, enrôlements de second facteur abandonnés, demandes de
 * changement de rôle échues. Les durées de conservation sont dans `RETENTION`.
 *
 * Chaque étape est indépendante : l'échec de l'une n'empêche pas les autres, et le travail
 * d'une exécution est borné — le reliquat est traité à l'exécution suivante. Le journal
 * d'audit n'est jamais purgé.
 */
@Injectable()
export class AccountMaintenanceService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly challenges: ChallengeRepository,
    private readonly mfa: MfaRepository,
    private readonly roleChanges: RoleChangeRepository,
    private readonly otherSteps: MaintenanceStepRegistry,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountMaintenanceService.name);
  }

  async run(): Promise<MaintenanceReport> {
    const now = this.clock.now();
    const before = (retentionMs: number): Date => new Date(now.getTime() - retentionMs);
    let failures = 0;
    const step = async (name: string, work: () => Promise<number>): Promise<number> => {
      try {
        return await work();
      } catch (error) {
        failures += 1;
        this.logger.error({ err: error, step: name }, 'Account maintenance step failed');
        // Ce qu'une étape a traité avant d'échouer sur le reste figure au compte rendu.
        return error instanceof MaintenanceStepIncompleteError ? error.done : 0;
      }
    };

    // Les demandes de rôle d'abord : elles ne dépendent de rien et se closent en une instruction.
    const expiredRoleChanges = await step('expire-role-changes', () =>
      this.roleChanges.expireOverdue(this.prisma, now),
    );
    const unverifiedRegistrations = await step('purge-unverified-registrations', async () => {
      const outcome = await this.purgeUnverifiedRegistrations(
        before(RETENTION.unverifiedRegistrationMs),
      );
      // Les inscriptions purgées le restent ; celles qui n'ont pas pu l'être signalent l'étape.
      failures += outcome.failed > 0 ? 1 : 0;
      return outcome.purged;
    });
    const endedSessions = await step('purge-ended-sessions', () =>
      this.sessions.deleteEnded(
        this.prisma,
        before(RETENTION.endedSessionMs),
        MAINTENANCE_BATCH_SIZE,
      ),
    );
    const expiredChallenges = await step('purge-expired-challenges', () =>
      this.challenges.deleteExpired(this.prisma, before(RETENTION.expiredChallengeMs)),
    );
    const unconfirmedTotpEnrollments = await step('purge-unconfirmed-totp', () =>
      this.mfa.deleteStalePendingTotp(this.prisma, before(RETENTION.unconfirmedTotpMs)),
    );

    const otherSteps: Record<string, number> = {};
    for (const other of this.otherSteps.steps()) {
      otherSteps[other.name] = await step(other.name, () => other.run(now));
    }

    const report: MaintenanceReport = {
      unverifiedRegistrations,
      endedSessions,
      expiredChallenges,
      unconfirmedTotpEnrollments,
      expiredRoleChanges,
      otherSteps,
      failures,
    };
    this.logger.info(report, 'Account maintenance completed');
    return report;
  }

  /**
   * Une inscription par transaction : une ligne qui ne peut pas être supprimée (donnée
   * inattendue rattachée au compte) est signalée sans bloquer les suivantes. Chaque
   * suppression est écrite au journal d'audit.
   */
  private async purgeUnverifiedRegistrations(
    registeredBefore: Date,
  ): Promise<{ readonly purged: number; readonly failed: number }> {
    const candidates = await this.users.findUnverifiedRegistrations(
      this.prisma,
      registeredBefore,
      MAINTENANCE_BATCH_SIZE,
    );
    let purged = 0;
    let failed = 0;
    for (const userId of candidates) {
      try {
        const deleted = await this.unitOfWork.run(async (tx) => {
          if (!(await this.users.deleteUnverifiedRegistration(tx, userId, registeredBefore))) {
            return false;
          }
          await this.audit.record(tx, {
            actor: { type: 'SYSTEM' },
            action: 'user.registration_purged',
            resource: { type: 'user', id: userId },
            outcome: 'SUCCESS',
            metadata: { reason: 'NEVER_VERIFIED' },
          });
          return true;
        });
        purged += deleted ? 1 : 0;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: error, userId }, 'Unverified registration could not be purged');
      }
    }
    return { purged, failed };
  }
}
