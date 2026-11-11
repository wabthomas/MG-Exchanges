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
