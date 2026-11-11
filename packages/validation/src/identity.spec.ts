import { describe, expect, it } from '@jest/globals';

import {
  countryCodeSchema,
  emailSchema,
  localeSchema,
  passwordSchema,
  phoneNumberSchema,
  presentedPasswordSchema,
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
