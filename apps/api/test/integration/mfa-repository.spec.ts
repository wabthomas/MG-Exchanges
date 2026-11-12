import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaMfaRepository } from '../../src/modules/identity/infrastructure/prisma-mfa.repository.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * Un code d'application d'authentification ne sert qu'une fois : le pas de temps du dernier
 * code accepté est retenu, et un pas déjà retenu — ou antérieur — est refusé. La comparaison
 * et l'écriture sont une seule instruction ; c'est elle qui est vérifiée ici, sur PostgreSQL,
 * sans le contrôle que le service fait en mémoire avant d'écrire.
 */
describe('Second facteur — usage unique d’un code (PostgreSQL réel)', () => {
  let database: TestDatabase;
  let app: PrismaClient;
  const repository = new PrismaMfaRepository();
  const now = new Date('2026-11-12T10:00:00.000Z');

  beforeAll(async () => {
    database = await createTestDatabase();
    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.appUrl }) });
  });

  afterAll(async () => {
    await app.$disconnect();
    await database.drop();
  });

  let sequence = 0;
  /** Compte dont le second facteur est en place (`confirmed`) ou seulement en cours d'activation. */
  async function userWithTotp(confirmed = true): Promise<string> {
    sequence += 1;
    const user = await app.user.create({
      data: {
        email: `mfa-repository${String(sequence)}@example.cd`,
        countryCode: 'CD',
        status: 'ACTIVE',
        termsAcceptedAt: now,
        emailVerifiedAt: now,
        totp: {
          create: {
            // version (1) ‖ nonce (12) ‖ secret chiffré (20) ‖ étiquette (16)
            secretCiphertext: new Uint8Array(Buffer.concat([Buffer.from([1]), randomBytes(48)])),
            confirmedAt: confirmed ? now : null,
          },
        },
      },
      select: { id: true },
    });
    return user.id;
  }

  const lastUsedStep = async (userId: string): Promise<number | null> =>
    (await app.userTotpCredential.findUniqueOrThrow({ where: { userId } })).lastUsedStep;

  it('un pas de temps ne se retient qu’une fois, et jamais en arrière', async () => {
    const userId = await userWithTotp();

    expect(await repository.markTotpStepUsed(app, userId, 59_000_000)).toBe(true);
    // Le même code présenté de nouveau : refusé, sans rien écrire.
    expect(await repository.markTotpStepUsed(app, userId, 59_000_000)).toBe(false);
    // Un code plus ancien, encore dans la fenêtre de tolérance : refusé lui aussi.
    expect(await repository.markTotpStepUsed(app, userId, 58_999_999)).toBe(false);
    expect(await lastUsedStep(userId)).toBe(59_000_000);

    // Le code suivant est accepté, une fois.
    expect(await repository.markTotpStepUsed(app, userId, 59_000_001)).toBe(true);
    expect(await repository.markTotpStepUsed(app, userId, 59_000_001)).toBe(false);
    expect(await lastUsedStep(userId)).toBe(59_000_001);
  });

  it('le même pas présenté au même instant sur huit connexions n’est retenu qu’une fois', async () => {
    for (let round = 0; round < 5; round += 1) {
      const userId = await userWithTotp();

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => repository.markTotpStepUsed(app, userId, 59_000_000)),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await lastUsedStep(userId)).toBe(59_000_000);
    }
  });

  it('rien n’est retenu pour un second facteur encore en cours d’activation, ni pour un compte qui n’en a pas', async () => {
    const enrolling = await userWithTotp(false);
    expect(await repository.markTotpStepUsed(app, enrolling, 59_000_000)).toBe(false);
    expect(await lastUsedStep(enrolling)).toBeNull();

    const other = await userWithTotp();
    await app.userTotpCredential.delete({ where: { userId: other } });
    expect(await repository.markTotpStepUsed(app, other, 59_000_000)).toBe(false);
  });
});
