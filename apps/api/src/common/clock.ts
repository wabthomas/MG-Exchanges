/**
 * Horloge de l'application.
 *
 * Elle n'est injectée que là où un test doit maîtriser le temps sans attendre — les codes du
 * second facteur changent toutes les trente secondes et ne servent qu'une fois. Partout
 * ailleurs, le code lit l'heure directement.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
