import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { WALLET_ACCOUNT_TYPE } from '../domain/ledger-account.js';
import { type AssetRecord, LedgerRepository } from './ledger.repository.js';

/**
 * Ce que les opérations lisent du grand livre avant d'y passer une écriture : les actifs tenus,
 * et les fonds dont dispose un titulaire. Lecture seule — une écriture passe par
 * `LedgerService`, et par lui seul.
 */
@Injectable()
export class LedgerReader {
  constructor(private readonly ledger: LedgerRepository) {}

  /** Tous les actifs tenus par la plateforme, dans l'ordre de leurs codes. */
  assets(db: DbClient): Promise<AssetRecord[]> {
    return this.ledger.listAssets(db);
  }

  /** L'actif de ce code, ou `null` si la plateforme ne le tient pas. */
  async asset(db: DbClient, code: string): Promise<AssetRecord | null> {
    const [asset] = await this.ledger.findAssets(db, [code]);
    return asset ?? null;
  }

  /**
   * Fonds dont dispose un titulaire dans un actif, en unités minimales : zéro tant qu'aucune
   * écriture n'a ouvert son compte.
   *
   * Lu sans verrou : une écriture peut le modifier aussitôt. C'est à l'écriture elle-même —
   * passée sous le verrou du compte — de refuser des fonds insuffisants ; cette lecture ne
   * sert qu'à répondre plus tôt.
   */
  async availableBalance(db: DbClient, userId: string, assetCode: string): Promise<bigint> {
    const [account] = await this.ledger.findAccounts(db, [
      { type: WALLET_ACCOUNT_TYPE, assetCode, userId },
    ]);
    return account?.balance ?? 0n;
  }
}
