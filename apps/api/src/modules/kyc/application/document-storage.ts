/**
 * Port du stockage des pièces de vérification d'identité.
 *
 * Le stockage ne reçoit que des contenus **déjà chiffrés** : il n'a jamais accès à une pièce
 * en clair, ni aux clés. Les clés d'emplacement sont choisies par l'application (minuscules,
 * chiffres, `-` et `/`).
 */
export abstract class DocumentStorage {
  /**
   * Vérifie, au démarrage, que le stockage est utilisable — et le prépare si nécessaire.
   * Échoue si l'on ne peut pas y écrire : mieux vaut ne pas démarrer que refuser chaque envoi.
   */
  abstract prepare(): Promise<void>;

  /** Écrit le contenu à cet emplacement. Au retour, l'écriture est durable. */
  abstract put(key: string, content: Uint8Array): Promise<void>;

  /** Contenu de l'emplacement, ou `null` s'il n'existe pas. */
  abstract get(key: string): Promise<Buffer | null>;

  /** Efface l'emplacement ; sans effet s'il n'existe pas. */
  abstract delete(key: string): Promise<void>;
}
