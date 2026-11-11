import type { FeatureKey, LoginResponse } from '@mgx/contracts';
import { PrismaPg } from '@prisma/adapter-pg';
import type request from 'supertest';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { AuditService } from '../../src/modules/audit/application/audit.service.js';
import { createAdministrator } from '../../src/modules/identity/application/administrator-bootstrap.js';
import { Argon2PasswordHasher } from '../../src/modules/identity/infrastructure/argon2-password-hasher.js';
import { PrismaUserRepository } from '../../src/modules/identity/infrastructure/prisma-user.repository.js';
import { NotificationSender } from '../../src/modules/notifications/application/notification-sender.js';
import {
  InMemoryNotificationSender,
  type StoredNotification,
} from '../../src/modules/notifications/infrastructure/in-memory-notification-sender.js';
import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import { eventually, type TestApp } from './test-app.js';

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
}

/** Inscrit un compte et vérifie son adresse, par l'API (la fonctionnalité doit être ouverte). */
export async function registerVerifiedUser(
  http: Http,
  testApp: TestApp,
  overrides: Partial<RegisteredUser> = {},
): Promise<RegisteredUser> {
  const user = { email: overrides.email ?? newEmail(), password: overrides.password ?? PASSWORD };
  const ip = newClientIp();
  await http
    .post('/api/v1/auth/register')
    .set(from(ip))
    .send({ ...user, countryCode: 'CD', acceptTerms: true })
    .expect(202);
  const code = await nextCode(testApp, user.email);
  await http
    .post('/api/v1/auth/email/verify')
    .set(from(ip))
    .send({ email: user.email, code })
    .expect(204);
  return user;
}

export async function login(
  http: Http,
  user: RegisteredUser,
  options: { ip?: string; deviceName?: string } = {},
): Promise<LoginResponse> {
  const response = await http
    .post('/api/v1/auth/login')
    .set(from(options.ip ?? newClientIp()))
    .send({
      email: user.email,
      password: user.password,
      ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
    })
    .expect(200);
  return response.body as LoginResponse;
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

/** Crée un administrateur comme le fait l'outil en ligne de commande (rôle propriétaire). */
export async function createAdmin(testApp: TestApp): Promise<RegisteredUser & { id: string }> {
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
  return { ...admin, id };
}
