import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { loadAppConfig } from '../../../config/app-config.js';
import { Argon2PasswordHasher } from './argon2-password-hasher.js';
import { hashPresentedToken, issueSessionToken } from './session-tokens.js';
import { VerificationCodes } from './verification-codes.js';

const FAST = { memoryKib: 64, passes: 1 };

describe('hachage des mots de passe (Argon2id)', () => {
  const hasher = new Argon2PasswordHasher(FAST);

  it('produit une empreinte au format PHC, qui porte ses paramètres', async () => {
    const hash = await hasher.hash('lumumba-boulevard-30');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain('lumumba');
  });

  it('vérifie le bon mot de passe et lui seul', async () => {
    const hash = await hasher.hash('lumumba-boulevard-30');
    expect(await hasher.verify(hash, 'lumumba-boulevard-30')).toBe(true);
    expect(await hasher.verify(hash, 'lumumba-boulevard-31')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('sale chaque empreinte : deux hachages du même mot de passe diffèrent', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('same-password-1'),
      hasher.hash('same-password-1'),
    ]);
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, 'same-password-1')).toBe(true);
    expect(await hasher.verify(second, 'same-password-1')).toBe(true);
  });

  it('traite comme identiques deux saisies Unicode équivalentes', async () => {
    const hash = await hasher.hash('caf\u00e9-noir-du-kivu');
    expect(await hasher.verify(hash, 'cafe\u0301-noir-du-kivu')).toBe(true);
  });

  it('vérifie une empreinte calculée avec d’autres paramètres, et signale qu’elle est à recalculer', async () => {
    const stronger = new Argon2PasswordHasher({ memoryKib: 128, passes: 2 });
    const hash = await stronger.hash('lumumba-boulevard-30');

    expect(await hasher.verify(hash, 'lumumba-boulevard-30')).toBe(true);
    expect(hasher.needsRehash(hash)).toBe(true);
    expect(stronger.needsRehash(hash)).toBe(false);
  });

  it.each([
    ['vide', ''],
    ['mot de passe en clair', 'lumumba-boulevard-30'],
    ['autre algorithme', '$2b$12$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz012345'],
    ['argon2i', `$argon2i$v=19$m=64,t=1,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['version inconnue', `$argon2id$v=16$m=64,t=1,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['mémoire démesurée', `$argon2id$v=19$m=9999999,t=1,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['passes démesurées', `$argon2id$v=19$m=64,t=99,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['mémoire insuffisante', `$argon2id$v=19$m=4,t=1,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`],
    ['tronquée', `$argon2id$v=19$m=64,t=1,p=1$${'A'.repeat(22)}$`],
  ])(
    'une empreinte invalide (%s) ne correspond à rien, sans lever ni calculer',
    async (_label, hash) => {
      const started = Date.now();
      expect(await hasher.verify(hash, 'lumumba-boulevard-30')).toBe(false);
      expect(hasher.needsRehash(hash)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    },
  );

  it('la vérification factice s’exécute sans rien révéler', async () => {
    await expect(hasher.verifyAgainstDummy('whatever-password')).resolves.toBeUndefined();
  });
});

describe('jetons de session', () => {
  it('sont opaques, préfixés selon leur nature, et tous différents', () => {
    const access = issueSessionToken('access');
    const refresh = issueSessionToken('refresh');

    expect(access.token).toMatch(/^mgx_at_[A-Za-z0-9_-]{43}$/);
    expect(refresh.token).toMatch(/^mgx_rt_[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, () => issueSessionToken('access').token)).size).toBe(
      200,
    );
  });

  it('seule l’empreinte SHA-256 (32 octets) est destinée au stockage', () => {
    const issued = issueSessionToken('access');
    expect(issued.hash).toHaveLength(32);
    expect(Buffer.from(issued.hash).toString('hex')).toBe(
      createHash('sha256').update(issued.token, 'utf8').digest('hex'),
    );
    expect(hashPresentedToken('access', issued.token)).toEqual(issued.hash);
    expect(Buffer.from(issued.hash).toString('latin1')).not.toContain(issued.token.slice(7));
  });

  it.each([
    ['vide', ''],
    ['sans préfixe', 'A'.repeat(43)],
    ['trop court', 'mgx_at_short'],
    ['trop long', `mgx_at_${'A'.repeat(44)}`],
    ['caractère interdit', `mgx_at_${'A'.repeat(42)}!`],
    ['préfixe de l’autre nature', `mgx_rt_${'A'.repeat(43)}`],
  ])('un jeton mal formé (%s) est écarté sans recherche', (_label, token) => {
    expect(hashPresentedToken('access', token)).toBeNull();
  });
});

describe('codes à usage unique', () => {
  const config = (secret: string) =>
    loadAppConfig({
      DATABASE_URL: 'postgresql://app:pw@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379/0',
      AUTH_CODE_HMAC_SECRET: secret,
    });
  const codes = new VerificationCodes(config('unit-test-code-hmac-secret-0123456789abcdef'));
  const CHALLENGE = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  it('ont toujours six chiffres, zéros de tête compris', () => {
    const generated = Array.from({ length: 2000 }, () => codes.generate());
    expect(generated.every((code) => /^\d{6}$/.test(code))).toBe(true);
    expect(new Set(generated).size).toBeGreaterThan(1900);
    expect(generated.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('ne sont reconnus que pour leur défi', () => {
    const hash = codes.hash(CHALLENGE, '123456');
    expect(hash).toHaveLength(32);
    expect(Buffer.from(hash).toString('hex')).toBe(
      createHmac('sha256', 'unit-test-code-hmac-secret-0123456789abcdef')
        .update(`${CHALLENGE}:123456`, 'utf8')
        .digest('hex'),
    );
    expect(codes.matches(hash, CHALLENGE, '123456')).toBe(true);
    expect(codes.matches(hash, CHALLENGE, '123457')).toBe(false);
    expect(codes.matches(hash, '0195f3a2-7c1e-7d3a-9b1c-000000000000', '123456')).toBe(false);
    expect(codes.matches(new Uint8Array(6), CHALLENGE, '123456')).toBe(false);
  });

  it('leur empreinte dépend d’une clé absente de la base : sans elle, la base ne révèle rien', () => {
    const other = new VerificationCodes(config('another-code-hmac-secret-0123456789abcdef-xyz'));
    expect(other.hash(CHALLENGE, '123456')).not.toEqual(codes.hash(CHALLENGE, '123456'));
    expect(other.matches(codes.hash(CHALLENGE, '123456'), CHALLENGE, '123456')).toBe(false);
  });
});
