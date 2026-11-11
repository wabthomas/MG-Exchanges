import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

export interface StoredSetting {
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

/** Port de persistance des paramètres système (implémenté par l'infrastructure). */
export abstract class SystemSettingsRepository {
  /** Tous les paramètres stockés. */
  abstract findAll(): Promise<StoredSetting[]>;

  /**
   * Verrouille le paramètre pour la durée de la transaction (les modifications
   * concurrentes d'une même clé sont sérialisées), puis retourne sa valeur actuelle.
   */
  abstract lockAndFind(tx: DbClient, key: string): Promise<StoredSetting | null>;

  /** Crée le paramètre (version 1) ou le met à jour en incrémentant sa version. */
  abstract save(tx: DbClient, key: string, value: unknown): Promise<StoredSetting>;
}
