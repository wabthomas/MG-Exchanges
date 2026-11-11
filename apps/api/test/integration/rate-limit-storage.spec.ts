import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { RedisRateLimiter } from '../../src/infrastructure/rate-limit/redis-rate-limiter.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe('Limitation de débit — compteurs Redis (Redis réel)', () => {
  let testApp: TestApp;
  let limiter: RedisRateLimiter;

  beforeAll(async () => {
    testApp = await createTestApp();
    limiter = testApp.app.get(RedisRateLimiter);
  });

  afterAll(async () => {
    await testApp.close();
  });

  const hit = (key: string, limit = 3, windowMs = 60_000, blockMs?: number) =>
    limiter.consume(key, { limit, windowMs, ...(blockMs === undefined ? {} : { blockMs }) });

  it('compte les requêtes et n’en bloque aucune sous la limite', async () => {
    const results = [await hit('client-a'), await hit('client-a'), await hit('client-a')];
    expect(results.map((result) => result.remaining)).toEqual([2, 1, 0]);
    expect(results.every((result) => !result.blocked)).toBe(true);
    expect(results[0]).toMatchObject({ resetSeconds: 60, retryAfterSeconds: 0 });
  });

  it('bloque dès que la limite est dépassée, et le reste jusqu’à l’expiration', async () => {
    for (let count = 0; count < 3; count += 1) {
      await hit('client-b');
    }
    const blocked = await hit('client-b');
    expect(blocked).toMatchObject({ blocked: true, remaining: 0 });
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);

    expect(await hit('client-b')).toMatchObject({ blocked: true });
  });

  it('isole les clients les uns des autres', async () => {
    for (let count = 0; count < 5; count += 1) {
      await hit('client-c');
    }
    expect(await hit('client-d')).toMatchObject({ remaining: 2, blocked: false });
  });

  it('compte correctement sous forte concurrence (opération atomique)', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => hit('client-e', 20)));
    const allowed = results.filter((result) => !result.blocked);
    expect(allowed).toHaveLength(20);
    // Chaque requête autorisée a consommé une unité distincte : aucune mise à jour perdue.
    expect(new Set(allowed.map((result) => result.remaining)).size).toBe(20);
  });

  it('lève le blocage une fois sa durée écoulée', async () => {
    await hit('client-f', 1, 300, 300);
    expect(await hit('client-f', 1, 300, 300)).toMatchObject({ blocked: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await hit('client-f', 1, 300, 300)).toMatchObject({ remaining: 0, blocked: false });
  });
});
