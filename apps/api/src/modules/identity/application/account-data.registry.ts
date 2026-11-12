import type { AccountClosureBlocker, AccountClosureOrigin, DataExport } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

/** Travail à faire une fois la clôture validée (effacer des fichiers, par exemple). */
export type AfterClosure = () => Promise<void>;

/** Parties d'une copie des données qu'un autre module que l'identité fournit. */
export type ExportedSections = Partial<Pick<DataExport, 'verification'>>;

/**
 * Module qui détient des données rattachées à un compte. Il prend part à sa clôture, à
 * l'effacement de ce qu'il a conservé et à la copie remise au titulaire — l'identité ne sait
 * rien de ce qu'il détient.
 *
 * Ordre des appels à la clôture, dans une seule transaction : `lockForClosure`, puis le compte
 * est verrouillé, puis `closureBlockers` et `legalRetentionUntil`, puis le compte est clôturé,
 * puis `closeAccount`.
 */
export interface AccountDataHolder {
  /** Nom du module, tel qu'il apparaît dans les journaux. */
  readonly name: string;

  /** Ce qui, dans ce module, s'oppose à la clôture du compte. */
  closureBlockers(
    db: DbClient,
    userId: string,
    origin: AccountClosureOrigin,
  ): Promise<readonly AccountClosureBlocker[]>;

  /**
   * Verrouille, jusqu'à la fin de la transaction, les lignes du module rattachées au compte.
   * Appelé **avant** que le compte ne soit verrouillé : c'est l'ordre dans lequel les écritures
   * du module prennent leurs verrous, et le respecter écarte tout interblocage.
   */
  lockForClosure(tx: DbClient, userId: string): Promise<void>;

  /**
   * Date jusqu'à laquelle la loi impose de conserver des données du compte détenues par ce
   * module ; `null` s'il n'en détient pas de telles.
   */
  legalRetentionUntil(tx: DbClient, userId: string, closedAt: Date): Promise<Date | null>;

  /**
   * Le compte vient d'être clôturé : met fin à ce qui était en cours et efface ce que la loi
   * n'impose pas de conserver.
   */
  closeAccount(tx: DbClient, userId: string, closedAt: Date): Promise<AfterClosure | null>;

  /**
   * L'échéance d'effacement est atteinte : efface tout ce qui restait du compte. Doit pouvoir
   * être appelé plusieurs fois.
   */
  eraseRetained(userId: string, now: Date): Promise<void>;

  /** Ce que le module détient sur le compte, pour la copie remise à son titulaire. */
  exportData(db: DbClient, userId: string): Promise<ExportedSections>;
}

/** Registre des modules qui détiennent des données rattachées aux comptes, alimenté au démarrage. */
@Injectable()
export class AccountDataRegistry {
  private readonly registered: AccountDataHolder[] = [];

  register(holder: AccountDataHolder): void {
    if (this.registered.some((existing) => existing.name === holder.name)) {
      throw new Error(`Account data holder "${holder.name}" is already registered.`);
    }
    this.registered.push(holder);
  }

  holders(): readonly AccountDataHolder[] {
    return this.registered;
  }
}
