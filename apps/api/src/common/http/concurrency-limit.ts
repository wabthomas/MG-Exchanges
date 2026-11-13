/**
 * Borne le nombre de traitements simultanés d'une opération coûteuse **dans ce processus** —
 * typiquement, une opération qui garde en mémoire un corps de requête volumineux.
 *
 * Ce n'est pas une file d'attente : quand toutes les places sont prises, l'appelant est
 * informé aussitôt et répond « réessayez », plutôt que de laisser des requêtes s'accumuler.
 */
export class ConcurrencyLimit {
  private taken = 0;

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('A concurrency limit must be a positive integer.');
    }
  }

  /** Nombre de places actuellement prises. */
  get inFlight(): number {
    return this.taken;
  }

  /**
   * Prend une place et retourne la fonction qui la rend, ou `null` si toutes sont prises.
   * Rendre une place deux fois est sans effet.
   */
  tryAcquire(): (() => void) | null {
    if (this.taken >= this.max) {
      return null;
    }
    this.taken += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.taken -= 1;
      }
    };
  }
}
