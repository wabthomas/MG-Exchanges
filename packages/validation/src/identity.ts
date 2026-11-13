import { z } from 'zod';

/** Longueur maximale d'une adresse e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Adresse e-mail. Elle est **normalisée** par le schéma : espaces retirés, minuscules.
 * C'est sous cette forme qu'elle sert d'identifiant de connexion.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email({ error: 'Must be a valid email address.' })
      .max(EMAIL_MAX_LENGTH, { error: `Must be at most ${EMAIL_MAX_LENGTH} characters.` }),
  );

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Mot de passe choisi par l'utilisateur : la longueur est la seule règle de forme (aucune
 * règle de composition). Le serveur refuse en outre les mots de passe trop courants ou
 * dérivés de l'identifiant.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `Must be at least ${PASSWORD_MIN_LENGTH} characters.` })
  .max(PASSWORD_MAX_LENGTH, { error: `Must be at most ${PASSWORD_MAX_LENGTH} characters.` });

/**
 * Mot de passe présenté pour s'authentifier : seule sa taille est bornée. Les règles de
 * choix peuvent évoluer ; un mot de passe existant doit toujours pouvoir être présenté.
 */
export const presentedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** Numéro de téléphone au format international E.164 : `+243812345678`. */
export const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
export const phoneNumberSchema = z.string().regex(E164_PHONE_PATTERN, {
  error: 'Must be a phone number in international format, e.g. "+243812345678".',
});

/** Code pays ISO 3166-1 alpha-2, en majuscules : `CD`, `FR`… */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
export const countryCodeSchema = z.string().regex(COUNTRY_CODE_PATTERN, {
  error: 'Must be a two-letter ISO 3166-1 country code, e.g. "CD".',
});

/** Langues dans lesquelles la plateforme s'adresse à ses utilisateurs. */
export const SUPPORTED_LOCALES = ['fr', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const localeSchema = z.enum(SUPPORTED_LOCALES);

/** Nombre de chiffres des codes à usage unique envoyés par e-mail ou par SMS. */
export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
export const verificationCodeSchema = z.string().regex(VERIFICATION_CODE_PATTERN, {
  error: `Must be a ${VERIFICATION_CODE_LENGTH}-digit code.`,
});

/** Identifiant de ressource (UUID). */
export const uuidSchema = z.uuid({ error: 'Must be a UUID.' });

// --- Second facteur ---------------------------------------------------------------------------

/** Code à six chiffres affiché par une application d'authentification (TOTP, RFC 6238). */
export const TOTP_CODE_PATTERN = /^\d{6}$/;
export const totpCodeSchema = z.string().regex(TOTP_CODE_PATTERN, {
  error: 'Must be the 6-digit code shown by your authenticator app.',
});

/**
 * Codes de secours : dix caractères de l'alphabet base32 de Crockford (ni I, ni L, ni O, ni U,
 * trop faciles à confondre), présentés par groupes de cinq : `ABCDE-12345`.
 */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * Forme canonique d'un code de secours saisi à la main : majuscules, sans espace ni tiret ;
 * les lettres absentes de l'alphabet sont ramenées au chiffre qu'elles évoquent (O → 0, I et L → 1).
 */
export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Code de secours tel que saisi ; il est **normalisé** par le schéma. */
export const recoveryCodeSchema = z
  .string()
  .max(32)
  .transform(normalizeRecoveryCode)
  .pipe(
    z.string().regex(RECOVERY_CODE_PATTERN, {
      error: 'Must be a recovery code such as "ABCDE-12345".',
    }),
  );

/**
 * Identifiant d'appareil : valeur aléatoire créée par l'application cliente à son installation
 * et conservée sur l'appareil. Il permet de reconnaître un appareil déjà utilisé.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const deviceIdSchema = z.string().regex(DEVICE_ID_PATTERN, {
  error: 'Must be 16 to 128 characters: letters, digits, "_" or "-".',
});

// --- Profil -----------------------------------------------------------------------------------

export const PERSON_NAME_MAX_LENGTH = 100;
/** Lettres de toute écriture, avec espaces, apostrophes, points et traits d'union. */
export const PERSON_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’ .-]*$/u;

/** Nom ou prénom d'une personne (espaces superflus retirés). */
export const personNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PERSON_NAME_MAX_LENGTH)
  .regex(PERSON_NAME_PATTERN, {
    error: 'Must contain only letters, spaces, apostrophes, dots and hyphens.',
  });

/** Date civile sans heure : `1990-05-17`. */
export const isoDateSchema = z.iso.date();

const NO_CONTROL_CHARACTER = /^\P{Cc}*$/u;

/** Ligne de texte libre (adresse…) : bornée, sans caractère de contrôle. */
export function textLineSchema(maxLength: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .regex(NO_CONTROL_CHARACTER, { error: 'Must not contain control characters.' });
}

/**
 * Tout caractère, sauf les caractères de contrôle autres que le saut de ligne et la tabulation,
 * et sauf une demi-paire de substitution isolée (texte mal formé, qui ne s'encode pas en UTF-8).
 */
const TEXT_BLOCK_CHARACTERS = /^(?:[\n\r\t]|[^\p{Cc}\p{Cs}])*$/u;
const HAS_VISIBLE_CHARACTER = /\S/u;
/** Marque d'ordre des octets : certains éditeurs en placent une, invisible, en tête de fichier. */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Texte libre de plusieurs lignes (texte contractuel…) : borné, non vide, sans caractère de
 * contrôle autre que le saut de ligne et la tabulation, et sans marque d'ordre des octets en
 * tête. Il n'est **pas** retouché : ce qui est validé est ce qui sera conservé, à l'octet près.
 */
export function textBlockSchema(maxLength: number): z.ZodString {
  return z
    .string()
    .max(maxLength)
    .regex(HAS_VISIBLE_CHARACTER, { error: 'Must not be blank.' })
    .regex(TEXT_BLOCK_CHARACTERS, {
      error: 'Must be plain text: no control characters other than line breaks and tabs.',
    })
    .refine((value) => !value.startsWith(BYTE_ORDER_MARK), {
      error: 'Must not start with a byte order mark.',
    });
}

/** Vrai si `value` est un fuseau horaire IANA connu de l'environnement (`Africa/Kinshasa`). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TIME_ZONE_MAX_LENGTH = 64;
/** Fuseau horaire IANA : `Africa/Kinshasa`, `Africa/Lubumbashi`, `UTC`… */
export const timeZoneSchema = z
  .string()
  .max(TIME_ZONE_MAX_LENGTH)
  .refine(isTimeZone, { error: 'Must be an IANA time zone such as "Africa/Kinshasa".' });

// --- Vérification d'identité ------------------------------------------------------------------

/** Numéro d'une pièce d'identité, sous sa forme normalisée : majuscules et chiffres. */
export const IDENTITY_DOCUMENT_NUMBER_PATTERN = /^[A-Z0-9]{4,32}$/;

/**
 * Forme sous laquelle un numéro de pièce est comparé et conservé : majuscules, sans les
 * espaces, points, barres ni traits d'union qu'on y lit souvent. Deux saisies du même numéro
 * donnent ainsi la même valeur. Rien d'autre n'est retiré : un saut de ligne ou une tabulation
 * font refuser la saisie.
 */
export function normalizeIdentityDocumentNumber(value: string): string {
  return value.replace(/[ \u00A0./-]/g, '').toUpperCase();
}

export const identityDocumentNumberSchema = z
  .string()
  .max(64)
  .transform(normalizeIdentityDocumentNumber)
  .pipe(
    z.string().regex(IDENTITY_DOCUMENT_NUMBER_PATTERN, {
      error: 'Must be 4 to 32 letters and digits.',
    }),
  );
