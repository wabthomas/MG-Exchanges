import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { Digest } from '../application/digest.js';
import {
  type ChallengePurpose,
  type ChallengeRecord,
  ChallengeRepository,
  type NewChallenge,
} from '../application/challenge.repository.js';

const CHALLENGE_FIELDS = {
  id: true,
  userId: true,
  purpose: true,
  target: true,
  codeHash: true,
  attempts: true,
  maxAttempts: true,
  expiresAt: true,
} as const satisfies Prisma.VerificationChallengeSelect;

/** Un défi « en cours » n'a été ni utilisé, ni annulé. */
const ACTIVE = { consumedAt: null, invalidatedAt: null } as const;

@Injectable()
export class PrismaChallengeRepository extends ChallengeRepository {
  async replaceActive(tx: DbClient, challenge: NewChallenge): Promise<string> {
    // Deux demandes simultanées pour le même compte et le même usage sont traitées l'une
    // après l'autre : sans ce verrou, toutes deux annuleraient l'ancien défi puis tenteraient
    // d'en ouvrir un, et la seconde violerait l'unicité du défi en cours.
    const lockKey = `verification_challenge:${challenge.userId}:${challenge.purpose}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    await tx.verificationChallenge.updateMany({
      where: { userId: challenge.userId, purpose: challenge.purpose, ...ACTIVE },
      data: { invalidatedAt: new Date() },
    });
    const created = await tx.verificationChallenge.create({
      data: challenge,
      select: { id: true },
    });
    return created.id;
  }

  findActive(
    db: DbClient,
    userId: string,
    purpose: ChallengePurpose,
  ): Promise<ChallengeRecord | null> {
    return db.verificationChallenge.findFirst({
      where: { userId, purpose, ...ACTIVE },
      select: CHALLENGE_FIELDS,
    });
  }

  findActiveById(db: DbClient, challengeId: string): Promise<ChallengeRecord | null> {
    return db.verificationChallenge.findFirst({
      where: { id: challengeId, ...ACTIVE },
      select: CHALLENGE_FIELDS,
    });
  }

  async setCodeHash(db: DbClient, challengeId: string, codeHash: Digest): Promise<boolean> {
    const { count } = await db.verificationChallenge.updateMany({
      where: { id: challengeId, ...ACTIVE },
      data: { codeHash },
    });
    return count === 1;
  }

  async registerAttempt(db: DbClient, challengeId: string): Promise<boolean> {
    // Une seule instruction : la comparaison et l'incrément sont atomiques, même en
    // présence d'essais simultanés (la contrainte CHECK de la table en est le dernier garant).
    const updated = await db.$executeRaw`
      UPDATE verification_challenges
      SET attempts = attempts + 1
      WHERE id = ${challengeId}::uuid
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
        AND attempts < max_attempts
    `;
    return updated === 1;
  }

  async consume(tx: DbClient, challengeId: string, now: Date): Promise<boolean> {
    const { count } = await tx.verificationChallenge.updateMany({
      where: { id: challengeId, ...ACTIVE },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  async deleteExpired(db: DbClient, expiredBefore: Date): Promise<number> {
    const { count } = await db.verificationChallenge.deleteMany({
      where: { expiresAt: { lt: expiredBefore } },
    });
    return count;
  }
}
