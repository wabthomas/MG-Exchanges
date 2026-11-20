import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditService } from '../../audit/application/audit.service.js';
import {
  type MaintenanceStep,
  MaintenanceStepRegistry,
} from '../../identity/application/maintenance-step.registry.js';
import { type LedgerAnomaly, LedgerRepository } from './ledger.repository.js';

/** Nombre maximal d'anomalies rapportées par passage : au-delà, il suffit de savoir qu'il y en a. */
export const LEDGER_VERIFICATION_MAX_ANOMALIES = 50;

/** Le grand livre n'est pas tel que ses règles le garantissent. */
export class LedgerVerificationError extends Error {
  constructor(readonly anomalies: readonly LedgerAnomaly[]) {
    super(
      `The ledger failed its verification: ${String(anomalies.length)} anomaly(ies) found` +
        (anomalies.length >= LEDGER_VERIFICATION_MAX_ANOMALIES ? ' (list truncated).' : '.'),
    );
    this.name = 'LedgerVerificationError';
  }
}

/**
 * Relit **tout** le grand livre et vérifie ce que la base garantit à chaque écriture :
 *  - le solde de chaque compte est celui de sa dernière ligne ;
 *  - sur chaque compte, les lignes se suivent sans trou et chaque solde découle du précédent ;
 *  - chaque ligne est dans l'actif de son compte ;
 *  - chaque écriture a toutes ses lignes et s'équilibre, actif par actif ;
 *  - dans chaque actif, les soldes qui augmentent au débit égalent ceux qui augmentent au crédit.
 *
 * Aucune écriture normale ne peut enfreindre ces règles : une anomalie signale une altération
 * faite hors de l'application — ou un défaut de ces règles elles-mêmes. Elle est journalisée,
 * inscrite au journal d'audit, et fait échouer l'étape ; rien n'est corrigé automatiquement.
 *
 * Étape de la maintenance périodique (même cadence, mêmes journaux). Les messages ne
 * contiennent que des identifiants, jamais de montant.
 */
@Injectable()
export class LedgerVerification implements MaintenanceStep, OnModuleInit {
  readonly name = 'verify-ledger';

  constructor(
    private readonly ledger: LedgerRepository,
    private readonly registry: MaintenanceStepRegistry,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LedgerVerification.name);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * @returns le nombre d'écritures vérifiées.
   * @throws LedgerVerificationError si le grand livre présente une anomalie.
   */
  async run(): Promise<number> {
    const anomalies = await this.ledger.findAnomalies(
      this.prisma,
      LEDGER_VERIFICATION_MAX_ANOMALIES,
    );
    if (anomalies.length > 0) {
      this.logger.error({ anomalies }, 'Ledger verification failed');
      await this.audit.record(this.prisma, {
        actor: { type: 'SYSTEM' },
        action: 'ledger.verification_failed',
        resource: { type: 'ledger' },
        outcome: 'FAILURE',
        metadata: {
          anomalies: anomalies.map(({ kind, subject }) => ({ kind, subject })),
          truncated: anomalies.length >= LEDGER_VERIFICATION_MAX_ANOMALIES,
        },
      });
      throw new LedgerVerificationError(anomalies);
    }
    const { entries } = await this.ledger.counts(this.prisma);
    return entries;
  }
}
