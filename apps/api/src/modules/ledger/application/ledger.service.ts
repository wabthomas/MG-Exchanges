import { Money } from '@mgx/shared';
import { Injectable } from '@nestjs/common';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  DEFAULT_CONFLICT_RETRY,
  UnitOfWork,
} from '../../../infrastructure/database/unit-of-work.js';
import { UserRepository } from '../../identity/application/user.repository.js';
import {
  assertValidJournalEntry,
  type JournalEntryDraft,
  LEDGER_AMOUNT_MAX_UNITS,
  type PostedEntry,
  type PostingDraft,
} from '../domain/journal-entry.js';
import {
  type AccountKey,
  accountKeyOf,
  accountKeyText,
  balanceAfterPosting,
  compareAccountKeys,
} from '../domain/ledger-account.js';
import {
  AssetDefinitionMismatchError,
  HolderClosedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerIntegrityError,
  LedgerRuleError,
  UnknownAssetError,
} from '../domain/ledger-errors.js';
import { type AccountRecord, type EntryRecord, LedgerRepository } from './ledger.repository.js';

/** Ligne d'une écriture à passer, et le compte qu'elle désigne. */
interface DraftedLine {
  readonly lineNumber: number;
  readonly posting: PostingDraft;
  readonly key: AccountKey;
  readonly keyText: string;
}

function draftedLines(draft: JournalEntryDraft): DraftedLine[] {
  return draft.postings.map((posting, index) => {
    const key = accountKeyOf(posting.account, posting.amount.asset.code);
    return { lineNumber: index + 1, posting, key, keyText: accountKeyText(key) };
  });
}

/**
 * Vrai si l'écriture conservée est celle qu'on présente : même type, mêmes lignes — mêmes
 * comptes, mêmes sens, mêmes montants — dans le même ordre. Ni l'auteur, ni la requête, ni les
 * références n'entrent dans la comparaison : la même opération, représentée par un autre
 * chemin, reste la même écriture.
 */
function isSameEntry(lines: readonly DraftedLine[], kind: string, recorded: EntryRecord): boolean {
  return (
    recorded.kind === kind &&
    recorded.postings.length === lines.length &&
    lines.every(({ key, posting }, index) => {
      const written = recorded.postings[index];
      return (
        written?.accountType === key.type &&
        written.accountUserId === key.userId &&
        written.assetCode === key.assetCode &&
        written.side === posting.side &&
        written.units === posting.amount.units
      );
    })
  );
}

/**
 * Passe les écritures au grand livre. C'est **le seul chemin** par lequel le code de
 * l'application modifie un solde.
 *
 * Une écriture est entière, équilibrée et définitive : elle ne se modifie ni ne s'efface, une
 * erreur se corrige par une écriture inverse. La base de données impose ces règles elle-même
 * (voir la migration `ledger`) ; ce service fait les mêmes contrôles en amont, pour répondre
 * clairement et sans rien écrire.
 *
 * **Idempotence.** Chaque écriture porte une clé. La représenter sous la même clé ne l'écrit
 * pas une seconde fois : le résultat d'origine est rendu, marqué `replayed`. Présenter une
 * écriture *différente* sous une clé déjà utilisée lève `IdempotencyConflictError`.
 *
 * **Concurrence.** Les comptes de l'écriture sont verrouillés, toujours dans le même ordre,
 * avant que les soldes ne soient lus : deux écritures qui touchent un même compte passent l'une
 * après l'autre, sans jamais s'interbloquer, et la seconde voit le solde laissé par la
 * première. Aucun solde ne devient négatif.
 *
 * **Ordre des verrous : les titulaires, puis les comptes.** Avant ses comptes, l'écriture
 * retient leurs titulaires (`UserRepository.holdOpen`) : aucun ne peut être clôturé tant qu'elle
 * n'est pas validée. Une opération peut donc verrouiller un titulaire — même en exclusivité,
 * pour vérifier un plafond — *avant* de passer une écriture, jamais après : elle prendrait les
 * verrous dans l'ordre inverse d'une écriture qui la croise.
 *
 * Erreurs **attendues**, que l'opération appelante traduit pour son utilisateur :
 * `InsufficientFundsError`, `HolderClosedError`. Les autres signalent un défaut de l'appelant
 * (`LedgerRuleError`, `UnknownAssetError`, `AssetDefinitionMismatchError`,
 * `IdempotencyConflictError`) ou du grand livre lui-même (`LedgerIntegrityError`).
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly users: UserRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /**
   * Passe une écriture dans sa propre transaction. Si PostgreSQL annule celle-ci parce qu'elle
   * en croisait une autre, elle est relancée entière.
   */
  post(draft: JournalEntryDraft): Promise<PostedEntry> {
    // Une écriture mal formée n'ouvre pas de transaction.
    assertValidJournalEntry(draft);
    return this.unitOfWork.run((tx) => this.postWithin(tx, draft), {
      retry: DEFAULT_CONFLICT_RETRY,
    });
  }

  /**
   * Passe une écriture dans la transaction de l'appelant : elle est validée ou annulée avec ce
   * que l'opération écrit par ailleurs.
   *
   * La transaction doit être au niveau d'isolation par défaut (`READ COMMITTED`). Un refus
   * décidé ici — fonds insuffisants, titulaire clôturé, clé déjà utilisée — survient avant
   * toute écriture d'une ligne : la transaction reste utilisable. Un refus de la base, lui, la
   * rend inutilisable.
   *
   * Une transaction qui passe **plusieurs** écritures tient les verrous de la première pendant
   * qu'elle demande ceux de la suivante : elle peut s'interbloquer avec une autre. PostgreSQL
   * annule alors l'une des deux — ouvrir la transaction avec `retry` (voir `UnitOfWork`).
   */
  async postWithin(tx: DbClient, draft: JournalEntryDraft): Promise<PostedEntry> {
    assertValidJournalEntry(draft);
    const lines = draftedLines(draft);
    await this.assertRegisteredAssets(tx, draft);

    // Déjà passée ? Rien n'est alors verrouillé ni écrit : une requête renvoyée n'attend pas
    // derrière les autres écritures des mêmes comptes.
    const known = await this.ledger.findEntryByKey(tx, draft.idempotencyKey);
    if (known !== null) {
      return this.replay(draft, lines, known);
    }

    await this.holdHolders(tx, lines);
    const accounts = await this.lockAccounts(tx, lines);

    // Relue sous les verrous : la même écriture a pu passer pendant qu'on les attendait — et le
    // solde qu'elle a laissé ne doit pas faire refuser celle-ci.
    const passed = await this.ledger.findEntryByKey(tx, draft.idempotencyKey);
    if (passed !== null) {
      return this.replay(draft, lines, passed);
    }

    // Chaque solde est vérifié ligne après ligne, dans l'ordre où la base le fera.
    const balances = new Map<string, bigint>();
    for (const { key, keyText, posting } of lines) {
      const account = accounts.get(keyText);
      if (account === undefined) {
        throw new LedgerIntegrityError();
      }
      const balance = balanceAfterPosting(
        balances.get(keyText) ?? account.balance,
        account.normalSide,
        posting.side,
        posting.amount.units,
      );
      if (balance < 0n) {
        throw new InsufficientFundsError(key);
      }
      if (balance > LEDGER_AMOUNT_MAX_UNITS) {
        throw new LedgerRuleError(
          'AMOUNT_TOO_LARGE',
          'The balance of an account would exceed what the ledger can hold.',
        );
      }
      balances.set(keyText, balance);
    }

    const header = await this.ledger.insertEntry(tx, {
      idempotencyKey: draft.idempotencyKey,
      kind: draft.kind,
      postingCount: lines.length,
      actor: draft.actor,
      requestId: draft.requestId ?? null,
      metadata: draft.metadata ?? {},
    });
    if (header === null) {
      // Une écriture portant la même clé — sur d'autres comptes, sinon les verrous l'auraient
      // fait voir plus haut — vient d'être validée.
      const concurrent = await this.ledger.findEntryByKey(tx, draft.idempotencyKey);
      if (concurrent === null) {
        throw new LedgerIntegrityError();
      }
      return this.replay(draft, lines, concurrent);
    }

    const written = await this.ledger.insertPostings(
      tx,
      header.id,
      lines.map(({ key, keyText, lineNumber, posting }) => {
        const account = accounts.get(keyText);
        if (account === undefined) {
          throw new LedgerIntegrityError();
        }
        return {
          lineNumber,
          accountId: account.id,
          assetCode: key.assetCode,
          side: posting.side,
          units: posting.amount.units,
        };
      }),
    );
    if (written.length !== lines.length) {
      throw new LedgerIntegrityError();
    }

    return {
      id: header.id,
      kind: draft.kind,
      postedAt: header.postedAt,
      replayed: false,
      // Les soldes rendus sont ceux que la base a calculés et conservés.
      postings: lines.map(({ lineNumber, posting }, index) => {
        const line = written[index];
        if (line?.lineNumber !== lineNumber) {
          throw new LedgerIntegrityError();
        }
        return {
          id: line.id,
          lineNumber,
          accountId: line.accountId,
          account: posting.account,
          side: posting.side,
          amount: posting.amount,
          balanceAfter: Money.ofUnits(line.balanceAfter, posting.amount.asset),
        };
      }),
    };
  }

  /** Chaque montant est exprimé dans un actif enregistré, avec son nombre de décimales. */
  private async assertRegisteredAssets(tx: DbClient, draft: JournalEntryDraft): Promise<void> {
    const scales = new Map(
      draft.postings.map(({ amount }) => [amount.asset.code, amount.asset.scale]),
    );
    const registered = await this.ledger.findAssets(tx, [...scales.keys()]);
    for (const [code, scale] of scales) {
      const asset = registered.find((candidate) => candidate.code === code);
      if (asset === undefined) {
        throw new UnknownAssetError(code);
      }
      if (asset.scale !== scale) {
        throw new AssetDefinitionMismatchError(code);
      }
    }
  }

  /**
   * Retient les titulaires de l'écriture jusqu'à la fin de la transaction, dans l'ordre de leurs
   * identifiants, et vérifie que chacun peut détenir des fonds. La base de données fait de même
   * à chaque ligne ; le faire ici, d'abord, fixe l'ordre des verrous et refuse sans rien écrire.
   *
   * Un compte suspendu garde ses comptes et ses fonds : l'opération décide de ce qu'il peut en
   * faire, pas le grand livre.
   *
   * @throws HolderClosedError si l'un d'eux est clôturé.
   * @throws LedgerRuleError si l'un d'eux n'existe pas, ou n'a jamais achevé son inscription.
   */
  private async holdHolders(tx: DbClient, lines: readonly DraftedLine[]): Promise<void> {
    const holderIds = [
      ...new Set(lines.flatMap(({ key }) => (key.userId === null ? [] : [key.userId]))),
    ];
    const statuses = new Map(
      (await this.users.holdOpen(tx, holderIds)).map(({ id, status }) => [id, status]),
    );
    for (const holderId of holderIds) {
      const status = statuses.get(holderId);
      if (status === undefined) {
        throw new LedgerRuleError(
          'UNKNOWN_HOLDER',
          'The holder of one of the accounts does not exist.',
        );
      }
      if (status === 'CLOSED') {
        throw new HolderClosedError();
      }
      if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
        throw new LedgerRuleError(
          'HOLDER_NOT_ELIGIBLE',
          'The holder of one of the accounts never completed its registration: it cannot hold funds.',
        );
      }
    }
  }

  /**
   * Trouve les comptes de l'écriture, ouvre ceux qui n'existent pas encore, puis les verrouille
   * tous jusqu'à la fin de la transaction.
   *
   * L'ordre est toujours le même — ouverture dans l'ordre des clés, verrouillage dans l'ordre
   * des identifiants : deux écritures qui se croisent s'attendent, sans s'interbloquer.
   *
   * @returns les comptes, par clé, dans l'état que la première ligne trouvera.
   */
  private async lockAccounts(
    tx: DbClient,
    lines: readonly DraftedLine[],
  ): Promise<Map<string, AccountRecord>> {
    const keys = [...new Map(lines.map(({ key, keyText }) => [keyText, key])).values()].sort(
      compareAccountKeys,
    );
    const textOf = (account: AccountRecord): string =>
      accountKeyText({ type: account.type, assetCode: account.assetCode, userId: account.userId });

    let found = await this.ledger.findAccounts(tx, keys);
    if (found.length < keys.length) {
      const existing = new Set(found.map(textOf));
      await this.ledger.openAccounts(
        tx,
        keys.filter((key) => !existing.has(accountKeyText(key))),
      );
      found = await this.ledger.findAccounts(tx, keys);
    }

    const locked = await this.ledger.lockAccounts(
      tx,
      found.map(({ id }) => id),
    );
    const accounts = new Map(locked.map((account) => [textOf(account), account]));
    if (keys.some((key) => !accounts.has(accountKeyText(key)))) {
      throw new LedgerIntegrityError();
    }
    return accounts;
  }

  /**
   * L'écriture existe déjà sous cette clé : rend celle d'origine, sans rien écrire.
   *
   * @throws IdempotencyConflictError si l'écriture conservée n'est pas celle qu'on présente.
   */
  private replay(
    draft: JournalEntryDraft,
    lines: readonly DraftedLine[],
    recorded: EntryRecord,
  ): PostedEntry {
    if (!isSameEntry(lines, draft.kind, recorded)) {
      throw new IdempotencyConflictError(draft.idempotencyKey);
    }
    return {
      id: recorded.id,
      kind: recorded.kind,
      postedAt: recorded.postedAt,
      replayed: true,
      postings: lines.map(({ posting }, index) => {
        const written = recorded.postings[index];
        if (written === undefined) {
          throw new LedgerIntegrityError();
        }
        return {
          id: written.id,
          lineNumber: written.lineNumber,
          accountId: written.accountId,
          account: posting.account,
          side: posting.side,
          amount: posting.amount,
          balanceAfter: Money.ofUnits(written.balanceAfter, posting.amount.asset),
        };
      }),
    };
  }
}
