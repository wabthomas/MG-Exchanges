import { Writable } from 'node:stream';

import { describe, expect, it } from '@jest/globals';
import { pinoHttp } from 'pino-http';

import { loadAppConfig } from '../../config/app-config.js';
import { buildLoggerOptions } from './logger-options.js';

const config = loadAppConfig({
  DATABASE_URL: 'postgresql://app:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  AUTH_CODE_HMAC_SECRET: 'unit-test-code-hmac-secret-0123456789abcdef',
  LOG_LEVEL: 'debug',
});

function createLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const { logger } = pinoHttp(buildLoggerOptions(config), stream);
  return {
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(''),
  };
}

describe('journalisation structurée', () => {
  it('émet du JSON avec niveau lisible, horodatage ISO et identité du service', () => {
    const { logger, records } = createLogger();
    logger.info({ orderId: 'o-1' }, 'order accepted');

    expect(records()).toEqual([
      {
        level: 'info',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        service: 'mg-exchange-api',
        environment: 'local',
        version: config.app.version,
        orderId: 'o-1',
        msg: 'order accepted',
      },
    ]);
  });

  it('n’écrit jamais de secret, à quelque profondeur que ce soit', () => {
    const { logger, raw, records } = createLogger();
    logger.warn(
      {
        password: 'hunter2',
        user: { email: 'a@b.c', session: { refreshToken: 'rt-123456', pin: '4321' } },
        headers: { authorization: 'Bearer abc.def.ghi' },
        note: 'Bearer leaked-in-a-free-text-field',
      },
      'login attempt',
    );

    const output = raw();
    for (const secret of [
      'hunter2',
      'rt-123456',
      '4321',
      'abc.def.ghi',
      'leaked-in-a-free-text-field',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(records()[0]).toMatchObject({
      password: '[REDACTED]',
      user: { email: 'a@b.c', session: { refreshToken: '[REDACTED]', pin: '[REDACTED]' } },
      headers: { authorization: '[REDACTED]' },
      note: '[REDACTED]',
    });
  });

  it('conserve la pile d’appels des erreurs', () => {
    const { logger, records } = createLogger();
    logger.error({ err: new Error('database unreachable') }, 'request failed');
    expect(records()[0]?.['err']).toMatchObject({
      type: 'Error',
      message: 'database unreachable',
      stack: expect.stringContaining('database unreachable'),
    });
  });

  it('ne journalise d’une requête que méthode, chemin, client et agent — ni en-têtes ni paramètres', () => {
    const options = buildLoggerOptions(config);
    const serialize = options.serializers?.['req'] as (request: unknown) => Record<string, unknown>;
    const serialized = serialize({
      id: 'req-12345678',
      method: 'POST',
      url: '/api/v1/auth/reset?token=very-secret-reset-token&lang=fr',
      headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'user-agent': 'jest' },
      remoteAddress: '10.0.0.1',
      remotePort: 4242,
      raw: { ip: '203.0.113.7' },
    });

    expect(serialized).toEqual({
      id: 'req-12345678',
      method: 'POST',
      path: '/api/v1/auth/reset',
      clientIp: '203.0.113.7',
      userAgent: 'jest',
    });
    expect(JSON.stringify(serialized)).not.toMatch(/very-secret-reset-token|Bearer|sid=1/);
  });

  it('ignore les sondes de santé et classe les réponses par gravité', () => {
    const options = buildLoggerOptions(config);
    const autoLogging = options.autoLogging as { ignore: (request: { url?: string }) => boolean };
    expect(autoLogging.ignore({ url: '/health/live' })).toBe(true);
    expect(autoLogging.ignore({ url: '/api/v1/system/status' })).toBe(false);

    const level = options.customLogLevel as (
      req: unknown,
      res: { statusCode: number },
      error?: Error,
    ) => string;
    expect(level({}, { statusCode: 200 })).toBe('info');
    expect(level({}, { statusCode: 404 })).toBe('warn');
    expect(level({}, { statusCode: 503 })).toBe('error');
    expect(level({}, { statusCode: 200 }, new Error('aborted'))).toBe('error');
  });
});
