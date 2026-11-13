import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { type AccountData, AccountDataReader } from '../application/account-data.reader.js';

@Injectable()
export class PrismaAccountDataReader extends AccountDataReader {
  async read(db: DbClient, userId: string): Promise<AccountData | null> {
    // Des lectures simples, l'une après l'autre : elles peuvent s'exécuter dans une transaction.
    const account = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        phone: true,
        phoneVerifiedAt: true,
        countryCode: true,
        locale: true,
        accountType: true,
        status: true,
        createdAt: true,
        termsAcceptedAt: true,
      },
    });
    if (account === null) {
      return null;
    }
    const roles = await db.userRole.findMany({
      where: { userId },
      select: { role: { select: { key: true } } },
    });
    const profile = await db.userProfile.findUnique({
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
    // Du secret, seule la date de son dernier changement : jamais l'empreinte.
    const credential = await db.userCredential.findUnique({
      where: { userId },
      select: { passwordChangedAt: true },
    });
    const totp = await db.userTotpCredential.findUnique({
      where: { userId },
      select: { confirmedAt: true },
    });
    const recoveryCodesRemaining = await db.userRecoveryCode.count({
      where: { userId, usedAt: null },
    });
    const sessions = await db.userSession.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
        deviceName: true,
      },
    });

    const secondFactorEnabledAt = totp?.confirmedAt ?? null;
    return {
      account: { ...account, roles: roles.map(({ role }) => role.key).sort() },
      profile,
      security: {
        passwordChangedAt: credential?.passwordChangedAt ?? null,
        secondFactorEnabledAt,
        recoveryCodesRemaining: secondFactorEnabledAt === null ? 0 : recoveryCodesRemaining,
      },
      sessions,
    };
  }
}
