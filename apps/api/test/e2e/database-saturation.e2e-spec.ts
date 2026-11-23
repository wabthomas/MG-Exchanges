import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { problemDetailsSchema } from '@mgx/contracts';
import request from 'supertest';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import {
  backgroundWorkDone,
  bearer,
  from,
  type Http,
  login,
  newClientIp,
  openFeature,
  registerVerifiedUser,
  TEST_DEVICE_ID,
} from '../support/identity.js';
import { occupyConnections } from '../support/saturation.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const POOL_SIZE = 3;

describe('Base saturée — bout en bout (HTTP, PostgreSQL réel)', () => {
  let testApp: TestApp;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: {
        TRUST_PROXY_HOPS: '1',
        DATABASE_POOL_MAX: String(POOL_SIZE),
        // Le pool renonce vite : le test n'attend pas les cinq secondes du réglage par défaut.
        DATABASE_CONNECTION_TIMEOUT_MS: '300',
      },
    });
    http = request(testApp.app.getHttpServer());
    prisma = testApp.app.get(PrismaService);
    await openFeature(testApp, 'registration');
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('sans connexion libre, une requête répond 503 et le délai avant de réessayer ; renvoyée, elle passe', async () => {
    const member = await registerVerifiedUser(http, testApp);
    const { accessToken } = (await login(http, member)).tokens;
    await backgroundWorkDone(testApp);
    const ip = newClientIp();
    const credentials = {
      email: member.email,
      password: member.password,
      deviceId: TEST_DEVICE_ID,
    };

    const release = await occupyConnections(prisma, POOL_SIZE);
    let refusals: { route: string; response: request.Response }[];
    try {
      refusals = [
        {
          // Requête authentifiée : c'est la lecture de la session qui n'a pas de connexion.
          route: '/api/v1/me',
          response: await http.get('/api/v1/me').set(bearer(accessToken)),
        },
        {
          route: '/api/v1/auth/login',
          response: await http.post('/api/v1/auth/login').set(from(ip)).send(credentials),
        },
      ];
    } finally {
      await release();
    }

    for (const { route, response } of refusals) {
      // Ni 500 — rien n'est en panne —, ni 401 : la session n'est pas en cause.
      expect({ route, status: response.status }).toEqual({ route, status: 503 });
      expect(response.headers['retry-after']).toBe('5');
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemDetailsSchema.parse(response.body)).toMatchObject({
        status: 503,
        title: 'Service Unavailable',
        code: 'SERVICE_UNAVAILABLE',
        detail: 'The service is temporarily overloaded. Please retry in a few seconds.',
        instance: route,
      });
    }

    // La connexion refusée n'a pas été prise pour un mot de passe erroné : le compte n'a pas
    // pu être lu, rien n'a été examiné, compté ni inscrit.
    const redis = testApp.app.get(RedisService).client;
    expect(await redis.keys('*login-failures:*')).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'session.login_failed' } })).toBe(0);

    // Les connexions rendues, les mêmes requêtes passent : la session est intacte.
    await http.get('/api/v1/me').set(bearer(accessToken)).expect(200);
    await http.post('/api/v1/auth/login').set(from(ip)).send(credentials).expect(200);
  });
});
