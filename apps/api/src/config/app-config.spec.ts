import { describe, expect, it } from '@jest/globals';

import { ConfigValidationError, loadAppConfig } from './app-config.js';

const DB_PASSWORD = 'sup3r-s3cret-db-password';
const CODE_SECRET = 'code-hmac-secret-0123456789abcdef-0123456789abcdef';
/** 32 octets en base64 — clé de test uniquement. */
const ENCRYPTION_KEY = Buffer.from('unit-test-secrets-encryption-key').toString('base64');
const minimal = {
  DATABASE_URL: `postgresql://mgx_app:${DB_PASSWORD}@db.internal:5432/mgx`,
  REDIS_URL: 'redis://cache.internal:6379/0',
  AUTH_CODE_HMAC_SECRET: CODE_SECRET,
  AUTH_SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
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

describe('configuration de l’identité et des notifications', () => {
  it('applique des durées et un coût de hachage par défaut conformes aux recommandations', () => {
    const { auth, notifications } = loadAppConfig(minimal);

    expect(auth).toEqual({
      codeHmacSecret: CODE_SECRET,
      codeTtlSeconds: 900,
      secretsEncryptionKey: ENCRYPTION_KEY,
      accessTokenTtlMs: 10 * 60_000,
      sessionIdleTtlMs: 14 * 24 * 3600_000,
      sessionAbsoluteTtlMs: 60 * 24 * 3600_000,
      refreshReuseGraceMs: 10_000,
      passwordHash: { memoryKib: 19_456, passes: 2 },
    });
    expect(notifications).toEqual({ delivery: 'memory', smtp: null });
  });

  it('exige une clé de HMAC d’au moins 32 caractères, sans jamais l’afficher', () => {
    const { AUTH_CODE_HMAC_SECRET: _removed, ...withoutSecret } = minimal;
    expect(problemsOf(withoutSecret)).toEqual(['AUTH_CODE_HMAC_SECRET: is required.']);

    const short = 'too-short-secret';
    const problems = problemsOf({ ...minimal, AUTH_CODE_HMAC_SECRET: short });
    expect(problems).toEqual(['AUTH_CODE_HMAC_SECRET: Must be at least 32 characters.']);
    expect(problems.join(' ')).not.toContain(short);
  });

  it('exige une clé de chiffrement de 32 octets en base64, sans jamais l’afficher', () => {
    const { AUTH_SECRETS_ENCRYPTION_KEY: _removed, ...withoutKey } = minimal;
    expect(problemsOf(withoutKey)).toEqual(['AUTH_SECRETS_ENCRYPTION_KEY: is required.']);

    const expected = [
      'AUTH_SECRETS_ENCRYPTION_KEY: Must be 32 random bytes encoded in base64 (openssl rand -base64 32).',
    ];
    for (const malformed of [
      Buffer.alloc(16, 1).toString('base64'), // 128 bits : trop court
      Buffer.alloc(33, 1).toString('base64'), // trop long
      Buffer.alloc(32, 1).toString('hex'), // 32 octets, mais pas en base64
      `${ENCRYPTION_KEY.slice(0, -2)}*=`, // caractère hors alphabet
      'a-passphrase-is-not-a-key-of-32-random-bytes',
    ]) {
      const problems = problemsOf({ ...minimal, AUTH_SECRETS_ENCRYPTION_KEY: malformed });
      expect(problems).toEqual(expected);
      expect(problems.join(' ')).not.toContain(malformed);
    }
    expect(loadAppConfig(minimal).auth.secretsEncryptionKey).toBe(ENCRYPTION_KEY);
  });

  it('refuse une durée d’inactivité supérieure à la durée de vie maximale d’une session', () => {
    expect(
      problemsOf({
        ...minimal,
        AUTH_SESSION_IDLE_TTL_SECONDS: '7200',
        AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '3600',
      }),
    ).toEqual([
      'AUTH_SESSION_IDLE_TTL_SECONDS: Must not exceed AUTH_SESSION_ABSOLUTE_TTL_SECONDS.',
    ]);
  });

  it('hors développement, la remise par défaut est « aucune » : rien ne part sans prestataire', () => {
    expect(loadAppConfig(production).notifications.delivery).toBe('none');
    expect(loadAppConfig({ ...minimal, APP_ENV: 'development' }).notifications.delivery).toBe(
      'memory',
    );
    expect(
      loadAppConfig({ ...minimal, NOTIFICATION_DELIVERY: 'none' }).notifications.delivery,
    ).toBe('none');
  });

  it.each(['staging', 'production'])(
    'en %s : ni hachage affaibli, ni boîte de réception en mémoire',
    (environment) => {
      const hardened = { ...minimal, NODE_ENV: 'production', APP_ENV: environment };

      expect(
        problemsOf({
          ...hardened,
          AUTH_PASSWORD_HASH_MEMORY_KIB: '64',
          AUTH_PASSWORD_HASH_PASSES: '1',
          NOTIFICATION_DELIVERY: 'memory',
        }),
      ).toEqual([
        expect.stringMatching(/^AUTH_PASSWORD_HASH_MEMORY_KIB: Must be at least 19456/),
        expect.stringMatching(/^AUTH_PASSWORD_HASH_PASSES: Must be at least 2/),
        expect.stringMatching(/^NOTIFICATION_DELIVERY: "memory" is a development tool/),
      ]);

      // Un coût supérieur au minimum est, lui, toujours accepté.
      const stronger = loadAppConfig({
        ...hardened,
        AUTH_PASSWORD_HASH_MEMORY_KIB: '65536',
        AUTH_PASSWORD_HASH_PASSES: '3',
      });
      expect(stronger.auth.passwordHash).toEqual({ memoryKib: 65_536, passes: 3 });
    },
  );

  it('en test et en développement, un coût réduit est toléré', () => {
    const config = loadAppConfig({
      ...minimal,
      AUTH_PASSWORD_HASH_MEMORY_KIB: '64',
      AUTH_PASSWORD_HASH_PASSES: '1',
    });
    expect(config.auth.passwordHash).toEqual({ memoryKib: 64, passes: 1 });
  });
});

describe('configuration de l’envoi des e-mails par SMTP', () => {
  const SMTP_PASSWORD = 'smtp-acc0unt-p4ssword';
  const smtp = {
    ...minimal,
    SMTP_HOST: 'smtp.mail-provider.example',
    EMAIL_FROM: 'MG-Exchange <no-reply@mg-exchange.example>',
  };

  it('déclarer un serveur SMTP suffit à activer l’envoi : port 587 et chiffrement exigé par défaut', () => {
    expect(loadAppConfig(smtp).notifications).toEqual({
      delivery: 'smtp',
      smtp: {
        host: 'smtp.mail-provider.example',
        port: 587,
        security: 'starttls',
        auth: null,
        from: { name: 'MG-Exchange', address: 'no-reply@mg-exchange.example' },
      },
    });
  });

  it('le port suit le mode de chiffrement, sauf s’il est précisé ; les identifiants vont par deux', () => {
    expect(loadAppConfig({ ...smtp, SMTP_SECURITY: 'tls' }).notifications.smtp).toMatchObject({
      port: 465,
      security: 'tls',
    });
    expect(
      loadAppConfig({
        ...smtp,
        SMTP_PORT: '2525',
        SMTP_USER: 'apikey',
        SMTP_PASSWORD,
      }).notifications.smtp,
    ).toMatchObject({ port: 2525, auth: { user: 'apikey', password: SMTP_PASSWORD } });

    const problems = problemsOf({ ...smtp, SMTP_PASSWORD });
    expect(problems).toEqual(['SMTP_USER: SMTP_USER and SMTP_PASSWORD must be set together.']);
    expect(problems.join(' ')).not.toContain(SMTP_PASSWORD);
  });

  it('un mode de remise demandé explicitement l’emporte sur la présence d’un serveur', () => {
    expect(loadAppConfig({ ...smtp, NOTIFICATION_DELIVERY: 'memory' }).notifications).toEqual({
      delivery: 'memory',
      smtp: null,
    });
    expect(loadAppConfig({ ...smtp, NOTIFICATION_DELIVERY: 'none' }).notifications).toEqual({
      delivery: 'none',
      smtp: null,
    });
  });

  it('l’envoi par SMTP exige un serveur et un expéditeur', () => {
    expect(problemsOf({ ...minimal, NOTIFICATION_DELIVERY: 'smtp' })).toEqual([
      'SMTP_HOST: Is required when NOTIFICATION_DELIVERY is "smtp".',
      'EMAIL_FROM: Is required to send emails (sender address).',
    ]);
    expect(problemsOf({ ...minimal, SMTP_HOST: 'smtp.mail-provider.example' })).toEqual([
      'EMAIL_FROM: Is required to send emails (sender address).',
    ]);
    expect(problemsOf({ ...smtp, SMTP_HOST: 'smtp://mail-provider.example' })).toEqual([
      'SMTP_HOST: Must be a host name or an IP address.',
    ]);
  });

  it('l’expéditeur est une adresse, éventuellement précédée d’un nom affiché — et rien d’autre', () => {
    const fromOf = (value: string) =>
      loadAppConfig({ ...smtp, EMAIL_FROM: value }).notifications.smtp?.from;

    expect(fromOf('No-Reply@MG-Exchange.example')).toEqual({
      name: null,
      address: 'no-reply@mg-exchange.example',
    });
    expect(fromOf('  Équipe MG-Exchange   <no-reply@mg-exchange.example> ')).toEqual({
      name: 'Équipe MG-Exchange',
      address: 'no-reply@mg-exchange.example',
    });
    expect(fromOf('<no-reply@mg-exchange.example>')).toEqual({
      name: null,
      address: 'no-reply@mg-exchange.example',
    });

    for (const malformed of [
      'MG-Exchange',
      'MG-Exchange <not-an-address>',
      'a@mg-exchange.example, b@mg-exchange.example',
      'MG-Exchange <a@mg-exchange.example> <b@mg-exchange.example>',
      'MG-Exchange\r\nBcc: attacker@evil.example <a@mg-exchange.example>',
      '"MG" <a@mg-exchange.example>',
      `${'x'.repeat(65)} <a@mg-exchange.example>`,
    ]) {
      expect(problemsOf({ ...smtp, EMAIL_FROM: malformed })).toEqual([
        'EMAIL_FROM: Must look like "no-reply@example.com" or "Display name <no-reply@example.com>".',
      ]);
    }
  });

  it.each(['staging', 'production'])(
    'en %s, la connexion SMTP est obligatoirement chiffrée',
    (environment) => {
      const hardened = { ...smtp, NODE_ENV: 'production', APP_ENV: environment };

      expect(problemsOf({ ...hardened, SMTP_SECURITY: 'none' })).toEqual([
        `SMTP_SECURITY: Must be "starttls" or "tls" when APP_ENV is "${environment}" (encrypted connection).`,
      ]);
      expect(loadAppConfig(hardened).notifications).toMatchObject({
        delivery: 'smtp',
        smtp: { security: 'starttls', port: 587 },
      });
      expect(
        loadAppConfig({ ...hardened, SMTP_SECURITY: 'tls' }).notifications.smtp?.security,
      ).toBe('tls');
    },
  );

  it('hors environnements exposés, une connexion sans chiffrement reste possible (outils locaux)', () => {
    expect(
      loadAppConfig({ ...smtp, SMTP_SECURITY: 'none', SMTP_PORT: '1025' }).notifications.smtp,
    ).toMatchObject({ security: 'none', port: 1025 });
  });
});
