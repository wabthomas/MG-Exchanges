import { Injectable } from '@nestjs/common';

/**
 * Étape de la purge périodique fournie par un autre module : elle efface ce que ce module n'a
 * plus de raison de conserver et retourne le nombre d'éléments traités.
 */
export interface MaintenanceStep {
  /** Nom de l'étape, tel qu'il apparaît dans le compte rendu et les journaux. */
  readonly name: string;
  run(now: Date): Promise<number>;
}

/**
 * Registre des étapes de purge des autres modules, alimenté au démarrage. La purge périodique
 * des données d'identité les exécute après les siennes, avec la même cadence et le même
 * traitement des échecs.
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
