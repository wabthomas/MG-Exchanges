import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { LedgerAnomaly } from './ledger.repository.js';

/**
 * Contrôle apporté à la vérification du grand livre par un module qui y passe des écritures :
 * il relit **toutes** ses opérations et leurs écritures, et relève ce que ses propres règles en
 * base refusent à l'écriture — une opération sans l'écriture qui lui correspond, une écriture
 * de l'un de ses types sans son opération.
 */
export interface LedgerCheck {
  /** Nom du contrôle, tel qu'il apparaît dans les journaux. */
  readonly name: string;
  /**
   * Rend au plus `limit` anomalies, en une seule instruction : une opération et son écriture
   * sont validées ensemble, et se lisent donc ensemble. Les sujets sont des identifiants,
   * jamais des montants.
   */
  findAnomalies(db: DbClient, limit: number): Promise<LedgerAnomaly[]>;
}

/**
 * Registre des contrôles des autres modules, alimenté au démarrage. La vérification périodique
 * du grand livre (`verify-ledger`) les exécute après les siens : le grand livre relit ainsi le
 * lien de chaque écriture à son opération sans connaître aucune opération. **Tout module à
 * venir qui passe des écritures d'un type nouveau doit s'y inscrire** — un test l'exige.
 */
@Injectable()
export class LedgerCheckRegistry {
  private readonly registered: LedgerCheck[] = [];

  register(check: LedgerCheck): void {
    if (this.registered.some((existing) => existing.name === check.name)) {
      throw new Error(`Ledger check "${check.name}" is already registered.`);
    }
    this.registered.push(check);
  }

  checks(): readonly LedgerCheck[] {
    return this.registered;
  }
}
