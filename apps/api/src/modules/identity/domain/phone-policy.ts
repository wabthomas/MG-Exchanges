/**
 * Numéros de téléphone vérifiables par SMS : les numéros **mobiles** des pays desservis.
 *
 * La liste est fermée, comme celle des pays d'inscription. Elle protège aussi le budget
 * d'envoi : sans elle, n'importe quel compte pourrait faire expédier des SMS vers des numéros
 * surtaxés à l'étranger. RDC : indicatif +243, mobiles en 8x et 9x (neuf chiffres).
 */
const VERIFIABLE_MOBILE_NUMBERS: readonly RegExp[] = [/^\+243[89]\d{8}$/];

export function isVerifiablePhoneNumber(phone: string): boolean {
  return VERIFIABLE_MOBILE_NUMBERS.some((pattern) => pattern.test(phone));
}

/** Numéro masqué pour le journal d'audit : indicatif et quatre derniers chiffres. */
export function maskPhoneNumber(phone: string): string {
  return phone.length <= 8 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
