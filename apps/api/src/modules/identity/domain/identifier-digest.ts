import { createHash } from 'node:crypto';

/**
 * Empreinte courte d'un identifiant saisi (adresse e-mail, numéro de téléphone) : elle permet
 * de rapprocher des entrées du journal d'audit sans y recopier une donnée personnelle — qui
 * peut être celle d'un tiers étranger à la plateforme.
 */
export function identifierDigest(identifier: string): string {
  return createHash('sha256').update(identifier, 'utf8').digest('hex').slice(0, 16);
}
