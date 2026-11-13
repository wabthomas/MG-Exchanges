import { Injectable } from '@nestjs/common';

/**
 * Étape de la maintenance périodique fournie par un autre module : elle efface ce que ce module
 * n'a plus de raison de conserver, ou vérifie ce qu'il conserve, et retourne le nombre
 * d'éléments traités.
 */
export interface MaintenanceStep {
  /** Nom de l'étape, tel qu'il apparaît dans le compte rendu et les journaux. */
  readonly name: string;
  /**
   * @returns le nombre d'éléments traités.
   * @throws MaintenanceStepIncompleteError si certains éléments n'ont pas pu l'être.
   */
  run(now: Date): Promise<number>;
}

/**
 * Une étape a traité une partie de son travail, et échoué sur le reste. L'étape est comptée en
 * échec ; ce qu'elle a traité figure tout de même au compte rendu.
 */
export class MaintenanceStepIncompleteError extends Error {
  constructor(
    /** Éléments traités. */
    readonly done: number,
    /** Éléments qui n'ont pas pu l'être. */
    readonly failed: number,
    what: string,
  ) {
    super(`${String(failed)} ${what} could not be processed (${String(done)} processed).`);
    this.name = 'MaintenanceStepIncompleteError';
  }
}

/**
 * Registre des étapes de maintenance des autres modules, alimenté au démarrage. La purge
 * périodique des données d'identité les exécute après les siennes, avec la même cadence et le
 * même traitement des échecs.
 */
@Injectable()
export class MaintenanceStepRegistry {
  private readonly registered: MaintenanceStep[] = [];

  register(step: MaintenanceStep): void {
    if (this.registered.some((existing) => existing.name === step.name)) {
      throw new Error(`Maintenance step "${step.name}" is already registered.`);
    }
    this.registered.push(step);
  }

  steps(): readonly MaintenanceStep[] {
    return this.registered;
  }
}
