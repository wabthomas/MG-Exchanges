import { randomUUID } from 'node:crypto';

import type { AuthenticatedLogin, FeatureKey, LoginResponse } from '@mgx/contracts';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Queue } from 'bullmq';
import type request from 'supertest';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { DOMAIN_EVENTS_QUEUE } from '../../src/infrastructure/queue/queue.constants.js';
import { AuditService } from '../../src/modules/audit/application/audit.service.js';
import { createAdministrator } from '../../src/modules/identity/application/administrator-bootstrap.js';
import { MfaService } from '../../src/modules/identity/application/mfa.service.js';
import { Argon2PasswordHasher } from '../../src/modules/identity/infrastructure/argon2-password-hasher.js';
import { PrismaUserRepository } from '../../src/modules/identity/infrastructure/prisma-user.repository.js';
import { base32Decode, hotp, totpStep } from '../../src/modules/identity/infrastructure/totp.js';
import { NotificationSender } from '../../src/modules/notifications/application/notification-sender.js';
import {
  InMemoryNotificationSender,
  type StoredNotification,
} from '../../src/modules/notifications/infrastructure/in-memory-notification-sender.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import { eventually, type TestApp, testClock } from './test-app.js';

export type Http = ReturnType<typeof request>;

/** Mot de passe conforme aux règles, utilisé par défaut dans les tests. */
export const PASSWORD = 'lumumba-boulevard-30';

const SYSTEM = { type: 'SYSTEM' } as const;

export const bearer = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
});

/**
 * Adresse IP cliente simulée : l'application de test fait confiance à un proxy
 * (`TRUST_PROXY_HOPS=1`), ce qui permet à chaque scénario d'avoir ses propres compteurs.
 */
let nextClient = 1;
export function newClientIp(): string {
  nextClient += 1;
  return `198.51.${Math.floor(nextClient / 250) % 250}.${(nextClient % 250) + 1}`;
}
export const from = (ip: string): Record<string, string> => ({ 'X-Forwarded-For': ip });

let nextUser = 1;
export function newEmail(prefix = 'user'): string {
  nextUser += 1;
  return `${prefix}-${nextUser}-${Date.now().toString(36)}@example.cd`;
}

export function mailbox(testApp: TestApp): InMemoryNotificationSender {
  const sender = testApp.app.get(NotificationSender);
  if (!(sender instanceof InMemoryNotificationSender)) {
    throw new Error('The in-memory mailbox is not active in this test application.');
  }
  return sender;
}

/** Attend le prochain message reçu par `recipient` (au-delà des `alreadyReceived` premiers). */
export async function nextMessage(
  testApp: TestApp,
  recipient: string,
  alreadyReceived = 0,
): Promise<StoredNotification> {
  const sender = mailbox(testApp);
  await eventually(() => Promise.resolve(sender.messagesFor(recipient).length > alreadyReceived));
  const message = sender.messagesFor(recipient)[0];
  if (message === undefined) {
    throw new Error(`No message received by ${recipient}.`);
  }
  return message;
}

/**
 * Attend que `recipient` ait reçu au moins `count` messages du modèle donné et retourne le plus
 * récent. Désigner un message par son modèle, plutôt que par son rang dans la boîte, rend le
 * test indifférent aux autres messages que le scénario fait partir.
 */
export async function nextMessageOf(
  testApp: TestApp,
  recipient: string,
  template: StoredNotification['template'],
  count = 1,
): Promise<StoredNotification> {
  const sender = mailbox(testApp);
  const matching = (): readonly StoredNotification[] =>
    sender.messagesFor(recipient).filter((message) => message.template === template);
  await eventually(() => Promise.resolve(matching().length >= count));
  const message = matching()[0];
  if (message === undefined) {
    throw new Error(`No "${template}" message received by ${recipient}.`);
  }
  return message;
}

/**
 * Attend la fin des traitements en arrière-plan : événements relayés **et** traités. Au-delà,
 * plus aucun message n'est en route — on peut affirmer qu'un message n'a pas été envoyé.
 */
export async function backgroundWorkDone(testApp: TestApp): Promise<void> {
  const prisma = testApp.app.get(PrismaService);
  const queue = testApp.app.get<Queue>(getQueueToken(DOMAIN_EVENTS_QUEUE));
  await eventually(async () => {
    if ((await prisma.outboxEvent.count({ where: { status: 'PENDING' } })) > 0) {
      return false;
    }
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).every((count) => count === 0);
  });
}

export function codeIn(message: StoredNotification): string {
  const code = /\b\d{6}\b/.exec(message.text)?.[0];
  if (code === undefined) {
    throw new Error(`No 6-digit code in message "${message.subject}".`);
  }
  return code;
}

/** Attend le prochain code envoyé à `recipient`. */
export async function nextCode(
  testApp: TestApp,
  recipient: string,
  alreadyReceived = 0,
): Promise<string> {
  return codeIn(await nextMessage(testApp, recipient, alreadyReceived));
}

export async function openFeature(testApp: TestApp, feature: FeatureKey): Promise<void> {
  await testApp.app
    .get(SystemSettingsService)
    .setFeatureEnabled(feature, true, { actor: SYSTEM, reason: 'test setup' });
}

export interface RegisteredUser {
  readonly email: string;
  readonly password: string;
  /** Secret (base32) de l'application d'authentification, si le second facteur est activé. */
  readonly totpSecret?: string;
}

const STEP_MS = 30_000;

/**
 * Code qu'afficherait l'application d'authentification. Un code n'étant accepté qu'une fois,
 * l'horloge de test avance d'un pas à chaque appel : chaque code est neuf.
 */
export function nextTotpCode(secret: string): string {
  const key = base32Decode(secret);
  if (key === null) {
    throw new Error('Invalid base32 TOTP secret.');
  }
  testClock.advance(STEP_MS);
  return hotp(key, totpStep(testClock.now()));
}

/**
 * Code à six chiffres que l'application d'authentification n'affiche pas — ni maintenant, ni
 * aux pas voisins. Un code choisi au hasard serait valide trois fois sur un million.
 */
export function wrongTotpCode(secret: string): string {
  const key = base32Decode(secret);
  if (key === null) {
    throw new Error('Invalid base32 TOTP secret.');
  }
  const current = totpStep(testClock.now());
  const valid = new Set([-2, -1, 0, 1, 2].map((offset) => hotp(key, current + offset)));
  for (let candidate = 0; ; candidate += 1) {
    const code = String(candidate).padStart(6, '0');
    if (!valid.has(code)) {
      return code;
    }
  }
}

/** Active le second facteur d'un compte, comme le ferait son titulaire. @returns le secret (base32). */
export async function enableSecondFactor(
  testApp: TestApp,
  user: { readonly id: string; readonly password: string },
): Promise<string> {
  const mfa = testApp.app.get(MfaService);
  const auth = { userId: user.id, sessionId: randomUUID() };
  const client = { requestId: `test-${randomUUID()}`, ipAddress: undefined, userAgent: undefined };
  const { secret } = await mfa.startTotpEnrollment(
    auth,
    { currentPassword: user.password },
    client,
  );
  await mfa.confirmTotpEnrollment(auth, { code: nextTotpCode(secret) }, client);
  return secret;
}

/** Inscrit un compte et vérifie son adresse, par l'API (la fonctionnalité doit être ouverte). */
export async function registerVerifiedUser(
  http: Http,
  testApp: TestApp,
  overrides: Partial<RegisteredUser> = {},
): Promise<RegisteredUser> {
  const user = { email: overrides.email ?? newEmail(), password: overrides.password ?? PASSWORD };
  const ip = newClientIp();
  // L'adresse a pu servir à un compte clôturé depuis : seul un code reçu après compte.
  const codesBefore = mailbox(testApp)
    .messagesFor(user.email)
    .filter(({ template }) => template === 'email_verification_code').length;
  await http
    .post('/api/v1/auth/register')
    .set(from(ip))
    .send({ ...user, countryCode: 'CD', acceptTerms: true })
    .expect(202);
  const code = codeIn(
    await nextMessageOf(testApp, user.email, 'email_verification_code', codesBefore + 1),
  );
  await http
    .post('/api/v1/auth/email/verify')
    .set(from(ip))
    .send({ email: user.email, code, password: user.password })
    .expect(204);
  return user;
}

/**
 * Appareil par défaut des connexions de test. Sans identifiant d'appareil, chaque connexion
 * passerait pour un nouvel appareil et ferait partir un e-mail d'avertissement.
 */
export const TEST_DEVICE_ID = 'test-device-0000-default';

/**
 * Ouvre une session depuis l'appareil habituel du compte (`TEST_DEVICE_ID`, sauf mention
 * contraire). Si le compte est protégé par un second facteur (`totpSecret`), la seconde étape
 * est franchie avec un code de l'application d'authentification.
 */
export async function login(
  http: Http,
  user: RegisteredUser,
  options: { ip?: string; deviceName?: string; deviceId?: string } = {},
): Promise<AuthenticatedLogin> {
  const ip = options.ip ?? newClientIp();
  const response = await http
    .post('/api/v1/auth/login')
    .set(from(ip))
    .send({
      email: user.email,
      password: user.password,
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      deviceId: options.deviceId ?? TEST_DEVICE_ID,
    })
    .expect(200);
  const first = response.body as LoginResponse;
  if (first.status === 'AUTHENTICATED') {
    return first;
  }
  if (user.totpSecret === undefined) {
    throw new Error(`Sign-in of ${user.email} requires a second factor the test does not hold.`);
  }
  const second = await http
    .post('/api/v1/auth/mfa/verify')
    .set(from(ip))
    .send({ mfaToken: first.mfaToken, code: nextTotpCode(user.totpSecret) })
    .expect(200);
  return second.body as AuthenticatedLogin;
}

/** Connexion PostgreSQL avec le rôle **propriétaire** — celui des migrations et de l'amorçage. */
export async function withOwner<T>(
  testApp: TestApp,
  work: (prisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testApp.database.ownerUrl }),
  });
  try {
    return await work(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Crée un administrateur comme le fait l'outil en ligne de commande (rôle propriétaire), puis
 * active son second facteur — le back-office l'exige. `secondFactor: false` laisse le compte
 * tel que l'outil le crée.
 */
export async function createAdmin(
  testApp: TestApp,
  options: { secondFactor?: boolean } = {},
): Promise<RegisteredUser & { id: string }> {
  const admin = { email: newEmail('admin'), password: 'kivu-lake-sunrise-71' };
  const id = await withOwner(testApp, (prisma) =>
    prisma.$transaction((tx) =>
      createAdministrator(
        tx,
        {
          users: new PrismaUserRepository(),
          hasher: new Argon2PasswordHasher({ memoryKib: 64, passes: 1 }),
          audit: new AuditService(),
        },
        { ...admin, countryCode: 'CD' },
      ),
    ),
  );
  if (options.secondFactor === false) {
    return { ...admin, id };
  }
  return { ...admin, id, totpSecret: await enableSecondFactor(testApp, { ...admin, id }) };
}
