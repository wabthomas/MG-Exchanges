import { setTimeout as pause } from 'node:timers/promises';

import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { isTransactionConflict } from './database-errors.js';
import { type DbClient, PrismaService } from './prisma.service.js';

/**
 * Nouvelles tentatives d'une transaction que PostgreSQL a annulée parce qu'elle en croisait une
 * autre (conflit de sérialisation, interblocage).
 */
export interface RetryPolicy {
  /**
   * Pause maximale, en millisecondes, avant chaque nouvelle tentative. Leur nombre fixe celui
   * des tentatives supplémentaires ; chaque pause est tirée au hasard entre la moitié et la
   * totalité de la valeur, pour que deux transactions qui se sont croisées ne se recroisent pas.
   */
  readonly delaysMs: readonly number[];
}

/** Trois nouvelles tentatives, de plus en plus espacées : quatre essais au plus. */
export const DEFAULT_CONFLICT_RETRY: RetryPolicy = { delaysMs: [20, 60, 150] };

/**
 * Pause, en millisecondes, avant une nouvelle tentative : de la moitié du délai prévu
 * (`random` = 0) à sa totalité (`random` proche de 1) — `random` est un tirage de
 * `Math.random()`.
 */
export function retryPauseMs(delayMs: number, random: number): number {
  return delayMs / 2 + random * (delayMs / 2);
}

export interface TransactionOptions {
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Durée maximale de la transaction, en millisecondes. */
  readonly timeoutMs?: number;
  /**
   * Relance la transaction **entière** lorsque PostgreSQL l'a annulée parce qu'elle en croisait
   * une autre. `work` est alors exécuté plusieurs fois : il ne doit rien faire d'autre
   * qu'écrire avec le client `tx` qu'il reçoit — ce qu'une transaction annulée défait. Sans
   * cette option, l'erreur est relancée au premier conflit.
   */
  readonly retry?: RetryPolicy;
}

/**
 * Délimite une transaction de base de données.
 *
 * Toutes les écritures effectuées avec le client `tx` reçu par `work` sont validées
 * ensemble, ou annulées ensemble si `work` lève une exception. Les frontières de
 * transaction sont ainsi toujours explicites et visibles dans le code appelant.
 */
@Injectable()
export class UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(work: (tx: DbClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const delays = options.retry?.delaysMs ?? [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          ...(options.isolationLevel === undefined
            ? {}
            : { isolationLevel: options.isolationLevel }),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        });
      } catch (error) {
        const delay = delays[attempt];
        // Tentatives épuisées, ou erreur d'une autre nature : à l'appelant d'en décider.
        if (delay === undefined || !isTransactionConflict(error)) {
          throw error;
        }
        await pause(retryPauseMs(delay, Math.random()));
      }
    }
  }
}
