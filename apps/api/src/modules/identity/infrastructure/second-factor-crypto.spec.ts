import { describe, expect, it } from '@jest/globals';
import { RECOVERY_CODE_COUNT } from '@mgx/contracts';
import { RECOVERY_CODE_PATTERN, recoveryCodeSchema } from '@mgx/validation';

import { loadAppConfig } from '../../../config/app-config.js';
import { deviceFingerprint } from './device-fingerprint.js';
import { RecoveryCodes } from './recovery-codes.js';
import { SecretCipher, SecretDecryptionError } from './secret-cipher.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  otpauthUri,
  TOTP_SECRET_BYTES,
  totpStep,
} from './totp.js';

const key = (seed: string): string => Buffer.from(seed.padEnd(32, '.')).toString('base64');

const config = (overrides: Record<string, string> = {}) =>
  loadAppConfig({
    DATABASE_URL: 'postgresql://app:pw@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    AUTH_CODE_HMAC_SECRET: 'unit-test-code-hmac-secret-0123456789abcdef',
    AUTH_SECRETS_ENCRYPTION_KEY: key('unit-test-secrets-encryption-key'),
    ...overrides,
  });

/** Secret des vecteurs de test des RFC 4226 et 6238. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (unixSeconds: number): Date => new Date(unixSeconds * 1000);

describe('base32 (RFC 4648)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encode %j en %j (vecteurs de la RFC, sans remplissage)', (text, encoded) => {
    expect(base32Encode(Buffer.from(text, 'ascii'))).toBe(encoded);
    expect(base32Decode(encoded)?.toString('ascii')).toBe(text);
  });

  it('décode sans tenir compte de la casse ni du remplissage, et refuse le reste', () => {
    expect(base32Decode('mzxw6ytboi======')?.toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW6YTB0I')).toBeNull(); // « 0 » n'appartient pas à l'alphabet
    expect(base32Decode('MZ XW')).toBeNull();
  });

  it('un secret aléatoire survit à un aller-retour', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(TOTP_SECRET_BYTES);
    expect(base32Encode(secret)).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(base32Encode(secret))?.equals(secret)).toBe(true);
    expect(generateTotpSecret().equals(secret)).toBe(false);
  });
});

describe('HOTP et TOTP', () => {
  it('HOTP : vecteurs de test de la RFC 4226 (annexe D)', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });

  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ])('TOTP : vecteur de test de la RFC 6238 à t = %d s', (unixSeconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(at(unixSeconds)), 8)).toBe(code);
    // Six chiffres : les six derniers du code à huit chiffres.
    expect(hotp(RFC_SECRET, totpStep(at(unixSeconds)))).toBe(code.slice(2));
  });

  it('un pas de temps dure trente secondes', () => {
    expect(totpStep(at(0))).toBe(0);
    expect(totpStep(at(29.999))).toBe(0);
    expect(totpStep(at(30))).toBe(1);
    expect(totpStep(at(1_111_111_109))).toBe(37_037_036);
  });

  describe('acceptation d’un code', () => {
    const now = at(1_111_111_109);
    const step = totpStep(now);
    const codeAt = (offset: number): string => hotp(RFC_SECRET, step + offset);

    it('accepte le code du pas courant et de ses voisins immédiats, pas au-delà', () => {
      expect(matchTotpStep(RFC_SECRET, codeAt(0), now, null)).toBe(step);
      expect(matchTotpStep(RFC_SECRET, codeAt(-1), now, null)).toBe(step - 1);
      expect(matchTotpStep(RFC_SECRET, codeAt(1), now, null)).toBe(step + 1);
      expect(matchTotpStep(RFC_SECRET, codeAt(-2), now, null)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, codeAt(2), now, null)).toBeNull();
    });

    it('refuse un code erroné, mal formé, ou calculé avec un autre secret', () => {
      const wrong = codeAt(0) === '000000' ? '000001' : '000000';
      expect(matchTotpStep(RFC_SECRET, wrong, now, null)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, codeAt(0).slice(0, 5), now, null)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, `${codeAt(0)}0`, now, null)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, '', now, null)).toBeNull();
      expect(matchTotpStep(generateTotpSecret(), codeAt(0), now, null)).toBeNull();
    });

    it('un code ne sert qu’une fois : il faut un pas postérieur au dernier accepté', () => {
      expect(matchTotpStep(RFC_SECRET, codeAt(0), now, step)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, codeAt(-1), now, step)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, codeAt(1), now, step)).toBe(step + 1);
      expect(matchTotpStep(RFC_SECRET, codeAt(0), now, step - 1)).toBe(step);
      // Un code d'un pas ultérieur a déjà servi : plus aucun code de la fenêtre n'est accepté.
      expect(matchTotpStep(RFC_SECRET, codeAt(1), now, step + 1)).toBeNull();
    });
  });

  it('l’URI otpauth décrit le compte et les paramètres attendus par les applications', () => {
    const uri = otpauthUri({
      issuer: 'MG-Exchange (staging)',
      accountName: 'jean.mukendi+test@example.cd',
      secret: RFC_SECRET,
    });
    expect(uri).toBe(
      'otpauth://totp/MG-Exchange%20(staging):jean.mukendi%2Btest%40example.cd' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=MG-Exchange%20(staging)' +
        '&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('chiffrement des secrets', () => {
  const cipher = new SecretCipher(config());
  const secret = generateTotpSecret();
  const CONTEXT = 'totp:0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  it('le contenu chiffré a le format attendu par la base et ne contient pas le secret', () => {
    const envelope = Buffer.from(cipher.encrypt(secret, CONTEXT));
    expect(envelope).toHaveLength(1 + 12 + TOTP_SECRET_BYTES + 16);
    expect(envelope.readUInt8(0)).toBe(1);
    expect(envelope.includes(secret)).toBe(false);
  });

  it('se déchiffre avec la même clé et le même contexte', () => {
    expect(cipher.decrypt(cipher.encrypt(secret, CONTEXT), CONTEXT).equals(secret)).toBe(true);
  });

  it('deux chiffrements du même secret diffèrent (nonce aléatoire)', () => {
    const first = Buffer.from(cipher.encrypt(secret, CONTEXT));
    expect(first.equals(Buffer.from(cipher.encrypt(secret, CONTEXT)))).toBe(false);
  });

  it('ne se déchiffre ni avec une autre clé, ni pour un autre compte, ni altéré', () => {
    const envelope = cipher.encrypt(secret, CONTEXT);
    const otherKey = new SecretCipher(
      config({ AUTH_SECRETS_ENCRYPTION_KEY: key('another-secrets-encryption-key') }),
    );
    expect(() => otherKey.decrypt(envelope, CONTEXT)).toThrow(SecretDecryptionError);
    expect(() => cipher.decrypt(envelope, 'totp:another-account')).toThrow(SecretDecryptionError);

    for (const index of [0, 1, 13, envelope.length - 1]) {
      const tampered = Uint8Array.from(envelope);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => cipher.decrypt(tampered, CONTEXT)).toThrow(SecretDecryptionError);
    }
    expect(() => cipher.decrypt(envelope.subarray(0, 20), CONTEXT)).toThrow(SecretDecryptionError);
    expect(() => cipher.decrypt(new Uint8Array(), CONTEXT)).toThrow(SecretDecryptionError);
  });
});

describe('codes de secours', () => {
  const codes = new RecoveryCodes(config());
  const USER = '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d';

  it('dix codes distincts de dix caractères, dans l’alphabet sans caractères ambigus', () => {
    const generated = codes.generate();
    expect(generated).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(generated).size).toBe(RECOVERY_CODE_COUNT);
    expect(generated.every((code) => RECOVERY_CODE_PATTERN.test(code))).toBe(true);
    expect(codes.generate()).not.toEqual(generated);
  });

  it('la forme présentée à l’utilisateur se relit telle qu’il la saisirait', () => {
    const [code = ''] = codes.generate(1);
    const shown = codes.format(code);
    expect(shown).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(recoveryCodeSchema.parse(shown)).toBe(code);
    expect(recoveryCodeSchema.parse(` ${shown.toLowerCase().replace('-', ' ')} `)).toBe(code);
  });

  it('l’empreinte dépend du code, du compte et de la clé — et ne contient pas le code', () => {
    const hash = Buffer.from(codes.hash(USER, 'ABCDE12345'));
    expect(hash).toHaveLength(32);
    expect(hash.equals(Buffer.from(codes.hash(USER, 'ABCDE12345')))).toBe(true);
    expect(hash.equals(Buffer.from(codes.hash(USER, 'ABCDE12346')))).toBe(false);
    expect(hash.equals(Buffer.from(codes.hash('another-account', 'ABCDE12345')))).toBe(false);
    const otherKey = new RecoveryCodes(
      config({ AUTH_CODE_HMAC_SECRET: 'another-code-hmac-secret-0123456789abcdef' }),
    );
    expect(hash.equals(Buffer.from(otherKey.hash(USER, 'ABCDE12345')))).toBe(false);
    expect(hash.toString('latin1')).not.toContain('ABCDE12345');
  });
});

describe('empreinte d’appareil', () => {
  const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';

  it('repose sur l’identifiant d’appareil lorsqu’il est fourni', () => {
    const first = deviceFingerprint('device-0123456789abcdef', UA);
    expect(first).toHaveLength(32);
    expect(first).toEqual(deviceFingerprint('device-0123456789abcdef', 'another user agent'));
    expect(first).not.toEqual(deviceFingerprint('device-fedcba9876543210', UA));
  });

  it('à défaut, sur l’agent utilisateur ; sans rien, l’appareil est inconnu', () => {
    expect(deviceFingerprint(undefined, UA)).toEqual(deviceFingerprint(undefined, UA));
    expect(deviceFingerprint(undefined, UA)).not.toEqual(deviceFingerprint(undefined, `${UA}x`));
    expect(deviceFingerprint(undefined, undefined)).toBeNull();
    expect(deviceFingerprint(undefined, '')).toBeNull();
  });

  it('un identifiant d’appareil ne se confond pas avec un agent utilisateur de même valeur', () => {
    expect(deviceFingerprint('same-value-0123456789', undefined)).not.toEqual(
      deviceFingerprint(undefined, 'same-value-0123456789'),
    );
  });
});
