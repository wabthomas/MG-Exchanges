import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditService } from '../../audit/application/audit.service.js';
import {
  type MaintenanceStep,
  MaintenanceStepRegistry,
} from '../../identity/application/maintenance-step.registry.js';
import { type LedgerCheck, LedgerCheckRegistry } from './ledger-check.registry.js';
import { type LedgerAnomaly, LedgerRepository } from './ledger.repository.js';

/** Nombre maximal d'anomalies rapportées par passage : au-delà, il suffit de savoir qu'il y en a. */
export const LEDGER_VERIFICATION_MAX_ANOMALIES = 50;

/** Nom, dans les journaux, du contrôle des règles du grand livre lui-même. */
export const LEDGER_OWN_CHECK = 'ledger';

const failedChecksText = (failedChecks: readonly string[]): string =>
  `${String(failedChecks.length)} check(s) failed (${failedChecks.join(', ')}).`;

/** Le grand livre n'est pas tel que ses règles le garantissent. */
export class LedgerVerificationError extends Error {
  constructor(
    readonly anomalies: readonly LedgerAnomaly[],
    /**
     * Contrôles qui n'ont pas pu s'exécuter : la liste des anomalies ne dit rien de ce qu'ils
     * relisent.
     */
    readonly failedChecks: readonly string[] = [],
  ) {
    super(
      `The ledger failed its verification: ${String(anomalies.length)} anomaly(ies) found` +
        (anomalies.length >= LEDGER_VERIFICATION_MAX_ANOMALIES ? ' (list truncated).' : '.') +
        (failedChecks.length > 0 ? ` ${failedChecksText(failedChecks)}` : ''),
    );
    this.name = 'LedgerVerificationError';
  }
}

/**
 * Un contrôle au moins n'a pas pu s'exécuter, et les autres n'ont rien relevé : le grand livre
 * n'a pas été vérifié en entier.
 */
export class LedgerVerificationIncompleteError extends Error {
  constructor(readonly failedChecks: readonly string[]) {
    super(`The ledger could not be verified entirely: ${failedChecksText(failedChecks)}`);
    this.name = 'LedgerVerificationIncompleteError';
  }
}

/**
 * Relit **tout** le grand livre et vérifie ce que la base garantit à chaque écriture :
 *  - le solde de chaque compte est celui de sa dernière ligne ;
 *  - sur chaque compte, les lignes se suivent sans trou et chaque solde découle du précédent ;
 *  - chaque ligne est dans l'actif de son compte ;
 *  - chaque écriture a toutes ses lignes et s'équilibre, actif par actif ;
 *  - dans chaque actif, les soldes qui augmentent au débit égalent ceux qui augmentent au crédit ;
 *  - chaque écriture est d'un type que la base connaît ;
 *  - chaque opération a l'écriture qui lui correspond, et chaque écriture d'un type réservé à
 *    une opération a la sienne : ce sont les contrôles des modules qui passent des écritures
 *    (`LedgerCheckRegistry`), exécutés après ceux du grand livre.
 *
 * Aucune écriture normale ne peut enfreindre ces règles : une anomalie signale une altération
 * faite hors de l'application, une écriture antérieure à l'une de ces règles — ou un défaut de
 * ces règles elles-mêmes. Elle est journalisée, inscrite au journal d'audit, et fait échouer
 * l'étape, à chaque passage tant qu'elle demeure ; rien n'est corrigé automatiquement.
 *
 * Chaque contrôle est une instruction, soumise au délai d'exécution des requêtes. Un contrôle
 * qui échoue est journalisé et n'empêche pas les autres : ce qu'ils relèvent est signalé comme
 * d'habitude — avec le nom de celui qui a manqué — et l'étape échoue dans tous les cas.
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
    private readonly checks: LedgerCheckRegistry,
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
   * @throws LedgerVerificationIncompleteError si rien n'a été relevé, mais qu'un contrôle n'a
   *   pas pu s'exécuter.
   */
  async run(): Promise<number> {
    const { anomalies, failedChecks } = await this.inspect();
    if (anomalies.length > 0) {
      // Une trace ne dit pas plus que ce qui a été relu : elle nomme les contrôles qui ont manqué.
      const incomplete = failedChecks.length > 0 ? { failedChecks } : {};
      this.logger.error({ anomalies, ...incomplete }, 'Ledger verification failed');
      await this.audit.record(this.prisma, {
        actor: { type: 'SYSTEM' },
        action: 'ledger.verification_failed',
        resource: { type: 'ledger' },
        outcome: 'FAILURE',
        metadata: {
          anomalies: anomalies.map(({ kind, subject }) => ({ kind, subject })),
          truncated: anomalies.length >= LEDGER_VERIFICATION_MAX_ANOMALIES,
          ...incomplete,
        },
      });
      throw new LedgerVerificationError(anomalies, failedChecks);
    }
    if (failedChecks.length > 0) {
      throw new LedgerVerificationIncompleteError(failedChecks);
    }
    const { entries } = await this.ledger.counts(this.prisma);
    return entries;
  }

  /**
   * Exécute les contrôles du grand livre, puis ceux des modules inscrits, tant que le nombre
   * maximal d'anomalies n'est pas atteint : chacun n'est interrogé que sur ce qu'il en reste.
   */
  private async inspect(): Promise<{ anomalies: LedgerAnomaly[]; failedChecks: string[] }> {
    const own: LedgerCheck = {
      name: LEDGER_OWN_CHECK,
      findAnomalies: (db, limit) => this.ledger.findAnomalies(db, limit),
    };
    const anomalies: LedgerAnomaly[] = [];
    const failedChecks: string[] = [];
    for (const check of [own, ...this.checks.checks()]) {
      const remaining = LEDGER_VERIFICATION_MAX_ANOMALIES - anomalies.length;
      if (remaining <= 0) {
        break;
      }
      try {
        const found = await check.findAnomalies(this.prisma, remaining);
        // Un contrôle ne rend pas plus qu'on ne lui demande ; la liste n'en dépend pas.
        anomalies.push(...found.slice(0, remaining));
      } catch (error) {
        failedChecks.push(check.name);
        this.logger.error({ err: error, check: check.name }, 'Ledger verification check failed');
      }
    }
    return { anomalies, failedChecks };
  }
}
