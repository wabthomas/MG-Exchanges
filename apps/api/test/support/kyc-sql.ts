import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';

/**
 * Dossiers de vérification d'identité écrits directement en SQL, pour les tests qui éprouvent
 * les règles portées par la base de données (sans passer par l'application).
 */

export type Level = 1 | 2 | 3;

export interface CaseOverrides {
  readonly columns?: Record<string, unknown>;
  /** Empreinte de la pièce d'identité (niveau 1) : la même pièce a la même empreinte. */
  readonly digest?: Buffer;
}

/** Colonnes d'une déclaration valide pour chaque niveau. */
export function declaration(level: Level, digest: Buffer): Record<string, unknown> {
  switch (level) {
    case 1:
      return {
        given_name: 'Jean',
        family_name: 'Mukendi',
        additional_name: 'Kabongo',
        date_of_birth: '1990-05-17',
        place_of_birth: 'Lubumbashi',
        nationality: 'CD',
        document_type: 'PASSPORT',
        document_number_encrypted: randomBytes(40),
        document_number_digest: digest,
        document_issuing_country: 'CD',
        document_issued_on: '2024-01-10',
        document_issued_at: 'Kinshasa',
        document_expires_on: '2034-01-09',
      };
    case 2:
      return {
        address_line1: '12 avenue Kasa-Vubu',
        city: 'Kinshasa',
        address_country: 'CD',
        address_proof_type: 'UTILITY_BILL',
        address_proof_issued_on: '2026-10-20',
      };
    case 3:
      return {
        funds_sources: '{EMPLOYMENT,SAVINGS}',
        occupation: 'Ingénieur des mines',
        funds_explanation: 'Salaire mensuel et épargne constituée depuis 2015.',
      };
  }
}

/** Insère un dossier en préparation, valide pour son niveau sauf mention contraire. */
export async function insertCase(
  db: pg.Client,
  user: string,
  level: Level,
  overrides: CaseOverrides = {},
): Promise<string> {
  const columns: Record<string, unknown> = {
    user_id: user,
    level,
    ...declaration(level, overrides.digest ?? randomBytes(32)),
    ...overrides.columns,
  };
  const names = Object.keys(columns);
  const result = await db.query<{ id: string }>(
    `INSERT INTO kyc_cases (${names.map((name) => `"${name}"`).join(', ')})
     VALUES (${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
     RETURNING id`,
    Object.values(columns),
  );
  return result.rows[0]!.id;
}

export async function addDocument(
  db: pg.Client,
  caseId: string,
  kind: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const columns: Record<string, unknown> = {
    id,
    case_id: caseId,
    kind,
    content_type: kind === 'SELFIE' ? 'image/jpeg' : 'application/pdf',
    byte_size: 20_480,
    sha256: randomBytes(32),
    storage_key: `${id.slice(-2)}/${id}`,
    wrapped_key: randomBytes(61),
    ...overrides,
  };
  const names = Object.keys(columns);
  await db.query(
    `INSERT INTO kyc_documents (${names.map((name) => `"${name}"`).join(', ')})
     VALUES (${names.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    Object.values(columns),
  );
  return id;
}

export const REQUIRED_DOCUMENTS: Record<Level, readonly string[]> = {
  1: ['IDENTITY_FRONT', 'SELFIE'],
  2: ['PROOF_OF_ADDRESS'],
  3: ['SOURCE_OF_FUNDS'],
};

export const submit = (db: pg.Client, id: string) =>
  db.query(
    `UPDATE kyc_cases SET status = 'SUBMITTED', submitted_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );

export const approve = (db: pg.Client, id: string, by: string, extra = '') =>
  db.query(
    `UPDATE kyc_cases
     SET status = 'APPROVED', decided_by = $2, decided_at = now(), updated_at = now()${extra}
     WHERE id = $1`,
    [id, by],
  );

export const reject = (db: pg.Client, id: string, by: string) =>
  db.query(
    `UPDATE kyc_cases
     SET status = 'REJECTED', decided_by = $2, decided_at = now(), updated_at = now(),
         rejection_reasons = '{DOCUMENT_UNREADABLE}', decision_note = 'Pièce illisible, ticket 311'
     WHERE id = $1`,
    [id, by],
  );

export const revoke = (db: pg.Client, id: string, by: string) =>
  db.query(
    `UPDATE kyc_cases
     SET status = 'REVOKED', revoked_by = $2, ended_at = now(), updated_at = now(),
         revocation_reason = 'Pièce reconnue fausse'
     WHERE id = $1`,
    [id, by],
  );

/** Dossier complet, prêt à être déposé. */
export async function completeDraft(
  db: pg.Client,
  user: string,
  level: Level,
  overrides: CaseOverrides = {},
): Promise<string> {
  const id = await insertCase(db, user, level, overrides);
  for (const kind of REQUIRED_DOCUMENTS[level]) {
    await addDocument(db, id, kind);
  }
  return id;
}

export async function submitted(
  db: pg.Client,
  user: string,
  level: Level,
  overrides: CaseOverrides = {},
): Promise<string> {
  const id = await completeDraft(db, user, level, overrides);
  await submit(db, id);
  return id;
}
