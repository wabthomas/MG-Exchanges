import { describe, expect, it } from '@jest/globals';

import { ConcurrencyLimit } from './concurrency-limit.js';

describe('ConcurrencyLimit', () => {
  it('accorde au plus `max` places, puis refuse sans attendre', () => {
    const limit = new ConcurrencyLimit(2);
    const first = limit.tryAcquire();
    const second = limit.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(limit.inFlight).toBe(2);
    expect(limit.tryAcquire()).toBeNull();
    // Un refus ne prend pas de place.
    expect(limit.inFlight).toBe(2);
  });

  it('une place rendue est de nouveau disponible', () => {
    const limit = new ConcurrencyLimit(1);
    const release = limit.tryAcquire();
    expect(limit.tryAcquire()).toBeNull();
    release?.();
    expect(limit.inFlight).toBe(0);
    expect(limit.tryAcquire()).not.toBeNull();
    expect(limit.inFlight).toBe(1);
  });

  it('rendre deux fois la même place n’en libère qu’une', () => {
    const limit = new ConcurrencyLimit(2);
    const first = limit.tryAcquire();
    limit.tryAcquire();
    first?.();
    first?.();
    expect(limit.inFlight).toBe(1);
    expect(limit.tryAcquire()).not.toBeNull();
    // La seconde place n'a jamais été rendue : la limite tient toujours.
    expect(limit.tryAcquire()).toBeNull();
  });

  it('refuse une limite qui ne laisserait passer personne, ou qui n’est pas un entier', () => {
    for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ConcurrencyLimit(max)).toThrow(/positive integer/);
    }
  });
});
