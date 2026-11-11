/**
 * Règles de choix d'un mot de passe.
 *
 * Conformes aux recommandations actuelles (NIST SP 800-63B) : une longueur minimale, aucune
 * règle de composition, aucun renouvellement périodique ; en revanche les mots de passe
 * prévisibles sont refusés — trop courants, répétitifs, ou dérivés de l'identifiant.
 * La longueur (10 à 128 caractères) est vérifiée par le contrat de l'API.
 */

export type PasswordRejection = 'TOO_COMMON' | 'TOO_REPETITIVE' | 'CONTAINS_IDENTIFIER';

export const PASSWORD_REJECTION_MESSAGES: Readonly<Record<PasswordRejection, string>> = {
  TOO_COMMON: 'This password is too common. Choose a less predictable one.',
  TOO_REPETITIVE: 'This password is too repetitive. Choose a less predictable one.',
  CONTAINS_IDENTIFIER: 'The password must not contain your email address or phone number.',
};

export interface PasswordOwner {
  readonly email: string;
  readonly phone?: string | null | undefined;
}

/** Nombre minimal de caractères distincts. */
const MIN_DISTINCT_CHARACTERS = 5;
/** Longueur à partir de laquelle un fragment de l'identifiant est jugé significatif. */
const MIN_IDENTIFIER_FRAGMENT = 4;

/**
 * Mots de passe d'au moins dix caractères parmi les plus utilisés (fuites publiques) et
 * variantes évidentes autour du produit. La comparaison ignore la casse.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '1234567890',
  '0123456789',
  '12345678910',
  '123456789a',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'qwertyuiop',
  'azertyuiop',
  'qwerty12345',
  'qwerty123456',
  'azerty12345',
  'azerty123456',
  'password123',
  'password1234',
  'password12345',
  'passw0rd123',
  'motdepasse',
  'motdepasse1',
  'motdepasse123',
  'iloveyou123',
  'jetaime12345',
  'administrator',
  'welcome12345',
  'bienvenue123',
  'letmein12345',
  'changeme123',
  'abcdefghij',
  'abcdefghijk',
  'abcd123456',
  'abc1234567',
  'a123456789',
  'football123',
  'kinshasa123',
  'kinshasa2024',
  'kinshasa2025',
  'kinshasa2026',
  'congo12345',
  'mgexchange',
  'mgexchange1',
  'mgexchange123',
  'mg-exchange',
  'mg-exchange1',
  'mg-exchange123',
]);

/**
 * Forme canonique d'un mot de passe : normalisation Unicode NFKC, pour qu'un même mot de
 * passe saisi sur deux claviers ou deux systèmes produise la même empreinte.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** Raison du refus d'un mot de passe, ou `null` s'il est acceptable. */
export function checkPasswordPolicy(
  password: string,
  owner: PasswordOwner,
): PasswordRejection | null {
  const candidate = normalizePassword(password).toLowerCase();

  if (COMMON_PASSWORDS.has(candidate)) {
    return 'TOO_COMMON';
  }
  if (new Set(candidate).size < MIN_DISTINCT_CHARACTERS) {
    return 'TOO_REPETITIVE';
  }

  const email = owner.email.toLowerCase();
  const localPart = email.split('@')[0] ?? '';
  if (
    candidate.includes(email) ||
    (localPart.length >= MIN_IDENTIFIER_FRAGMENT && candidate.includes(localPart))
  ) {
    return 'CONTAINS_IDENTIFIER';
  }

  // Numéro de téléphone, avec ou sans indicatif : comparaison sur les chiffres.
  const phoneDigits = digitsOf(owner.phone ?? '');
  const nationalNumber = phoneDigits.slice(-9);
  if (nationalNumber.length >= 9 && digitsOf(candidate).includes(nationalNumber)) {
    return 'CONTAINS_IDENTIFIER';
  }

  return null;
}
