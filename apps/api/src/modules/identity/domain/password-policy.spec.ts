import { describe, expect, it } from '@jest/globals';

import { checkPasswordPolicy, normalizePassword } from './password-policy.js';

const owner = { email: 'mukendi.jean@example.cd', phone: '+243812345678' };

describe('règles de choix d’un mot de passe', () => {
  it.each([
    'lumumba-boulevard-30',
    'correct horse battery staple',
    'Zx9!vQ2#mL7@',
    'ma phrase de passe préférée',
    '密码是一个很长的短语句子',
  ])('accepte %j — aucune règle de composition', (password) => {
    expect(checkPasswordPolicy(password, owner)).toBeNull();
  });

  it.each([
    'password123',
    'PASSWORD123',
    '1234567890',
    'azertyuiop',
    'MotDePasse123',
    'mgexchange123',
  ])('refuse %j : trop courant, quelle que soit la casse', (password) => {
    expect(checkPasswordPolicy(password, owner)).toBe('TOO_COMMON');
  });

  it.each(['aaaaaaaaaaaa', 'abababababab', '1212121212', 'aabbccddaabb'])(
    'refuse %j : trop peu de caractères différents',
    (password) => {
      expect(checkPasswordPolicy(password, owner)).toBe('TOO_REPETITIVE');
    },
  );

  it.each([
    'mukendi.jean@example.cd',
    'Mukendi.Jean-2026',
    'xx-mukendi.jean-xx',
    '+243812345678!',
    'tel-0812345678-ok',
    'call 812 345 678 now',
  ])('refuse %j : dérivé de l’adresse ou du numéro', (password) => {
    expect(checkPasswordPolicy(password, owner)).toBe('CONTAINS_IDENTIFIER');
  });

  it('un identifiant très court ne suffit pas à refuser un mot de passe', () => {
    expect(checkPasswordPolicy('abc-is-in-here-42', { email: 'abc@example.cd' })).toBeNull();
    expect(
      checkPasswordPolicy('lumumba-boulevard-30', { email: 'a@b.cd', phone: null }),
    ).toBeNull();
  });

  it('normalise en NFKC : deux saisies équivalentes donnent le même mot de passe', () => {
    const composed = 'caf\u00e9-noir-du-kivu';
    const decomposed = 'cafe\u0301-noir-du-kivu';
    expect(composed).not.toBe(decomposed);
    expect(normalizePassword(decomposed)).toBe(normalizePassword(composed));
    // Chiffres « pleine largeur » (clavier asiatique) : même mot de passe courant.
    expect(checkPasswordPolicy('１２３４５６７８９０', owner)).toBe('TOO_COMMON');
  });
});
