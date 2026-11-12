import { getQueueToken } from '@nestjs/bullmq';
import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { AppModule } from '../../src/app.module.js';
import {
  configureApp,
  initializeApp,
  NEST_APPLICATION_OPTIONS,
} from '../../src/bootstrap/configure-app.js';
import { Clock } from '../../src/common/clock.js';
import { AppConfig, loadAppConfig } from '../../src/config/app-config.js';
import { ACCOUNT_MAINTENANCE_QUEUE } from '../../src/infrastructure/queue/queue.constants.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { redisUrl } from './test-environment.js';

/** Clés de test uniquement : elles n'existent dans aucun environnement réel. */
export const TEST_CODE_HMAC_SECRET = 'test-only-code-hmac-secret-0123456789abcdef';
export const TEST_SECRETS_ENCRYPTION_KEY = Buffer.from('test-only-secrets-encryption-key').toString(
  'base64',
);

/**
 * Horloge maîtrisée par les tests ; elle ne peut qu'avancer. L'application y lit l'heure des
 * codes du second facteur — qui changent toutes les trente secondes et ne sont acceptés qu'une
 * fois : l'avancer en donne un nouveau sans attendre —, des décisions du back-office, des
 * échéances des demandes de changement de rôle et de la purge périodique. Les sessions et les
 * codes à usage unique lisent l'heure réelle.
 */
export class TestClock extends Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(milliseconds: number): void {
    this.offsetMs += milliseconds;
  }
}

/** Une horloge par fichier de test, partagée par ses applications et ses utilitaires. */
export const testClock = new TestClock();

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly config: AppConfig;
  readonly database: TestDatabase;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Variables d'environnement surchargeant la configuration de test. */
  readonly env?: Record<string, string>;
  /** Modules supplémentaires (contrôleurs de test). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
}

/** Applications de test démarrées par ce fichier de test et pas encore arrêtées. */
let running = 0;

/**
 * Démarre l'application complète — même module racine, même configuration HTTP qu'en
 * exécution réelle — sur une base PostgreSQL isolée et l'instance Redis de test (vidée).
 *
 * Une seule à la fois : voir le message de l'erreur levée sinon.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  if (running > 0) {
    throw new Error(
      'Another test application is still running. Test applications share one Redis instance ' +
        '— hence their queues — but each has its own database: either one may take an event ' +
        'of the other, find nothing about it in its own database, and drop it. Close the ' +
        'first application before starting another (a separate `describe` block does it).',
    );
  }
  const database = await createTestDatabase();

  const flush = new Redis(redisUrl());
  await flush.flushdb();
  await flush.quit();

  // Un environnement durci refuse un hachage affaibli : le coût réduit ne vaut qu'en test.
  const hardened = ['staging', 'production'].includes(options.env?.['APP_ENV'] ?? 'test');

  const config = loadAppConfig({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.appUrl,
    DATABASE_POOL_MAX: '5',
    REDIS_URL: redisUrl(),
    RATE_LIMIT_MAX_REQUESTS: '1000',
    OUTBOX_POLL_INTERVAL_MS: '100',
    AUTH_CODE_HMAC_SECRET: TEST_CODE_HMAC_SECRET,
    AUTH_SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
    // Coût de hachage minimal : les tests vérifient le comportement, pas la résistance.
    ...(hardened ? {} : { AUTH_PASSWORD_HASH_MEMORY_KIB: '64', AUTH_PASSWORD_HASH_PASSES: '1' }),
    ...options.env,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(Clock)
    .useValue(testClock)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APPLICATION_OPTIONS);
  configureApp(app);
  await initializeApp(app);
  running += 1;
  await startupMaintenanceDone(app);

  return {
    app,
    config,
    database,
    close: async () => {
      await app.close();
      running -= 1;
      await database.drop();
    },
  };
}

/**
 * La purge périodique s'exécute une première fois au démarrage, puis toutes les heures.
 * Attendre la fin de cette première exécution garantit qu'aucune purge ne se déroule pendant
 * les tests — sauf celles qu'ils déclenchent eux-mêmes.
 */
async function startupMaintenanceDone(app: NestExpressApplication): Promise<void> {
  const queue = app.get<Queue>(getQueueToken(ACCOUNT_MAINTENANCE_QUEUE));
  await eventually(async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'prioritized');
    return Object.values(counts).every((count) => count === 0);
  });
}

/** Attend qu'une condition asynchrone devienne vraie (traitements en arrière-plan). */
export async function eventually(
  condition: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
