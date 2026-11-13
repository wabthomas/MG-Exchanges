import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { type DbClient, PrismaService } from './prisma.service.js';

export interface TransactionOptions {
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Durée maximale de la transaction, en millisecondes. */
  readonly timeoutMs?: number;
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

  run<T>(work: (tx: DbClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return this.prisma.$transaction(work, {
      ...(options.isolationLevel === undefined ? {} : { isolationLevel: options.isolationLevel }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  }
}
