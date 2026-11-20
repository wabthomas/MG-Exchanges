import type { SupportedLocale } from '@mgx/validation';

/** Texte d'une version dans une langue. */
export interface TermsText {
  readonly summary: string;
  readonly body: string;
  /** Empreinte SHA-256 (hexadécimal) de `body` encodé en UTF-8. */
  readonly sha256: string;
}

/** Nombre maximal de versions rendues par une liste : les plus récentes. */
export const TERMS_VERSION_LIST_MAX = 100;

/**
 * Vrai si un compte doit accepter la version en vigueur avant de continuer.
 *
 * @param latestRequired numéro de la dernière version publiée qui exige d'être acceptée ;
 *   `null` s'il n'y en a aucune.
 * @param lastAccepted numéro de la dernière version que le compte a acceptée ; `null` s'il
 *   n'en a accepté aucune.
 *
 * Accepter une version, c'est accepter le texte en vigueur ce jour-là : il tient lieu des
 * versions qui l'ont précédé. Une version publiée ensuite ne rouvre l'obligation que si elle
 * l'exige elle-même.
 */
export function isAcceptanceRequired(
  latestRequired: number | null,
  lastAccepted: number | null,
): boolean {
  return latestRequired !== null && (lastAccepted === null || lastAccepted < latestRequired);
}

/**
 * Le texte d'une version dans la langue demandée, s'il a été publié dans cette langue ; le
 * texte français sinon — c'est lui qui fait foi.
 */
export function textIn<Text>(
  version: { readonly fr: Text; readonly en: Text | null },
  locale: SupportedLocale,
): { readonly locale: SupportedLocale; readonly text: Text } {
  if (locale === 'en' && version.en !== null) {
    return { locale: 'en', text: version.en };
  }
  return { locale: 'fr', text: version.fr };
}

/** Langues dans lesquelles une version a été publiée. */
export function localesOf(version: { readonly en: unknown }): SupportedLocale[] {
  return version.en === null ? ['fr'] : ['fr', 'en'];
}
