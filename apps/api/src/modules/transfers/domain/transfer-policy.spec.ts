import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import {
  decideTransfer,
  isLevelOpen,
  ledgerKeyOf,
  remainingAllowance,
  requestDigest,
  type TransferCeilings,
  type TransferUsage,
} from './transfer-policy.js';

const ceilings = (
  perTransferMax: bigint,
  dailyMax: bigint,
  monthlyMax: bigint,
): TransferCeilings => ({
  perTransferMax,
  dailyMax,
  monthlyMax,
});
const usage = (last24Hours: bigint, last31Days: bigint): TransferUsage => ({
  last24Hours,
  last31Days,
});
const NOTHING_SENT = usage(0n, 0n);

describe('isLevelOpen', () => {
  it('un niveau sans plafond n’est pas ouvert', () => {
    expect(isLevelOpen(null)).toBe(false);
  });

  it('un plafond par transfert nul referme le niveau, quels que soient les autres', () => {
    expect(isLevelOpen(ceilings(0n, 0n, 0n))).toBe(false);
    expect(isLevelOpen(ceilings(0n, 500n, 5000n))).toBe(false);
  });

  it('un plafond par transfert positif, même d’une seule unité, l’ouvre', () => {
    expect(isLevelOpen(ceilings(1n, 1n, 1n))).toBe(true);
  });
});

describe('decideTransfer', () => {
  const LIMITS = ceilings(100n, 250n, 1000n);

  it('sans plafond fixé, ou avec un plafond par transfert nul : le niveau n’est pas ouvert', () => {
    expect(decideTransfer(1n, null, NOTHING_SENT)).toEqual({
      allowed: false,
      reason: 'LEVEL_NOT_OPEN',
    });
    expect(decideTransfer(1n, ceilings(0n, 250n, 1000n), NOTHING_SENT)).toEqual({
      allowed: false,
      reason: 'LEVEL_NOT_OPEN',
    });
  });

  it('le plafond par transfert est inclus : il admet son montant exact, pas une unité de plus', () => {
    expect(decideTransfer(100n, LIMITS, NOTHING_SENT)).toEqual({ allowed: true });
    expect(decideTransfer(101n, LIMITS, NOTHING_SENT)).toEqual({
      allowed: false,
      reason: 'LIMIT_EXCEEDED',
      breach: 'PER_TRANSFER',
    });
  });

  it('le plafond sur 24 heures compte ce qui a déjà été envoyé, et s’atteint exactement', () => {
    expect(decideTransfer(100n, LIMITS, usage(150n, 150n))).toEqual({ allowed: true });
    expect(decideTransfer(100n, LIMITS, usage(151n, 151n))).toEqual({
      allowed: false,
      reason: 'LIMIT_EXCEEDED',
      breach: 'DAILY',
    });
  });

  it('le plafond sur 31 jours compte ce qui a déjà été envoyé, et s’atteint exactement', () => {
    expect(decideTransfer(100n, LIMITS, usage(0n, 900n))).toEqual({ allowed: true });
    expect(decideTransfer(100n, LIMITS, usage(0n, 901n))).toEqual({
      allowed: false,
      reason: 'LIMIT_EXCEEDED',
      breach: 'MONTHLY',
    });
  });

  it('nomme le premier plafond dépassé, du plus court au plus long', () => {
    // Les trois sont dépassés : c'est le plafond par transfert qui est nommé.
    expect(decideTransfer(101n, LIMITS, usage(250n, 1000n))).toMatchObject({
      breach: 'PER_TRANSFER',
    });
    // Les deux cumuls sont dépassés : c'est celui des 24 heures.
    expect(decideTransfer(1n, LIMITS, usage(250n, 1000n))).toMatchObject({ breach: 'DAILY' });
    // Seul le cumul des 31 jours l'est.
    expect(decideTransfer(1n, LIMITS, usage(249n, 1000n))).toMatchObject({ breach: 'MONTHLY' });
  });

  it('des plafonds égaux admettent un seul transfert de leur montant', () => {
    const single = ceilings(100n, 100n, 100n);
    expect(decideTransfer(100n, single, NOTHING_SENT)).toEqual({ allowed: true });
    expect(decideTransfer(1n, single, usage(100n, 100n))).toMatchObject({ breach: 'DAILY' });
    // Le lendemain, le cumul des 24 heures est vide ; celui des 31 jours ne l'est pas.
    expect(decideTransfer(1n, single, usage(0n, 100n))).toMatchObject({ breach: 'MONTHLY' });
  });

  it('compte sans perte au-delà de 2^53', () => {
    const huge = 10n ** 30n;
    const limits = ceilings(huge, huge * 2n, huge * 3n);
    expect(decideTransfer(huge, limits, usage(huge, huge))).toEqual({ allowed: true });
    expect(decideTransfer(huge, limits, usage(huge + 1n, huge + 1n))).toMatchObject({
      breach: 'DAILY',
    });
  });
});

describe('remainingAllowance', () => {
  const LIMITS = ceilings(100n, 250n, 1000n);

  it('zéro si le niveau n’est pas ouvert', () => {
    expect(remainingAllowance(null, NOTHING_SENT)).toBe(0n);
    expect(remainingAllowance(ceilings(0n, 250n, 1000n), NOTHING_SENT)).toBe(0n);
  });

  it('le plus petit des trois : le plafond par transfert, ou ce qu’un cumul admet encore', () => {
    expect(remainingAllowance(LIMITS, NOTHING_SENT)).toBe(100n);
    expect(remainingAllowance(LIMITS, usage(200n, 200n))).toBe(50n);
    expect(remainingAllowance(LIMITS, usage(0n, 970n))).toBe(30n);
    expect(remainingAllowance(LIMITS, usage(240n, 995n))).toBe(5n);
  });

  it('zéro lorsqu’un cumul a atteint — ou dépassé — son plafond', () => {
    expect(remainingAllowance(LIMITS, usage(250n, 250n))).toBe(0n);
    expect(remainingAllowance(LIMITS, usage(0n, 1000n))).toBe(0n);
    // Les plafonds ont été abaissés après des envois : le reste ne devient pas négatif.
    expect(remainingAllowance(LIMITS, usage(400n, 4000n))).toBe(0n);
  });

  it('ce qu’il annonce est admis, et une unité de plus ne l’est pas', () => {
    for (const sent of [NOTHING_SENT, usage(200n, 200n), usage(0n, 970n), usage(240n, 995n)]) {
      const remaining = remainingAllowance(LIMITS, sent);
      expect(decideTransfer(remaining, LIMITS, sent)).toEqual({ allowed: true });
      expect(decideTransfer(remaining + 1n, LIMITS, sent)).toMatchObject({ allowed: false });
    }
  });
});

describe('requestDigest', () => {
  const REQUEST = { recipientEmail: 'bob@example.cd', assetCode: 'USD', units: 1250n };

  it('une empreinte SHA-256 de 32 octets, la même pour la même requête', () => {
    expect(requestDigest(REQUEST)).toHaveLength(32);
    expect(requestDigest({ ...REQUEST }).equals(requestDigest(REQUEST))).toBe(true);
  });

  it('son format est figé : le modifier ferait refuser les requêtes renvoyées', () => {
    expect(requestDigest(REQUEST).toString('hex')).toBe(
      createHash('sha256')
        .update('["transfer.internal","bob@example.cd","USD","1250"]', 'utf8')
        .digest('hex'),
    );
  });

  it('le destinataire, l’actif et le montant la changent chacun', () => {
    const digests = [
      REQUEST,
      { ...REQUEST, recipientEmail: 'bobby@example.cd' },
      { ...REQUEST, assetCode: 'CDF' },
      { ...REQUEST, units: 1251n },
    ].map((request) => requestDigest(request).toString('hex'));
    expect(new Set(digests).size).toBe(4);
  });

  it('deux requêtes distinctes ne se confondent pas en déplaçant un caractère d’un champ à l’autre', () => {
    const left = requestDigest({ recipientEmail: 'a@b.cd', assetCode: 'USD', units: 11n });
    const right = requestDigest({ recipientEmail: 'a@b.cd', assetCode: 'USD1', units: 1n });
    expect(left.equals(right)).toBe(false);
    // Un guillemet dans une adresse ne permet pas d'imiter une autre requête.
    const quoted = requestDigest({ recipientEmail: 'a","USD","1', assetCode: 'USD', units: 1n });
    const plain = requestDigest({ recipientEmail: 'a', assetCode: 'USD', units: 1n });
    expect(quoted.equals(plain)).toBe(false);
  });
});

describe('ledgerKeyOf', () => {
  it('la clé de l’écriture d’un transfert porte son identifiant', () => {
    expect(ledgerKeyOf('0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d')).toBe(
      'transfer:0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
    );
  });
});
