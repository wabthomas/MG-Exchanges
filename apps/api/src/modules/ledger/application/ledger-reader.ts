import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import { WALLET_ACCOUNT_TYPE } from '../domain/ledger-account.js';
import { type AssetRecord, LedgerRepository } from './ledger.repository.js';
import { WalletFreezeRepository } from './wallet-freeze.repository.js';

/**
 * Ce que les opérations lisent du grand livre avant d'y passer une écriture : les actifs tenus,
 * les fonds dont dispose un titulaire, et si son portefeuille est gelé. Lecture seule — une
 * écriture passe par `LedgerService`, et par lui seul.
 */
@Injectable()
export class LedgerReader {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly freezes: WalletFreezeRepository,
  ) {}

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

  /**
   * Vrai si le portefeuille d'un titulaire dans un actif est gelé.
   *
   * Lu sans verrou : un gel peut être posé aussitôt. C'est à l'écriture elle-même — passée sous
   * les verrous que le gel prend aussi — de le refuser ; cette lecture sert à répondre plus tôt,
   * et clairement. Elle est exacte pour qui tient déjà le verrou du titulaire, que le gel
   * attend : un transfert sur son émetteur.
   */
  async isWalletFrozen(db: DbClient, userId: string, assetCode: string): Promise<boolean> {
    const frozen = await this.freezes.frozenAmong(db, [{ userId, assetCode }]);
    return frozen.length > 0;
  }
}
