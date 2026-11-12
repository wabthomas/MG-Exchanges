import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import { createTestApp, type TestApp } from '../support/test-app.js';

const OPENAPI_SNAPSHOT_PATH = fileURLToPath(
  new URL('../../../../docs/api/openapi.json', import.meta.url),
);

describe('Règles par environnement — bout en bout', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
  });

  describe('documentation OpenAPI', () => {
    it('en développement : interface et document servis ; le document versionné est à jour', async () => {
      testApp = await createTestApp();
      const http = request(testApp.app.getHttpServer());

      const ui = await http.get('/api/docs').expect(200);
      expect(ui.text).toContain('swagger-ui');

      const response = await http.get('/api/docs-json').expect(200);
      expect(response.body.openapi).toMatch(/^3\./);
      expect(Object.keys(response.body.paths).sort()).toEqual([
        '/api/v1/admin/role-changes',
        '/api/v1/admin/role-changes/{requestId}',
        '/api/v1/admin/role-changes/{requestId}/approve',
        '/api/v1/admin/role-changes/{requestId}/cancel',
        '/api/v1/admin/role-changes/{requestId}/reject',
        '/api/v1/admin/roles',
        '/api/v1/admin/system-settings',
        '/api/v1/admin/system-settings/{key}',
        '/api/v1/admin/users',
        '/api/v1/admin/users/search',
        '/api/v1/admin/users/{userId}',
        '/api/v1/admin/users/{userId}/mfa/reset',
        '/api/v1/admin/users/{userId}/reactivate',
        '/api/v1/admin/users/{userId}/sessions/revoke',
        '/api/v1/admin/users/{userId}/suspend',
        '/api/v1/auth/email/resend',
        '/api/v1/auth/email/verify',
        '/api/v1/auth/login',
        '/api/v1/auth/logout',
        '/api/v1/auth/mfa/verify',
        '/api/v1/auth/password/change',
        '/api/v1/auth/password/forgot',
        '/api/v1/auth/password/reset',
        '/api/v1/auth/refresh',
        '/api/v1/auth/register',
        '/api/v1/me',
        '/api/v1/me/activity',
        '/api/v1/me/mfa',
        '/api/v1/me/mfa/recovery-codes',
        '/api/v1/me/mfa/totp/confirm',
        '/api/v1/me/mfa/totp/disable',
        '/api/v1/me/mfa/totp/enroll',
        '/api/v1/me/phone/verification',
        '/api/v1/me/phone/verify',
        '/api/v1/me/profile',
        '/api/v1/me/sessions',
        '/api/v1/me/sessions/revoke-others',
        '/api/v1/me/sessions/{sessionId}',
        '/api/v1/system/status',
        '/health/live',
        '/health/ready',
      ]);
      // Les outils de développement (boîte de réception) ne font pas partie du contrat publié.
      expect(JSON.stringify(response.body.paths)).not.toContain('/dev/');

      // docs/api/openapi.json est le contrat publié (importable dans Postman, Insomnia…).
      // `pnpm --filter @mgx/api openapi:export` le régénère ; ce test échoue s'il a dérivé.
      const current = `${JSON.stringify(response.body, null, 2)}\n`;
      if (process.env['UPDATE_OPENAPI'] === '1') {
        writeFileSync(OPENAPI_SNAPSHOT_PATH, current);
      }
      expect(readFileSync(OPENAPI_SNAPSHOT_PATH, 'utf8')).toBe(current);
    });

    it('en pré-production : accessible uniquement après authentification', async () => {
      testApp = await createTestApp({
        env: {
          NODE_ENV: 'production',
          APP_ENV: 'staging',
          SWAGGER_ENABLED: 'true',
          SWAGGER_USER: 'docs',
          SWAGGER_PASSWORD: 'a-long-enough-password',
        },
      });
      const http = request(testApp.app.getHttpServer());

      for (const path of ['/api/docs', '/api/docs-json']) {
        const anonymous = await http.get(path).expect(401);
        expect(anonymous.headers['www-authenticate']).toMatch(/^Basic /);
        await http.get(path).auth('docs', 'wrong-password-value').expect(401);
        await http.get(path).auth('wrong', 'a-long-enough-password').expect(401);
        await http.get(path).auth('docs', 'a-long-enough-password').expect(200);
      }
      // L'API elle-même n'est pas concernée par cette authentification.
      await http.get('/api/v1/system/status').expect(200);
    });

    it('en production : aucune documentation n’est servie', async () => {
      testApp = await createTestApp({ env: { NODE_ENV: 'production', APP_ENV: 'production' } });
      const http = request(testApp.app.getHttpServer());

      for (const path of ['/api/docs', '/api/docs-json', '/api/docs-yaml']) {
        const response = await http.get(path);
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      }
      await http.get('/api/v1/system/status').expect(200);
    });
  });

  describe('limitation de débit globale', () => {
    it('bloque un client au-delà de la limite configurée', async () => {
      testApp = await createTestApp({ env: { RATE_LIMIT_MAX_REQUESTS: '3' } });
      const http = request(testApp.app.getHttpServer());

      for (let count = 0; count < 3; count += 1) {
        await http.get('/api/v1/system/status').expect(200);
      }
      const blocked = await http.get('/api/v1/system/status');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Les sondes de l'orchestrateur ne sont jamais limitées.
      await http.get('/health/live').expect(200);
    });

    it('ne se fie à X-Forwarded-For que derrière un proxy de confiance', async () => {
      testApp = await createTestApp({ env: { RATE_LIMIT_MAX_REQUESTS: '2' } });
      const http = request(testApp.app.getHttpServer());

      // Sans proxy de confiance (TRUST_PROXY_HOPS=0), changer l'en-tête ne remet pas le compteur à zéro.
      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.1').expect(200);
      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.2').expect(200);
      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.3').expect(429);
    });

    it('derrière le reverse proxy, chaque client réel a son propre compteur', async () => {
      testApp = await createTestApp({
        env: { RATE_LIMIT_MAX_REQUESTS: '1', TRUST_PROXY_HOPS: '1' },
      });
      const http = request(testApp.app.getHttpServer());

      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.1').expect(200);
      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.1').expect(429);
      await http.get('/api/v1/system/status').set('X-Forwarded-For', '198.51.100.2').expect(200);
    });
  });

  describe('traitements asynchrones de bout en bout', () => {
    it('le relais planifié publie les événements de la boîte d’envoi sans intervention', async () => {
      testApp = await createTestApp();
      const { PrismaService } = await import('../../src/infrastructure/database/prisma.service.js');
      const { SystemSettingsService } =
        await import('../../src/modules/system-settings/application/system-settings.service.js');
      const prisma = testApp.app.get(PrismaService);

      await testApp.app
        .get(SystemSettingsService)
        .setFeatureEnabled('kyc', true, { actor: { type: 'USER', id: 'admin-1' } });

      const { eventually } = await import('../support/test-app.js');
      await eventually(async () => {
        const event = await prisma.outboxEvent.findFirstOrThrow({
          where: { aggregateId: 'features.kyc' },
        });
        return event.status === 'PUBLISHED';
      });
    });
  });
});
