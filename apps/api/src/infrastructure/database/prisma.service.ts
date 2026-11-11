import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { AppConfig } from '../../config/app-config.js';
import { type Prisma, PrismaClient } from '../../generated/prisma/client.js';

/**
 * Client de base de données utilisable indifféremment hors transaction ({@link PrismaService})
 * ou à l'intérieur d'une transaction (client fourni par {@link UnitOfWork}).
 */
export type DbClient = Prisma.TransactionClient;

/** Connexion PostgreSQL de l'application (pool `pg`, client Prisma généré). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.database.url,
        max: config.database.poolMax,
        connectionTimeoutMillis: config.database.connectionTimeoutMs,
        // Aucune requête ne peut monopoliser une connexion indéfiniment.
        statement_timeout: config.database.statementTimeoutMs,
        application_name: config.app.name,
      }),
    });
  }

  /** Échec immédiat au démarrage si la base est injoignable ou mal configurée. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
