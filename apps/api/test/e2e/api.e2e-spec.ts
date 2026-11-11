import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { problemDetailsSchema, systemStatusSchema } from '@mgx/contracts';
import request from 'supertest';

import { SystemSettingsService } from '../../src/modules/system-settings/application/system-settings.service.js';
import { ProbeModule } from '../support/probe.module.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const ADMIN = { type: 'USER', id: 'admin-1' } as const;

describe('API — bout en bout (HTTP, PostgreSQL et Redis réels)', () => {
  let testApp: TestApp;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    testApp = await createTestApp({
      imports: [ProbeModule],
      env: {
        HTTP_BODY_LIMIT_BYTES: '2048',
        CORS_ALLOWED_ORIGINS: 'https://app.mg-exchange.example',
      },
    });
    http = request(testApp.app.getHttpServer());
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe('sondes de santé', () => {
    it('GET /health/live répond sans dépendre d’aucun service', async () => {
      const response = await http.get('/health/live').expect(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('GET /health/ready vérifie PostgreSQL et Redis', async () => {
      const response = await http.get('/health/ready').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' }, redis: { status: 'up' } },
      });
    });

    it('les sondes ne sont ni préfixées, ni versionnées, ni limitées en débit', async () => {
      await http.get('/api/health/live').expect(404);
      const response = await http.get('/health/live').expect(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    });
  });

  describe('GET /api/v1/system/status', () => {
    it('respecte le contrat partagé et annonce toutes les fonctionnalités fermées', async () => {
      const response = await http.get('/api/v1/system/status').expect(200);
      const status = systemStatusSchema.parse(response.body);

      expect(status.service).toBe('mg-exchange-api');
      expect(status.version).toBe(testApp.config.app.version);
      expect(status.maintenance).toEqual({ enabled: false, message: null });
      expect(Object.values(status.features).every((enabled) => !enabled)).toBe(true);
      expect(Math.abs(Date.parse(status.serverTime) - Date.now())).toBeLessThan(5000);
    });

    it('n’existe que sous une version explicite', async () => {
      await http.get('/api/system/status').expect(404);
      await http.get('/api/v2/system/status').expect(404);
    });
  });

  describe('en-têtes', () => {
    it('pose les en-têtes de sécurité et interdit toute mise en cache', async () => {
      const { headers } = await http.get('/api/v1/system/status').expect(200);

      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['content-security-policy']).toContain("default-src 'self'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('attribue un identifiant de requête, ou reprend celui fourni s’il est bien formé', async () => {
      const generated = await http.get('/api/v1/system/status');
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

      const provided = await http
        .get('/api/v1/system/status')
        .set('X-Request-Id', 'client-trace-0001');
      expect(provided.headers['x-request-id']).toBe('client-trace-0001');

      const forged = await http.get('/api/v1/system/status').set('X-Request-Id', 'bad id <script>');
      expect(forged.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('n’autorise en CORS que les origines configurées', async () => {
      const allowed = await http
        .get('/api/v1/system/status')
        .set('Origin', 'https://app.mg-exchange.example');
      expect(allowed.headers['access-control-allow-origin']).toBe(
        'https://app.mg-exchange.example',
      );
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const denied = await http.get('/api/v1/system/status').set('Origin', 'https://evil.example');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('erreurs normalisées (application/problem+json)', () => {
    const expectProblem = (response: request.Response, status: number, code: string) => {
      expect(response.status).toBe(status);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      const problem = problemDetailsSchema.parse(response.body);
      expect(problem).toMatchObject({ status, code, type: 'about:blank' });
      expect(problem.requestId).toBe(response.headers['x-request-id']);
      return problem;
    };

    it('route inconnue, sous le préfixe de l’API comme en dehors', async () => {
      const inside = expectProblem(await http.get('/api/v1/unknown?x=1'), 404, 'NOT_FOUND');
      expect(inside.instance).toBe('/api/v1/unknown');
      expectProblem(await http.get('/somewhere-else'), 404, 'NOT_FOUND');
      expectProblem(await http.post('/'), 404, 'NOT_FOUND');
    });

    it('corps JSON mal formé', async () => {
      const response = await http
        .post('/api/v1/probe/validate')
        .set('Content-Type', 'application/json')
        .send('{"amount": ');
      expectProblem(response, 400, 'MALFORMED_REQUEST');
    });

    it('corps trop volumineux', async () => {
      const response = await http.post('/api/v1/probe/validate').send({ note: 'x'.repeat(5000) });
      expectProblem(response, 413, 'PAYLOAD_TOO_LARGE');
    });

    it('entrée invalide : détail champ par champ, propriétés inconnues refusées', async () => {
      const response = await http
        .post('/api/v1/probe/validate')
        .send({ amount: 12.5, note: 'this note is far too long', admin: true });
      const problem = expectProblem(response, 400, 'VALIDATION_FAILED');

      expect(problem.detail).toBe('Request validation failed.');
      expect(problem.errors?.map((error) => error.path).sort()).toEqual(['', 'amount', 'note']);
      // Un nombre JSON est refusé : un montant est toujours une chaîne.
      expect(problem.errors?.find((error) => error.path === 'amount')?.message).toMatch(
        /expected string/,
      );

      const notCanonical = await http.post('/api/v1/probe/validate').send({ amount: '1e3' });
      expect(expectProblem(notCanonical, 400, 'VALIDATION_FAILED').errors).toEqual([
        { path: 'amount', message: 'Must be a canonical decimal string, e.g. "12.34".' },
      ]);
    });

    it('entrée valide : un montant est une chaîne décimale, jamais un nombre', async () => {
      const response = await http
        .post('/api/v1/probe/validate')
        .send({ amount: '12.50' })
        .expect(201);
      expect(response.body).toEqual({ amount: '12.50' });
    });

    it('un formulaire n’est pas interprété (API JSON uniquement)', async () => {
      const response = await http
        .post('/api/v1/probe/validate')
        .type('form')
        .send({ amount: '12.50' });
      expectProblem(response, 400, 'VALIDATION_FAILED');
    });

    it('erreur inattendue : message générique, aucun détail interne dans la réponse', async () => {
      const response = await http.get('/api/v1/probe/crash');
      const problem = expectProblem(response, 500, 'INTERNAL_ERROR');

      expect(problem.detail).toBe('An unexpected error occurred. Please try again later.');
      expect(JSON.stringify(response.body)).not.toMatch(
        /postgresql|10\.0\.0\.5|internal detail|stack/i,
      );
    });
  });

  describe('fonctionnalités réglementées', () => {
    it('une route liée à une fonctionnalité fermée est refusée, puis ouverte après décision', async () => {
      const settings = testApp.app.get(SystemSettingsService);

      const closed = await http.get('/api/v1/probe/exchange');
      expect(closed.status).toBe(403);
      expect(closed.body).toMatchObject({ code: 'FEATURE_DISABLED' });

      await settings.setFeatureEnabled('exchange', true, { actor: ADMIN, reason: 'e2e' });
      await http.get('/api/v1/probe/exchange').expect(200);

      const status = await http.get('/api/v1/system/status').expect(200);
      expect(status.body.features).toMatchObject({ exchange: true, p2p: false });

      await settings.setFeatureEnabled('exchange', false, { actor: ADMIN, reason: 'e2e' });
      await http.get('/api/v1/probe/exchange').expect(403);
    });
  });

  describe('mode maintenance', () => {
    it('ferme l’API sauf les sondes et l’état de la plateforme', async () => {
      const settings = testApp.app.get(SystemSettingsService);
      await http.get('/api/v1/probe/ping').expect(200);

      await settings.set(
        'maintenance.mode',
        { enabled: true, message: 'Maintenance planifiée jusqu’à 02:00 UTC.' },
        { actor: ADMIN },
      );
      try {
        const blocked = await http.get('/api/v1/probe/ping');
        expect(blocked.status).toBe(503);
        expect(blocked.body).toMatchObject({
          code: 'MAINTENANCE',
          detail: 'Maintenance planifiée jusqu’à 02:00 UTC.',
        });

        const status = await http.get('/api/v1/system/status').expect(200);
        expect(status.body.maintenance).toEqual({
          enabled: true,
          message: 'Maintenance planifiée jusqu’à 02:00 UTC.',
        });
        await http.get('/health/live').expect(200);
        await http.get('/health/ready').expect(200);
      } finally {
        await settings.set('maintenance.mode', { enabled: false, message: null }, { actor: ADMIN });
      }
      await http.get('/api/v1/probe/ping').expect(200);
    });
  });

  describe('limitation de débit', () => {
    it('une route sensible applique sa propre limite et indique quand réessayer', async () => {
      const first = await http.get('/api/v1/probe/strict').expect(200);
      expect(first.headers).toMatchObject({
        'x-ratelimit-limit': '2',
        'x-ratelimit-remaining': '1',
      });
      await http.get('/api/v1/probe/strict').expect(200);

      const blocked = await http.get('/api/v1/probe/strict');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Les autres routes, comptées séparément, restent accessibles.
      await http.get('/api/v1/probe/ping').expect(200);
    });
  });
});
