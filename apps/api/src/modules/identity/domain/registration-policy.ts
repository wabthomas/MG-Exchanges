/**
 * Pays de résidence depuis lesquels l'inscription est possible.
 *
 * Ouvrir un pays suppose d'y disposer des autorisations requises : la liste ne change que par
 * une modification du code, relue et tracée. Marché de lancement : la République démocratique
 * du Congo. Les règles par pays (plafonds, pièces exigées…) viendront avec la conformité.
 */
export const REGISTRATION_COUNTRIES: readonly string[] = ['CD'];

export function isRegistrationCountry(countryCode: string): boolean {
  return REGISTRATION_COUNTRIES.includes(countryCode);
}
