/** Connexion dont le mot de passe a été vérifié et qui attend le second facteur. */
export interface PendingLogin {
  readonly userId: string;
  readonly deviceName: string | null;
  /** Empreinte de l'appareil (hexadécimal), ou `null` s'il n'est pas identifiable. */
  readonly deviceFingerprint: string | null;
}

export interface IssuedPendingLogin {
  /** Jeton remis au client ; seule son empreinte est conservée. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Port de stockage des connexions en attente du second facteur — données éphémères
 * (quelques minutes), qui s'effacent d'elles-mêmes.
 */
export abstract class PendingLoginStore {
  abstract create(login: PendingLogin, ttlSeconds: number): Promise<IssuedPendingLogin>;

  /**
   * Compte un essai pour cette connexion, de façon atomique, puis la retourne.
   * @returns `null` si le jeton est inconnu ou expiré, ou si le nombre d'essais est dépassé
   *   (la connexion en attente est alors supprimée).
   */
  abstract registerAttempt(token: string, maxAttempts: number): Promise<PendingLogin | null>;

  /**
   * Supprime la connexion en attente.
   * @returns faux si elle n'existait plus : de deux requêtes simultanées, une seule obtient vrai.
   */
  abstract consume(token: string): Promise<boolean>;

  /**
   * Annule toutes les connexions en attente d'un compte : son mot de passe vient de changer,
   * ou ses sessions viennent d'être fermées d'autorité. Un mot de passe vérifié **avant** ne
   * doit plus permettre d'ouvrir une session **après**.
   */
  abstract invalidateAllForUser(userId: string): Promise<void>;
}
