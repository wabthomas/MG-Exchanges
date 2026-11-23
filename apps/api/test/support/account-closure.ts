import type pg from 'pg';

export interface SqlClosureOptions {
  /** Auteur de la clôture s'il n'est pas le titulaire : un membre du personnel. */
  readonly closedBy?: string;
  /**
   * Date de la clôture ; par défaut, l'heure de la base. Les tests dont l'horloge applicative
   * a été avancée donnent la leur : la base refuse une clôture antidatée, pas une clôture à venir.
   */
  readonly closedAt?: Date;
  /**
   * Terme de la conservation légale. Par défaut : dix ans après la clôture si une décision a
   * été prise sur un dossier de vérification du compte, ou si une écriture a été passée sur un
   * de ses comptes au grand livre ; aucun sinon.
   */
  readonly legalRetentionUntil?: Date | null;
}

/** Tables dont un compte ne garde aucune ligne une fois clôturé, dans l'ordre où elles se vident. */
export const TABLES_EMPTIED_AT_CLOSURE = [
  'user_recovery_codes',
  'user_totp_credentials',
  'user_credentials',
  'verification_challenges',
  'user_profiles',
  'terms_acceptances',
  'user_sessions',
] as const;

const TEN_YEARS_LATER = `((closing.at AT TIME ZONE 'UTC') + INTERVAL '10 years') AT TIME ZONE 'UTC'`;

/** Écrit la trace de la clôture d'un compte : la première écriture d'une clôture. */
export async function insertClosureRecord(
  db: pg.Client,
  userId: string,
  options: SqlClosureOptions = {},
): Promise<void> {
  const closedBy = options.closedBy ?? userId;
  const computed = options.legalRetentionUntil === undefined;
  await db.query(
    `WITH closing AS (SELECT COALESCE($5::timestamptz, now()) AS at),
     term AS (
       SELECT CASE
         WHEN $4::boolean THEN (
           SELECT ${TEN_YEARS_LATER}
           WHERE EXISTS (SELECT 1 FROM kyc_cases k
                         WHERE k.user_id = $1 AND k.status NOT IN ('DRAFT', 'SUBMITTED'))
              OR EXISTS (SELECT 1 FROM ledger_accounts a
                         WHERE a.user_id = $1 AND a.posting_count > 0))
         ELSE $3::timestamptz
       END AS until
       FROM closing
     )
     INSERT INTO account_closures
       (user_id, closed_at, origin, closed_by, email, phone, legal_retention_until, erasure_due_at)
     SELECT u.id, closing.at,
            CASE WHEN $2::uuid = u.id THEN 'HOLDER' ELSE 'STAFF' END::account_closure_origin,
            $2::uuid, u.email, u.phone, term.until,
            GREATEST(closing.at + INTERVAL '30 days', term.until)
     FROM users u, closing, term WHERE u.id = $1`,
    [
      userId,
      closedBy,
      computed ? null : options.legalRetentionUntil,
      computed,
      options.closedAt ?? null,
    ],
  );
}

/**
 * Retire au compte tout ce qu'il portait : secrets, codes, profil, acceptations des conditions
 * d'utilisation, sessions. À appeler une fois la trace de la clôture écrite : avant elle, la
 * base refuse d'effacer une acceptation.
 */
export async function emptyAccount(db: pg.Client, userId: string): Promise<void> {
  for (const table of TABLES_EMPTIED_AT_CLOSURE) {
    await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
}

/** Fait du compte une ligne sans identifiant : son adresse devient l'adresse factice. */
export function markAccountClosed(db: pg.Client, userId: string): Promise<unknown> {
  return db.query(
    `UPDATE users
     SET status = 'CLOSED', email = 'closed-' || id::text || '@closed.invalid',
         email_verified_at = NULL, phone = NULL, phone_verified_at = NULL
     WHERE id = $1`,
    [userId],
  );
}

/** Met fin aux vérifications en vigueur du compte et efface ses dossiers jamais examinés. */
export async function closeVerificationCases(db: pg.Client, userId: string): Promise<void> {
  await db.query(
    `UPDATE kyc_cases SET status = 'ACCOUNT_CLOSED', ended_at = now(), updated_at = now()
     WHERE user_id = $1 AND status = 'APPROVED'`,
    [userId],
  );
  await db.query(
    `DELETE FROM kyc_documents
     WHERE case_id IN (SELECT id FROM kyc_cases
                       WHERE user_id = $1 AND status IN ('DRAFT', 'SUBMITTED'))`,
    [userId],
  );
  await db.query(`DELETE FROM kyc_cases WHERE user_id = $1 AND status IN ('DRAFT', 'SUBMITTED')`, [
    userId,
  ]);
}

/**
 * Clôt un compte directement en SQL, comme le fait l'application : la trace d'abord, puis ce
 * que le compte portait, puis le compte lui-même, puis ses dossiers de vérification — dans une
 * seule transaction, car la base vérifie à sa validation que la clôture est entière.
 *
 * À l'usage des tests qui ont besoin d'un compte clôturé sans passer par l'API.
 */
export async function closeAccountInSql(
  db: pg.Client,
  userId: string,
  options: SqlClosureOptions = {},
): Promise<void> {
  await db.query('BEGIN');
  try {
    await insertClosureRecord(db, userId, options);
    await emptyAccount(db, userId);
    await markAccountClosed(db, userId);
    await closeVerificationCases(db, userId);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/**
 * Déplace les trois dates de la trace d'une clôture de la durée que calcule `shiftSql` (une
 * expression SQL de type `interval`, où `c` désigne la trace).
 *
 * La base lit l'échéance de la conservation légale à sa propre horloge, et la trace d'une
 * clôture ne se modifie pas : le temps ne peut « passer » que si le propriétaire du schéma
 * neutralise la règle, le temps d'une transaction. À n'appeler qu'avec le rôle propriétaire.
 */
async function shiftClosureDates(
  owner: pg.Client,
  userId: string,
  shiftSql: string,
  parameter: string,
): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query('ALTER TABLE account_closures DISABLE TRIGGER account_closures_enforce');
    const { rowCount } = await owner.query(
      `UPDATE account_closures AS c
       SET closed_at = c.closed_at - shift.by,
           legal_retention_until = c.legal_retention_until - shift.by,
           erasure_due_at = c.erasure_due_at - shift.by
       FROM (SELECT ${shiftSql} AS by FROM account_closures AS c WHERE c.user_id = $1) AS shift
       WHERE c.user_id = $1`,
      [userId, parameter],
    );
    if (rowCount !== 1) {
      throw new Error(`Account ${userId} has no closure record.`);
    }
    await owner.query('ALTER TABLE account_closures ENABLE TRIGGER account_closures_enforce');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/** Fait comme si la clôture d'un compte datait de `interval` plus tôt (« 11 years », « 31 days »). */
export function ageClosure(owner: pg.Client, userId: string, interval: string): Promise<void> {
  return shiftClosureDates(owner, userId, '$2::interval', interval);
}

/**
 * Fait comme si l'échéance d'effacement d'un compte clôturé tombait à `offset` de l'heure de la
 * base (« -1 day » : échue depuis un jour ; « 1 day » : dans un jour). La date de la clôture et
 * le terme de la conservation légale sont déplacés d'autant.
 */
export function moveErasureTerm(owner: pg.Client, userId: string, offset: string): Promise<void> {
  return shiftClosureDates(owner, userId, 'c.erasure_due_at - (now() + $2::interval)', offset);
}
