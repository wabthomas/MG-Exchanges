import { describe, expect, it } from '@jest/globals';

import { isRegistrationCountry } from './registration-policy.js';
import { decideRefresh, isSessionUsable, nextIdleExpiry } from './session-policy.js';
import { canUseSessions } from './user.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const MINUTE = 60_000;

describe('vie d’une session', () => {
  const usable = { idleExpiresAt: at(MINUTE), expiresAt: at(2 * MINUTE), revokedAt: null };

  it('est utilisable tant qu’elle n’est ni révoquée, ni expirée', () => {
    expect(isSessionUsable(usable, NOW)).toBe(true);
    expect(isSessionUsable({ ...usable, revokedAt: at(-1) }, NOW)).toBe(false);
    expect(isSessionUsable({ ...usable, idleExpiresAt: at(-1) }, NOW)).toBe(false);
    expect(isSessionUsable({ ...usable, expiresAt: at(-1) }, NOW)).toBe(false);
  });

  it('expire à l’instant exact de son échéance', () => {
    expect(isSessionUsable({ ...usable, idleExpiresAt: NOW }, NOW)).toBe(false);
    expect(isSessionUsable({ ...usable, expiresAt: NOW }, NOW)).toBe(false);
  });

  it('chaque utilisation repousse l’échéance d’inactivité, jamais au-delà de l’échéance absolue', () => {
    expect(nextIdleExpiry(NOW, at(60 * MINUTE), 10 * MINUTE)).toEqual(at(10 * MINUTE));
    expect(nextIdleExpiry(NOW, at(5 * MINUTE), 10 * MINUTE)).toEqual(at(5 * MINUTE));
  });
});

describe('renouvellement des jetons', () => {
  const GRACE = 10_000;

  it('un jeton jamais utilisé est remplacé', () => {
    expect(decideRefresh({ consumedAt: null }, NOW, GRACE)).toBe('ROTATE');
  });

  it('un jeton utilisé il y a quelques secondes est toléré (réponse perdue)', () => {
    expect(decideRefresh({ consumedAt: at(-1) }, NOW, GRACE)).toBe('REISSUE_WITHIN_GRACE');
    expect(decideRefresh({ consumedAt: at(-GRACE) }, NOW, GRACE)).toBe('REISSUE_WITHIN_GRACE');
  });

  it('au-delà du délai, sa réutilisation est une alerte', () => {
    expect(decideRefresh({ consumedAt: at(-GRACE - 1) }, NOW, GRACE)).toBe('REUSE_DETECTED');
    expect(decideRefresh({ consumedAt: at(-24 * 60 * MINUTE) }, NOW, GRACE)).toBe('REUSE_DETECTED');
  });

  it('avec un délai nul, toute réutilisation est une alerte — même dans la même milliseconde', () => {
    expect(decideRefresh({ consumedAt: at(-1) }, NOW, 0)).toBe('REUSE_DETECTED');
    expect(decideRefresh({ consumedAt: NOW }, NOW, 0)).toBe('REUSE_DETECTED');
    // Horloges légèrement décalées entre deux instances : la date d'usage peut être « future ».
    expect(decideRefresh({ consumedAt: at(5) }, NOW, 0)).toBe('REUSE_DETECTED');
    expect(decideRefresh({ consumedAt: null }, NOW, 0)).toBe('ROTATE');
  });

  it('avec un délai non nul, un léger décalage d’horloge entre instances reste toléré', () => {
    expect(decideRefresh({ consumedAt: at(5) }, NOW, GRACE)).toBe('REISSUE_WITHIN_GRACE');
  });
});

describe('autres règles d’identité', () => {
  it('seul un compte actif peut ouvrir ou utiliser une session', () => {
    expect(canUseSessions('ACTIVE')).toBe(true);
    for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'CLOSED'] as const) {
      expect(canUseSessions(status)).toBe(false);
    }
  });

  it('l’inscription n’est ouverte que dans le pays de lancement', () => {
    expect(isRegistrationCountry('CD')).toBe(true);
    for (const country of ['FR', 'US', 'CG', 'cd', '']) {
      expect(isRegistrationCountry(country)).toBe(false);
    }
  });
});
