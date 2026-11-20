import { randomUUID } from 'node:crypto';

import type pg from 'pg';

export type SqlSide = 'DEBIT' | 'CREDIT';

/** Ligne d'une écriture passée directement en SQL. */
export interface SqlPosting {
  /** Identifiant du compte. */
  readonly account: string;
  readonly side: SqlSide;
  /** Unités minimales de l'actif. */
  readonly amount: bigint | number;
  /** Actif de la ligne ; par défaut, USD. */
  readonly asset?: string;
  /** Numéro de la ligne ; par défaut, son rang dans la liste. */
  readonly line?: number;
}

/** Ligne telle que la base l'a conservée. */
export interface WrittenPosting {
  readonly line: number;
  readonly sequence: string;
  readonly balanceAfter: string;
}

/**
 * Enregistre un actif avec le rôle **propriétaire**, sans auteur — comme le ferait un outil
 * d'exploitation. `overrides` remplace n'importe quelle colonne.
 */
export async function registerAssetInSql(
  owner: pg.Client,
  code: string,
  scale: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row: Record<string, unknown> = {
    code,
    name: `Asset ${code}`,
    kind: 'FIAT',
    scale,
    ...overrides,
  };
  const columns = Object.keys(row);
  await owner.query(
    `INSERT INTO assets (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    Object.values(row),
  );
}

/** Ouvre un compte du grand livre — ou retrouve celui qui existe déjà — et rend son identifiant. */
export async function openLedgerAccount(
  db: pg.Client,
  type: string,
  assetCode: string,
  userId: string | null = null,
): Promise<string> {
  await db.query(
    `INSERT INTO ledger_accounts (type_key, asset_code, user_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [type, assetCode, userId],
  );
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ledger_accounts
     WHERE type_key = $1 AND asset_code = $2 AND user_id IS NOT DISTINCT FROM $3`,
    [type, assetCode, userId],
  );
  return rows[0]!.id;
}

/** Écrit l'en-tête d'une écriture ; `overrides` remplace n'importe quelle colonne. */
export async function insertEntryHeader(
  db: pg.Client,
  postingCount: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    idempotency_key: `test:${randomUUID()}`,
    kind: 'test.entry',
    posting_count: postingCount,
    actor_type: 'SYSTEM',
    ...overrides,
  };
  const columns = Object.keys(row);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger_entries (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0]!.id;
}

/**
 * Passe des lignes en **une seule instruction**, dans l'ordre donné. Le rang et le solde
 * fournis (`given`) sont ceux que la base doit ignorer.
 */
export async function insertPostings(
  db: pg.Client,
  entryId: string,
  postings: readonly SqlPosting[],
  given: { readonly sequence: number; readonly balanceAfter: number } = {
    sequence: 0,
    balanceAfter: 0,
  },
): Promise<WrittenPosting[]> {
  const values: unknown[] = [];
  const tuples = postings.map((posting, index) => {
    values.push(
      entryId,
      posting.line ?? index + 1,
      posting.account,
      posting.asset ?? 'USD',
      posting.side,
      posting.amount.toString(),
      given.sequence,
      given.balanceAfter,
    );
    const at = index * 8;
    return (
      `($${String(at + 1)}, $${String(at + 2)}, $${String(at + 3)}, $${String(at + 4)}, ` +
      `$${String(at + 5)}, $${String(at + 6)}::numeric, $${String(at + 7)}, $${String(at + 8)})`
    );
  });
  const { rows } = await db.query<{
    line_number: number;
    account_sequence: string;
    balance_after: string;
  }>(
    `INSERT INTO ledger_postings
       (entry_id, line_number, account_id, asset_code, side, amount, account_sequence,
        balance_after)
     VALUES ${tuples.join(', ')}
     RETURNING line_number, account_sequence::text, balance_after::text`,
    values,
  );
  return rows.map((row) => ({
    line: row.line_number,
    sequence: row.account_sequence,
    balanceAfter: row.balance_after,
  }));
}

/**
 * Passe une écriture entière dans sa propre transaction — en-tête, puis lignes — et rend son
 * identifiant. À l'usage des tests qui ont besoin de fonds sur un compte sans passer par
 * l'application.
 */
export async function postEntryInSql(
  db: pg.Client,
  postings: readonly SqlPosting[],
  overrides: Record<string, unknown> = {},
): Promise<string> {
  await db.query('BEGIN');
  try {
    const entryId = await insertEntryHeader(db, postings.length, overrides);
    await insertPostings(db, entryId, postings);
    await db.query('COMMIT');
    return entryId;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/** Solde et nombre de lignes d'un compte, en texte. */
export async function accountState(
  db: pg.Client,
  accountId: string,
): Promise<{ balance: string; postings: string }> {
  const { rows } = await db.query<{ balance: string; postings: string }>(
    `SELECT balance::text AS balance, posting_count::text AS postings
     FROM ledger_accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0]!;
}

/** Nombre d'écritures et de lignes du grand livre. */
export async function ledgerSize(db: pg.Client): Promise<{ entries: number; postings: number }> {
  const { rows } = await db.query<{ entries: number; postings: number }>(
    `SELECT (SELECT count(*)::int FROM ledger_entries) AS entries,
            (SELECT count(*)::int FROM ledger_postings) AS postings`,
  );
  return rows[0]!;
}

/**
 * Altère le grand livre comme seul le propriétaire du schéma peut le faire : les règles sont
 * neutralisées le temps de `work`, puis rétablies. À l'usage des tests de la vérification.
 */
export async function tamperWithLedger(
  owner: pg.Client,
  work: (owner: pg.Client) => Promise<void>,
): Promise<void> {
  const tables = ['ledger_accounts', 'ledger_entries', 'ledger_postings'];
  await owner.query('BEGIN');
  try {
    for (const table of tables) {
      await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }
    await work(owner);
    for (const table of tables) {
      await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}
