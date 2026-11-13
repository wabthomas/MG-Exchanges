import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  activityListSchema,
  type ActivityType,
  currentUserSchema,
  phoneVerificationPendingSchema,
  problemDetailsSchema,
  profileSchema,
} from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  backgroundWorkDone,
  bearer,
  codeIn,
  from,
  type Http,
  login,
  mailbox,
  newClientIp,
  nextMessageOf,
  openFeature,
  type RegisteredUser,
  registerVerifiedUser,
} from '../support/identity.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const EMPTY_PROFILE = {
  givenName: null,
  familyName: null,
  additionalName: null,
  dateOfBirth: null,
  // Connus seulement une fois l'identité vérifiée (voir kyc.e2e-spec.ts).
  placeOfBirth: null,
  nationality: null,
  identityVerified: false,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  addressVerified: false,
  locale: 'fr',
  timeZone: null,
  updatedAt: null,
};

/** Jour civil (UTC) situé `years` années avant aujourd'hui, décalé de `days` jours. */
function yearsAgo(years: number, days = 0): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let nextSubscriber = 10_000_000;
/** Numéro mobile congolais (+243 8x) jamais utilisé par un autre test. */
function newPhone(): string {
  nextSubscriber += 1;
  return `+2438${String(nextSubscriber)}`;
}

describe('Profil, téléphone et historique d’activité — bout en bout', () => {
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

  const getProfile = (accessToken: string) =>
    http.get('/api/v1/me/profile').set(bearer(accessToken)).set(from(newClientIp()));
  const patchProfile = (accessToken: string, body: Record<string, unknown>) =>
    http.patch('/api/v1/me/profile').set(bearer(accessToken)).set(from(newClientIp())).send(body);
  const me = async (accessToken: string) =>
    currentUserSchema.parse(
      (await http.get('/api/v1/me').set(bearer(accessToken)).set(from(newClientIp())).expect(200))
        .body,
    );
  const requestPhoneCode = (accessToken: string, phone: unknown) =>
    http
      .post('/api/v1/me/phone/verification')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send({ phone });
  const verifyPhone = (accessToken: string, code: string) =>
    http
      .post('/api/v1/me/phone/verify')
      .set(bearer(accessToken))
      .set(from(newClientIp()))
      .send({ code });
  const activity = (accessToken: string, query = '') =>
    http.get(`/api/v1/me/activity${query}`).set(bearer(accessToken)).set(from(newClientIp()));

  async function signedIn(): Promise<{ user: RegisteredUser; accessToken: string; id: string }> {
    const user = await registerVerifiedUser(http, testApp);
    const session = await login(http, user);
    return { user, accessToken: session.tokens.accessToken, id: session.user.id };
  }

  /** Demande un code pour `phone` et retourne celui que le SMS contient. */
  async function smsCode(accessToken: string, phone: string, received = 1): Promise<string> {
    await requestPhoneCode(accessToken, phone).expect(202);
    return codeIn(await nextMessageOf(testApp, phone, 'phone_verification_code', received));
  }

  describe('profil', () => {
    it('un compte neuf a un profil vide, en français', async () => {
      const { accessToken } = await signedIn();
      const profile = profileSchema.parse((await getProfile(accessToken).expect(200)).body);
      expect(profile).toEqual(EMPTY_PROFILE);
      await http.get('/api/v1/me/profile').expect(401);
      await http.patch('/api/v1/me/profile').send({ city: 'Goma' }).expect(401);
    });

    it('la modification est partielle, `null` efface, et le journal ne retient que le nom des champs', async () => {
      const { accessToken, id } = await signedIn();

      const first = await patchProfile(accessToken, {
        givenName: '  Jean-Pierre ',
        familyName: "N'Kashama",
        additionalName: 'Mukendi wa Kabongo',
        dateOfBirth: '1990-05-17',
        addressLine1: '12, avenue de la Libération',
        city: 'Kinshasa',
        region: 'Kinshasa',
        timeZone: 'Africa/Kinshasa',
      }).expect(200);
      const created = profileSchema.parse(first.body);
      expect(created).toMatchObject({
        givenName: 'Jean-Pierre',
        familyName: "N'Kashama",
        additionalName: 'Mukendi wa Kabongo',
        dateOfBirth: '1990-05-17',
        addressLine1: '12, avenue de la Libération',
        addressLine2: null,
        city: 'Kinshasa',
        region: 'Kinshasa',
        postalCode: null,
        locale: 'fr',
        timeZone: 'Africa/Kinshasa',
      });
      expect(created.updatedAt).not.toBeNull();

      const second = await patchProfile(accessToken, {
        city: 'Lubumbashi',
        region: null,
        locale: 'en',
      }).expect(200);
      expect(profileSchema.parse(second.body)).toMatchObject({
        givenName: 'Jean-Pierre',
        dateOfBirth: '1990-05-17',
        city: 'Lubumbashi',
        region: null,
        locale: 'en',
        timeZone: 'Africa/Kinshasa',
      });
      expect(profileSchema.parse((await getProfile(accessToken).expect(200)).body)).toEqual(
        profileSchema.parse(second.body),
      );
      expect((await me(accessToken)).locale).toBe('en');

      const audit = await prisma.auditLog.findMany({
        where: { actorId: id, action: 'user.profile_updated' },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => entry.metadata)).toEqual([
        {
          fields: [
            'additionalName',
            'addressLine1',
            'city',
            'dateOfBirth',
            'familyName',
            'givenName',
            'region',
            'timeZone',
          ],
        },
        { fields: ['city', 'locale', 'region'] },
      ]);
      // Ni les noms, ni l'adresse, ni la date de naissance ne sont recopiés dans le journal.
      expect(JSON.stringify(audit)).not.toMatch(
        /Jean-Pierre|Kashama|Libération|1990-05-17|Kinshasa/,
      );
    });

    it('la langue choisie est celle des messages suivants', async () => {
      const { user, accessToken } = await signedIn();
      await patchProfile(accessToken, { locale: 'en' }).expect(200);

      await http
        .post('/api/v1/auth/password/change')
        .set(bearer(accessToken))
        .set(from(newClientIp()))
        .send({ currentPassword: user.password, newPassword: 'a-brand-new-password-9' })
        .expect(204);
      const notice = await nextMessageOf(testApp, user.email, 'password_changed');
      expect(notice.locale).toBe('en');
      expect(notice.text).toMatch(/^The password of your MG-Exchange account was just changed/);
    });

    it('le titulaire doit être majeur et la date de naissance, exister', async () => {
      const { accessToken } = await signedIn();

      for (const [dateOfBirth, message] of [
        [yearsAgo(18, 1), 'You must be at least 18 years old.'],
        [yearsAgo(0), 'You must be at least 18 years old.'],
        ['1899-12-31', 'Must not be before 1900-01-01.'],
      ] as const) {
        const response = await patchProfile(accessToken, { dateOfBirth }).expect(400);
        expect(problemDetailsSchema.parse(response.body)).toMatchObject({
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'dateOfBirth', message }],
        });
      }
      for (const dateOfBirth of ['2001-02-30', '17/05/1990', '1990-5-17', 19900517]) {
        const response = await patchProfile(accessToken, { dateOfBirth }).expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      expect((await getProfile(accessToken).expect(200)).body.dateOfBirth).toBeNull();

      // Dix-huit ans aujourd'hui même : majeur.
      const adult = await patchProfile(accessToken, { dateOfBirth: yearsAgo(18) }).expect(200);
      expect(adult.body.dateOfBirth).toBe(yearsAgo(18));
      const cleared = await patchProfile(accessToken, { dateOfBirth: null }).expect(200);
      expect(cleared.body.dateOfBirth).toBeNull();
    });

    it('seuls les champs du profil se modifient, avec des valeurs plausibles', async () => {
      const { accessToken, id } = await signedIn();

      for (const body of [
        {},
        { givenName: '' },
        { givenName: 'Jean2' },
        { givenName: '<script>alert(1)</script>' },
        { familyName: 'x'.repeat(101) },
        { addressLine1: 'ligne 1\nligne 2' },
        { city: 'x'.repeat(101) },
        { postalCode: 'x'.repeat(21) },
        { timeZone: 'Mars/Olympus_Mons' },
        { locale: 'de' },
        { locale: null },
        // Ce qui ne relève pas du profil ne se change pas ici.
        { email: 'someone-else@example.cd' },
        { phone: '+243812345678' },
        { status: 'ACTIVE' },
        { roles: ['super_admin'] },
        { countryCode: 'FR' },
        { city: 'Goma', emailVerified: true },
      ]) {
        const response = await patchProfile(accessToken, body).expect(400);
        expect({ body, code: problemDetailsSchema.parse(response.body).code }).toEqual({
          body,
          code: 'VALIDATION_FAILED',
        });
      }
      expect(profileSchema.parse((await getProfile(accessToken).expect(200)).body)).toEqual(
        EMPTY_PROFILE,
      );
      expect(await prisma.userProfile.count({ where: { userId: id } })).toBe(0);
      expect((await me(accessToken)).roles).toEqual([]);
    });
  });

  describe('numéro de téléphone', () => {
    it('un numéro se vérifie par SMS et ne devient celui du compte qu’une fois confirmé', async () => {
      const { accessToken, id, user } = await signedIn();
      const phone = newPhone();

      const pending = await requestPhoneCode(accessToken, phone).expect(202);
      expect(phoneVerificationPendingSchema.parse(pending.body)).toEqual({
        nextStep: 'VERIFY_PHONE',
        codeTtlSeconds: 900,
      });
      const sms = await nextMessageOf(testApp, phone, 'phone_verification_code');
      expect(sms).toMatchObject({ channel: 'SMS', recipient: phone, locale: 'fr' });
      expect(sms.text.length).toBeLessThanOrEqual(160);
      // Le code part par SMS, pas par e-mail.
      expect(
        mailbox(testApp)
          .messagesFor(user.email)
          .filter((message) => message.template === 'phone_verification_code'),
      ).toHaveLength(0);
      expect(await me(accessToken)).toMatchObject({ phone: null, phoneVerified: false });

      const code = codeIn(sms);
      const wrong = await verifyPhone(accessToken, code === '111111' ? '222222' : '111111').expect(
        400,
      );
      expect(problemDetailsSchema.parse(wrong.body).code).toBe('INVALID_OR_EXPIRED_CODE');
      expect(await me(accessToken)).toMatchObject({ phone: null, phoneVerified: false });

      await verifyPhone(accessToken, code).expect(204);
      expect(await me(accessToken)).toMatchObject({ phone, phoneVerified: true });
      await verifyPhone(accessToken, code).expect(400);

      const audit = await prisma.auditLog.findMany({
        where: { actorId: id, action: { startsWith: 'user.phone_' } },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((entry) => [entry.action, entry.outcome, entry.metadata])).toEqual([
        ['user.phone_verification_requested', 'SUCCESS', { phone: `+243****${phone.slice(-4)}` }],
        ['user.phone_verification_failed', 'FAILURE', { reason: 'WRONG_CODE' }],
        ['user.phone_verified', 'SUCCESS', { phone: `+243****${phone.slice(-4)}` }],
        ['user.phone_verification_failed', 'FAILURE', { reason: 'WRONG_CODE' }],
      ]);
      // Le journal ne contient ni le numéro complet, ni le code.
      expect(JSON.stringify(audit)).not.toContain(phone);
      expect(JSON.stringify(audit)).not.toContain(code);

      // Le numéro déjà vérifié ne se vérifie pas une seconde fois.
      const again = await requestPhoneCode(accessToken, phone).expect(409);
      expect(problemDetailsSchema.parse(again.body).code).toBe('CONFLICT');
    });

    it('seuls les numéros mobiles des pays desservis reçoivent un code', async () => {
      const { accessToken } = await signedIn();

      for (const phone of ['+33612345678', '+14155550123', '+243123456789', '+24381234567']) {
        const response = await requestPhoneCode(accessToken, phone).expect(422);
        expect(problemDetailsSchema.parse(response.body).code).toBe('COUNTRY_NOT_SUPPORTED');
      }
      for (const phone of ['0812345678', '243812345678', '+243 81 234 5678', 'abc', '', null]) {
        const response = await requestPhoneCode(accessToken, phone).expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      await backgroundWorkDone(testApp);
      for (const phone of ['+33612345678', '+14155550123', '+243123456789']) {
        expect(mailbox(testApp).messagesFor(phone)).toHaveLength(0);
      }
      // Les refus ne consomment pas le quota d'envois du compte.
      await requestPhoneCode(accessToken, newPhone()).expect(202);
    });

    it('un numéro vérifié n’appartient qu’à un compte — ce que seul son détenteur peut apprendre', async () => {
      const [owner, other] = [await signedIn(), await signedIn()];
      const phone = newPhone();
      await verifyPhone(owner.accessToken, await smsCode(owner.accessToken, phone)).expect(204);

      // La demande reçoit la même réponse qu'un numéro libre : elle ne révèle rien.
      const pending = await requestPhoneCode(other.accessToken, phone).expect(202);
      expect(pending.body).toEqual({ nextStep: 'VERIFY_PHONE', codeTtlSeconds: 900 });
      const code = codeIn(await nextMessageOf(testApp, phone, 'phone_verification_code', 2));

      const conflict = await verifyPhone(other.accessToken, code).expect(409);
      expect(problemDetailsSchema.parse(conflict.body).code).toBe('CONFLICT');
      expect(await me(other.accessToken)).toMatchObject({ phone: null, phoneVerified: false });
      expect(await me(owner.accessToken)).toMatchObject({ phone, phoneVerified: true });

      const failure = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: other.id, action: 'user.phone_verification_failed' },
      });
      expect(failure.metadata).toEqual({ reason: 'PHONE_ALREADY_IN_USE' });
    });

    it('deux comptes qui confirment le même numéro au même instant : un seul l’obtient', async () => {
      for (let round = 0; round < 3; round++) {
        const [first, second] = [await signedIn(), await signedIn()];
        const phone = newPhone();
        const firstCode = await smsCode(first.accessToken, phone);
        const secondCode = await smsCode(second.accessToken, phone, 2);

        const [firstAnswer, secondAnswer] = await Promise.all([
          verifyPhone(first.accessToken, firstCode).then((response) => response),
          verifyPhone(second.accessToken, secondCode).then((response) => response),
        ]);

        expect([firstAnswer.status, secondAnswer.status].sort()).toEqual([204, 409]);
        const holders = await prisma.user.findMany({
          where: { phone, phoneVerifiedAt: { not: null } },
          select: { id: true },
        });
        const winner = firstAnswer.status === 204 ? first : second;
        expect(holders).toEqual([{ id: winner.id }]);
      }
    });

    it('changer de numéro : l’ancien reste en place jusqu’à la confirmation du nouveau, puis redevient libre', async () => {
      const [owner, other] = [await signedIn(), await signedIn()];
      const [first, second] = [newPhone(), newPhone()];
      await verifyPhone(owner.accessToken, await smsCode(owner.accessToken, first)).expect(204);

      const code = await smsCode(owner.accessToken, second);
      expect(await me(owner.accessToken)).toMatchObject({ phone: first, phoneVerified: true });
      await verifyPhone(owner.accessToken, code).expect(204);
      expect(await me(owner.accessToken)).toMatchObject({ phone: second, phoneVerified: true });

      await verifyPhone(other.accessToken, await smsCode(other.accessToken, first, 2)).expect(204);
      expect(await me(other.accessToken)).toMatchObject({ phone: first, phoneVerified: true });
    });

    it('un nouveau code annule le précédent et vaut pour le dernier numéro demandé', async () => {
      const { accessToken } = await signedIn();
      const [first, second] = [newPhone(), newPhone()];

      const stale = await smsCode(accessToken, first);
      const fresh = await smsCode(accessToken, second);
      if (stale !== fresh) {
        await verifyPhone(accessToken, stale).expect(400);
      }
      await verifyPhone(accessToken, fresh).expect(204);
      // Le code envoyé au second numéro ne vérifie que celui-ci.
      expect(await me(accessToken)).toMatchObject({ phone: second, phoneVerified: true });
    });

    it('cinq essais erronés invalident le code', async () => {
      const { accessToken } = await signedIn();
      const code = await smsCode(accessToken, newPhone());
      const wrong = code === '111111' ? '222222' : '111111';

      for (let failure = 0; failure < 5; failure += 1) {
        await verifyPhone(accessToken, wrong).expect(400);
      }
      await verifyPhone(accessToken, code).expect(400);
      expect(await me(accessToken)).toMatchObject({ phone: null, phoneVerified: false });
    });

    it('au plus trois SMS par quart d’heure et par compte', async () => {
      const { accessToken } = await signedIn();
      for (let sent = 0; sent < 3; sent += 1) {
        await requestPhoneCode(accessToken, newPhone()).expect(202);
      }
      const unsent = newPhone();
      const refused = await requestPhoneCode(accessToken, unsent).expect(429);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(unsent)).toHaveLength(0);
    });

    it('au plus trois SMS par heure vers un même numéro, quel que soit le compte qui les demande', async () => {
      const phone = newPhone();
      for (let sent = 0; sent < 3; sent += 1) {
        const { accessToken } = await signedIn();
        await requestPhoneCode(accessToken, phone).expect(202);
      }
      const { accessToken } = await signedIn();
      const refused = await requestPhoneCode(accessToken, phone).expect(429);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('RATE_LIMITED');
      await nextMessageOf(testApp, phone, 'phone_verification_code', 3);
      await backgroundWorkDone(testApp);
      expect(mailbox(testApp).messagesFor(phone)).toHaveLength(3);
    });
  });

  describe('historique d’activité', () => {
    const typesOf = (body: unknown): ActivityType[] =>
      activityListSchema.parse(body).entries.map((entry) => entry.type);

    it('le titulaire voit les événements de sécurité de son compte, du plus récent au plus ancien', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const ip = newClientIp();
      const session = await login(http, user, { ip });
      await http
        .post('/api/v1/auth/login')
        .set(from(ip))
        .send({ email: user.email, password: 'not-the-password-1' })
        .expect(401);
      await patchProfile(session.tokens.accessToken, { city: 'Goma' }).expect(200);
      const newPassword = 'a-brand-new-password-9';
      await http
        .post('/api/v1/auth/password/change')
        .set(bearer(session.tokens.accessToken))
        .set(from(ip))
        .send({ currentPassword: 'not-the-password-1', newPassword })
        .expect(401);
      await http
        .post('/api/v1/auth/password/change')
        .set(bearer(session.tokens.accessToken))
        .set(from(ip))
        .send({ currentPassword: user.password, newPassword })
        .expect(204);

      const response = await activity(session.tokens.accessToken).expect(200);
      const list = activityListSchema.parse(response.body);
      expect(list.entries.map((entry) => [entry.type, entry.outcome])).toEqual([
        ['PASSWORD_CHANGED', 'SUCCESS'],
        ['PASSWORD_CHANGE_FAILED', 'FAILURE'],
        ['PROFILE_UPDATED', 'SUCCESS'],
        ['SIGN_IN_FAILED', 'FAILURE'],
        ['SIGN_IN', 'SUCCESS'],
        ['EMAIL_VERIFIED', 'SUCCESS'],
        ['ACCOUNT_CREATED', 'SUCCESS'],
      ]);
      expect(list.nextCursor).toBeNull();
      expect(list.entries[0]?.ipAddress).toBe(ip);
      const times = list.entries.map((entry) => entry.occurredAt);
      expect([...times].sort().reverse()).toEqual(times);
      // Rien d'autre que le type, la date, l'issue et l'origine : ni métadonnées, ni identifiants internes.
      for (const entry of response.body.entries as Record<string, unknown>[]) {
        expect(Object.keys(entry).sort()).toEqual([
          'id',
          'ipAddress',
          'occurredAt',
          'outcome',
          'type',
          'userAgent',
        ]);
      }
    });

    it('l’historique se parcourt par pages ; il ne montre que le compte qui le consulte', async () => {
      const [reader, stranger] = [await signedIn(), await signedIn()];
      await patchProfile(stranger.accessToken, { city: 'Bukavu' }).expect(200);
      for (const city of ['Goma', 'Kisangani', 'Matadi']) {
        await patchProfile(reader.accessToken, { city }).expect(200);
      }

      const all = activityListSchema.parse(
        (await activity(reader.accessToken, '?limit=100').expect(200)).body,
      );
      expect(all.entries.map((entry) => entry.type)).toEqual([
        'PROFILE_UPDATED',
        'PROFILE_UPDATED',
        'PROFILE_UPDATED',
        'SIGN_IN',
        'EMAIL_VERIFIED',
        'ACCOUNT_CREATED',
      ]);

      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? '?limit=4' : `?limit=4&before=${cursor}`;
        const page = activityListSchema.parse(
          (await activity(reader.accessToken, query).expect(200)).body,
        );
        pages.push(page.entries.map((entry) => entry.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(pages.map((page) => page.length)).toEqual([4, 2]);
      expect(pages.flat()).toEqual(all.entries.map((entry) => entry.id));

      // Une page exactement pleine n'annonce pas de suite.
      const exact = activityListSchema.parse(
        (await activity(reader.accessToken, '?limit=6').expect(200)).body,
      );
      expect(exact.nextCursor).toBeNull();

      const ownEvents = await prisma.auditLog.findMany({
        where: { id: { in: all.entries.map((entry) => entry.id) } },
      });
      for (const event of ownEvents) {
        expect([event.actorId, event.resourceId]).toContain(reader.id);
      }
    });

    it('les événements internes n’y figurent pas ; les paramètres sont bornés', async () => {
      const { accessToken, id } = await signedIn();
      await requestPhoneCode(accessToken, newPhone()).expect(202);
      await http
        .get('/api/v1/admin/system-settings')
        .set(bearer(accessToken))
        .set(from(newClientIp()))
        .expect(403);
      expect(
        await prisma.auditLog.count({
          where: {
            actorId: id,
            action: { in: ['user.phone_verification_requested', 'authorization.denied'] },
          },
        }),
      ).toBe(2);

      expect(typesOf((await activity(accessToken).expect(200)).body)).toEqual([
        'SIGN_IN',
        'EMAIL_VERIFIED',
        'ACCOUNT_CREATED',
      ]);

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=abc',
        '?before=not-a-uuid',
        '?userId=0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
        '?type=SIGN_IN',
      ]) {
        const response = await activity(accessToken, query).expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      await http.get('/api/v1/me/activity').expect(401);
    });
  });

  describe('connexion depuis un nouvel appareil', () => {
    const CHROME_WINDOWS =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const signIn = (
      user: RegisteredUser,
      device: { deviceId?: string; userAgent?: string; deviceName?: string; ip?: string },
    ) => {
      const call = http.post('/api/v1/auth/login').set(from(device.ip ?? newClientIp()));
      if (device.userAgent !== undefined) {
        void call.set('User-Agent', device.userAgent);
      }
      return call.send({
        email: user.email,
        password: user.password,
        ...(device.deviceId === undefined ? {} : { deviceId: device.deviceId }),
        ...(device.deviceName === undefined ? {} : { deviceName: device.deviceName }),
      });
    };
    const notices = (user: RegisteredUser) =>
      mailbox(testApp)
        .messagesFor(user.email)
        .filter((message) => message.template === 'new_sign_in');

    it('la première connexion et les appareils connus ne sont pas signalés ; un appareil inconnu l’est, une fois', async () => {
      const user = await registerVerifiedUser(http, testApp);
      const phone = { deviceId: 'device-phone-0000-0001' };
      const laptop = { deviceId: 'device-laptop-0000-0002', userAgent: CHROME_WINDOWS };

      await signIn(user, phone).expect(200);
      await signIn(user, phone).expect(200);
      await backgroundWorkDone(testApp);
      expect(notices(user)).toHaveLength(0);

      const ip = newClientIp();
      const opened = await signIn(user, {
        ...laptop,
        ip,
        deviceName: 'Cliquez sur http://phishing.example',
      }).expect(200);
      const notice = await nextMessageOf(testApp, user.email, 'new_sign_in');
      expect(notice.text).toContain('Appareil : Chrome — Windows');
      expect(notice.text).toContain(`Adresse IP : ${ip}`);
      expect(notice.text).toMatch(/Date : \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
      // Le nom d'appareil est un texte libre fourni par celui qui se connecte : il n'est pas recopié.
      expect(notice.text).not.toContain('phishing');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'session.opened', resourceId: opened.body.sessionId },
      });
      expect(audit.metadata).toMatchObject({ newDevice: true });

      // Désormais connu, il n'est plus signalé — même depuis une autre adresse.
      await signIn(user, laptop).expect(200);
      await signIn(user, phone).expect(200);
      await backgroundWorkDone(testApp);
      expect(notices(user)).toHaveLength(1);
    });

    it('sans identifiant d’appareil, l’agent utilisateur sert de repère ; sans rien, toute connexion est signalée', async () => {
      const user = await registerVerifiedUser(http, testApp);
      await signIn(user, { deviceId: 'device-phone-0000-0001' }).expect(200);

      await signIn(user, { userAgent: CHROME_WINDOWS }).expect(200);
      await nextMessageOf(testApp, user.email, 'new_sign_in', 1);
      await signIn(user, { userAgent: CHROME_WINDOWS }).expect(200);
      await backgroundWorkDone(testApp);
      expect(notices(user)).toHaveLength(1);

      // Un identifiant d'appareil l'emporte sur l'agent utilisateur : même navigateur, autre appareil.
      await signIn(user, { deviceId: 'device-other-0000-0003', userAgent: CHROME_WINDOWS }).expect(
        200,
      );
      await nextMessageOf(testApp, user.email, 'new_sign_in', 2);

      await signIn(user, {}).expect(200);
      const anonymous = await nextMessageOf(testApp, user.email, 'new_sign_in', 3);
      expect(anonymous.text).toContain('Appareil : inconnu');
      await signIn(user, {}).expect(200);
      await nextMessageOf(testApp, user.email, 'new_sign_in', 4);
    });

    it('l’identifiant d’appareil est une valeur opaque de 16 à 128 caractères', async () => {
      const user = await registerVerifiedUser(http, testApp);
      for (const deviceId of ['short', 'x'.repeat(129), 'has spaces in the id!', '', 42]) {
        const response = await http
          .post('/api/v1/auth/login')
          .set(from(newClientIp()))
          .send({ email: user.email, password: user.password, deviceId })
          .expect(400);
        expect(problemDetailsSchema.parse(response.body).code).toBe('VALIDATION_FAILED');
      }
      // Seule son empreinte est conservée.
      const deviceId = 'device-opaque-0000-0004';
      const session = await signIn(user, { deviceId }).expect(200);
      const stored = await prisma.userSession.findUniqueOrThrow({
        where: { id: session.body.sessionId },
      });
      expect(stored.deviceFingerprint).toHaveLength(32);
      expect(Buffer.from(stored.deviceFingerprint ?? []).toString('utf8')).not.toContain(deviceId);
    });
  });
});
