import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { Digest } from '../application/digest.js';
import { MfaRepository, type TotpCredential } from '../application/mfa.repository.js';

@Injectable()
export class PrismaMfaRepository extends MfaRepository {
  findTotp(db: DbClient, userId: string): Promise<TotpCredential | null> {
    return db.userTotpCredential.findUnique({
      where: { userId },
      select: {
        userId: true,
        secretCiphertext: true,
        confirmedAt: true,
        lastUsedStep: true,
        createdAt: true,
      },
    });
  }

  async isTotpEnabled(db: DbClient, userId: string): Promise<boolean> {
    const count = await db.userTotpCredential.count({
      where: { userId, confirmedAt: { not: null } },
    });
    return count === 1;
  }

  async savePendingTotp(db: DbClient, userId: string, secretCiphertext: Digest): Promise<boolean> {
    // Une seule instruction : un enrôlement inachevé est remplacé, un second facteur confirmé
    // n'est jamais écrasé — même par deux demandes simultanées.
    const written = await db.$executeRaw`
      INSERT INTO user_totp_credentials (user_id, secret_ciphertext)
      VALUES (${userId}::uuid, ${secretCiphertext})
      ON CONFLICT (user_id) DO UPDATE
        SET secret_ciphertext = EXCLUDED.secret_ciphertext,
            created_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_totp_credentials.confirmed_at IS NULL
    `;
    return written === 1;
  }

  async confirmTotp(tx: DbClient, userId: string, step: number, now: Date): Promise<boolean> {
    const { count } = await tx.userTotpCredential.updateMany({
      where: { userId, confirmedAt: null },
      data: { confirmedAt: now, lastUsedStep: step },
    });
    return count === 1;
  }

  async markTotpStepUsed(db: DbClient, userId: string, step: number): Promise<boolean> {
    // La comparaison et l'écriture sont une seule instruction : de deux présentations
    // simultanées du même code, une seule est acceptée.
    const { count } = await db.userTotpCredential.updateMany({
      where: {
        userId,
        confirmedAt: { not: null },
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });
    return count === 1;
  }

  async deleteTotp(tx: DbClient, userId: string): Promise<boolean> {
    await tx.userRecoveryCode.deleteMany({ where: { userId } });
    const { count } = await tx.userTotpCredential.deleteMany({ where: { userId } });
    return count === 1;
  }

  async replaceRecoveryCodes(
    tx: DbClient,
    userId: string,
    codeHashes: readonly Digest[],
  ): Promise<void> {
    await tx.userRecoveryCode.deleteMany({ where: { userId } });
    await tx.userRecoveryCode.createMany({
      data: codeHashes.map((codeHash) => ({ userId, codeHash })),
    });
  }

  async useRecoveryCode(
    db: DbClient,
    userId: string,
    codeHash: Digest,
    now: Date,
  ): Promise<boolean> {
    const { count } = await db.userRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: now },
    });
    return count === 1;
  }

  countUnusedRecoveryCodes(db: DbClient, userId: string): Promise<number> {
    return db.userRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async deleteStalePendingTotp(db: DbClient, startedBefore: Date): Promise<number> {
    const { count } = await db.userTotpCredential.deleteMany({
      where: { confirmedAt: null, createdAt: { lt: startedBefore } },
    });
    return count;
  }
}
