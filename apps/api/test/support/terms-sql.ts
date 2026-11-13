import { createHash } from 'node:crypto';

import type pg from 'pg';

/**
 * Longueur d'un texte en caractères (points de code) — l'unité des bornes de la base et du
 * contrat —, et non en unités UTF-16 comme `String.length` : un émoji y compte pour un.
 */
export function lengthInCharacters(text: string): number {
  return Array.from(text).length;
}

/** Empreinte SHA-256 d'un texte encodé en UTF-8, calculée hors de la base. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Numéro de la version en vigueur ; `0` tant qu'aucune n'a été publiée. */
export async function currentTermsNumber(db: pg.Client): Promise<number> {
  const { rows } = await db.query<{ number: number }>(
    'SELECT COALESCE(max(number), 0)::int AS number FROM terms_versions',
  );
  return rows[0]!.number;
}

/**
 * Publie une version directement en SQL. Par défaut : la version suivante, qui exige d'être
 * acceptée, sans auteur (ce que seul le rôle propriétaire peut écrire), avec un texte propre
 * à son numéro et l'empreinte de ce texte. `overrides` remplace n'importe quelle colonne —
 * l'empreinte n'est calculée que si elle n'y figure pas.
 *
 * @returns le numéro de la version publiée.
 */
export async function insertTermsVersion(
  db: pg.Client,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const number = (overrides['number'] as number | undefined) ?? (await currentTermsNumber(db)) + 1;
  const row: Record<string, unknown> = {
    number,
    requires_acceptance: true,
    summary_fr: `Version ${String(number)}.`,
    body_fr: `Conditions d’utilisation — version ${String(number)}.\n`,
    ...overrides,
  };
  if (!('body_fr_sha256' in row)) {
    row['body_fr_sha256'] = sha256Hex(String(row['body_fr']));
  }
  if (typeof row['body_en'] === 'string' && !('body_en_sha256' in row)) {
    row['body_en_sha256'] = sha256Hex(row['body_en']);
  }
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO terms_versions (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    Object.values(row),
  );
  return number;
}

/** Enregistre l'acceptation d'une version (par défaut : celle en vigueur) par un compte. */
export async function acceptTermsInSql(
  db: pg.Client,
  userId: string,
  versionNumber?: number,
): Promise<unknown> {
  return db.query(`INSERT INTO terms_acceptances (user_id, version_number) VALUES ($1, $2)`, [
    userId,
    versionNumber ?? (await currentTermsNumber(db)),
  ]);
}
