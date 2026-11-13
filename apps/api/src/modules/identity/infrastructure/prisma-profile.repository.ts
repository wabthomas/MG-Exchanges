import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type ProfileFields,
  type ProfileRecord,
  ProfileRepository,
} from '../application/profile.repository.js';

@Injectable()
export class PrismaProfileRepository extends ProfileRepository {
  find(db: DbClient, userId: string): Promise<ProfileRecord | null> {
    return db.userProfile.findUnique({
      where: { userId },
      select: {
        givenName: true,
        familyName: true,
        additionalName: true,
        dateOfBirth: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        timeZone: true,
        updatedAt: true,
      },
    });
  }

  async save(tx: DbClient, userId: string, changes: Partial<ProfileFields>): Promise<void> {
    await tx.userProfile.upsert({
      where: { userId },
      create: { userId, ...changes },
      update: changes,
    });
  }
}
