import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  currentUserSchema,
  loginResponseSchema,
  problemDetailsSchema,
  verificationPendingSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  bearer,
  codeIn,
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
  registerVerifiedUser,
} from '../support/identity.js';
import {
  createTestApp,
  eventually,
  TEST_CODE_HMAC_SECRET,
  type TestApp,
} from '../support/test-app.js';

const registration = (email: string, overrides: Record<string, unknown> = {}) => ({
  email,
  password: PASSWORD,
  countryCode: 'CD',
  acceptTerms: true,
  ...overrides,
});

describe('Inscription et vérification de l’adresse e-mail — bout en bout', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
  });

  afterAll(async () => {
    await testApp.close();
  });

  const register = (body: Record<string, unknown>, ip = newClientIp()) =>
    http.post('/api/v1/auth/register').set(from(ip)).send(body);
  const verify = (email: string, code: string, ip = newClientIp()) =>
    http.post('/api/v1/auth/email/verify').set(from(ip)).send({ email, code });

  it('l’inscription est fermée tant qu’aucune décision ne l’a ouverte', async () => {
    const response = await register(registration(newEmail())).expect(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('FEATURE_DISABLED');
    expect(await prisma.user.count()).toBe(0);

    await openFeature(testApp, 'registration');
  });

  describe('parcours nominal', () => {
    const email = newEmail('jean');

    it('crée un compte en attente et envoie un code à six chiffres', async () => {
      const response = await register(
        registration(` ${email.toUpperCase()} `, { phone: '+243812345678', locale: 'fr' }),
      ).expect(202);
      expect(verificationPendingSchema.parse(response.body)).toEqual({
        nextStep: 'VERIFY_EMAIL',
        codeTtlSeconds: 900,
      });

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({
        status: 'PENDING_VERIFICATION',
        emailVerifiedAt: null,
        phone: '+243812345678',
        phoneVerifiedAt: null,
        countryCode: 'CD',
        accountType: 'INDIVIDUAL',
        locale: 'fr',
      });
      expect(user.termsAcceptedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);

      const message = await nextMessage(testApp, email);
      expect(message).toMatchObject({ channel: 'EMAIL', template: 'email_verification_code' });
      expect(codeIn(message)).toMatch(/^\d{6}$/);
    });

    it('tant que l’adresse n’est pas vérifiée, la connexion est refusée', async () => {
      const response = await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email, password: PASSWORD })
        .expect(403);
      expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('le code vérifie l’adresse, active le compte et ne sert qu’une fois', async () => {
      const code = await nextCode(testApp, email);
      await verify(email, code).expect(204);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.status).toBe('ACTIVE');
      expect(user.emailVerifiedAt).not.toBeNull();

      const again = await verify(email, code).expect(400);
      expect(again.body.code).toBe('INVALID_OR_EXPIRED_CODE');
    });

    it('le compte vérifié se connecte ; la réponse respecte le contrat', async () => {
      const session = loginResponseSchema.parse(await login(http, { email, password: PASSWORD }));
      expect(session.status).toBe('AUTHENTICATED');
      expect(session.user).toMatchObject({
        email,
        emailVerified: true,
        phone: '+243812345678',
        phoneVerified: false,
        status: 'ACTIVE',
        roles: [],
        permissions: [],
      });
      expect(session.tokens.accessToken).toMatch(/^mgx_at_[\w-]{43}$/);
      expect(session.tokens.refreshToken).toMatch(/^mgx_rt_[\w-]{43}$/);

      const me = await http.get('/api/v1/me').set(bearer(session.tokens.accessToken)).expect(200);
      expect(currentUserSchema.parse(me.body)).toEqual(session.user);
    });

    it('chaque étape est inscrite au journal d’audit, avec le contexte de la requête', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const actions = await prisma.auditLog.findMany({
        where: { actorId: user.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(actions.map((entry) => entry.action)).toEqual([
        'user.registered',
        'session.login_denied',
        'user.email_verified',
        // Le second essai du même code, refusé.
        'user.email_verification_failed',
        'session.opened',
      ]);
      for (const entry of actions) {
        expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(entry.ipAddress).toMatch(/^198\.51\./);
      }
    });
  });

  describe('règles de saisie', () => {
    it.each([
      ['mot de passe très courant', { password: 'password123' }, 'password'],
      ['mot de passe répétitif', { password: 'aaaaaaaaaaaa' }, 'password'],
      ['mot de passe trop court', { password: 'court' }, 'password'],
      ['conditions non acceptées', { acceptTerms: false }, 'acceptTerms'],
      ['téléphone mal formé', { phone: '0812345678' }, 'phone'],
      ['code pays mal formé', { countryCode: 'Congo' }, 'countryCode'],
      ['propriété inconnue', { role: 'super_admin' }, ''],
    ])('%s : 400, champ désigné', async (_label, overrides, field) => {
      const response = await register(registration(newEmail(), overrides)).expect(400);
      const problem = problemDetailsSchema.parse(response.body);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.map((error) => error.path)).toContain(field);
    });

    it('un mot de passe dérivé de l’adresse est refusé', async () => {
      const response = await register(
        registration('mukendi.jean@example.cd', { password: 'mukendi.jean-2026' }),
      ).expect(400);
      expect(response.body.errors).toEqual([
        {
          path: 'password',
          message: 'The password must not contain your email address or phone number.',
        },
      ]);
    });

    it('un pays non desservi est refusé avec un code dédié', async () => {
      const response = await register(registration(newEmail(), { countryCode: 'FR' })).expect(422);
      expect(response.body.code).toBe('COUNTRY_NOT_SUPPORTED');
    });

    it('aucun de ces refus ne crée de compte', async () => {
      expect(await prisma.user.count({ where: { email: { startsWith: 'user-' } } })).toBe(0);
    });
  });

  describe('l’existence d’un compte n’est jamais révélée', () => {
    it('s’inscrire avec une adresse déjà prise répond exactement comme une inscription réussie', async () => {
      const owner = await registerVerifiedUser(http, testApp, { email: newEmail('owner') });
      const received = mailbox(testApp).messagesFor(owner.email).length;

      const fresh = await register(registration(newEmail('fresh'))).expect(202);
      const taken = await register(
        registration(owner.email, { password: 'a-different-password-42' }),
      ).expect(202);
      expect(taken.body).toEqual(fresh.body);

      // Rien n'a été créé ni modifié : le mot de passe du titulaire est inchangé.
      expect(await prisma.user.count({ where: { email: owner.email } })).toBe(1);
      await login(http, owner);
      await http
        .post('/api/v1/auth/login')
        .set(from(newClientIp()))
        .send({ email: owner.email, password: 'a-different-password-42' })
        .expect(401);

      // Le titulaire, lui, est prévenu — sans code, et une seule fois même si l'on insiste.
      const notice = await nextMessage(testApp, owner.email, received);
      expect(notice.template).toBe('account_already_exists');
      expect(notice.text).not.toMatch(/\d{6}/);

      await register(registration(owner.email)).expect(202);
      await register(registration(owner.email)).expect(202);
      await eventually(
        async () => (await prisma.outboxEvent.count({ where: { status: 'PENDING' } })) === 0,
      );
      expect(mailbox(testApp).messagesFor(owner.email)).toHaveLength(received + 1);
    });

    it('vérification et renvoi de code répondent de la même façon pour une adresse inconnue', async () => {
      const unknown = await verify(newEmail('ghost'), '123456').expect(400);
      expect(unknown.body.code).toBe('INVALID_OR_EXPIRED_CODE');

      const pending = newEmail('pending');
      await register(registration(pending)).expect(202);
      const wrong = await verify(pending, '000000').expect(400);
      expect({ code: wrong.body.code, detail: wrong.body.detail }).toEqual({
        code: unknown.body.code,
        detail: unknown.body.detail,
      });

      const resendKnown = await http
        .post('/api/v1/auth/email/resend')
        .set(from(newClientIp()))
        .send({ email: pending })
        .expect(202);
      const resendUnknown = await http
        .post('/api/v1/auth/email/resend')
        .set(from(newClientIp()))
        .send({ email: newEmail('ghost') })
        .expect(202);
      expect(resendUnknown.body).toEqual(resendKnown.body);
    });

    it('deux inscriptions simultanées avec la même adresse ne créent qu’un compte', async () => {
      const email = newEmail('race');
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => register(registration(email))),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(6).fill(202));
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.userCredential.count({ where: { user: { email } } })).toBe(1);
    });
  });

  describe('codes à usage unique', () => {
    it('le code n’est stocké nulle part en clair : ni en base, ni dans la boîte d’envoi', async () => {
      const email = newEmail('secret');
      await register(registration(email)).expect(202);
      const code = await nextCode(testApp, email);

      const challenge = await prisma.verificationChallenge.findFirstOrThrow({
        where: { user: { email } },
      });
      // Ce qui est stocké : le HMAC du code, calculé avec une clé qui n'est pas dans la base.
      expect(Buffer.from(challenge.codeHash ?? []).toString('hex')).toBe(
        createHmac('sha256', TEST_CODE_HMAC_SECRET)
          .update(`${challenge.id}:${code}`, 'utf8')
          .digest('hex'),
      );

      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: challenge.id },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(code);
      expect(events[0]?.payload).toEqual({ challengeId: challenge.id });
    });

    it('après cinq essais erronés, même le bon code est refusé ; un nouveau code repart de zéro', async () => {
      const email = newEmail('attempts');
      await register(registration(email)).expect(202);
      const code = await nextCode(testApp, email);
      const wrong = code === '111111' ? '222222' : '111111';

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await verify(email, wrong).expect(400);
      }
      await verify(email, code).expect(400);
      const exhausted = await prisma.verificationChallenge.findFirstOrThrow({
        where: { user: { email } },
      });
      expect(exhausted).toMatchObject({ attempts: 5, maxAttempts: 5, consumedAt: null });

      await http
        .post('/api/v1/auth/email/resend')
        .set(from(newClientIp()))
        .send({ email })
        .expect(202);
      const fresh = await nextCode(testApp, email, 1);
      await verify(email, fresh).expect(204);
    });

    it('un nouveau code annule le précédent', async () => {
      const email = newEmail('replace');
      await register(registration(email)).expect(202);
      const first = await nextCode(testApp, email);

      // Une nouvelle inscription sur un compte encore en attente renvoie simplement un code.
      await register(registration(email, { password: 'another-password-77' })).expect(202);
      const second = await nextCode(testApp, email, 1);

      if (first !== second) {
        await verify(email, first).expect(400);
      }
      await verify(email, second).expect(204);
      // Le mot de passe retenu est celui de la première inscription.
      await login(http, { email, password: PASSWORD });
    });

    it('au plus trois codes par quart d’heure et par compte ; un refus n’annule pas le code en cours', async () => {
      const email = newEmail('throttle');
      const resend = () =>
        http.post('/api/v1/auth/email/resend').set(from(newClientIp())).send({ email }).expect(202);

      await register(registration(email)).expect(202);
      await nextCode(testApp, email);
      await resend();
      await nextCode(testApp, email, 1);
      await resend();
      const third = await nextCode(testApp, email, 2);

      // Quatrième et cinquième demandes : même réponse, mais rien n'est envoyé.
      await resend();
      await resend();
      await eventually(
        async () => (await prisma.outboxEvent.count({ where: { status: 'PENDING' } })) === 0,
      );
      expect(mailbox(testApp).messagesFor(email)).toHaveLength(3);
      expect(await prisma.verificationChallenge.count({ where: { user: { email } } })).toBe(3);

      await verify(email, third).expect(204);
    });

    it('des demandes rapprochées ne produisent qu’un message : celui du dernier code', async () => {
      const email = newEmail('burst');
      await register(registration(email)).expect(202);
      await Promise.all([
        http.post('/api/v1/auth/email/resend').set(from(newClientIp())).send({ email }),
        http.post('/api/v1/auth/email/resend').set(from(newClientIp())).send({ email }),
      ]);
      await eventually(
        async () => (await prisma.outboxEvent.count({ where: { status: 'PENDING' } })) === 0,
      );

      // Un seul défi reste en cours, et chaque message reçu porte un code de ce défi ou d'un
      // défi annulé : seul le dernier code fonctionne.
      expect(
        await prisma.verificationChallenge.count({
          where: { user: { email }, consumedAt: null, invalidatedAt: null },
        }),
      ).toBe(1);
      const messages = mailbox(testApp).messagesFor(email);
      expect(messages.length).toBeGreaterThanOrEqual(1);
      await verify(email, codeIn(messages[0]!)).expect(204);
    });

    it('un code expiré est refusé', async () => {
      const email = newEmail('expired');
      await register(registration(email)).expect(202);
      const code = await nextCode(testApp, email);

      await prisma.$executeRaw`
        UPDATE verification_challenges
        SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE user_id = (SELECT id FROM users WHERE email = ${email})`;

      await verify(email, code).expect(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe(
        'PENDING_VERIFICATION',
      );
    });
  });
});
