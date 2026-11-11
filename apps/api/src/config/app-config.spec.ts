import { describe, expect, it } from '@jest/globals';

import { ConfigValidationError, loadAppConfig } from './app-config.js';

const DB_PASSWORD = 'sup3r-s3cret-db-password';
const minimal = {
  DATABASE_URL: `postgresql://mgx_app:${DB_PASSWORD}@db.internal:5432/mgx`,
  REDIS_URL: 'redis://cache.internal:6379/0',
};
const production = { ...minimal, NODE_ENV: 'production', APP_ENV: 'production' };

const problemsOf = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadAppConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.problems;
    }
    throw error;
  }
  return [];
};

describe('loadAppConfig', () => {
  it('applique des valeurs par défaut sûres à une configuration minimale', () => {
    const config = loadAppConfig(minimal);

    expect(config.app).toMatchObject({
      name: 'mg-exchange-api',
      environment: 'local',
      host: '0.0.0.0',
      port: 3000,
      trustProxyHops: 0,
    });
    expect(config.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.http).toEqual({
      corsAllowedOrigins: [],
      bodyLimitBytes: 102_400,
      rateLimit: { windowMs: 60_000, maxRequests: 120 },
    });
    expect(config.log).toEqual({ level: 'info', pretty: false });
    expect(config.redis).toMatchObject({ queueUrl: minimal.REDIS_URL, keyPrefix: 'mgx:local:' });
    expect(config.swagger).toEqual({ enabled: true, credentials: null });
    expect(config.isProduction).toBe(false);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('traite une variable vide comme absente', () => {
    expect(loadAppConfig({ ...minimal, PORT: '', QUEUE_REDIS_URL: '' }).app.port).toBe(3000);
    expect(problemsOf({ ...minimal, DATABASE_URL: '' })).toEqual(['DATABASE_URL: is required.']);
  });

  it('signale toutes les variables manquantes ou invalides en une seule fois', () => {
    expect(problemsOf({ PORT: '70000', LOG_LEVEL: 'verbose', TRUST_PROXY_HOPS: '1.5' })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^PORT: /),
        expect.stringMatching(/^LOG_LEVEL: /),
        expect.stringMatching(/^TRUST_PROXY_HOPS: /),
        'DATABASE_URL: is required.',
        'REDIS_URL: is required.',
      ]),
    );
  });

  it('ne divulgue jamais la valeur d’une variable dans le message d’erreur', () => {
    const env = {
      ...minimal,
      DATABASE_URL: `mysql://root:${DB_PASSWORD}@db.internal/mgx`,
      SWAGGER_PASSWORD: 'short',
      SWAGGER_USER: 'docs',
    };
    try {
      loadAppConfig(env);
      throw new Error('une erreur de configuration était attendue');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('SWAGGER_PASSWORD');
      expect(message).not.toContain(DB_PASSWORD);
      expect(message).not.toContain('short');
    }
  });

  it('lit les origines CORS et refuse les formats approximatifs', () => {
    const config = loadAppConfig({
      ...minimal,
      CORS_ALLOWED_ORIGINS: 'https://app.mg-exchange.example, http://localhost:3001',
    });
    expect(config.http.corsAllowedOrigins).toEqual([
      'https://app.mg-exchange.example',
      'http://localhost:3001',
    ]);

    for (const invalid of [
      'app.example.com',
      'https://app.example.com/path',
      'ftp://example.com',
    ]) {
      expect(problemsOf({ ...minimal, CORS_ALLOWED_ORIGINS: invalid })).toEqual([
        expect.stringMatching(/^CORS_ALLOWED_ORIGINS: /),
      ]);
    }
  });

  it('utilise un Redis dédié aux files lorsqu’il est fourni', () => {
    const config = loadAppConfig({
      ...minimal,
      QUEUE_REDIS_URL: 'rediss://queues.internal:6380/1',
    });
    expect(config.redis.queueUrl).toBe('rediss://queues.internal:6380/1');
    expect(config.redis.url).toBe(minimal.REDIS_URL);
  });

  describe('règles durcies de la production et de la pré-production', () => {
    it('accepte une configuration de production conforme, documentation désactivée', () => {
      const config = loadAppConfig({
        ...production,
        CORS_ALLOWED_ORIGINS: 'https://app.mg-exchange.example',
        TRUST_PROXY_HOPS: '1',
      });
      expect(config.isProduction).toBe(true);
      expect(config.swagger.enabled).toBe(false);
      expect(config.redis.keyPrefix).toBe('mgx:production:');
    });

    it('interdit la documentation de l’API en production', () => {
      expect(problemsOf({ ...production, SWAGGER_ENABLED: 'true' })).toEqual([
        'SWAGGER_ENABLED: The API documentation is never served in production.',
      ]);
    });

    it('exige NODE_ENV=production, des journaux JSON et des origines CORS explicites', () => {
      for (const environment of ['production', 'staging']) {
        const problems = problemsOf({
          ...minimal,
          APP_ENV: environment,
          NODE_ENV: 'development',
          LOG_PRETTY: 'true',
          CORS_ALLOWED_ORIGINS: '*',
        });
        expect(problems).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^NODE_ENV: /),
            expect.stringMatching(/^LOG_PRETTY: /),
            expect.stringMatching(/^CORS_ALLOWED_ORIGINS: /),
          ]),
        );
      }
    });

    it('en pré-production, la documentation exige une authentification', () => {
      const staging = { ...minimal, NODE_ENV: 'production', APP_ENV: 'staging' };
      expect(loadAppConfig(staging).swagger.enabled).toBe(false);
      expect(problemsOf({ ...staging, SWAGGER_ENABLED: 'true' })).toEqual([
        expect.stringMatching(/^SWAGGER_ENABLED: In staging/),
      ]);

      const config = loadAppConfig({
        ...staging,
        SWAGGER_ENABLED: 'true',
        SWAGGER_USER: 'docs',
        SWAGGER_PASSWORD: 'a-long-enough-password',
      });
      expect(config.swagger).toEqual({
        enabled: true,
        credentials: { user: 'docs', password: 'a-long-enough-password' },
      });
    });

    it('le joker CORS reste toléré en développement local', () => {
      expect(
        loadAppConfig({ ...minimal, CORS_ALLOWED_ORIGINS: '*' }).http.corsAllowedOrigins,
      ).toEqual(['*']);
    });
  });
});
