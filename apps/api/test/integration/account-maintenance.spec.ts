import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { ACCOUNT_MAINTENANCE_QUEUE } from '../../src/infrastructure/queue/queue.constants.js';
import {
  AccountMaintenanceService,
  type MaintenanceReport,
} from '../../src/modules/identity/application/account-maintenance.service.js';
import {
  MAINTENANCE_BATCH_SIZE,
  RETENTION,
} from '../../src/modules/identity/application/identity-policy.js';
import { SessionRepository } from '../../src/modules/identity/application/session.repository.js';
import { createTestApp, type TestApp, testClock } from '../support/test-app.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ARGON2_HASH = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${'A'.repeat(43)}`;
const NOTHING: MaintenanceReport = {
  unverifiedRegistrations: 0,
  endedSessions: 0,
  expiredChallenges: 0,
  unconfirmedTotpEnrollments: 0,
  expiredRoleChanges: 0,
  failures: 0,
};

describe('Purge périodique des données d’identité (PostgreSQL réel)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let maintenance: AccountMaintenanceService;

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = testApp.app.get(PrismaService);
    maintenance = testApp.app.get(AccountMaintenanceService);
  });

  afterAll(async () => {
    await testApp.close();
  });

  /** Instant situé `ms` avant l'heure de l'application. */
  const ago = (ms: number): Date => new Date(testClock.now().getTime() - ms);

  let sequence = 0;
  async function createUser(
    status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED',
    registeredAt: Date = testClock.now(),
  ): Promise<string> {
    sequence += 1;
    const user = await prisma.user.create({
      data: {
        email: `maintenance${String(sequence)}@example.cd`,
        countryCode: 'CD',
        status,
        termsAcceptedAt: registeredAt,
        emailVerifiedAt: status === 'PENDING_VERIFICATION' ? null : registeredAt,
        credential: { create: { passwordHash: ARGON2_HASH } },
      },
      select: { id: true },
    });
    return user.id;
  }

  /** Session dont l'échéance d'inactivité est `idleExpiresAt` ; créée bien avant. */
  async function createSession(
    userId: string,
    idleExpiresAt: Date,
    options: { revoked?: boolean; tokens?: number } = {},
  ): Promise<string> {
    const createdAt = new Date(idleExpiresAt.getTime() - 14 * DAY_MS);
    const session = await prisma.userSession.create({
      data: {
        userId,
        createdAt,
        lastUsedAt: createdAt,
        idleExpiresAt,
        expiresAt: new Date(idleExpiresAt.getTime() + 46 * DAY_MS),
        ...(options.revoked === true
          ? { revokedAt: createdAt, revocationReason: 'LOGOUT' as const }
          : {}),
        tokens: {
          create: Array.from({ length: options.tokens ?? 1 }, () => ({
            accessTokenHash: new Uint8Array(randomBytes(32)),
            refreshTokenHash: new Uint8Array(randomBytes(32)),
            accessExpiresAt: new Date(createdAt.getTime() + 10 * MINUTE_MS),
          })),
        },
      },
      select: { id: true },
    });
    return session.id;
  }

  async function createChallenge(userId: string, expiresAt: Date, used = false): Promise<string> {
    const challenge = await prisma.verificationChallenge.create({
      data: {
        userId,
        purpose: 'PASSWORD_RESET',
        target: 'someone@example.cd',
        codeHash: new Uint8Array(randomBytes(32)),
        maxAttempts: 5,
        createdAt: new Date(expiresAt.getTime() - 15 * MINUTE_MS),
        expiresAt,
        // Un seul défi en cours par compte et par usage : les autres sont clos.
        ...(used ? { consumedAt: expiresAt } : { invalidatedAt: expiresAt }),
      },
      select: { id: true },
    });
    return challenge.id;
  }

  const exists = {
    user: async (id: string) => (await prisma.user.count({ where: { id } })) === 1,
    session: async (id: string) => (await prisma.userSession.count({ where: { id } })) === 1,
    challenge: async (id: string) =>
      (await prisma.verificationChallenge.count({ where: { id } })) === 1,
    totp: async (userId: string) =>
      (await prisma.userTotpCredential.count({ where: { userId } })) === 1,
  };

  it('une base sans rien à purger : la purge ne touche à rien', async () => {
    const active = await createUser('ACTIVE');
    const session = await createSession(active, new Date(testClock.now().getTime() + 14 * DAY_MS));

    expect(await maintenance.run()).toEqual(NOTHING);
    expect(await exists.user(active)).toBe(true);
    expect(await exists.session(session)).toBe(true);
  });

  it('une inscription jamais vérifiée disparaît après sept jours, avec son secret et ses codes ; un compte, jamais', async () => {
    const limit = RETENTION.unverifiedRegistrationMs;
    expect(limit).toBe(7 * DAY_MS);
    const abandoned = await createUser('PENDING_VERIFICATION', ago(limit + MINUTE_MS));
    const abandonedCode = await createChallenge(abandoned, ago(limit));
    const recent = await createUser('PENDING_VERIFICATION', ago(limit - MINUTE_MS));
    const oldAccount = await createUser('ACTIVE', ago(400 * DAY_MS));
    const oldSuspended = await createUser('SUSPENDED', ago(400 * DAY_MS));

    const report = await maintenance.run();
    expect(report).toMatchObject({ unverifiedRegistrations: 1, failures: 0 });

    expect(await exists.user(abandoned)).toBe(false);
    expect(await prisma.userCredential.count({ where: { userId: abandoned } })).toBe(0);
    expect(await exists.challenge(abandonedCode)).toBe(false);
    expect(await exists.user(recent)).toBe(true);
    expect(await exists.user(oldAccount)).toBe(true);
    expect(await exists.user(oldSuspended)).toBe(true);
    expect(
      await prisma.userCredential.count({ where: { userId: { in: [recent, oldAccount] } } }),
    ).toBe(2);

    // La suppression laisse une trace, attribuée à la plateforme.
    const trace = await prisma.auditLog.findMany({ where: { action: 'user.registration_purged' } });
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      resourceType: 'user',
      resourceId: abandoned,
      outcome: 'SUCCESS',
      metadata: { reason: 'NEVER_VERIFIED' },
    });
    // L'adresse saisie, qui appartient peut-être à un tiers, n'y figure pas.
    expect(JSON.stringify(trace)).not.toContain('@example.cd');

    expect(await maintenance.run()).toEqual(NOTHING);
  });

  it('une nouvelle inscription sur la même adresse repousse l’échéance', async () => {
    const limit = RETENTION.unverifiedRegistrationMs;
    const renewed = await createUser('PENDING_VERIFICATION', ago(limit + DAY_MS));
    await prisma.user.update({ where: { id: renewed }, data: { termsAcceptedAt: ago(DAY_MS) } });

    expect((await maintenance.run()).unverifiedRegistrations).toBe(0);
    expect(await exists.user(renewed)).toBe(true);
  });

  it('une inscription qui ne peut pas être supprimée est signalée sans bloquer les autres', async () => {
    const limit = RETENTION.unverifiedRegistrationMs;
    const stuck = await createUser('PENDING_VERIFICATION', ago(limit + 2 * DAY_MS));
    // Donnée inattendue rattachée à une inscription : la clé étrangère interdit la suppression.
    await prisma.userProfile.create({ data: { userId: stuck, givenName: 'Inattendu' } });
    const purgeable = await createUser('PENDING_VERIFICATION', ago(limit + DAY_MS));

    const report = await maintenance.run();
    expect(report).toMatchObject({ unverifiedRegistrations: 1, failures: 1 });
    expect(await exists.user(stuck)).toBe(true);
    // Rien n'a été supprimé à moitié.
    expect(await prisma.userCredential.count({ where: { userId: stuck } })).toBe(1);
    expect(await exists.user(purgeable)).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { action: 'user.registration_purged', resourceId: stuck },
      }),
    ).toBe(0);

    // L'obstacle levé, l'exécution suivante la supprime.
    await prisma.userProfile.delete({ where: { userId: stuck } });
    expect(await maintenance.run()).toEqual({ ...NOTHING, unverifiedRegistrations: 1 });
    expect(await exists.user(stuck)).toBe(false);
  });

  it('les sessions terminées depuis 90 jours sont supprimées avec leurs jetons — sauf la plus récente de chaque compte', async () => {
    const limit = RETENTION.endedSessionMs;
    expect(limit).toBe(90 * DAY_MS);
    const user = await createUser('ACTIVE');
    const oldest = await createSession(user, ago(limit + 30 * DAY_MS), { tokens: 3 });
    const old = await createSession(user, ago(limit + MINUTE_MS), { revoked: true });
    const recentlyEnded = await createSession(user, ago(limit - MINUTE_MS), { revoked: true });
    const live = await createSession(user, new Date(testClock.now().getTime() + DAY_MS));

    // Un compte qui ne s'est plus connecté depuis longtemps garde sa dernière session.
    const dormant = await createUser('ACTIVE');
    const dormantOlder = await createSession(dormant, ago(limit + 200 * DAY_MS));
    const dormantLast = await createSession(dormant, ago(limit + 100 * DAY_MS));
    const single = await createUser('ACTIVE');
    const onlySession = await createSession(single, ago(limit + 300 * DAY_MS));

    const report = await maintenance.run();
    expect(report).toEqual({ ...NOTHING, endedSessions: 3 });

    expect(await Promise.all([oldest, old, dormantOlder].map(exists.session))).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      await Promise.all([recentlyEnded, live, dormantLast, onlySession].map(exists.session)),
    ).toEqual([true, true, true, true]);
    expect(
      await prisma.sessionToken.count({
        where: { sessionId: { in: [oldest, old, dormantOlder] } },
      }),
    ).toBe(0);
    expect(await prisma.sessionToken.count({ where: { sessionId: live } })).toBe(1);

    // L'avertissement « nouvel appareil » repose sur l'existence d'une session antérieure.
    const sessions = testApp.app.get(SessionRepository);
    for (const account of [dormant, single]) {
      expect(await sessions.deviceHistory(prisma, account, null)).toMatchObject({
        hasSessions: true,
      });
    }
    expect(await maintenance.run()).toEqual(NOTHING);
  });

  it('les codes expirés depuis sept jours sont supprimés, utilisés ou non', async () => {
    const limit = RETENTION.expiredChallengeMs;
    const user = await createUser('ACTIVE');
    const oldUnused = await createChallenge(user, ago(limit + MINUTE_MS));
    const oldUsed = await createChallenge(user, ago(limit + DAY_MS), true);
    const recent = await createChallenge(user, ago(limit - MINUTE_MS));
    const valid = await createChallenge(user, new Date(testClock.now().getTime() + 10 * MINUTE_MS));

    expect(await maintenance.run()).toEqual({ ...NOTHING, expiredChallenges: 2 });
    expect(await Promise.all([oldUnused, oldUsed, recent, valid].map(exists.challenge))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('un enrôlement de second facteur jamais confirmé est supprimé après 24 heures ; un second facteur en place, jamais', async () => {
    const limit = RETENTION.unconfirmedTotpMs;
    const secret = (): Uint8Array<ArrayBuffer> =>
      new Uint8Array(Buffer.concat([Buffer.from([1]), randomBytes(48)]));
    const enrol = async (createdAt: Date, confirmedAt: Date | null): Promise<string> => {
      const userId = await createUser('ACTIVE');
      await prisma.userTotpCredential.create({
        data: { userId, secretCiphertext: secret(), createdAt, confirmedAt },
      });
      return userId;
    };
    const abandoned = await enrol(ago(limit + MINUTE_MS), null);
    const inProgress = await enrol(ago(limit - MINUTE_MS), null);
    const enabled = await enrol(ago(400 * DAY_MS), ago(400 * DAY_MS));
    await prisma.userRecoveryCode.create({
      data: { userId: enabled, codeHash: new Uint8Array(randomBytes(32)) },
    });

    expect(await maintenance.run()).toEqual({ ...NOTHING, unconfirmedTotpEnrollments: 1 });
    expect(await Promise.all([abandoned, inProgress, enabled].map(exists.totp))).toEqual([
      false,
      true,
      true,
    ]);
    expect(await prisma.userRecoveryCode.count({ where: { userId: enabled } })).toBe(1);
  });

  it('les demandes de changement de rôle échues sont closes — sans auteur, et sans rien attribuer', async () => {
    const [requester, target] = [await createUser('ACTIVE'), await createUser('ACTIVE')];
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'support' } });
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    const overdue = await prisma.roleChangeRequest.create({
      data: {
        userId: target,
        roleId: role.id,
        action: 'GRANT',
        reason: 'Demande restée sans réponse',
        requestedBy: requester,
        requestedAt: ago(4 * DAY_MS),
        expiresAt: ago(MINUTE_MS),
      },
    });
    const pending = await prisma.roleChangeRequest.create({
      data: {
        userId: target,
        roleId: superAdmin.id,
        action: 'GRANT',
        reason: 'Demande encore dans les temps',
        requestedBy: requester,
        requestedAt: ago(DAY_MS),
        expiresAt: new Date(testClock.now().getTime() + MINUTE_MS),
      },
    });

    expect(await maintenance.run()).toEqual({ ...NOTHING, expiredRoleChanges: 1 });

    const closed = await prisma.roleChangeRequest.findUniqueOrThrow({ where: { id: overdue.id } });
    expect(closed).toMatchObject({ status: 'EXPIRED', decidedBy: null, decisionNote: null });
    expect(closed.decidedAt).not.toBeNull();
    expect(
      (await prisma.roleChangeRequest.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('PENDING');
    expect(await prisma.userRole.count({ where: { userId: target } })).toBe(0);
  });

  it('le travail d’une exécution est borné à 500 lignes par catégorie : le reliquat est traité à la suivante', async () => {
    // La borne est écrite ici en toutes lettres : la relever est une décision, pas un réglage.
    const batch = 500;
    expect(MAINTENANCE_BATCH_SIZE).toBe(batch);
    const user = await createUser('ACTIVE');
    const ended = ago(RETENTION.endedSessionMs + DAY_MS);
    const createdAt = new Date(ended.getTime() - 14 * DAY_MS);
    await prisma.userSession.createMany({
      data: Array.from({ length: batch + 2 }, () => ({
        userId: user,
        createdAt,
        lastUsedAt: createdAt,
        idleExpiresAt: ended,
        expiresAt: new Date(ended.getTime() + 46 * DAY_MS),
      })),
    });

    expect((await maintenance.run()).endedSessions).toBe(batch);
    // Toutes sauf la plus récente du compte.
    expect((await maintenance.run()).endedSessions).toBe(1);
    expect(await prisma.userSession.count({ where: { userId: user } })).toBe(1);
    expect(await maintenance.run()).toEqual(NOTHING);
  });

  it('la purge est planifiée toutes les heures, une seule fois pour toutes les instances', async () => {
    const queue = testApp.app.get<Queue>(getQueueToken(ACCOUNT_MAINTENANCE_QUEUE));
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: 'account-maintenance',
      name: 'purge',
      every: 60 * 60 * 1000,
    });
  });
});
