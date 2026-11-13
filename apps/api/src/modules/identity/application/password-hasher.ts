/**
 * Port de hachage des mots de passe. Un mot de passe n'est jamais stocké ni comparé en
 * clair : seule son empreinte, non réversible et salée, est conservée.
 */
export abstract class PasswordHasher {
  /** Empreinte autoportante (algorithme, paramètres, sel) du mot de passe. */
  abstract hash(password: string): Promise<string>;

  /** Vrai si le mot de passe correspond à l'empreinte. Ne lève jamais sur une empreinte invalide. */
  abstract verify(hash: string, password: string): Promise<boolean>;

  /** Vrai si l'empreinte a été calculée avec des paramètres différents des paramètres actuels. */
  abstract needsRehash(hash: string): boolean;

  /**
   * Effectue une vérification factice, de même coût qu'une vraie. Utilisée lorsque le compte
   * n'existe pas, afin que le temps de réponse ne révèle pas son existence.
   */
  abstract verifyAgainstDummy(password: string): Promise<void>;
}
