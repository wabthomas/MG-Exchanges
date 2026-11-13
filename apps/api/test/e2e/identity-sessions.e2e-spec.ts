import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { refreshResponseSchema, sessionListSchema, type TokenPair } from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { PasswordHasher } from '../../src/modules/identity/application/password-hasher.js';
import { Argon2PasswordHasher } from '../../src/modules/identity/infrastructure/argon2-password-hasher.js';
import {
  backgroundWorkDone,
  bearer,
  from,
  type Http,
  login,
  mailbox,
  newClientIp,
  newEmail,
  nextCode,
  nextMessage,
  openFeature,
  PASSWORD,
  type RegisteredUser,
  registerVerifiedUser,
} from '../support/identity.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe('Connexion, sessions et mot de passe — bout en bout', () => {
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

  const attempt = (email: string, password: string, ip: string) =>
    http.post('/api/v1/auth/login').set(from(ip)).send({ email, password });
  const refresh = (refreshToken: string) =>
    http.post('/api/v1/auth/refresh').set(from(newClientIp())).send({ refreshToken });
  const me = (accessToken: string) => http.get('/api/v1/me').set(bearer(accessToken));
  const userId = async (email: string): Promise<string> =>
    (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

  describe('connexion', () => {
    let user: RegisteredUser;

    beforeAll(async () => {
      user = await registerVerifiedUser(http, testApp);
    });

    it('adresse inconnue et mot de passe erroné reçoivent exactement la même réponse', async () => {
      const unknown = await attempt(newEmail('ghost'), PASSWORD, newClientIp()).expect(401);
      const wrong = await attempt(user.email, 'not-the-password-1', newClientIp()).expect(401);

      const essence = ({ body, headers }: typeof unknown) => ({
        code: body.code,
        title: body.title,
        detail: body.detail,
        challenge: headers['www-authenticate'],
      });
      expect(essence(wrong)).toEqual(essence(unknown));
      expect(essence(unknown)).toEqual({
        code: 'INVALID_CREDENTIALS',
        title: 'Unauthorized',
        detail: 'Invalid email or password.',
        challenge: 'Bearer',
      });
    });

    it('cinq échecs bloquent ce client un quart d’heure — même avec le bon mot de passe ensuite', async () => {
      const ip = newClientIp();
      for (let failure = 0; failure < 5; failure += 1) {
        await attempt(user.email, 'not-the-password-1', ip).expect(401);
      }

      const blocked = await attempt(user.email, user.password, ip).expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(14 * 60);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);

      // Le blocage vise ce client : depuis une autre adresse, le titulaire se connecte.
      await attempt(user.email, user.password, newClientIp()).expect(200);
    });

    it('une adresse inconnue est bloquée de la même façon : le blocage ne révèle rien', async () => {
      const ip = newClientIp();
      const ghost = newEmail('ghost');
      for (let failure = 0; failure < 5; failure += 1) {
        await attempt(ghost, 'not-the-password-1', ip).expect(401);
      }
      const blocked = await attempt(ghost, 'not-the-password-1', ip).expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
    });

    it('vingt échecs depuis des adresses différentes bloquent le compte pour tous', async () => {
      const target = await registerVerifiedUser(http, testApp);
      for (let failure = 0; failure < 20; failure += 1) {
        await attempt(target.email, 'not-the-password-1', newClientIp()).expect(401);
      }
      await attempt(target.email, target.password, newClientIp()).expect(429);
    });

    it('une connexion réussie remet le compteur de ce client à zéro', async () => {
      const ip = newClientIp();
      for (let round = 0; round < 3; round += 1) {
        for (let failure = 0; failure < 4; failure += 1) {
          await attempt(user.email, 'not-the-password-1', ip).expect(401);
        }
        await attempt(user.email, user.password, ip).expect(200);
      }
    });

    it('l’état du compte n’est indiqué qu’à qui présente le bon mot de passe', async () => {
      const suspended = await registerVerifiedUser(http, testApp);
      await prisma.user.update({
        where: { email: suspended.email },
        data: { status: 'SUSPENDED' },
      });

      const wrong = await attempt(suspended.email, 'not-the-password-1', newClientIp()).expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

      const right = await attempt(suspended.email, suspended.password, newClientIp()).expect(403);
      expect(right.body.code).toBe('ACCOUNT_DISABLED');
      expect(await prisma.userSession.count({ where: { user: { email: suspended.email } } })).toBe(
        0,
      );
    });

    it('une empreinte calculée avec d’anciens paramètres est recalculée à la connexion', async () => {
      const legacy = await registerVerifiedUser(http, testApp);
      const id = await userId(legacy.email);
      const weaker = new Argon2PasswordHasher({ memoryKib: 32, passes: 1 });
      await prisma.userCredential.update({
        where: { userId: id },
        data: { passwordHash: await weaker.hash(legacy.password) },
      });
      const before = await prisma.userCredential.findUniqueOrThrow({ where: { userId: id } });
      expect(before.passwordHash).toContain('$m=32,t=1,p=1$');

      await login(http, legacy);

      const after = await prisma.userCredential.findUniqueOrThrow({ where: { userId: id } });
      expect(after.passwordHash).toContain('$m=64,t=1,p=1$');
      expect(testApp.app.get(PasswordHasher).needsRehash(after.passwordHash)).toBe(false);
      // Ce n'est pas un changement de mot de passe.
      expect(after.passwordChangedAt).toEqual(before.passwordChangedAt);
      await login(http, legacy);
    });

    it('une adresse de client invalide ou un agent utilisateur démesuré ne font pas échouer la connexion', async () => {
      const response = await http
        .post('/api/v1/auth/login')
        .set({ 'X-Forwarded-For': 'not-an-address', 'User-Agent': 'x'.repeat(4000) })
        .send({ email: user.email, password: user.password })
        .expect(200);

      const session = await prisma.userSession.findUniqueOrThrow({
        where: { id: response.body.sessionId as string },
      });
      expect(session.ipAddress).toBeNull();
      expect(session.userAgent).toHaveLength(512);
    });

    it('les échecs sont inscrits à l’audit sans l’adresse saisie', async () => {
      const ghost = newEmail('audited-ghost');
      await attempt(ghost, 'not-the-password-1', newClientIp()).expect(401);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'session.login_failed', actorType: 'SYSTEM' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(entry.metadata).toMatchObject({ reason: 'UNKNOWN_ACCOUNT' });
      expect(JSON.stringify(entry)).not.toContain(ghost);
    });
  });

  describe('jetons de session', () => {
    let user: RegisteredUser;

    beforeAll(async () => {
      user = await registerVerifiedUser(http, testApp);
    });

    it('seules des empreintes sont stockées : aucun jeton en base', async () => {
      const { tokens, sessionId } = await login(http, user);
      const stored = await prisma.sessionToken.findMany({ where: { sessionId } });

      const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
      expect(stored).toHaveLength(1);
      expect(Buffer.from(stored[0]!.accessTokenHash).toString('hex')).toBe(
        sha256(tokens.accessToken),
      );
      expect(Buffer.from(stored[0]!.refreshTokenHash).toString('hex')).toBe(
        sha256(tokens.refreshToken),
      );
      const dump = JSON.stringify(
        await prisma.$queryRaw`SELECT s::text AS session, t::text AS token
                               FROM user_sessions s JOIN session_tokens t ON t.session_id = s.id
                               WHERE s.id = ${sessionId}::uuid`,
      );
      expect(dump).not.toContain(tokens.accessToken.slice(7));
      expect(dump).not.toContain(tokens.refreshToken.slice(7));
    });

    it('le renouvellement remplace la paire de jetons et prolonge la session', async () => {
      const { tokens, sessionId } = await login(http, user);
      const before = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });

      const response = await refresh(tokens.refreshToken).expect(200);
      const renewed = refreshResponseSchema.parse(response.body).tokens;

      expect(renewed.accessToken).not.toBe(tokens.accessToken);
      expect(renewed.refreshToken).not.toBe(tokens.refreshToken);
      await me(renewed.accessToken).expect(200);

      const after = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(after.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.lastUsedAt.getTime());
      expect(after.idleExpiresAt.getTime()).toBeGreaterThanOrEqual(before.idleExpiresAt.getTime());
      expect(after.expiresAt).toEqual(before.expiresAt);
    });

    it('un jeton d’un type ne vaut pas pour l’autre', async () => {
      const { tokens } = await login(http, user);
      await me(tokens.refreshToken).expect(401);
      await refresh(tokens.accessToken).expect(401);
    });

    it('réponse perdue : le même jeton représenté dans les secondes qui suivent est accepté', async () => {
      const { tokens } = await login(http, user);
      const first = await refresh(tokens.refreshToken).expect(200);
      const retry = await refresh(tokens.refreshToken).expect(200);

      // Les deux paires émises fonctionnent : le client garde celle qu'il a reçue.
      await me((first.body.tokens as TokenPair).accessToken).expect(200);
      await me((retry.body.tokens as TokenPair).accessToken).expect(200);
      await refresh((retry.body.tokens as TokenPair).refreshToken).expect(200);
    });

    it('dix renouvellements simultanés avec le même jeton réussissent tous, sans incohérence', async () => {
      const { tokens, sessionId } = await login(http, user);
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => refresh(tokens.refreshToken)),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));

      const pairs = await prisma.sessionToken.findMany({ where: { sessionId } });
      expect(pairs).toHaveLength(11);
      expect(pairs.filter((pair) => pair.consumedAt !== null)).toHaveLength(1);
      expect(
        (await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } })).revokedAt,
      ).toBeNull();
    });

    it('un jeton de renouvellement déjà utilisé, représenté plus tard, révoque toute la session', async () => {
      const { tokens, sessionId } = await login(http, user);
      const renewed = (await refresh(tokens.refreshToken).expect(200)).body.tokens as TokenPair;

      // Le délai de tolérance est écoulé : le jeton d'origine a été copié.
      await prisma.sessionToken.updateMany({
        where: { sessionId, consumedAt: { not: null } },
        data: { consumedAt: new Date(Date.now() - 60_000) },
      });

      await refresh(tokens.refreshToken).expect(401);

      // Le voleur comme le titulaire perdent l'accès : la paire la plus récente est morte aussi.
      await me(renewed.accessToken).expect(401);
      await refresh(renewed.refreshToken).expect(401);

      const session = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.revocationReason).toBe('TOKEN_REUSE');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'session.refresh_token_reused', resourceId: sessionId },
      });
      expect(audit.outcome).toBe('DENIED');

      // Les autres sessions du compte ne sont pas touchées.
      await login(http, user);
    });

    it('les paires renouvelées depuis plus de 24 heures sont supprimées au renouvellement suivant', async () => {
      const { tokens, sessionId } = await login(http, user);
      const second = (await refresh(tokens.refreshToken).expect(200)).body.tokens as TokenPair;
      await prisma.sessionToken.updateMany({
        where: { sessionId, consumedAt: { not: null } },
        data: { consumedAt: new Date(Date.now() - 25 * 3600_000) },
      });

      await refresh(second.refreshToken).expect(200);

      const pairs = await prisma.sessionToken.findMany({ where: { sessionId } });
      expect(pairs).toHaveLength(2);
      // Trop ancien pour être reconnu : simplement refusé, sans révoquer la session.
      await refresh(tokens.refreshToken).expect(401);
      expect(
        (await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } })).revokedAt,
      ).toBeNull();
    });

    it('un jeton d’accès expiré est refusé ; le renouvellement reste possible', async () => {
      const { tokens, sessionId } = await login(http, user);
      await prisma.sessionToken.updateMany({
        where: { sessionId },
        data: { accessExpiresAt: new Date(Date.now() - 1000) },
      });

      await me(tokens.accessToken).expect(401);
      const renewed = (await refresh(tokens.refreshToken).expect(200)).body.tokens as TokenPair;
      await me(renewed.accessToken).expect(200);
    });

    it.each([
      ['inactivité', { idleExpiresAt: new Date(Date.now() - 1000) }],
      [
        'durée de vie maximale',
        {
          createdAt: new Date(Date.now() - 3600_000),
          idleExpiresAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() - 1000),
        },
      ],
    ])('une session expirée (%s) n’ouvre plus aucun droit', async (_label, expiry) => {
      const { tokens, sessionId } = await login(http, user);
      await prisma.userSession.update({ where: { id: sessionId }, data: expiry });

      await me(tokens.accessToken).expect(401);
      await refresh(tokens.refreshToken).expect(401);
    });

    it('la suspension du compte prend effet immédiatement sur les sessions ouvertes', async () => {
      const victim = await registerVerifiedUser(http, testApp);
      const { tokens } = await login(http, victim);
      await me(tokens.accessToken).expect(200);

      await prisma.user.update({ where: { email: victim.email }, data: { status: 'SUSPENDED' } });

      await me(tokens.accessToken).expect(401);
      await refresh(tokens.refreshToken).expect(401);
    });

    it('le nom du schéma d’authentification est insensible à la casse', async () => {
      const { tokens } = await login(http, user);
      await http
        .get('/api/v1/me')
        .set({ Authorization: `bearer ${tokens.accessToken}` })
        .expect(200);
      await http
        .get('/api/v1/me')
        .set({ Authorization: `BEARER ${tokens.accessToken}` })
        .expect(200);
    });

    it.each([
      ['absent', {}],
      ['vide', { Authorization: 'Bearer ' }],
      ['autre schéma', { Authorization: 'Basic dXNlcjpwYXNz' }],
      ['mal formé', { Authorization: 'Bearer mgx_at_too-short' }],
      ['inconnu', { Authorization: `Bearer mgx_at_${'A'.repeat(43)}` }],
      ['injection', { Authorization: "Bearer ' OR 1=1 --" }],
    ])('jeton d’accès %s : 401', async (_label, headers) => {
      const response = await http.get('/api/v1/me').set(headers).expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });
  });

  describe('gestion de ses sessions', () => {
    it('liste ses appareils, en ferme un, puis tous les autres', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const phone = await login(http, user, { deviceName: 'Téléphone de Jean' });
      const laptop = await login(http, user, { deviceName: 'Ordinateur' });
      const tablet = await login(http, user);

      const listed = sessionListSchema.parse(
        (await http.get('/api/v1/me/sessions').set(bearer(phone.tokens.accessToken)).expect(200))
          .body,
      );
      expect(listed.sessions).toHaveLength(3);
      expect(listed.sessions.filter((session) => session.current).map((s) => s.id)).toEqual([
        phone.sessionId,
      ]);
      expect(listed.sessions.map((session) => session.deviceName).sort()).toEqual(
        ['Ordinateur', 'Téléphone de Jean', null].sort(),
      );
      expect(listed.sessions.every((session) => session.ipAddress?.startsWith('198.51.'))).toBe(
        true,
      );

      // Ferme l'ordinateur depuis le téléphone : effet immédiat.
      await http
        .delete(`/api/v1/me/sessions/${laptop.sessionId}`)
        .set(bearer(phone.tokens.accessToken))
        .expect(204);
      await me(laptop.tokens.accessToken).expect(401);
      await refresh(laptop.tokens.refreshToken).expect(401);
      await me(tablet.tokens.accessToken).expect(200);

      // Une session déjà fermée, ou inexistante, n'existe plus pour l'appelant.
      await http
        .delete(`/api/v1/me/sessions/${laptop.sessionId}`)
        .set(bearer(phone.tokens.accessToken))
        .expect(404);
      await http
        .delete('/api/v1/me/sessions/not-a-uuid')
        .set(bearer(phone.tokens.accessToken))
        .expect(400);

      const others = await http
        .post('/api/v1/me/sessions/revoke-others')
        .set(bearer(phone.tokens.accessToken))
        .expect(200);
      expect(others.body).toEqual({ revoked: 1 });
      await me(tablet.tokens.accessToken).expect(401);
      await me(phone.tokens.accessToken).expect(200);
    });

    it('la session d’un autre compte est introuvable : ni lisible, ni révocable', async () => {
      const alice = await registerVerifiedUser(http, testApp);
      const mallory = await registerVerifiedUser(http, testApp);
      const aliceSession = await login(http, alice);
      const mallorySession = await login(http, mallory);

      await http
        .delete(`/api/v1/me/sessions/${aliceSession.sessionId}`)
        .set(bearer(mallorySession.tokens.accessToken))
        .expect(404);
      await me(aliceSession.tokens.accessToken).expect(200);

      const listed = await http
        .get('/api/v1/me/sessions')
        .set(bearer(mallorySession.tokens.accessToken))
        .expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(aliceSession.sessionId);
    });

    it('la déconnexion ferme la session : jetons d’accès et de renouvellement meurent ensemble', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens, sessionId } = await login(http, user);

      await http.post('/api/v1/auth/logout').set(bearer(tokens.accessToken)).expect(204);

      await me(tokens.accessToken).expect(401);
      await refresh(tokens.refreshToken).expect(401);
      const session = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.revocationReason).toBe('LOGOUT');
      await http.post('/api/v1/auth/logout').set(bearer(tokens.accessToken)).expect(401);
    });
  });

  describe('mot de passe oublié', () => {
    const forgot = (email: string) =>
      http.post('/api/v1/auth/password/forgot').set(from(newClientIp())).send({ email });
    const reset = (email: string, code: string, newPassword: string) =>
      http
        .post('/api/v1/auth/password/reset')
        .set(from(newClientIp()))
        .send({ email, code, newPassword });

    it('même réponse que le compte existe ou non ; seul un compte existant reçoit un code', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const ghost = newEmail('ghost');

      const known = await forgot(user.email).expect(202);
      const unknown = await forgot(ghost).expect(202);
      expect(unknown.body).toEqual(known.body);
      expect(known.body).toEqual({ nextStep: 'RESET_PASSWORD', codeTtlSeconds: 900 });

      const message = await nextMessage(testApp, user.email, 1);
      expect(message.template).toBe('password_reset_code');
      expect(mailbox(testApp).messagesFor(ghost)).toHaveLength(0);

      const wrongKnown = await reset(user.email, '000000', 'a-brand-new-password-9').expect(400);
      const wrongUnknown = await reset(ghost, '000000', 'a-brand-new-password-9').expect(400);
      expect(wrongUnknown.body.code).toBe('INVALID_OR_EXPIRED_CODE');
      expect(wrongUnknown.body.detail).toBe(wrongKnown.body.detail);
    });

    it('le code remplace le mot de passe, ferme toutes les sessions et prévient le titulaire', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const stolen = await login(http, user);
      const own = await login(http, user);

      await forgot(user.email).expect(202);
      const code = await nextCode(testApp, user.email, 1);
      const newPassword = 'a-brand-new-password-9';
      await reset(user.email, code, newPassword).expect(204);

      await me(stolen.tokens.accessToken).expect(401);
      await me(own.tokens.accessToken).expect(401);
      await refresh(own.tokens.refreshToken).expect(401);
      await attempt(user.email, user.password, newClientIp()).expect(401);
      await login(http, { email: user.email, password: newPassword });

      const notice = await nextMessage(testApp, user.email, 2);
      expect(notice.template).toBe('password_changed');

      // Le code ne sert qu'une fois.
      await reset(user.email, code, 'yet-another-password-3').expect(400);
      await login(http, { email: user.email, password: newPassword });

      const sessions = await prisma.userSession.findMany({
        where: { id: { in: [stolen.sessionId, own.sessionId] } },
      });
      expect(sessions.map((session) => session.revocationReason)).toEqual([
        'PASSWORD_RESET',
        'PASSWORD_RESET',
      ]);
    });

    it('le nouveau mot de passe est soumis aux mêmes règles ; un refus ne consomme pas le code', async () => {
      const user = await registerVerifiedUser(http, testApp);
      await forgot(user.email).expect(202);
      const code = await nextCode(testApp, user.email, 1);

      const common = await reset(user.email, code, 'password123').expect(400);
      expect(common.body.errors).toEqual([
        {
          path: 'newPassword',
          message: 'This password is too common. Choose a less predictable one.',
        },
      ]);
      // Le refus précède tout examen du code : aucun essai n'est compté…
      const challenge = await prisma.verificationChallenge.findFirstOrThrow({
        where: { user: { email: user.email }, purpose: 'PASSWORD_RESET' },
      });
      expect(challenge.attempts).toBe(0);
      // …et la réponse est la même pour une adresse inconnue.
      const unknown = await reset(newEmail('ghost'), code, 'password123').expect(400);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');
      expect(unknown.body.errors).toEqual(common.body.errors);

      await reset(user.email, code, 'a-brand-new-password-9').expect(204);
    });

    it('cinq essais erronés invalident le code de réinitialisation', async () => {
      const user = await registerVerifiedUser(http, testApp);
      await forgot(user.email).expect(202);
      const code = await nextCode(testApp, user.email, 1);
      const wrong = code === '111111' ? '222222' : '111111';

      for (let failure = 0; failure < 5; failure += 1) {
        await reset(user.email, wrong, 'a-brand-new-password-9').expect(400);
      }
      await reset(user.email, code, 'a-brand-new-password-9').expect(400);
      await login(http, user);
    });

    it('réinitialiser débloque le compte verrouillé par des essais erronés', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const ip = newClientIp();
      for (let failure = 0; failure < 5; failure += 1) {
        await attempt(user.email, 'not-the-password-1', ip).expect(401);
      }
      await attempt(user.email, user.password, ip).expect(429);

      await forgot(user.email).expect(202);
      const code = await nextCode(testApp, user.email, 1);
      await http
        .post('/api/v1/auth/password/reset')
        .set(from(ip))
        .send({ email: user.email, code, newPassword: 'a-brand-new-password-9' })
        .expect(204);

      const response = await attempt(user.email, 'a-brand-new-password-9', ip).expect(200);
      expect(response.body.user).toMatchObject({ status: 'ACTIVE', emailVerified: true });
    });

    it('une inscription inachevée ne s’achève pas par une réinitialisation : son auteur est invité à la reprendre', async () => {
      const email = newEmail('unfinished');
      await http
        .post('/api/v1/auth/register')
        .set(from(newClientIp()))
        .send({ email, password: PASSWORD, countryCode: 'CD', acceptTerms: true })
        .expect(202);
      const verificationCode = await nextCode(testApp, email);

      // Même réponse que pour un compte actif : rien ne distingue les deux cas.
      const pending = await forgot(email).expect(202);
      expect(pending.body).toEqual({ nextStep: 'RESET_PASSWORD', codeTtlSeconds: 900 });
      const notice = await nextMessage(testApp, email, 1);
      expect(notice.template).toBe('registration_incomplete');
      expect(
        await prisma.verificationChallenge.count({
          where: { user: { email }, purpose: 'PASSWORD_RESET' },
        }),
      ).toBe(0);

      // Aucun code — pas même celui de l'inscription — ne réinitialise ce compte.
      await reset(email, verificationCode, 'a-brand-new-password-9').expect(400);
      const account = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(account).toMatchObject({ status: 'PENDING_VERIFICATION', emailVerifiedAt: null });

      const denied = await prisma.auditLog.findFirstOrThrow({
        where: { resourceId: account.id, action: 'user.password_reset_requested' },
      });
      expect(denied).toMatchObject({
        outcome: 'DENIED',
        metadata: { reason: 'REGISTRATION_INCOMPLETE' },
      });
    });

    it('un compte suspendu ne reçoit aucun code', async () => {
      const user = await registerVerifiedUser(http, testApp);
      await prisma.user.update({ where: { email: user.email }, data: { status: 'SUSPENDED' } });

      await forgot(user.email).expect(202);
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(user.email)).toHaveLength(1);
      expect(
        await prisma.verificationChallenge.count({
          where: { user: { email: user.email }, purpose: 'PASSWORD_RESET' },
        }),
      ).toBe(0);
    });
  });

  describe('changement de mot de passe', () => {
    const change = (accessToken: string, currentPassword: string, newPassword: string) =>
      http
        .post('/api/v1/auth/password/change')
        .set(bearer(accessToken))
        .send({ currentPassword, newPassword });

    it('exige le mot de passe actuel, ferme les autres sessions et conserve la session en cours', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const current = await login(http, user);
      const other = await login(http, user);
      const newPassword = 'a-brand-new-password-9';

      const wrong = await change(
        current.tokens.accessToken,
        'not-the-password-1',
        newPassword,
      ).expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      await login(http, user);

      await change(current.tokens.accessToken, user.password, newPassword).expect(204);

      await me(current.tokens.accessToken).expect(200);
      await me(other.tokens.accessToken).expect(401);
      await attempt(user.email, user.password, newClientIp()).expect(401);
      await login(http, { email: user.email, password: newPassword });

      const notice = await nextMessage(testApp, user.email, 1);
      expect(notice.template).toBe('password_changed');
      const revoked = await prisma.userSession.findUniqueOrThrow({
        where: { id: other.sessionId },
      });
      expect(revoked.revocationReason).toBe('PASSWORD_CHANGED');
    });

    it('le nouveau mot de passe suit les règles, et ne peut pas dériver de l’adresse du compte', async () => {
      const user = await registerVerifiedUser(http, testApp, { email: newEmail('mukendi-jean') });
      const { tokens } = await login(http, user);
      const localPart = user.email.split('@')[0] ?? '';

      const derived = await change(tokens.accessToken, user.password, `${localPart}!2026`).expect(
        400,
      );
      expect(derived.body.errors?.[0]?.path).toBe('newPassword');
      await change(tokens.accessToken, user.password, 'court').expect(400);
      await login(http, user);
    });

    it('cinq mots de passe actuels erronés bloquent le changement — une session volée ne suffit pas', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const { tokens } = await login(http, user);

      for (let failure = 0; failure < 5; failure += 1) {
        await change(tokens.accessToken, 'not-the-password-1', 'a-brand-new-password-9').expect(
          401,
        );
      }
      const blocked = await change(
        tokens.accessToken,
        user.password,
        'a-brand-new-password-9',
      ).expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await login(http, user);
    });

    it('sans session, la route est fermée', async () => {
      await http
        .post('/api/v1/auth/password/change')
        .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password-9' })
        .expect(401);
    });
  });
});

describe('Sessions — tolérance nulle à la réutilisation d’un jeton', () => {
  it('cinq renouvellements simultanés avec le même jeton : un seul aboutit, puis la session est révoquée', async () => {
    const testApp = await createTestApp({
      env: { TRUST_PROXY_HOPS: '1', AUTH_REFRESH_REUSE_GRACE_SECONDS: '0' },
    });
    try {
      const http = request(testApp.app.getHttpServer());
      const prisma = testApp.app.get(PrismaService);
      await openFeature(testApp, 'registration');
      const user = await registerVerifiedUser(http, testApp);
      const { tokens, sessionId } = await login(http, user);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          http
            .post('/api/v1/auth/refresh')
            .set(from(newClientIp()))
            .send({ refreshToken: tokens.refreshToken }),
        ),
      );

      // Chaque requête lit l'état laissé par la précédente : la première remplace le jeton,
      // les suivantes constatent sa réutilisation.
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 401, 401, 401, 401,
      ]);
      const session = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.revocationReason).toBe('TOKEN_REUSE');
      expect(await prisma.sessionToken.count({ where: { sessionId } })).toBe(2);

      const winner = responses.find((response) => response.status === 200);
      await http
        .get('/api/v1/me')
        .set(bearer((winner?.body.tokens as TokenPair).accessToken))
        .expect(401);
    } finally {
      await testApp.close();
    }
  });
});
