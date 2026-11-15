import type pg from 'pg';

import { insertEntryHeader, insertPostings, type SqlPosting, type SqlSide } from './ledger-sql.js';

/**
 * Ajustements et gels écrits directement en SQL, pour les tests qui éprouvent les règles
 * portées par la base de données (sans passer par l'application).
 */

const DEFAULT_REASON = 'Dépôt en espèces constaté au guichet';

function insertInto(
  db: pg.Client,
  table: string,
  row: Record<string, unknown>,
): Promise<pg.QueryResult<{ id: string }>> {
  const columns = Object.keys(row);
  return db.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})
     RETURNING id`,
    Object.values(row),
  );
}

function updateRow(
  db: pg.Client,
  table: string,
  id: string,
  columns: Record<string, unknown>,
): Promise<pg.QueryResult> {
  const names = Object.keys(columns);
  return db.query(
    `UPDATE ${table}
     SET ${names.map((name, index) => `${name} = $${String(index + 2)}`).join(', ')}
     WHERE id = $1`,
    [id, ...Object.values(columns)],
  );
}

// --- Ajustements --------------------------------------------------------------------------------

/**
 * Dépose une demande d'ajustement : par défaut, un crédit de 100 unités en dollars. `columns`
 * fournit — `user_id` et `requested_by` au moins — ou remplace n'importe quelle colonne.
 */
export async function insertAdjustmentRow(
  db: pg.Client,
  columns: Record<string, unknown>,
): Promise<string> {
  const { rows } = await insertInto(db, 'ledger_adjustments', {
    asset_code: 'USD',
    direction: 'CREDIT',
    amount: 100,
    reason: DEFAULT_REASON,
    ...columns,
  });
  return rows[0]!.id;
}

/** Écrit sur une demande ce que `columns` désigne — une décision, ou ce que la base doit refuser. */
export async function updateAdjustment(
  db: pg.Client,
  id: string,
  columns: Record<string, unknown>,
): Promise<void> {
  await updateRow(db, 'ledger_adjustments', id, columns);
}

export interface AdjustmentRow {
  readonly status: string;
  readonly direction: SqlSide;
  readonly amount: string;
  readonly requested_at: Date;
  readonly expires_at: Date;
  readonly decided_by: string | null;
  readonly decided_at: Date | null;
  readonly decision_note: string | null;
  readonly entry_id: string | null;
}

export async function adjustmentRow(db: pg.Client, id: string): Promise<AdjustmentRow> {
  const { rows } = await db.query<AdjustmentRow>(
    `SELECT status::text AS status, direction::text AS direction, amount::text AS amount,
            requested_at, expires_at, decided_by::text AS decided_by, decided_at, decision_note,
            entry_id::text AS entry_id
     FROM ledger_adjustments WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

export interface SqlAdjustmentEntry {
  /** Sens de l'ajustement, vu du portefeuille. */
  readonly direction: SqlSide;
  /** Compte « fonds disponibles » du titulaire. */
  readonly holderAccount: string;
  /** Compte de conservation de la plateforme, dans le même actif. */
  readonly custodyAccount: string;
  readonly amount: number | bigint;
  readonly asset?: string;
  /** Type de l'écriture ; par défaut, celui du sens. */
  readonly kind?: string;
  /** Lignes à passer à la place des deux lignes attendues. */
  readonly postings?: readonly SqlPosting[];
}

const opposite = (side: SqlSide): SqlSide => (side === 'CREDIT' ? 'DEBIT' : 'CREDIT');

/**
 * Passe l'écriture d'un ajustement — son en-tête et ses deux lignes, celle qui débite d'abord —
 * **sans** ouvrir ni valider de transaction. Rend l'identifiant de l'écriture.
 */
export async function writeAdjustmentEntry(
  db: pg.Client,
  entry: SqlAdjustmentEntry,
): Promise<string> {
  const asset = entry.asset ?? 'USD';
  const wallet: SqlPosting = {
    account: entry.holderAccount,
    side: entry.direction,
    amount: entry.amount,
    asset,
  };
  const custody: SqlPosting = {
    account: entry.custodyAccount,
    side: opposite(entry.direction),
    amount: entry.amount,
    asset,
  };
  const postings =
    entry.postings ?? (entry.direction === 'DEBIT' ? [wallet, custody] : [custody, wallet]);
  const entryId = await insertEntryHeader(db, postings.length, {
    kind: entry.kind ?? (entry.direction === 'CREDIT' ? 'adjustment.credit' : 'adjustment.debit'),
  });
  await insertPostings(db, entryId, postings);
  return entryId;
}

/**
 * Approuve une demande comme le fait l'application — l'écriture, puis la décision qui la
 * désigne — **sans** ouvrir ni valider de transaction. `columns` remplace des colonnes de la
 * décision.
 */
export async function writeApproval(
  db: pg.Client,
  id: string,
  approver: string,
  entry: SqlAdjustmentEntry,
  columns: Record<string, unknown> = {},
): Promise<string> {
  const entryId = await writeAdjustmentEntry(db, entry);
  await updateAdjustment(db, id, {
    status: 'APPROVED',
    decided_by: approver,
    entry_id: entryId,
    ...columns,
  });
  return entryId;
}

/** Le même, dans sa propre transaction, validée. */
export async function approveInSql(
  db: pg.Client,
  id: string,
  approver: string,
  entry: SqlAdjustmentEntry,
  columns: Record<string, unknown> = {},
): Promise<string> {
  await db.query('BEGIN');
  try {
    const entryId = await writeApproval(db, id, approver, entry, columns);
    await db.query('COMMIT');
    return entryId;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/**
 * Recule l'heure d'une demande et son échéance, comme seul le propriétaire du schéma peut le
 * faire : les règles de la table sont neutralisées le temps de la modification, puis rétablies.
 * L'horloge de la base ne se règle pas.
 */
export async function ageAdjustment(owner: pg.Client, id: string, interval: string): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query('ALTER TABLE ledger_adjustments DISABLE TRIGGER USER');
    await owner.query(
      `UPDATE ledger_adjustments
       SET requested_at = requested_at - $2::interval, expires_at = expires_at - $2::interval
       WHERE id = $1`,
      [id, interval],
    );
    await owner.query('ALTER TABLE ledger_adjustments ENABLE TRIGGER USER');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

// --- Gels ---------------------------------------------------------------------------------------

/**
 * Gèle un portefeuille : par défaut, celui en dollars. `columns` fournit — `user_id` et
 * `frozen_by` au moins — ou remplace n'importe quelle colonne.
 */
export async function insertFreezeRow(
  db: pg.Client,
  columns: Record<string, unknown>,
): Promise<string> {
  const { rows } = await insertInto(db, 'wallet_freezes', {
    asset_code: 'USD',
    reason: 'Signalement du service conformité',
    ...columns,
  });
  return rows[0]!.id;
}

/** Écrit sur un gel ce que `columns` désigne — sa levée, ou ce que la base doit refuser. */
export async function updateFreeze(
  db: pg.Client,
  id: string,
  columns: Record<string, unknown>,
): Promise<void> {
  await updateRow(db, 'wallet_freezes', id, columns);
}

/** Lève un gel. */
export function liftFreezeInSql(
  db: pg.Client,
  id: string,
  liftedBy: string,
  reason = 'Vérification terminée, rien à signaler',
): Promise<void> {
  return updateFreeze(db, id, { lifted_by: liftedBy, lift_reason: reason });
}

export interface FreezeRow {
  readonly frozen_at: Date;
  readonly lifted_by: string | null;
  readonly lifted_at: Date | null;
  readonly lift_reason: string | null;
}

export async function freezeRow(db: pg.Client, id: string): Promise<FreezeRow> {
  const { rows } = await db.query<FreezeRow>(
    `SELECT frozen_at, lifted_by::text AS lifted_by, lifted_at, lift_reason
     FROM wallet_freezes WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}
