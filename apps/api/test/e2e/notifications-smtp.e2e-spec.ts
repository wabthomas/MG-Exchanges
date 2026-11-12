import tls from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { problemDetailsSchema } from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import {
  bearer,
  from,
  type Http,
  login,
  newClientIp,
  newEmail,
  openFeature,
  PASSWORD,
} from '../support/identity.js';
import {
  createTestCertificate,
  startSmtpServer,
  type TestCertificate,
  type TestSmtpServer,
} from '../support/smtp.js';
import { createTestApp, eventually, type TestApp } from '../support/test-app.js';

const ACCOUNT = { user: 'mgx-sender', password: 'smtp-test-password-7391' };
const SENDER = 'MG-Exchange <no-reply@mg-exchange.test>';

/** Code à six chiffres contenu dans un e-mail reçu par le serveur SMTP. */
function codeIn(text: string | undefined): string {
  const code = /\b\d{6}\b/.exec(text ?? '')?.[0];
  if (code === undefined) {
    throw new Error('No 6-digit code in the received email.');
  }
  return code;
}

async function register(http: Http, email: string): Promise<void> {
  await http
    .post('/api/v1/auth/register')
    .set(from(newClientIp()))
    .send({ email, password: PASSWORD, countryCode: 'CD', acceptTerms: true })
    .expect(202);
}

async function verifyEmail(http: Http, email: string, code: string): Promise<void> {
  await http
    .post('/api/v1/auth/email/verify')
    .set(from(newClientIp()))
    .send({ email, code, password: PASSWORD })
    .expect(204);
}

describe('Envoi réel des e-mails par SMTP — bout en bout', () => {
  let smtp: TestSmtpServer;
  let testApp: TestApp;
  let http: Http;

  beforeAll(async () => {
    smtp = await startSmtpServer({ account: ACCOUNT });
    testApp = await createTestApp({
      env: {
        TRUST_PROXY_HOPS: '1',
        SMTP_HOST: smtp.host,
        SMTP_PORT: String(smtp.port),
        SMTP_SECURITY: 'none',
        SMTP_USER: ACCOUNT.user,
        SMTP_PASSWORD: ACCOUNT.password,
        EMAIL_FROM: SENDER,
      },
    });
    http = request(testApp.app.getHttpServer());
    await openFeature(testApp, 'registration');
  });

  afterAll(async () => {
    await testApp.close();
    await smtp.close();
  });

  it('au démarrage, l’API vérifie que le serveur répond et accepte ses identifiants', async () => {
    expect(testApp.config.notifications.delivery).toBe('smtp');
    await eventually(() => Promise.resolve(smtp.authentications.length >= 1));
    expect(smtp.authentications[0]).toMatchObject({ user: ACCOUNT.user, accepted: true });
    // Vérifier n'envoie rien.
    expect(smtp.messages).toEqual([]);
  });

  it('une inscription se termine avec le code reçu par e-mail', async () => {
    const email = newEmail('smtp');
    await register(http, email);

    const received = await smtp.nextMessageTo(email);
    expect(received.envelope).toEqual({ from: 'no-reply@mg-exchange.test', to: [email] });
    expect(received.authenticatedAs).toBe(ACCOUNT.user);
    expect(received.mail.from?.value).toEqual([
      { name: 'MG-Exchange', address: 'no-reply@mg-exchange.test' },
    ]);
    expect(received.mail.subject).toBe('MG-Exchange — votre code de vérification');
    expect(received.mail.headers.get('auto-submitted')).toBe('auto-generated');
    expect(received.mail.headers.get('content-language')).toBe('fr');

    // Un code erroné est refusé ; celui de l'e-mail active le compte.
    const code = codeIn(received.mail.text);
    const wrong = code === '000000' ? '000001' : '000000';
    await http
      .post('/api/v1/auth/email/verify')
      .set(from(newClientIp()))
      .send({ email, code: wrong, password: PASSWORD })
      .expect(400);
    await verifyEmail(http, email, code);

    const session = await login(http, { email, password: PASSWORD });
    expect(session.user).toMatchObject({ email, emailVerified: true });
    // Un seul message est parti pour cette inscription.
    expect(smtp.messagesTo(email)).toHaveLength(1);
  });

  it('les messages de sécurité partent eux aussi : changement de mot de passe', async () => {
    const email = newEmail('smtp');
    await register(http, email);
    await verifyEmail(http, email, codeIn((await smtp.nextMessageTo(email)).mail.text));
    const session = await login(http, { email, password: PASSWORD });

    const newPassword = 'tanganyika-rive-ouest-48';
    await http
      .post('/api/v1/auth/password/change')
      .set(bearer(session.tokens.accessToken))
      .set(from(newClientIp()))
      .send({ currentPassword: PASSWORD, newPassword })
      .expect(204);

    const notice = await smtp.nextMessageTo(email, 2);
    expect(notice.mail.subject).toBe('MG-Exchange — votre mot de passe a été modifié');
    // Un message d'information ne contient ni l'ancien ni le nouveau mot de passe.
    expect(notice.raw).not.toContain(PASSWORD);
    expect(notice.raw).not.toContain(newPassword);
  });

  it('la vérification du téléphone reste indisponible : aucun prestataire SMS n’est branché', async () => {
    const email = newEmail('smtp');
    await register(http, email);
    await verifyEmail(http, email, codeIn((await smtp.nextMessageTo(email)).mail.text));
    const session = await login(http, { email, password: PASSWORD });

    const response = await http
      .post('/api/v1/me/phone/verification')
      .set(bearer(session.tokens.accessToken))
      .set(from(newClientIp()))
      .send({ phone: '+243810004321' })
      .expect(503);

    expect(problemDetailsSchema.parse(response.body).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('la boîte de réception de développement n’existe pas : les messages partent réellement', async () => {
    const response = await http
      .get('/api/v1/dev/mailbox?recipient=nobody@example.cd')
      .set(from(newClientIp()))
      .expect(404);

    expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
  });

  it('si le serveur refuse l’adresse, l’inscription reste en attente et rien n’est retenté', async () => {
    const refusing = await startSmtpServer({
      account: ACCOUNT,
      recipientPolicy: (address) => ({ code: 550, message: `5.1.1 <${address}>: User unknown` }),
    });
    const app = await createTestApp({
      env: {
        TRUST_PROXY_HOPS: '1',
        SMTP_HOST: refusing.host,
        SMTP_PORT: String(refusing.port),
        SMTP_SECURITY: 'none',
        SMTP_USER: ACCOUNT.user,
        SMTP_PASSWORD: ACCOUNT.password,
        EMAIL_FROM: SENDER,
      },
    });
    try {
      await openFeature(app, 'registration');
      const email = newEmail('refused');
      await register(request(app.app.getHttpServer()), email);

      await eventually(() => Promise.resolve(refusing.recipientsSeen.includes(email)));
      // Le traitement de l'événement s'est terminé normalement : une seule tentative.
      const prisma = app.app.get(PrismaService);
      await eventually(
        async () => (await prisma.outboxEvent.count({ where: { status: 'PENDING' } })) === 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(refusing.recipientsSeen.filter((address) => address === email)).toHaveLength(1);
      expect(refusing.messages).toEqual([]);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.status).toBe('PENDING_VERIFICATION');
    } finally {
      await app.close();
      await refusing.close();
    }
  });
});

describe('Envoi des e-mails en production — connexion chiffrée et authentifiée', () => {
  let certificate: TestCertificate;
  let smtp: TestSmtpServer;
  let testApp: TestApp;
  let trustedBefore: string[];

  beforeAll(async () => {
    certificate = createTestCertificate();
    // Équivalent, pour ce processus de test, de la variable NODE_EXTRA_CA_CERTS : l'autorité
    // qui a signé le certificat du serveur de test s'ajoute aux autorités reconnues.
    trustedBefore = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...trustedBefore, certificate.authority]);

    smtp = await startSmtpServer({
      encryption: 'starttls',
      certificate: certificate.server,
      account: ACCOUNT,
    });
    testApp = await createTestApp({
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        TRUST_PROXY_HOPS: '1',
        SMTP_HOST: 'localhost',
        SMTP_PORT: String(smtp.port),
        SMTP_USER: ACCOUNT.user,
        SMTP_PASSWORD: ACCOUNT.password,
        EMAIL_FROM: SENDER,
      },
    });
    await openFeature(testApp, 'registration');
  });

  afterAll(async () => {
    await testApp.close();
    await smtp.close();
    tls.setDefaultCACertificates(trustedBefore);
  });

  it('l’inscription est ouverte, et son code arrive par une connexion chiffrée', async () => {
    const http = request(testApp.app.getHttpServer());
    expect(testApp.config.notifications).toMatchObject({
      delivery: 'smtp',
      smtp: { security: 'starttls' },
    });

    const email = newEmail('prod');
    await register(http, email);

    const received = await smtp.nextMessageTo(email);
    expect(received).toMatchObject({ encrypted: true, authenticatedAs: ACCOUNT.user });
    // Aucun identifiant n'a été présenté sur une connexion en clair.
    expect(smtp.authentications.length).toBeGreaterThan(0);
    expect(smtp.authentications.every((attempt) => attempt.encrypted && attempt.accepted)).toBe(
      true,
    );

    await verifyEmail(http, email, codeIn(received.mail.text));
    const session = await login(http, { email, password: PASSWORD });
    expect(session.user).toMatchObject({ email, emailVerified: true });
  });

  it('la boîte de réception de développement reste absente', async () => {
    const http = request(testApp.app.getHttpServer());

    await http
      .get('/api/v1/dev/mailbox?recipient=nobody@example.cd')
      .set(from(newClientIp()))
      .expect(404);
  });
});
