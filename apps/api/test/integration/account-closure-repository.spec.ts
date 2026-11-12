import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  ClosureRuleViolationError,
  type NewClosure,
} from '../../src/modules/identity/application/account-closure.repository.js';
import { PrismaAccountClosureRepository } from '../../src/modules/identity/infrastructure/prisma-account-closure.repository.js';
import { PrismaUserRepository } from '../../src/modules/identity/infrastructure/prisma-user.repository.js';
import { moveErasureTerm } from '../support/account-closure.js';
import { addDocument, insertCase, reject, submit } from '../support/kyc-sql.js';
import {
  createTestDatabase,
  type TestDatabase,
  untilBlocked,
  withConnection,
} from '../support/test-database.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ARGON2_HASH = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${'A'.repeat(43)}`;
const UNKNOWN_ID = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

/**
 * La clôture d'un compte est une suite d'écritures qui n'a de sens qu'entière. Ce qui est
 * vérifié ici, sur PostgreSQL et sans les contrôles que le service fait avant d'écrire : ce
 * que le port de persistance écrit, ce qu'il efface, ce qu'il dit — et qu'un refus de la base
 * est une erreur nommée.
 */
describe('Clôture des comptes — port de persistance (PostgreSQL réel)', () => {
  let database: TestDatabase;
  let app: PrismaClient;
  let owner: PrismaClient;
  /** Agent de conformité, nommé comme le fait l'outil d'amorçage : par le propriétaire. */
  let officer: string;
  const repository = new PrismaAccountClosureRepository();
  const users = new PrismaUserRepository();

  beforeAll(async () => {
    database = await createTestDatabase();
    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.appUrl }) });
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.ownerUrl }) });
    officer = await createUser();
    await grant(officer, 'compliance');
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
    await database.drop();
  });

  let sequence = 0;
  const nextPhone = (): string => `+24399${String(1_000_000 + sequence).slice(1)}7`;

  /** Compte actif, avec tout ce qu'un compte peut porter si `full`. */
  async function createUser(
    options: {
      full?: boolean;
      phone?: string;
      email?: string;
      status?: 'ACTIVE' | 'SUSPENDED';
    } = {},
  ): Promise<string> {
    sequence += 1;
    const now = new Date();
    const full = options.full === true;
    const user = await app.user.create({
      data: {
        email: options.email ?? `closure-repository${String(sequence)}@example.cd`,
        countryCode: 'CD',
        status: options.status ?? 'ACTIVE',
        termsAcceptedAt: now,
        emailVerifiedAt: now,
        ...(options.phone === undefined ? {} : { phone: options.phone, phoneVerifiedAt: now }),
        credential: { create: { passwordHash: ARGON2_HASH } },
        ...(full
          ? {
              profile: { create: { givenName: 'Jean', city: 'Goma' } },
              totp: {
                create: {
                  secretCiphertext: new Uint8Array(
                    Buffer.concat([Buffer.from([1]), randomBytes(48)]),
                  ),
                  confirmedAt: now,
                },
              },
              recoveryCodes: {
                create: [0, 1, 2].map(() => ({ codeHash: new Uint8Array(randomBytes(32)) })),
              },
              challenges: {
                create: {
                  purpose: 'PASSWORD_RESET',
                  target: 'someone@example.cd',
                  maxAttempts: 5,
                  expiresAt: new Date(now.getTime() + 15 * MINUTE_MS),
                },
              },
              sessions: {
                create: [0, 1].map(() => ({
                  idleExpiresAt: new Date(now.getTime() + DAY_MS),
                  expiresAt: new Date(now.getTime() + 60 * DAY_MS),
                  tokens: {
                    create: {
                      accessTokenHash: new Uint8Array(randomBytes(32)),
                      refreshTokenHash: new Uint8Array(randomBytes(32)),
                      accessExpiresAt: new Date(now.getTime() + 10 * MINUTE_MS),
                    },
                  },
                })),
              },
            }
          : {}),
      },
      select: { id: true },
    });
    return user.id;
  }

  async function grant(userId: string, roleKey: string): Promise<void> {
    const role = await owner.role.findUniqueOrThrow({ where: { key: roleKey } });
    await owner.userRole.create({ data: { userId, roleId: role.id } });
  }

  /** Clôture demandée par le titulaire, à l'instant ; sans conservation légale sauf mention. */
  async function closureOf(
    userId: string,
    overrides: Partial<NewClosure> = {},
  ): Promise<NewClosure> {
    const account = await app.user.findUniqueOrThrow({ where: { id: userId } });
    const closedAt = overrides.closedAt ?? new Date();
    return {
      userId,
      closedAt,
      origin: 'HOLDER',
      closedBy: userId,
      email: account.email,
      phone: account.phone,
      legalRetentionUntil: null,
      erasureDueAt: new Date(closedAt.getTime() + 30 * DAY_MS),
      ...overrides,
    };
  }

  /** Clôt un compte comme le fait le service : verrou, puis clôture, dans une transaction. */
  async function close(userId: string, overrides: Partial<NewClosure> = {}): Promise<NewClosure> {
    const closure = await closureOf(userId, overrides);
    await app.$transaction(async (tx) => {
      await repository.lockAccount(tx, userId);
      await repository.close(tx, closure);
    });
    return closure;
  }

  const counts = async (userId: string) => {
    const where = { where: { userId } };
    return {
      credentials: await app.userCredential.count(where),
      totp: await app.userTotpCredential.count(where),
      recoveryCodes: await app.userRecoveryCode.count(where),
      challenges: await app.verificationChallenge.count(where),
      profiles: await app.userProfile.count(where),
      sessions: await app.userSession.count(where),
      tokens: await app.sessionToken.count({ where: { session: { userId } } }),
    };
  };
  const NOTHING = {
    credentials: 0,
    totp: 0,
    recoveryCodes: 0,
    challenges: 0,
    profiles: 0,
    sessions: 0,
    tokens: 0,
  };

  const asOwnerSql = <T>(work: Parameters<typeof withConnection<T>>[1]): Promise<T> =>
    withConnection(database.ownerUrl, work);

  describe('verrouiller', () => {
    it('rend l’état du compte et dit s’il détient un rôle ; rien pour un compte inconnu', async () => {
      const phone = nextPhone();
      const userId = await createUser({ phone });
      const account = await app.user.findUniqueOrThrow({ where: { id: userId } });

      await app.$transaction(async (tx) => {
        expect(await repository.lockAccount(tx, userId)).toEqual({
          status: 'ACTIVE',
          email: account.email,
          phone,
          locale: 'fr',
          holdsRole: false,
        });
        expect(await repository.lockAccount(tx, officer)).toMatchObject({ holdsRole: true });
        expect(await repository.lockAccount(tx, UNKNOWN_ID)).toBeNull();
      });
    });

    it('tient le compte jusqu’à la fin de la transaction : ce qui s’y ajoute attend', async () => {
      const userId = await createUser();

      await withConnection(database.appUrl, async (writer) => {
        await withConnection(database.appUrl, async (observer) => {
          let session: Promise<unknown> | undefined;
          await app.$transaction(async (tx) => {
            await repository.lockAccount(tx, userId);
            session = writer.query(
              `INSERT INTO user_sessions (user_id, idle_expires_at, expires_at)
               VALUES ($1, now() + interval '1 day', now() + interval '2 days')`,
              [userId],
            );
            await untilBlocked(observer);
          });
          // Le verrou relâché sans clôture, l'écriture aboutit.
          await session;
          expect(await app.userSession.count({ where: { userId } })).toBe(1);
        });
      });
    });
  });

  describe('clôturer', () => {
    it('écrit la trace, efface tout ce que portait le compte et lui retire son adresse', async () => {
      const phone = nextPhone();
      const userId = await createUser({ full: true, phone });
      const { email } = await app.user.findUniqueOrThrow({ where: { id: userId } });
      expect(await counts(userId)).toEqual({
        credentials: 1,
        totp: 1,
        recoveryCodes: 3,
        challenges: 1,
        profiles: 1,
        sessions: 2,
        tokens: 2,
      });
      const closure = await closureOf(userId);

      const closedSessions = await app.$transaction(async (tx) => {
        await repository.lockAccount(tx, userId);
        return repository.close(tx, closure);
      });

      expect(closedSessions).toBe(2);
      expect(await counts(userId)).toEqual(NOTHING);
      expect(await app.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
        status: 'CLOSED',
        email: `closed-${userId}@closed.invalid`,
        emailVerifiedAt: null,
        phone: null,
        phoneVerifiedAt: null,
      });
      expect(await repository.find(app, userId)).toEqual({
        userId,
        closedAt: closure.closedAt,
        origin: 'HOLDER',
        closedBy: userId,
        email,
        phone,
        legalRetentionUntil: null,
        erasureDueAt: closure.erasureDueAt,
        erasedAt: null,
      });
      // Un compte clôturé ne se retrouve plus par une adresse — ni l'ancienne, ni la factice.
      expect(await users.findByEmail(app, email)).toBeNull();
      expect(await users.findByEmail(app, `closed-${userId}@closed.invalid`)).toBeNull();
      expect(
        await users.findByEmailWithPasswordHash(app, `closed-${userId}@closed.invalid`),
      ).toBeNull();
      expect((await users.findById(app, userId))?.status).toBe('CLOSED');
    });

    it('un compte suspendu se clôt aussi ; par un membre du personnel, la trace dit lequel', async () => {
      const userId = await createUser({ status: 'SUSPENDED' });

      await close(userId, { origin: 'STAFF', closedBy: officer });

      expect(await repository.find(app, userId)).toMatchObject({
        origin: 'STAFF',
        closedBy: officer,
      });
      expect((await app.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('CLOSED');
    });

    it('ce que la base refuse est une erreur nommée, et rien n’est fait à moitié', async () => {
      // Un compte qui détient un rôle.
      const agent = await createUser({ full: true });
      await grant(agent, 'support');
      // Une clôture par un compte sans qualité.
      const target = await createUser({ full: true });
      const stranger = await createUser();
      // Une trace qui ne porte pas l'adresse du compte.
      const other = await createUser({ full: true });

      for (const [userId, overrides] of [
        [agent, {}],
        [target, { origin: 'STAFF', closedBy: stranger }],
        [other, { email: 'someone-else@example.cd' }],
      ] as const) {
        const closure = await closureOf(userId, overrides);
        await expect(
          app.$transaction(async (tx) => {
            await repository.lockAccount(tx, userId);
            await repository.close(tx, closure);
          }),
        ).rejects.toBeInstanceOf(ClosureRuleViolationError);
        expect(await repository.find(app, userId)).toBeNull();
        expect((await app.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('ACTIVE');
        // Ses secrets, ses sessions et son profil sont intacts.
        expect(await counts(userId)).toMatchObject({ credentials: 1, sessions: 2, profiles: 1 });
      }
    });

    it('un compte ne se clôt qu’une fois', async () => {
      const userId = await createUser();
      const first = await close(userId);

      await expect(
        app.$transaction(async (tx) => repository.close(tx, { ...first, closedAt: new Date() })),
      ).rejects.toBeInstanceOf(ClosureRuleViolationError);
      expect((await repository.find(app, userId))?.closedAt).toEqual(first.closedAt);
    });
  });

  describe('retrouver', () => {
    it('une ancienne adresse ou un ancien numéro retrouvent les comptes clôturés qui les portaient, du plus récent au plus ancien', async () => {
      const email = 'returning-holder@example.cd';
      const phone = nextPhone();
      const first = await createUser({ email, phone });
      await close(first, { closedAt: new Date(Date.now() - 2 * MINUTE_MS) });
      const second = await createUser({ email });
      await close(second, { closedAt: new Date(Date.now() - MINUTE_MS) });
      const third = await createUser({ email, phone });
      await close(third);
      // Un compte ouvert qui porte aujourd'hui l'adresse n'est pas un compte clôturé.
      await createUser({ email });

      expect(await repository.findByFormerIdentifier(app, { email }, 10)).toEqual([
        third,
        second,
        first,
      ]);
      expect(await repository.findByFormerIdentifier(app, { phone }, 10)).toEqual([third, first]);
      expect(await repository.findByFormerIdentifier(app, { email, phone }, 10)).toEqual([
        third,
        first,
      ]);
      expect(await repository.findByFormerIdentifier(app, { email }, 2)).toEqual([third, second]);
      // Sans critère, rien — et surtout pas tous les comptes clôturés.
      expect(await repository.findByFormerIdentifier(app, {}, 10)).toEqual([]);
      expect(
        await repository.findByFormerIdentifier(app, { email: 'nobody@example.cd' }, 10),
      ).toEqual([]);
      expect(await repository.find(app, UNKNOWN_ID)).toBeNull();
    });
  });

  describe('effacer à l’échéance', () => {
    it('ne propose que les clôtures échues et pas encore effacées, les plus anciennes d’abord', async () => {
      const now = new Date();
      const at = (ms: number): Date => new Date(now.getTime() + ms);
      /** Compte clôturé à l'instant (la base refuse une clôture antidatée), d'échéance donnée. */
      const closedWithTerm = async (erasureDueAt: Date): Promise<string> => {
        const userId = await createUser();
        await close(userId, { closedAt: at(-MINUTE_MS), erasureDueAt });
        return userId;
      };
      // Seules celles de ce test : les autres clôtures de la base ont une échéance à trente jours.
      const horizon = at(10 * DAY_MS);
      const dueFirst = await closedWithTerm(at(1 * DAY_MS));
      const dueSecond = await closedWithTerm(at(2 * DAY_MS));
      const exactly = await closedWithTerm(horizon);
      const later = await closedWithTerm(at(10 * DAY_MS + 1));
      const erased = await closedWithTerm(at(3 * DAY_MS));
      await app.$transaction((tx) => repository.markErased(tx, erased, at(4 * DAY_MS)));

      const due = await repository.findDueForErasure(app, horizon, 10);
      // L'échéance s'entend au plus tard : à l'instant même, elle est atteinte.
      expect(due.map(({ userId }) => userId)).toEqual([dueFirst, dueSecond, exactly]);
      expect(due.map(({ userId }) => userId)).not.toContain(later);
      expect(due[0]).toMatchObject({ userId: dueFirst, erasedAt: null, origin: 'HOLDER' });
      expect(
        (await repository.findDueForErasure(app, horizon, 2)).map(({ userId }) => userId),
      ).toEqual([dueFirst, dueSecond]);
      expect(await repository.findDueForErasure(app, at(DAY_MS - 1), 10)).toEqual([]);
    });

    it('constater l’effacement retire l’adresse et le numéro de la trace, une seule fois', async () => {
      const email = 'erased-holder@example.cd';
      const phone = nextPhone();
      const userId = await createUser({ email, phone });
      const closure = await close(userId);
      const erasedAt = new Date(closure.closedAt.getTime() + 31 * DAY_MS);

      expect(await app.$transaction((tx) => repository.markErased(tx, userId, erasedAt))).toBe(
        true,
      );
      expect(await repository.find(app, userId)).toEqual({
        ...closure,
        email: null,
        phone: null,
        erasedAt,
      });
      // Constaté une fois : la seconde ne réécrit rien.
      const again = new Date(erasedAt.getTime() + DAY_MS);
      expect(await app.$transaction((tx) => repository.markErased(tx, userId, again))).toBe(false);
      expect((await repository.find(app, userId))?.erasedAt).toEqual(erasedAt);
      expect(await app.$transaction((tx) => repository.markErased(tx, UNKNOWN_ID, again))).toBe(
        false,
      );

      // Effacée, la trace ne répond plus à l'ancienne adresse ni à l'ancien numéro.
      expect(await repository.findByFormerIdentifier(app, { email }, 10)).toEqual([]);
      expect(await repository.findByFormerIdentifier(app, { phone }, 10)).toEqual([]);
    });

    it('tant que la loi impose de conserver, ou que des dossiers restent, la base refuse — et le dit', async () => {
      // Un compte dont un dossier de vérification a été refusé : dix ans de conservation.
      const userId = await createUser();
      await withConnection(database.appUrl, async (db) => {
        const caseId = await insertCase(db, userId, 1);
        await addDocument(db, caseId, 'IDENTITY_FRONT');
        await addDocument(db, caseId, 'SELFIE');
        await submit(db, caseId);
        await reject(db, caseId, officer);
      });
      const closedAt = new Date();
      const term = new Date(closedAt);
      term.setUTCFullYear(term.getUTCFullYear() + 10);

      // Sans le terme légal, la clôture elle-même est refusée.
      await expect(close(userId, { closedAt })).rejects.toBeInstanceOf(ClosureRuleViolationError);
      await close(userId, { closedAt, legalRetentionUntil: term, erasureDueAt: term });

      const markErased = () =>
        app.$transaction((tx) =>
          repository.markErased(tx, userId, new Date(term.getTime() + DAY_MS)),
        );
      // Avant le terme, lu à l'horloge de la base.
      await expect(markErased()).rejects.toBeInstanceOf(ClosureRuleViolationError);
      // Le terme passé, mais les dossiers toujours là.
      await asOwnerSql((sql) => moveErasureTerm(sql, userId, '-1 day'));
      await expect(markErased()).rejects.toBeInstanceOf(ClosureRuleViolationError);
      expect(await repository.find(app, userId)).toMatchObject({ erasedAt: null });
      expect((await repository.find(app, userId))?.email).not.toBeNull();

      // Les dossiers effacés, l'effacement se constate.
      await app.kycDocument.deleteMany({ where: { case: { userId } } });
      await app.kycCase.deleteMany({ where: { userId } });
      expect(await markErased()).toBe(true);
    });
  });
});
