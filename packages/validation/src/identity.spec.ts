import { describe, expect, it } from '@jest/globals';

import {
  countryCodeSchema,
  deviceIdSchema,
  emailSchema,
  IDENTITY_DOCUMENT_NUMBER_PATTERN,
  identityDocumentNumberSchema,
  isoDateSchema,
  isTimeZone,
  localeSchema,
  normalizeIdentityDocumentNumber,
  normalizeRecoveryCode,
  passwordSchema,
  personNameSchema,
  phoneNumberSchema,
  presentedPasswordSchema,
  RECOVERY_CODE_ALPHABET,
  recoveryCodeSchema,
  textBlockSchema,
  textLineSchema,
  timeZoneSchema,
  totpCodeSchema,
  uuidSchema,
  verificationCodeSchema,
} from './identity.js';

describe('emailSchema', () => {
  it('normalise l’adresse : espaces retirés, minuscules', () => {
    expect(emailSchema.parse('  Jean.Mukendi@Example.COM ')).toBe('jean.mukendi@example.com');
    expect(emailSchema.parse('a+tag@sub.example.cd')).toBe('a+tag@sub.example.cd');
  });

  it.each([
    'sans-arobase',
    'a@b',
    '@example.com',
    'a b@example.com',
    'a@example..com',
    '',
    42,
    null,
    `${'a'.repeat(250)}@example.com`,
  ])('refuse %p', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('n’impose qu’une longueur, sans règle de composition', () => {
    expect(passwordSchema.parse('correct horse')).toBe('correct horse');
    expect(passwordSchema.parse('a'.repeat(128))).toHaveLength(128);
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse(1234567890).success).toBe(false);
  });

  it('un mot de passe présenté pour s’authentifier n’est borné qu’en taille', () => {
    expect(presentedPasswordSchema.parse('short')).toBe('short');
    expect(presentedPasswordSchema.safeParse('').success).toBe(false);
    expect(presentedPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});

describe('phoneNumberSchema', () => {
  it.each(['+243812345678', '+33612345678', '+12025550123'])('accepte %s', (value) => {
    expect(phoneNumberSchema.parse(value)).toBe(value);
  });

  it.each([
    '0812345678',
    '243812345678',
    '+0123456789',
    '+243 81 234 5678',
    '+24381',
    '+1234567890123456',
  ])('refuse %s', (value) => {
    expect(phoneNumberSchema.safeParse(value).success).toBe(false);
  });
});

describe('autres primitives d’identité', () => {
  it('code pays : deux lettres majuscules', () => {
    expect(countryCodeSchema.parse('CD')).toBe('CD');
    for (const value of ['cd', 'COD', 'C', '', 243]) {
      expect(countryCodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('langue : uniquement celles prises en charge', () => {
    expect(localeSchema.parse('fr')).toBe('fr');
    expect(localeSchema.safeParse('de').success).toBe(false);
  });

  it('code de vérification : six chiffres, sous forme de chaîne', () => {
    expect(verificationCodeSchema.parse('012345')).toBe('012345');
    for (const value of ['12345', '1234567', '12345a', ' 123456', 123456]) {
      expect(verificationCodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('identifiant : UUID', () => {
    expect(uuidSchema.parse('0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d')).toBe(
      '0195f3a2-7c1e-7d3a-9b1c-2f4e6a8b0c1d',
    );
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('second facteur', () => {
  it('code de l’application d’authentification : six chiffres, zéros de tête compris', () => {
    expect(totpCodeSchema.parse('000042')).toBe('000042');
    for (const value of ['42', '12345', '1234567', '12 345', 'abcdef', '', 123456, null]) {
      expect(totpCodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('l’alphabet des codes de secours écarte les lettres qui se confondent', () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it.each([
    ['ABCDE-12345', 'ABCDE12345'],
    ['abcde-12345', 'ABCDE12345'],
    [' abcde 12345 ', 'ABCDE12345'],
    ['ABCDE12345', 'ABCDE12345'],
    // Lettres absentes de l'alphabet, ramenées au chiffre qu'elles évoquent.
    ['OIL0Z-1AAAA', '0110Z1AAAA'],
    ['oooo0-iiill', '0000011111'],
  ])('un code de secours saisi à la main est normalisé : %s', (typed, canonical) => {
    expect(normalizeRecoveryCode(typed)).toBe(canonical);
    expect(recoveryCodeSchema.parse(typed)).toBe(canonical);
  });

  it.each(['', 'ABCDE-1234', 'ABCDE-123456', 'ABCDE-1234U', 'ABCDE_12345', 'x'.repeat(33), 12345])(
    'refuse le code de secours %s',
    (value) => {
      expect(recoveryCodeSchema.safeParse(value).success).toBe(false);
    },
  );

  it('identifiant d’appareil : valeur opaque de 16 à 128 caractères sûrs', () => {
    for (const value of ['a'.repeat(16), 'A1b2-C3d4_E5f6-G7h8', 'z'.repeat(128)]) {
      expect(deviceIdSchema.parse(value)).toBe(value);
    }
    for (const value of [
      'a'.repeat(15),
      'z'.repeat(129),
      'has spaces in the id',
      'émoji-😀-device-id',
      '',
    ]) {
      expect(deviceIdSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('profil', () => {
  it.each([
    ['Jean', 'Jean'],
    ['  Jean-Pierre ', 'Jean-Pierre'],
    ["N'Kashama", "N'Kashama"],
    ['N’Kashama', 'N’Kashama'],
    ['Mukendi wa Kabongo', 'Mukendi wa Kabongo'],
    ['Élisabeth', 'Élisabeth'],
    ['St. Clair', 'St. Clair'],
    ['محمد', 'محمد'],
    ['x'.repeat(100), 'x'.repeat(100)],
  ])('accepte le nom « %s »', (value, expected) => {
    expect(personNameSchema.parse(value)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'Jean2',
    '-Jean',
    "'Jean",
    'Jean<script>',
    'Jean_Pierre',
    'a@b.cd',
    'x'.repeat(101),
    'Jean\nPierre',
    42,
  ])('refuse le nom %s', (value) => {
    expect(personNameSchema.safeParse(value).success).toBe(false);
  });

  it('date civile : année-mois-jour, et le jour doit exister', () => {
    expect(isoDateSchema.parse('1990-05-17')).toBe('1990-05-17');
    expect(isoDateSchema.parse('2024-02-29')).toBe('2024-02-29');
    for (const value of [
      '2023-02-29',
      '1990-13-01',
      '17/05/1990',
      '1990-5-17',
      '1990-05-17T00:00:00Z',
      '',
      19900517,
    ]) {
      expect(isoDateSchema.safeParse(value).success).toBe(false);
    }
  });

  it('ligne de texte : bornée, espaces superflus retirés, sans caractère de contrôle', () => {
    const line = textLineSchema(20);
    expect(line.parse('  12, av. de la Paix ')).toBe('12, av. de la Paix');
    expect(line.parse('x'.repeat(20))).toBe('x'.repeat(20));
    // Un retour à la ligne final n'est qu'un espace superflu.
    expect(line.parse('Goma\r\n')).toBe('Goma');
    for (const value of [
      '',
      '   ',
      'x'.repeat(21),
      'ligne 1\nligne 2',
      'tab\tulation',
      'nul\u0000',
      'retour\rchariot',
      7,
    ]) {
      expect(line.safeParse(value).success).toBe(false);
    }
  });

  it('bloc de texte : plusieurs lignes, borné, non vide, conservé tel quel', () => {
    const block = textBlockSchema(40);
    // Rien n'est retouché : ni les espaces de tête, ni le saut de ligne final.
    for (const value of [
      '  Article 1\n\n\tObjet.\r\n',
      'x'.repeat(40),
      'Conditions générales — « É » œ',
      'emoji 😀 hors du plan de base',
      'x',
      // Ailleurs qu'en tête, ce caractère est une espace insécable sans chasse : il passe.
      'mot\uFEFFcomposé',
    ]) {
      expect(block.parse(value)).toBe(value);
    }
    for (const value of [
      '',
      '   ',
      '\n\t\r\n',
      'x'.repeat(41),
      'nul\u0000',
      'sonnerie\u0007',
      'saut de page\u000c',
      'tabulation verticale\u000b',
      'échappement\u001b[0m',
      'suppression\u007f',
      'contrôle C1\u0085',
      'demi-paire haute \ud83d isolée',
      'demi-paire basse \ude00 isolée',
      // Marque d'ordre des octets laissée en tête par un éditeur : elle fausserait l'empreinte.
      '\uFEFF# Conditions',
      7,
      null,
    ]) {
      expect(block.safeParse(value).success).toBe(false);
    }
  });

  it('fuseau horaire : un identifiant IANA connu', () => {
    for (const value of ['Africa/Kinshasa', 'Africa/Lubumbashi', 'Europe/Paris', 'UTC']) {
      expect(isTimeZone(value)).toBe(true);
      expect(timeZoneSchema.parse(value)).toBe(value);
    }
    for (const value of ['Mars/Olympus_Mons', 'Kinshasa', '', 'x'.repeat(65), '+01:00:00:00', 1]) {
      expect(timeZoneSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('vérification d’identité', () => {
  it('numéro de pièce : normalisé en majuscules, sans séparateurs', () => {
    expect(identityDocumentNumberSchema.parse(' op-123 456.7/a ')).toBe('OP1234567A');
    expect(identityDocumentNumberSchema.parse('OP1234567A')).toBe('OP1234567A');
    expect(normalizeIdentityDocumentNumber('ab 12-34')).toBe('AB1234');
    expect(identityDocumentNumberSchema.parse('OP\u00A0123\u00A04567')).toBe('OP1234567');
    // Deux écritures du même numéro donnent la même valeur.
    expect(identityDocumentNumberSchema.parse('0012-3456')).toBe(
      identityDocumentNumberSchema.parse('0012 3456'),
    );
  });

  it('numéro de pièce : 4 à 32 lettres et chiffres, rien d’autre', () => {
    for (const valid of ['A123', 'a'.repeat(32), '12345678901']) {
      expect(identityDocumentNumberSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      '',
      'A12',
      'a'.repeat(33),
      'AB_1234',
      'ÉB1234',
      'AB1234;DROP',
      'AB12\n34X',
      'AB12\t34X',
      '- - -',
      'x'.repeat(65),
      1234567,
      null,
    ]) {
      expect(identityDocumentNumberSchema.safeParse(invalid).success).toBe(false);
    }
    expect(IDENTITY_DOCUMENT_NUMBER_PATTERN.test('op1234')).toBe(false);
  });
});
