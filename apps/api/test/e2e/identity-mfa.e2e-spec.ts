import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  authenticatedLoginSchema,
  type AuthenticatedLogin,
  mfaRequiredLoginSchema,
  mfaStatusSchema,
  problemDetailsSchema,
  recoveryCodesSchema,
  totpEnrollmentSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import { SecondFactorThrottle } from '../../src/modules/identity/infrastructure/second-factor-throttle.js';
import { hashPresentedToken } from '../../src/modules/identity/infrastructure/session-tokens.js';
import { base32Decode } from '../../src/modules/identity/infrastructure/totp.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import {
  backgroundWorkDone,
  bearer,
  createAdmin,
  from,
  type Http,
  login,
  codeIn,
  mailbox,
  newClientIp,
  nextMessageOf,
  nextTotpCode,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
  TEST_DEVICE_ID,
  wrongTotpCode,
} from '../support/identity.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const SYSTEM = { type: 'SYSTEM' } as const;

interface ProtectedUser extends RegisteredUser {
  readonly id: string;
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
  /** Session depuis laquelle le second facteur a été activé : elle seule lui survit. */
  readonly session: AuthenticatedLogin;
}

describe('Validation en deux étapes — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    await openFeature(testApp, 'registration');
  });

  afterAll(async () => {
    await testApp.close();
  });

  const mfaStatus = (accessToken: string) =>
    http.get('/api/v1/me/mfa').set(bearer(accessToken)).set(from(newClientIp()));
  const me = (accessToken: string) =>
    http.get('/api/v1/me').set(bearer(accessToken)).set(from(newClientIp()));
  const enroll = (accessToken: string, currentPassword: string) =>
    http
      .post('/api/v1/me/mfa/totp/enroll')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send({ currentPassword });
  const confirm = (accessToken: string, code: string) =>
    http
      .post('/api/v1/me/mfa/totp/confirm')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send({ code });
  const disable = (accessToken: string, body: Record<string, unknown>) =>
    http
      .post('/api/v1/me/mfa/totp/disable')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send(body);
  const regenerate = (accessToken: string, body: Record<string, unknown>) =>
    http
      .post('/api/v1/me/mfa/recovery-codes')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send(body);
  /** Première étape de la connexion : adresse et mot de passe. */
  const signIn = (user: RegisteredUser, ip = newClientIp()) =>
    http
      .post('/api/v1/auth/login')
      .set(from(ip))
      .send({ email: user.email, password: user.password, deviceId: TEST_DEVICE_ID });
  /** Seconde étape : le jeton de la connexion en cours et une preuve du second facteur. */
  const secondStep = (body: Record<string, unknown>, ip = newClientIp()) =>
    http.post('/api/v1/auth/mfa/verify').set(from(ip)).send(body);

  /** Issue d'une seconde étape : `OPENED`, ou le statut et le code de l'erreur. */
  const outcomeOf = (response: { status: number; body: unknown }): string =>
    response.status === 200
      ? 'OPENED'
      : `${String(response.status)} ${problemDetailsSchema.parse(response.body).code}`;

  async function pendingSignIn(user: RegisteredUser): Promise<string> {
    const response = await signIn(user).expect(200);
    return mfaRequiredLoginSchema.parse(response.body).mfaToken;
  }

  /** Inscrit un compte et active son second facteur par l'API, comme le ferait son titulaire. */
  async function protectedUser(): Promise<ProtectedUser> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    const enrollment = totpEnrollmentSchema.parse(
      (await enroll(session.tokens.accessToken, user.password).expect(200)).body,
    );
    const { recoveryCodes } = recoveryCodesSchema.parse(
      (await confirm(session.tokens.accessToken, nextTotpCode(enrollment.secret)).expect(200)).body,
    );
    return {
      ...user,
      id: session.user.id,
      totpSecret: enrollment.secret,
      recoveryCodes,
      session,
    };
  }

  describe('activation', () => {
    it('sans second facteur, le mot de passe ouvre la session et l’état le dit', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const response = await signIn(user).expect(200);
      const session = authenticatedLoginSchema.parse(response.body);
      expect(session.user.secondFactorEnabled).toBe(false);

      const status = mfaStatusSchema.parse(
        (await mfaStatus(session.tokens.accessToken).expect(200)).body,
      );
      expect(status).toEqual({
        totp: { enabled: false, enabledAt: null },
        recoveryCodesRemaining: 0,
      });
    });

    it('l’enrôlement exige le mot de passe ; le secret n’est conservé que chiffré et rien ne change avant sa confirmation', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens, user: account } = await login(http, user);

      const refused = await enroll(tokens.accessToken, 'not-the-password-1').expect(401);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('INVALID_CREDENTIALS');
      expect(await prisma.userTotpCredential.count({ where: { userId: account.id } })).toBe(0);
      await http
        .post('/api/v1/me/mfa/totp/enroll')
        .set(from(newClientIp()))
        .send({ currentPassword: user.password })
        .expect(401);

      const enrollment = totpEnrollmentSchema.parse(
        (await enroll(tokens.accessToken, user.password).expect(200)).body,
      );
      expect(enrollment).toMatchObject({ algorithm: 'SHA1', digits: 6, periodSeconds: 30 });
      // 20 octets aléatoires (RFC 4226), soit 32 caractères en base32.
      expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
      const uri = new URL(enrollment.otpauthUri);
      expect(uri.protocol).toBe('otpauth:');
      expect(uri.host).toBe('totp');
      expect(decodeURIComponent(uri.pathname)).toBe(`/MG-Exchange (test):${user.email}`);
      expect(Object.fromEntries(uri.searchParams)).toEqual({
        secret: enrollment.secret,
        issuer: 'MG-Exchange (test)',
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      });

      const stored = await prisma.userTotpCredential.findUniqueOrThrow({
        where: { userId: account.id },
      });
      const ciphertext = Buffer.from(stored.secretCiphertext);
      const secret = base32Decode(enrollment.secret);
      // Version (1) + nonce (12) + secret chiffré (20) + sceau (16).
      expect(ciphertext).toHaveLength(49);
      expect(ciphertext[0]).toBe(1);
      expect(secret).not.toBeNull();
      expect(ciphertext.includes(secret ?? Buffer.alloc(0))).toBe(false);
      expect(stored).toMatchObject({ confirmedAt: null, lastUsedStep: null });

      // Tant qu'aucun code n'a confirmé l'enrôlement, rien n'est exigé à la connexion.
      expect((await signIn(user).expect(200)).body.status).toBe('AUTHENTICATED');
      expect((await mfaStatus(tokens.accessToken).expect(200)).body.totp.enabled).toBe(false);

      const audit = await prisma.auditLog.findMany({
        where: { actorId: account.id, action: { startsWith: 'mfa.' } },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => [entry.action, entry.outcome])).toEqual([
        ['mfa.enrollment_failed', 'FAILURE'],
        ['mfa.enrollment_started', 'SUCCESS'],
      ]);
      expect(JSON.stringify(audit)).not.toContain(enrollment.secret);
    });

    it('un code de l’application confirme l’enrôlement : codes de secours remis une fois, autres sessions fermées, titulaire prévenu', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const enrolling = await login(http, user);
      const other = await login(http, user);
      const { secret } = totpEnrollmentSchema.parse(
        (await enroll(enrolling.tokens.accessToken, user.password).expect(200)).body,
      );

      const wrong = await confirm(enrolling.tokens.accessToken, wrongTotpCode(secret)).expect(400);
      expect(problemDetailsSchema.parse(wrong.body).code).toBe('INVALID_OR_EXPIRED_CODE');
      await me(other.tokens.accessToken).expect(200);

      const confirmed = await confirm(enrolling.tokens.accessToken, nextTotpCode(secret)).expect(
        200,
      );
      const { recoveryCodes } = recoveryCodesSchema.parse(confirmed.body);
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const code of recoveryCodes) {
        expect(code).toMatch(RECOVERY_CODE);
      }

      // La session qui a activé le second facteur continue ; les autres, ouvertes avec le seul
      // mot de passe, sont fermées.
      const account = (await me(enrolling.tokens.accessToken).expect(200)).body;
      expect(account.secondFactorEnabled).toBe(true);
      await me(other.tokens.accessToken).expect(401);
      const closed = await prisma.userSession.findUniqueOrThrow({ where: { id: other.sessionId } });
      expect(closed.revocationReason).toBe('SECOND_FACTOR_CHANGED');

      const status = mfaStatusSchema.parse(
        (await mfaStatus(enrolling.tokens.accessToken).expect(200)).body,
      );
      expect(status.totp.enabled).toBe(true);
      expect(status.totp.enabledAt).not.toBeNull();
      expect(status.recoveryCodesRemaining).toBe(10);

      const notice = await nextMessageOf(testApp, user.email, 'two_factor_enabled');
      expect(notice.channel).toBe('EMAIL');

      // Seules les empreintes des codes de secours sont conservées.
      const storedCodes = await prisma.userRecoveryCode.findMany({
        where: { userId: enrolling.user.id },
      });
      expect(storedCodes).toHaveLength(10);
      for (const stored of storedCodes) {
        expect(stored.codeHash).toHaveLength(32);
        expect(stored.usedAt).toBeNull();
      }
      const persisted = JSON.stringify(
        await prisma.auditLog.findMany({ where: { actorId: enrolling.user.id } }),
      );
      for (const code of recoveryCodes) {
        expect(persisted).not.toContain(code);
        expect(persisted).not.toContain(code.replace('-', ''));
      }

      const enabled = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: enrolling.user.id, action: 'mfa.enabled' },
      });
      expect(enabled).toMatchObject({
        outcome: 'SUCCESS',
        metadata: { method: 'TOTP', revokedSessions: 1 },
      });

      // Les codes ne sont remis qu'une fois ; un second facteur en place ne s'écrase pas.
      const again = await confirm(enrolling.tokens.accessToken, nextTotpCode(secret)).expect(409);
      expect(problemDetailsSchema.parse(again.body).code).toBe('CONFLICT');
      await enroll(enrolling.tokens.accessToken, user.password).expect(409);
    });

    it('un enrôlement se confirme dans la demi-heure ; passé ce délai il se recommence', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens, user: account } = await login(http, user);

      const none = await confirm(tokens.accessToken, '123456').expect(409);
      expect(none.body.detail).toBe('No two-step verification setup is in progress.');

      const first = totpEnrollmentSchema.parse(
        (await enroll(tokens.accessToken, user.password).expect(200)).body,
      );
      await prisma.userTotpCredential.update({
        where: { userId: account.id },
        data: { createdAt: new Date(Date.now() - 31 * 60_000) },
      });
      const expired = await confirm(tokens.accessToken, nextTotpCode(first.secret)).expect(409);
      expect(expired.body.detail).toMatch(/expired/);
      expect((await signIn(user).expect(200)).body.status).toBe('AUTHENTICATED');

      // Recommencer donne un nouveau secret : l'ancien ne confirme plus rien.
      const second = totpEnrollmentSchema.parse(
        (await enroll(tokens.accessToken, user.password).expect(200)).body,
      );
      expect(second.secret).not.toBe(first.secret);
      await confirm(tokens.accessToken, nextTotpCode(first.secret)).expect(400);
      await confirm(tokens.accessToken, nextTotpCode(second.secret)).expect(200);
    });

    it('les requêtes mal formées sont refusées avant tout examen', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens } = await login(http, user);

      for (const send of [
        () => enroll(tokens.accessToken, ''),
        () => confirm(tokens.accessToken, '12345'),
        () => confirm(tokens.accessToken, '1234567'),
        () => confirm(tokens.accessToken, 'abcdef'),
      ]) {
        const response = await send().expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      const extra = await http
        .post('/api/v1/me/mfa/totp/enroll')
        .set(bearer(tokens.accessToken))
        .send({ currentPassword: user.password, secret: 'JBSWY3DPEHPK3PXP' })
        .expect(400);
      expect(problemDetailsSchema.parse(extra.body).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('connexion en deux étapes', () => {
    it('le mot de passe ne suffit plus : aucune session n’est ouverte avant le code', async () => {
      const user = await protectedUser();
      const sessionsBefore = await prisma.userSession.count({ where: { userId: user.id } });

      const first = await signIn(user).expect(200);
      const pending = mfaRequiredLoginSchema.parse(first.body);
      expect(Object.keys(first.body).sort()).toEqual([
        'methods',
        'mfaToken',
        'mfaTokenExpiresAt',
        'status',
      ]);
      expect(pending.methods).toEqual(['TOTP', 'RECOVERY_CODE']);
      expect(pending.mfaToken).toMatch(/^mgx_mfa_/);
      const ttlMs = new Date(pending.mfaTokenExpiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(290_000);
      expect(ttlMs).toBeLessThanOrEqual(300_000);
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(sessionsBefore);

      // Le jeton de la connexion en cours n'ouvre aucun droit et expire de lui-même.
      await me(pending.mfaToken).expect(401);
      await http
        .post('/api/v1/auth/refresh')
        .set(from(newClientIp()))
        .send({ refreshToken: pending.mfaToken })
        .expect(401);
      const hash = hashPresentedToken('mfa', pending.mfaToken);
      const key = `pending-login:${Buffer.from(hash ?? []).toString('hex')}`;
      const redis = testApp.app.get(RedisService).client;
      const ttlSeconds = await redis.ttl(key);
      expect(ttlSeconds).toBeGreaterThan(290);
      expect(ttlSeconds).toBeLessThanOrEqual(300);
      // Redis ne détient que l'empreinte du jeton.
      expect(JSON.stringify(await redis.hgetall(key))).not.toContain(pending.mfaToken);

      const second = await secondStep({
        mfaToken: pending.mfaToken,
        code: nextTotpCode(user.totpSecret),
      }).expect(200);
      const session = authenticatedLoginSchema.parse(second.body);
      expect(session.user).toMatchObject({ id: user.id, secondFactorEnabled: true });
      await me(session.tokens.accessToken).expect(200);
      expect(await redis.exists(key)).toBe(0);

      const steps = await prisma.auditLog.findMany({
        where: { actorId: user.id, action: { startsWith: 'session.' } },
        orderBy: { id: 'desc' },
        take: 2,
      });
      expect(steps.map((entry) => entry.action)).toEqual([
        'session.opened',
        'session.second_factor_required',
      ]);
      expect(steps[0]?.metadata).toMatchObject({ secondFactor: 'TOTP', newDevice: false });

      // Le jeton ne sert qu'une fois.
      const reused = await secondStep({
        mfaToken: pending.mfaToken,
        code: nextTotpCode(user.totpSecret),
      }).expect(401);
      expect(problemDetailsSchema.parse(reused.body).code).toBe('UNAUTHENTICATED');
    });

    it('un code n’est accepté qu’une fois, même pour une autre connexion', async () => {
      const user = await protectedUser();
      const code = nextTotpCode(user.totpSecret);

      await secondStep({ mfaToken: await pendingSignIn(user), code }).expect(200);
      const replay = await secondStep({ mfaToken: await pendingSignIn(user), code }).expect(400);
      expect(problemDetailsSchema.parse(replay.body).code).toBe('INVALID_OR_EXPIRED_CODE');

      await secondStep({
        mfaToken: await pendingSignIn(user),
        code: nextTotpCode(user.totpSecret),
      }).expect(200);
    });

    it('le même code présenté au même instant sur quatre connexions n’en ouvre qu’une', async () => {
      const user = await protectedUser();
      const sessionsBefore = await prisma.userSession.count({ where: { userId: user.id } });
      const tokens = [
        await pendingSignIn(user),
        await pendingSignIn(user),
        await pendingSignIn(user),
        await pendingSignIn(user),
      ];
      const code = nextTotpCode(user.totpSecret);

      const responses = await Promise.all(
        tokens.map((mfaToken) => secondStep({ mfaToken, code }).then((response) => response)),
      );

      const outcomes = responses.map(outcomeOf);
      expect(outcomes.sort()).toEqual([
        '400 INVALID_OR_EXPIRED_CODE',
        '400 INVALID_OR_EXPIRED_CODE',
        '400 INVALID_OR_EXPIRED_CODE',
        'OPENED',
      ]);
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
        sessionsBefore + 1,
      );
    });

    it('le même code de secours présenté au même instant sur trois connexions n’en ouvre qu’une', async () => {
      const user = await protectedUser();
      const sessionsBefore = await prisma.userSession.count({ where: { userId: user.id } });
      const tokens = [
        await pendingSignIn(user),
        await pendingSignIn(user),
        await pendingSignIn(user),
      ];
      const recoveryCode = user.recoveryCodes[0];

      const responses = await Promise.all(
        tokens.map((mfaToken) =>
          secondStep({ mfaToken, recoveryCode }).then((response) => response),
        ),
      );

      expect(responses.map(outcomeOf).sort()).toEqual([
        '400 INVALID_OR_EXPIRED_CODE',
        '400 INVALID_OR_EXPIRED_CODE',
        'OPENED',
      ]);
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
        sessionsBefore + 1,
      );
      // Un seul code a été consommé, et son usage n'est inscrit qu'une fois au journal.
      expect(
        await prisma.userRecoveryCode.count({ where: { userId: user.id, usedAt: { not: null } } }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { actorId: user.id, action: 'mfa.recovery_code_used' },
        }),
      ).toBe(1);
    });

    it('une connexion en cours présentée au même instant avec deux preuves valables n’ouvre qu’une session', async () => {
      const user = await protectedUser();
      const sessionsBefore = await prisma.userSession.count({ where: { userId: user.id } });
      const mfaToken = await pendingSignIn(user);

      const responses = await Promise.all([
        secondStep({ mfaToken, code: nextTotpCode(user.totpSecret) }).then((response) => response),
        secondStep({ mfaToken, recoveryCode: user.recoveryCodes[0] }).then((response) => response),
      ]);

      const outcomes = responses.map(outcomeOf);
      expect(outcomes.sort()).toEqual(['401 UNAUTHENTICATED', 'OPENED']);
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
        sessionsBefore + 1,
      );
    });

    it('un code erroné ne ferme pas la connexion en cours ; le code d’un autre compte ne vaut rien', async () => {
      const [user, stranger] = [await protectedUser(), await protectedUser()];
      const mfaToken = await pendingSignIn(user);

      const wrong = await secondStep({ mfaToken, code: wrongTotpCode(user.totpSecret) }).expect(
        400,
      );
      expect(problemDetailsSchema.parse(wrong.body).code).toBe('INVALID_OR_EXPIRED_CODE');
      await secondStep({ mfaToken, code: nextTotpCode(stranger.totpSecret) }).expect(400);
      await secondStep({ mfaToken, recoveryCode: stranger.recoveryCodes[0] }).expect(400);

      await secondStep({ mfaToken, code: nextTotpCode(user.totpSecret) }).expect(200);

      const failures = await prisma.auditLog.findMany({
        where: { actorId: user.id, action: 'session.second_factor_failed' },
        orderBy: { id: 'asc' },
      });
      expect(failures.map((entry) => entry.metadata)).toEqual([
        { reason: 'WRONG_SECOND_FACTOR', method: 'TOTP', blockedSeconds: 0 },
        { reason: 'WRONG_SECOND_FACTOR', method: 'TOTP', blockedSeconds: 0 },
        { reason: 'WRONG_SECOND_FACTOR', method: 'RECOVERY_CODE', blockedSeconds: 0 },
      ]);
    });

    it('la seconde étape exige exactement une preuve, bien formée', async () => {
      const user = await protectedUser();
      const mfaToken = await pendingSignIn(user);

      for (const body of [
        { mfaToken },
        { mfaToken, code: '123456', recoveryCode: user.recoveryCodes[0] },
        { mfaToken, code: '12345' },
        { mfaToken, recoveryCode: 'not a recovery code' },
        { code: '123456' },
        { mfaToken, code: '123456', email: user.email },
      ]) {
        const response = await secondStep(body).expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      // Une requête refusée à la validation ne compte pas pour un essai.
      await secondStep({ mfaToken, code: nextTotpCode(user.totpSecret) }).expect(200);

      const unknown = await secondStep({ mfaToken: 'mgx_mfa_unknown', code: '123456' }).expect(401);
      expect(problemDetailsSchema.parse(unknown.body).code).toBe('UNAUTHENTICATED');
    });

    it('cinq codes erronés épuisent la connexion en cours et bloquent la seconde étape du compte, d’où que viennent les essais', async () => {
      const user = await protectedUser();
      const mfaToken = await pendingSignIn(user);

      for (let failure = 0; failure < 5; failure += 1) {
        await secondStep({ mfaToken, code: wrongTotpCode(user.totpSecret) }).expect(400);
      }
      // Le jeton a été présenté cinq fois : il ne vaut plus rien, même avec le bon code.
      const exhausted = await secondStep({
        mfaToken,
        code: nextTotpCode(user.totpSecret),
      }).expect(401);
      expect(problemDetailsSchema.parse(exhausted.body).code).toBe('UNAUTHENTICATED');

      // Une nouvelle connexion, depuis une autre adresse, bute sur le blocage du compte — bon
      // code ou non, code de secours compris.
      const blocked = await secondStep({
        mfaToken: await pendingSignIn(user),
        code: nextTotpCode(user.totpSecret),
      }).expect(429);
      expect(problemDetailsSchema.parse(blocked.body).code).toBe('RATE_LIMITED');
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(840);
      expect(retryAfter).toBeLessThanOrEqual(900);
      await secondStep({
        mfaToken: await pendingSignIn(user),
        recoveryCode: user.recoveryCodes[0],
      }).expect(429);
      expect(
        await prisma.userRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      ).toBe(10);

      // Quelqu'un connaît le mot de passe : le titulaire en est averti, une seule fois.
      const notice = await nextMessageOf(testApp, user.email, 'second_factor_blocked');
      expect(notice.text).toContain('15 minutes');
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(user.email)
          .filter((message) => message.template === 'second_factor_blocked'),
      ).toHaveLength(1);

      const last = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: user.id, action: 'session.second_factor_failed' },
        orderBy: { id: 'desc' },
      });
      expect(last.metadata).toMatchObject({ method: 'TOTP', blockedSeconds: 900 });

      // La session déjà ouverte n'est pas touchée : seul le franchissement de la seconde étape l'est.
      await me(user.session.tokens.accessToken).expect(200);

      // Le blocage levé, le titulaire se connecte normalement.
      await testApp.app.get(SecondFactorThrottle).clear(user.id);
      await login(http, user);
    });

    it('vingt codes erronés en 24 heures bloquent la seconde étape pour 24 heures, même entrecoupés de connexions réussies', async () => {
      const user = await protectedUser();
      const attempt = async (code: string, expected: number) => {
        const response = await secondStep({ mfaToken: await pendingSignIn(user), code });
        expect(response.status).toBe(expected);
        return response;
      };

      // Quatre échecs puis un succès : la rafale est effacée à chaque fois, jamais de blocage court.
      for (let round = 0; round < 4; round += 1) {
        for (let failure = 0; failure < 4; failure += 1) {
          await attempt(wrongTotpCode(user.totpSecret), 400);
        }
        await attempt(nextTotpCode(user.totpSecret), 200);
      }
      for (let failure = 0; failure < 4; failure += 1) {
        await attempt(wrongTotpCode(user.totpSecret), 400);
      }

      // Le vingtième échec a déclenché le blocage long, que le bon code ne lève pas.
      const blocked = await attempt(nextTotpCode(user.totpSecret), 429);
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(23 * 3600);
      expect(retryAfter).toBeLessThanOrEqual(24 * 3600);

      const notice = await nextMessageOf(testApp, user.email, 'second_factor_blocked');
      expect(notice.text).toContain('24 heures');
      await backgroundWorkDone(testApp);
      expect(
        mailbox(testApp)
          .messagesFor(user.email)
          .filter((message) => message.template === 'second_factor_blocked'),
      ).toHaveLength(1);
      const failures = await prisma.auditLog.count({
        where: { actorId: user.id, action: 'session.second_factor_failed' },
      });
      expect(failures).toBe(20);
    });

    it('un code de secours remplace l’application, une seule fois, et le titulaire en est prévenu', async () => {
      const user = await protectedUser();
      const [first, second] = user.recoveryCodes;
      if (first === undefined || second === undefined) {
        throw new Error('Recovery codes are missing.');
      }

      const session = authenticatedLoginSchema.parse(
        (await secondStep({ mfaToken: await pendingSignIn(user), recoveryCode: first }).expect(200))
          .body,
      );
      const status = mfaStatusSchema.parse(
        (await mfaStatus(session.tokens.accessToken).expect(200)).body,
      );
      expect(status.recoveryCodesRemaining).toBe(9);

      const notice = await nextMessageOf(testApp, user.email, 'recovery_code_used');
      expect(notice.text).toContain('Codes de secours restants : 9.');
      const used = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: user.id, action: 'mfa.recovery_code_used' },
      });
      expect(used.metadata).toEqual({ remaining: 9 });
      const opened = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: user.id, action: 'session.opened', resourceId: session.sessionId },
      });
      expect(opened.metadata).toMatchObject({ secondFactor: 'RECOVERY_CODE' });

      const reused = await secondStep({
        mfaToken: await pendingSignIn(user),
        recoveryCode: first,
      }).expect(400);
      expect(problemDetailsSchema.parse(reused.body).code).toBe('INVALID_OR_EXPIRED_CODE');

      // Saisi à la main : minuscules, espaces, tiret oublié — et « O » pour « 0 ».
      const typed = ` ${second.toLowerCase().replace('-', ' ').replace(/0/g, 'o')} `;
      await secondStep({ mfaToken: await pendingSignIn(user), recoveryCode: typed }).expect(200);
      expect(
        await prisma.userRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      ).toBe(8);
    });

    it('réinitialiser le mot de passe annule la connexion en cours mais ne retire pas le second facteur', async () => {
      const user = await protectedUser();
      const stale = await pendingSignIn(user);

      const ip = newClientIp();
      await http
        .post('/api/v1/auth/password/forgot')
        .set(from(ip))
        .send({ email: user.email })
        .expect(202);
      const code = codeIn(await nextMessageOf(testApp, user.email, 'password_reset_code'));
      const newPassword = 'a-brand-new-password-9';
      await http
        .post('/api/v1/auth/password/reset')
        .set(from(ip))
        .send({ email: user.email, code, newPassword })
        .expect(204);

      // La connexion ouverte avec l'ancien mot de passe ne s'achève plus…
      await secondStep({ mfaToken: stale, code: nextTotpCode(user.totpSecret) }).expect(401);
      // …et l'accès à la boîte aux lettres ne suffit pas : le second facteur est toujours exigé.
      const renewed = { ...user, password: newPassword };
      expect((await signIn(renewed).expect(200)).body.status).toBe('MFA_REQUIRED');
      await login(http, renewed);
      expect(await prisma.userTotpCredential.count({ where: { userId: user.id } })).toBe(1);
    });

    it('changer de mot de passe annule aussi les connexions en cours', async () => {
      const user = await protectedUser();
      const stale = await pendingSignIn(user);

      await http
        .post('/api/v1/auth/password/change')
        .set(bearer(user.session.tokens.accessToken))
        .set(from(newClientIp()))
        .send({ currentPassword: user.password, newPassword: 'a-brand-new-password-9' })
        .expect(204);

      await secondStep({ mfaToken: stale, code: nextTotpCode(user.totpSecret) }).expect(401);
    });

    it('un compte suspendu entre les deux étapes ne se connecte pas', async () => {
      const user = await protectedUser();
      const mfaToken = await pendingSignIn(user);
      await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

      const refused = await secondStep({
        mfaToken,
        code: nextTotpCode(user.totpSecret),
      }).expect(401);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('UNAUTHENTICATED');
      // Le code n'a pas été examiné : il n'est pas consommé, et aucun essai n'est compté.
      expect(
        await prisma.auditLog.count({
          where: { actorId: user.id, action: 'session.second_factor_failed' },
        }),
      ).toBe(0);
    });
  });

  describe('gestion du second facteur', () => {
    it('désactiver exige le mot de passe et une preuve du second facteur', async () => {
      const user = await protectedUser();
      const { accessToken } = user.session.tokens;
      const other = await login(http, user);

      const noPassword = await disable(accessToken, {
        currentPassword: 'not-the-password-1',
        code: nextTotpCode(user.totpSecret),
      }).expect(401);
      expect(problemDetailsSchema.parse(noPassword.body).code).toBe('INVALID_CREDENTIALS');
      for (const body of [
        { currentPassword: user.password },
        { currentPassword: user.password, code: '123456', recoveryCode: user.recoveryCodes[0] },
        { code: nextTotpCode(user.totpSecret) },
      ]) {
        const response = await disable(accessToken, body).expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      const wrongCode = await disable(accessToken, {
        currentPassword: user.password,
        code: wrongTotpCode(user.totpSecret),
      }).expect(400);
      expect(problemDetailsSchema.parse(wrongCode.body).code).toBe('INVALID_OR_EXPIRED_CODE');
      expect((await mfaStatus(accessToken).expect(200)).body.totp.enabled).toBe(true);

      await disable(accessToken, {
        currentPassword: user.password,
        code: nextTotpCode(user.totpSecret),
      }).expect(204);

      expect((await mfaStatus(accessToken).expect(200)).body).toEqual({
        totp: { enabled: false, enabledAt: null },
        recoveryCodesRemaining: 0,
      });
      expect(await prisma.userTotpCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(await prisma.userRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
      await me(other.tokens.accessToken).expect(401);
      expect((await signIn(user).expect(200)).body.status).toBe('AUTHENTICATED');

      const notice = await nextMessageOf(testApp, user.email, 'two_factor_disabled');
      expect(notice.subject).toContain('désactivée');
      const audit = await prisma.auditLog.findMany({
        where: { actorId: user.id, action: { in: ['mfa.disabled', 'mfa.disable_failed'] } },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => [entry.action, entry.outcome])).toEqual([
        ['mfa.disable_failed', 'FAILURE'],
        ['mfa.disable_failed', 'FAILURE'],
        ['mfa.disabled', 'SUCCESS'],
      ]);

      const absent = await disable(accessToken, {
        currentPassword: user.password,
        code: '123456',
      }).expect(409);
      expect(problemDetailsSchema.parse(absent.body).code).toBe('CONFLICT');
    });

    it('un code de secours permet aussi de désactiver ; le second facteur se réactive ensuite avec un nouveau secret', async () => {
      const user = await protectedUser();
      const { accessToken } = user.session.tokens;

      await disable(accessToken, {
        currentPassword: user.password,
        recoveryCode: user.recoveryCodes[3],
      }).expect(204);

      const again = totpEnrollmentSchema.parse(
        (await enroll(accessToken, user.password).expect(200)).body,
      );
      expect(again.secret).not.toBe(user.totpSecret);
      const fresh = recoveryCodesSchema.parse(
        (await confirm(accessToken, nextTotpCode(again.secret)).expect(200)).body,
      );
      expect(fresh.recoveryCodes).toHaveLength(10);
      expect(fresh.recoveryCodes.filter((code) => user.recoveryCodes.includes(code))).toEqual([]);

      // L'ancien secret et les anciens codes de secours ne valent plus rien.
      const renewed = { ...user, totpSecret: again.secret };
      await secondStep({
        mfaToken: await pendingSignIn(user),
        code: nextTotpCode(user.totpSecret),
      }).expect(400);
      await secondStep({
        mfaToken: await pendingSignIn(user),
        recoveryCode: user.recoveryCodes[0],
      }).expect(400);
      await login(http, renewed);
    });

    it('régénérer les codes de secours exige mot de passe et code, et invalide les précédents', async () => {
      const user = await protectedUser();
      const { accessToken } = user.session.tokens;
      const [old] = user.recoveryCodes;

      await regenerate(accessToken, {
        currentPassword: 'not-the-password-1',
        code: nextTotpCode(user.totpSecret),
      }).expect(401);
      await regenerate(accessToken, {
        currentPassword: user.password,
        code: wrongTotpCode(user.totpSecret),
      }).expect(400);
      // Un code de secours ne sert pas à en obtenir d'autres.
      await regenerate(accessToken, {
        currentPassword: user.password,
        recoveryCode: old,
      }).expect(400);

      const { recoveryCodes } = recoveryCodesSchema.parse(
        (
          await regenerate(accessToken, {
            currentPassword: user.password,
            code: nextTotpCode(user.totpSecret),
          }).expect(200)
        ).body,
      );
      expect(recoveryCodes).toHaveLength(10);
      expect(recoveryCodes.filter((code) => user.recoveryCodes.includes(code))).toEqual([]);
      expect((await mfaStatus(accessToken).expect(200)).body.recoveryCodesRemaining).toBe(10);

      await secondStep({ mfaToken: await pendingSignIn(user), recoveryCode: old }).expect(400);
      await secondStep({
        mfaToken: await pendingSignIn(user),
        recoveryCode: recoveryCodes[0],
      }).expect(200);

      // Régénérer n'a pas de sens sans second facteur.
      const plain = await registerVerifiedUser(http, testApp);
      const plainSession = await login(http, plain);
      await regenerate(plainSession.tokens.accessToken, {
        currentPassword: plain.password,
        code: '123456',
      }).expect(409);
    });

    it('cinq mots de passe erronés bloquent les opérations sensibles du compte', async () => {
      const user = await protectedUser();
      const { accessToken } = user.session.tokens;

      for (let failure = 0; failure < 5; failure += 1) {
        await disable(accessToken, {
          currentPassword: 'not-the-password-1',
          code: '123456',
        }).expect(401);
      }
      const blocked = await disable(accessToken, {
        currentPassword: user.password,
        code: nextTotpCode(user.totpSecret),
      }).expect(429);
      expect(problemDetailsSchema.parse(blocked.body).code).toBe('RATE_LIMITED');
      expect((await mfaStatus(accessToken).expect(200)).body.totp.enabled).toBe(true);
    });
  });

  describe('back-office et maintenance', () => {
    it('le back-office exige la validation en deux étapes : un mot de passe d’administrateur ne suffit pas', async () => {
      const admin = await createAdmin(testApp, { secondFactor: false });
      const session = await login(http, admin);
      expect(session.user.permissions).toContain('system_settings.read');
      const settings = () =>
        http
          .get('/api/v1/admin/system-settings')
          .set(bearer(session.tokens.accessToken))
          .set(from(newClientIp()));

      const refused = await settings().expect(403);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('MFA_ENROLLMENT_REQUIRED');
      const denial = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: admin.id, action: 'authorization.denied' },
      });
      expect(denial).toMatchObject({
        outcome: 'DENIED',
        resourceId: 'GET /api/v1/admin/system-settings',
        metadata: { reason: 'SECOND_FACTOR_NOT_ENABLED' },
      });

      // Un enrôlement inachevé ne suffit pas non plus.
      const { secret } = totpEnrollmentSchema.parse(
        (await enroll(session.tokens.accessToken, admin.password).expect(200)).body,
      );
      await settings().expect(403);

      await confirm(session.tokens.accessToken, nextTotpCode(secret)).expect(200);
      await settings().expect(200);
    });

    it('la gestion du second facteur reste accessible pendant la maintenance — c’est par elle qu’un administrateur en sort', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens } = await login(http, user);
      const settings = testApp.app.get(SystemSettingsService);
      await settings.set(
        'maintenance.mode',
        { enabled: true, message: null },
        { actor: SYSTEM, reason: 'test: maintenance window' },
      );
      try {
        const blocked = await http
          .get('/api/v1/me/profile')
          .set(bearer(tokens.accessToken))
          .expect(503);
        expect(problemDetailsSchema.parse(blocked.body).code).toBe('MAINTENANCE');

        await mfaStatus(tokens.accessToken).expect(200);
        const { secret } = totpEnrollmentSchema.parse(
          (await enroll(tokens.accessToken, user.password).expect(200)).body,
        );
        await confirm(tokens.accessToken, nextTotpCode(secret)).expect(200);
        // La connexion, seconde étape comprise, reste possible elle aussi.
        await login(http, { ...user, totpSecret: secret });
      } finally {
        await settings.set(
          'maintenance.mode',
          { enabled: false, message: null },
          { actor: SYSTEM, reason: 'test: maintenance over' },
        );
      }
    });

    it('le code reçu par e-mail pour un autre usage ne sert pas de second facteur', async () => {
      const user = await protectedUser();
      await http
        .post('/api/v1/auth/password/forgot')
        .set(from(newClientIp()))
        .send({ email: user.email })
        .expect(202);
      const emailed = codeIn(await nextMessageOf(testApp, user.email, 'password_reset_code'));

      // Six chiffres eux aussi, mais d'une autre nature : seul le hasard les ferait coïncider
      // avec un code de l'application d'authentification.
      const mfaToken = await pendingSignIn(user);
      const coincidence = emailed !== wrongTotpCode(user.totpSecret) && isCurrentCode(emailed);
      if (!coincidence) {
        await secondStep({ mfaToken, code: emailed }).expect(400);
      }
      await secondStep({ mfaToken, code: nextTotpCode(user.totpSecret) }).expect(200);

      function isCurrentCode(code: string): boolean {
        // `wrongTotpCode` écarte les codes des pas voisins : s'il rend autre chose que « 000000 »,
        // ou si le code reçu vaut « 000000 », on ne peut rien affirmer — le test s'abstient.
        return code === '000000' || wrongTotpCode(user.totpSecret) !== '000000';
      }
    });
  });
});
