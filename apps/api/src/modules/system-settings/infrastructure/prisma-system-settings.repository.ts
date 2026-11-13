import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import {
  type StoredSetting,
  SystemSettingsRepository,
} from '../application/system-settings.repository.js';

const SELECTION = { key: true, value: true, version: true, updatedAt: true } as const;

@Injectable()
export class PrismaSystemSettingsRepository extends SystemSettingsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  findAll(): Promise<StoredSetting[]> {
    return this.prisma.systemSetting.findMany({ select: SELECTION });
  }

  async lockAndFind(tx: DbClient, key: string): Promise<StoredSetting | null> {
    // Verrou consultatif transactionnel : fonctionne aussi lorsque la ligne n'existe pas encore.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`system_setting:${key}`}, 0))`;
    return tx.systemSetting.findUnique({ where: { key }, select: SELECTION });
  }

  save(tx: DbClient, key: string, value: unknown): Promise<StoredSetting> {
    const json = value as Prisma.InputJsonValue;
    return tx.systemSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json, version: { increment: 1 } },
      select: SELECTION,
    });
  }
}
