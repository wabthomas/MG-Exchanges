import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';

import { AppModule } from '../../src/app.module.js';
import {
  configureApp,
  initializeApp,
  NEST_APPLICATION_OPTIONS,
} from '../../src/bootstrap/configure-app.js';
import { AppConfig, loadAppConfig } from '../../src/config/app-config.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { redisUrl } from './test-environment.js';

/** Clé de test uniquement : elle n'existe dans aucun environnement réel. */
export const TEST_CODE_HMAC_SECRET = 'test-only-code-hmac-secret-0123456789abcdef';

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

/**
 * Démarre l'application complète — même module racine, même configuration HTTP qu'en
 * exécution réelle — sur une base PostgreSQL isolée et l'instance Redis de test (vidée).
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
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
    // Coût de hachage minimal : les tests vérifient le comportement, pas la résistance.
    ...(hardened ? {} : { AUTH_PASSWORD_HASH_MEMORY_KIB: '64', AUTH_PASSWORD_HASH_PASSES: '1' }),
    ...options.env,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(AppConfig)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APPLICATION_OPTIONS);
  configureApp(app);
  await initializeApp(app);

  return {
    app,
    config,
    database,
    close: async () => {
      await app.close();
      await database.drop();
    },
  };
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
