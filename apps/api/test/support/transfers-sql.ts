import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';

import { approve, type Level, submitted } from './kyc-sql.js';
import { insertEntryHeader, insertPostings } from './ledger-sql.js';

/**
 * Plafonds et transferts écrits directement en SQL, pour les tests qui éprouvent les règles
 * portées par la base de données (sans passer par l'application).
 */

/** Plafonds par transfert, sur 24 heures et sur 31 jours, en unités minimales. */
export type Ceilings = readonly [perTransfer: number, daily: number, monthly: number];

/**
 * Fixe — ou remplace — les plafonds d'un niveau dans un actif. Sans `set_by`, seul le rôle
 * propriétaire y est admis ; `overrides` remplace n'importe quelle colonne.
 */
export async function setLimitInSql(
  db: pg.Client,
  assetCode: string,
  level: number,
  [perTransfer, daily, monthly]: Ceilings,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row: Record<string, unknown> = {
    asset_code: assetCode,
    kyc_level: level,
    per_transfer_max: perTransfer,
    daily_max: daily,
    monthly_max: monthly,
    ...overrides,
  };
  const columns = Object.keys(row);
  const replaced = columns.filter((column) => column !== 'asset_code' && column !== 'kyc_level');
  // `set_by` est toujours réécrit : chaque modification nomme son auteur — ou n'en a pas.
  const assignments = [...new Set([...replaced, 'set_by'])].map(
    (column) => `${column} = EXCLUDED.${column}`,
  );
  await db.query(
    `INSERT INTO transfer_limits (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})
     ON CONFLICT (asset_code, kyc_level) DO UPDATE SET ${assignments.join(', ')}`,
    Object.values(row),
  );
}

/**
 * Porte un compte au niveau de vérification voulu : un dossier déposé puis accepté par
 * `reviewer` pour chaque niveau, de 1 à `level`.
 *
 * @returns les dossiers acceptés, par niveau.
 */
export async function verifyUpTo(
  db: pg.Client,
  user: string,
  level: 0 | Level,
  reviewer: string,
): Promise<Partial<Record<Level, string>>> {
  const cases: Partial<Record<Level, string>> = {};
  for (const step of [1, 2, 3] as const) {
    if (step > level) {
      break;
    }
    const id = await submitted(db, user, step);
    await approve(db, id, reviewer);
    cases[step] = id;
  }
  return cases;
}

/** Une clé d'idempotence valide, jamais employée. */
export const freshKey = (): string => `test-${randomUUID()}`;

/**
 * Écrit la seule ligne d'un transfert — sans son écriture, qui doit exister par ailleurs.
 * `columns` fournit ou remplace n'importe quelle colonne.
 */
export async function insertTransferRow(
  db: pg.Client,
  columns: Record<string, unknown>,
): Promise<string> {
  const row: Record<string, unknown> = {
    asset_code: 'USD',
    idempotency_key: freshKey(),
    request_digest: randomBytes(32),
    sender_level: 1,
    ...columns,
  };
  const names = Object.keys(row);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transfers (${names.join(', ')})
     VALUES (${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
     RETURNING id`,
    Object.values(row),
  );
  return rows[0]!.id;
}

export interface SqlTransfer {
  readonly sender: string;
  /** Compte « fonds disponibles » de l'émetteur dans l'actif. */
  readonly senderAccount: string;
  readonly recipient: string;
  readonly recipientAccount: string;
  readonly amount: number | bigint;
  readonly asset?: string;
  /** Niveau de vérification de l'émetteur (défaut : 1). */
  readonly level?: number;
  /** Colonnes de la ligne de transfert à fournir ou à remplacer. */
  readonly columns?: Record<string, unknown>;
}

/**
 * Écrit un transfert entier comme le fait l'application — l'en-tête de son écriture, ses deux
 * lignes, puis la ligne du transfert — **sans** ouvrir ni valider de transaction : à l'appelant
 * de le faire.
 */
export async function writeTransfer(
  db: pg.Client,
  transfer: SqlTransfer,
): Promise<{ transferId: string; entryId: string }> {
  const asset = transfer.asset ?? 'USD';
  const entryId = await insertEntryHeader(db, 2, { kind: 'transfer.internal' });
  await insertPostings(db, entryId, [
    { account: transfer.senderAccount, side: 'DEBIT', amount: transfer.amount, asset },
    { account: transfer.recipientAccount, side: 'CREDIT', amount: transfer.amount, asset },
  ]);
  const transferId = await insertTransferRow(db, {
    sender_id: transfer.sender,
    recipient_id: transfer.recipient,
    asset_code: asset,
    amount: transfer.amount.toString(),
    entry_id: entryId,
    sender_level: transfer.level ?? 1,
    ...transfer.columns,
  });
  return { transferId, entryId };
}

/** Le même, dans sa propre transaction, validée. */
export async function transferInSql(
  db: pg.Client,
  transfer: SqlTransfer,
): Promise<{ transferId: string; entryId: string }> {
  await db.query('BEGIN');
  try {
    const written = await writeTransfer(db, transfer);
    await db.query('COMMIT');
    return written;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/**
 * Recule l'heure d'un transfert, comme seul le propriétaire du schéma peut le faire : les
 * règles de la table sont neutralisées le temps de la modification, puis rétablies. À l'usage
 * des tests des fenêtres glissantes — l'horloge de la base ne se règle pas.
 */
export async function backdateTransfer(
  owner: pg.Client,
  transferId: string,
  interval: string,
): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query('ALTER TABLE transfers DISABLE TRIGGER USER');
    await owner.query(`UPDATE transfers SET created_at = created_at - $2::interval WHERE id = $1`, [
      transferId,
      interval,
    ]);
    await owner.query('ALTER TABLE transfers ENABLE TRIGGER USER');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/** Cumuls des envois d'un compte dans un actif, tels que la base les compte. */
export async function usageInSql(
  db: pg.Client,
  sender: string,
  assetCode = 'USD',
): Promise<{ last24Hours: string; last31Days: string }> {
  const { rows } = await db.query<{ last24Hours: string; last31Days: string }>(
    `SELECT last_24_hours::text AS "last24Hours", last_31_days::text AS "last31Days"
     FROM mgx_transfer_usage($1, $2)`,
    [sender, assetCode],
  );
  return rows[0]!;
}
