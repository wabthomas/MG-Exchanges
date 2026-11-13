import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PERMISSION_KEYS, SYSTEM_ROLES } from '@mgx/contracts';
import type pg from 'pg';

import {
  ageClosure,
  closeAccountInSql,
  emptyAccount,
  insertClosureRecord,
  markAccountClosed,
} from '../support/account-closure.js';
import {
  addDocument,
  approve,
  type CaseOverrides,
  completeDraft,
  insertCase,
  type Level,
  reject,
  revoke,
  submit,
  submitted,
} from '../support/kyc-sql.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE } from '../support/test-environment.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';
const STRING_TOO_LONG = '22001';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table protégée (voir la migration init_foundations). */
const FORBIDDEN_MUTATION = 'MGX01';
/** Règle du parcours d'un dossier de vérification enfreinte (migration kyc). */
const KYC_RULE_VIOLATION = 'MGX03';

describe('Vérification d’identité — règles portées par la base de données', () => {
  let database: TestDatabase;
  /** Deux agents de conformité, un agent du support et un administrateur, créés une fois. */
  let claire: string;
  let david: string;
  let support: string;
  let admin: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      claire = await insertStaff(db, 'compliance');
      david = await insertStaff(db, 'compliance');
      support = await insertStaff(db, 'support');
      admin = await insertStaff(db, 'super_admin');
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);

  /** Code et message de l'erreur levée par `action`, ou `undefined` si elle réussit. */
  async function failureOf(
    action: () => Promise<unknown>,
  ): Promise<{ code: string | undefined; message: string } | undefined> {
    try {
      await action();
      return undefined;
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      return { code, message };
    }
  }

  let sequence = 0;
  async function insertUser(db: pg.Client, status = 'ACTIVE'): Promise<string> {
    sequence += 1;
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, country_code, registered_at, status, email_verified_at)
       VALUES ($1, 'CD', now(), $2::user_status, now())
       RETURNING id`,
      [`kyc${String(sequence)}@example.cd`, status],
    );
    return result.rows[0]!.id;
  }

  /** Membre du personnel, créé comme le fait l'outil d'amorçage : avec le rôle propriétaire. */
  async function insertStaff(owner: pg.Client, roleKey: string): Promise<string> {
    const id = await insertUser(owner);
    await owner.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`,
      [id, roleKey],
    );
    return id;
  }

  async function approved(
    db: pg.Client,
    user: string,
    level: Level,
    overrides: CaseOverrides = {},
  ): Promise<string> {
    const id = await submitted(db, user, level, overrides);
    await approve(db, id, claire);
    return id;
  }

  const caseRow = async (db: pg.Client, id: string) =>
    (
      await db.query<{
        status: string;
        ended_at: Date | null;
        decided_by: string | null;
        revoked_by: string | null;
      }>('SELECT status, ended_at, decided_by, revoked_by FROM kyc_cases WHERE id = $1', [id])
    ).rows[0]!;

  const statusOf = async (db: pg.Client, id: string): Promise<string> =>
    (await caseRow(db, id)).status;

  describe('catalogue des permissions et des rôles', () => {
    it('le catalogue de la base est celui du code, et le rôle de conformité a exactement ses permissions', async () => {
      await asApp(async (db) => {
        const permissions = await db.query<{ key: string }>(
          'SELECT key FROM permissions ORDER BY key',
        );
        expect(permissions.rows.map(({ key }) => key)).toEqual([...PERMISSION_KEYS].sort());

        const { rows } = await db.query<{ key: string; permissions: string[] }>(
          `SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS permissions
           FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
           WHERE r.is_system GROUP BY r.key`,
        );
        const byRole = Object.fromEntries(rows.map((row) => [row.key, row.permissions]));
        expect(byRole['compliance']).toEqual([
          'kyc.read',
          'kyc.review',
          'kyc.revoke',
          'users.close',
          'users.read',
        ]);
        expect(byRole['compliance']).toEqual([...SYSTEM_ROLES.compliance].sort());
        // L'administrateur détient tout le catalogue ; le support ne voit aucun dossier.
        expect(byRole['super_admin']).toEqual([...PERMISSION_KEYS].sort());
        expect(byRole['support']?.filter((key) => key.startsWith('kyc.'))).toEqual([]);
      });
    });
  });

  describe('naissance et contenu d’un dossier', () => {
    it('un dossier naît en préparation, avec la déclaration de son niveau — et elle seule', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        for (const level of [1, 2, 3] as const) {
          const id = await insertCase(db, user, level);
          expect(await statusOf(db, id)).toBe('DRAFT');
        }

        // Né autrement qu'en préparation.
        const other = await insertUser(db);
        expect(
          await sqlState(() =>
            insertCase(db, other, 1, {
              columns: { status: 'SUBMITTED', submitted_at: new Date() },
            }),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        expect(
          await sqlState(() =>
            insertCase(db, other, 1, {
              columns: {
                status: 'APPROVED',
                submitted_at: new Date(),
                decided_at: new Date(),
                decided_by: claire,
              },
            }),
          ),
        ).toBe(KYC_RULE_VIOLATION);

        // Niveau hors bornes.
        for (const level of [0, 4]) {
          expect(
            await sqlState(() =>
              db.query(`INSERT INTO kyc_cases (user_id, level) VALUES ($1, $2)`, [other, level]),
            ),
          ).toBe(CHECK_VIOLATION);
        }

        // Déclaration incomplète, ou d'un autre niveau.
        for (const columns of [
          { given_name: null },
          { given_name: '   ' },
          { nationality: 'cd' },
          { document_number_digest: randomBytes(31) },
          { document_issued_on: '1980-01-01' },
          { document_expires_on: '2024-01-10' },
          { date_of_birth: '1899-12-31' },
          { city: 'Kinshasa' },
          { occupation: 'Ingénieur' },
          { funds_sources: '{SAVINGS}' },
        ]) {
          expect(await sqlState(() => insertCase(db, other, 1, { columns }))).toBe(CHECK_VIOLATION);
        }
        for (const columns of [
          { address_line1: null },
          { city: '' },
          { address_country: 'cd' },
          { address_proof_issued_on: null },
          { given_name: 'Jean' },
        ]) {
          expect(await sqlState(() => insertCase(db, other, 2, { columns }))).toBe(CHECK_VIOLATION);
        }
        // Un code de pays tient en deux lettres : le type de la colonne refuse le reste.
        expect(
          await sqlState(() => insertCase(db, other, 2, { columns: { address_country: 'COD' } })),
        ).toBe(STRING_TOO_LONG);
        for (const columns of [
          { funds_sources: '{}' },
          { occupation: null },
          { funds_explanation: ' ' },
          { city: 'Kinshasa' },
        ]) {
          expect(await sqlState(() => insertCase(db, other, 3, { columns }))).toBe(CHECK_VIOLATION);
        }
        // Les listes ne sont jamais nulles.
        expect(
          await sqlState(() => insertCase(db, other, 1, { columns: { rejection_reasons: null } })),
        ).toBe(CHECK_VIOLATION);

        // Un brouillon ne porte ni décision, ni motif, ni retrait.
        for (const columns of [
          { decided_by: claire, decided_at: new Date() },
          { submitted_at: new Date() },
          { rejection_reasons: '{OTHER}' },
          { decision_note: 'note' },
          { revocation_reason: 'motif' },
          { ended_at: new Date() },
        ]) {
          expect(await sqlState(() => insertCase(db, other, 1, { columns }))).toBe(CHECK_VIOLATION);
        }
        expect(
          (await db.query('SELECT 1 FROM kyc_cases WHERE user_id = $1', [other])).rowCount,
        ).toBe(0);
      });
    });

    it('un seul dossier ouvert par compte et par niveau ; le titulaire et le niveau ne changent jamais', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const other = await insertUser(db);
        const id = await insertCase(db, user, 1);

        expect(await sqlState(() => insertCase(db, user, 1))).toBe(UNIQUE_VIOLATION);
        // Un autre compte, ou un autre niveau, ne sont pas concernés.
        await insertCase(db, other, 1);

        for (const [column, value] of [
          ['user_id', other],
          ['created_at', new Date(0)],
          ['id', randomUUID()],
        ] as const) {
          expect(
            await sqlState(() =>
              db.query(`UPDATE kyc_cases SET "${column}" = $2 WHERE id = $1`, [id, value]),
            ),
          ).toBe(KYC_RULE_VIOLATION);
        }
        // Changer de niveau reviendrait à changer de déclaration : refusé avant même les contrôles.
        expect(
          await sqlState(() => db.query(`UPDATE kyc_cases SET level = 2 WHERE id = $1`, [id])),
        ).toBe(KYC_RULE_VIOLATION);

        // Tant qu'il est en préparation, sa déclaration se corrige librement.
        await db.query(
          `UPDATE kyc_cases SET given_name = 'Jeanne', updated_at = now() WHERE id = $1`,
          [id],
        );
        // … mais pas vers un état incohérent.
        expect(
          await sqlState(() =>
            db.query(`UPDATE kyc_cases SET family_name = NULL WHERE id = $1`, [id]),
          ),
        ).toBe(CHECK_VIOLATION);
      });
    });
  });

  describe('pièces', () => {
    it('une pièce a sa place dans un dossier de son niveau, et respecte les bornes', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const identity = await insertCase(db, user, 1);

        await addDocument(db, identity, 'IDENTITY_FRONT');
        await addDocument(db, identity, 'IDENTITY_BACK');
        await addDocument(db, identity, 'SELFIE', { content_type: 'image/png' });
        // Recto, verso et autoportrait sont uniques.
        for (const kind of ['IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE']) {
          expect(await sqlState(() => addDocument(db, identity, kind))).toBe(UNIQUE_VIOLATION);
        }
        // Les pièces des autres niveaux n'y ont pas leur place.
        for (const kind of ['PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS']) {
          expect(await sqlState(() => addDocument(db, identity, kind))).toBe(KYC_RULE_VIOLATION);
        }

        const draft = await insertCase(db, await insertUser(db), 1);
        for (const overrides of [
          { content_type: 'image/gif' },
          { content_type: 'text/html' },
          { byte_size: 0 },
          { byte_size: 10_485_761 },
          { sha256: randomBytes(20) },
          { wrapped_key: randomBytes(16) },
          { wrapped_key: randomBytes(300) },
          { storage_key: '../etc/passwd' },
          { storage_key: 'AB/Upper' },
        ]) {
          expect(await sqlState(() => addDocument(db, draft, 'IDENTITY_FRONT', overrides))).toBe(
            CHECK_VIOLATION,
          );
        }
        // Un autoportrait est une image.
        expect(
          await sqlState(() =>
            addDocument(db, draft, 'SELFIE', { content_type: 'application/pdf' }),
          ),
        ).toBe(CHECK_VIOLATION);
        // Deux pièces ne partagent pas un emplacement.
        const first = await addDocument(db, draft, 'IDENTITY_FRONT');
        expect(
          await sqlState(() =>
            addDocument(db, draft, 'SELFIE', { storage_key: `${first.slice(-2)}/${first}` }),
          ),
        ).toBe(UNIQUE_VIOLATION);
        // Une pièce appartient à un dossier qui existe.
        expect(await sqlState(() => addDocument(db, randomUUID(), 'SELFIE'))).toBe(
          KYC_RULE_VIOLATION,
        );
      });
    });

    it('une pièce ne se modifie jamais, pas même par le propriétaire du schéma', async () => {
      const [draft, document] = await asApp(async (db) => {
        const id = await insertCase(db, await insertUser(db), 1);
        return [id, await addDocument(db, id, 'IDENTITY_FRONT')] as const;
      });
      const update = (db: pg.Client) =>
        db.query(`UPDATE kyc_documents SET byte_size = 1 WHERE id = $1`, [document]);

      // Le rôle applicatif n'en a pas le privilège ; le propriétaire se heurte au déclencheur.
      expect(await asApp((db) => sqlState(() => update(db)))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await asOwner((db) => sqlState(() => update(db)))).toBe(KYC_RULE_VIOLATION);
      for (const table of ['kyc_documents', 'kyc_cases']) {
        expect(await asApp((db) => sqlState(() => db.query(`TRUNCATE ${table} CASCADE`)))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        // Chaque table refuse elle-même d'être vidée : celle des dossiers ne s'en remet pas à
        // celle des pièces, que la cascade viderait avec elle.
        const refusal = await asOwner((db) =>
          failureOf(() => db.query(`TRUNCATE ${table} CASCADE`)),
        );
        expect(refusal).toEqual({
          code: FORBIDDEN_MUTATION,
          message: `table "${table}" is append-only: TRUNCATE is not allowed`,
        });
      }
      await asApp(async (db) => {
        expect(
          (await db.query('SELECT byte_size FROM kyc_documents WHERE id = $1', [document])).rows,
        ).toEqual([{ byte_size: 20_480 }]);
        expect(await statusOf(db, draft)).toBe('DRAFT');
      });
    });

    it('le rôle applicatif n’a, sur ces tables, que les privilèges dont il a besoin', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ table_name: string; privileges: string[] }>(
          `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_name IN ('kyc_cases', 'kyc_documents')
           GROUP BY table_name ORDER BY table_name`,
          [TEST_APP_ROLE],
        );
        expect(rows).toEqual([
          { table_name: 'kyc_cases', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
          { table_name: 'kyc_documents', privileges: ['DELETE', 'INSERT', 'SELECT'] },
        ]);
      });
    });
  });

  describe('dépôt', () => {
    it('un dossier ne se dépose qu’avec ses pièces obligatoires', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertCase(db, user, 1);
        expect(await sqlState(() => submit(db, id))).toBe(KYC_RULE_VIOLATION);
        await addDocument(db, id, 'IDENTITY_FRONT');
        expect(await sqlState(() => submit(db, id))).toBe(KYC_RULE_VIOLATION);
        await addDocument(db, id, 'SELFIE');

        // Un brouillon ne saute pas l'étape du dépôt.
        expect(await sqlState(() => approve(db, id, claire))).toBe(KYC_RULE_VIOLATION);
        expect(await sqlState(() => reject(db, id, claire))).toBe(KYC_RULE_VIOLATION);
        expect(await sqlState(() => revoke(db, id, claire))).toBe(KYC_RULE_VIOLATION);
        // Un dépôt porte sa date.
        expect(
          await sqlState(() =>
            db.query(`UPDATE kyc_cases SET status = 'SUBMITTED' WHERE id = $1`, [id]),
          ),
        ).toBe(CHECK_VIOLATION);

        await submit(db, id);
        expect(await statusOf(db, id)).toBe('SUBMITTED');
      });
    });

    it('les niveaux se déposent dans l’ordre : le précédent doit être vérifié', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const address = await completeDraft(db, user, 2);
        const funds = await completeDraft(db, user, 3);

        expect(await sqlState(() => submit(db, address))).toBe(KYC_RULE_VIOLATION);
        // Un niveau 1 seulement déposé ne suffit pas.
        const identity = await submitted(db, user, 1);
        expect(await sqlState(() => submit(db, address))).toBe(KYC_RULE_VIOLATION);
        await approve(db, identity, claire);

        await submit(db, address);
        expect(await sqlState(() => submit(db, funds))).toBe(KYC_RULE_VIOLATION);
        await approve(db, address, david);
        await submit(db, funds);
        await approve(db, funds, claire);
        expect(await statusOf(db, funds)).toBe('APPROVED');
      });
    });

    it('déposé, le dossier est une preuve : ni sa déclaration ni ses pièces ne changent, et il ne s’efface pas', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await completeDraft(db, user, 1);
        const back = await addDocument(db, id, 'IDENTITY_BACK');
        await submit(db, id);

        for (const assignment of [
          `given_name = 'Paul'`,
          `document_number_digest = decode(repeat('00', 32), 'hex')`,
          `document_expires_on = DATE '2040-01-01'`,
          `submitted_at = now() - interval '1 day'`,
          `status = 'DRAFT', submitted_at = NULL`,
        ]) {
          expect(
            await sqlState(() =>
              db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [id]),
            ),
          ).toBe(KYC_RULE_VIOLATION);
        }
        // Ni ajout, ni retrait de pièce : le déclencheur répond avant l'index d'unicité.
        for (const kind of ['IDENTITY_BACK', 'SELFIE', 'PROOF_OF_ADDRESS']) {
          expect(await sqlState(() => addDocument(db, id, kind))).toBe(KYC_RULE_VIOLATION);
        }
        expect(
          await sqlState(() => db.query('DELETE FROM kyc_documents WHERE id = $1', [back])),
        ).toBe(KYC_RULE_VIOLATION);
        expect(
          await sqlState(() => db.query('DELETE FROM kyc_documents WHERE case_id = $1', [id])),
        ).toBe(KYC_RULE_VIOLATION);
        // Le dossier ne s'efface pas : le déclencheur le refuse avant même que la clé étrangère
        // de ses pièces ne soit consultée.
        expect(await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [id]))).toBe(
          KYC_RULE_VIOLATION,
        );

        // La décision y ajoute ses propres colonnes — rien d'autre.
        expect(await sqlState(() => approve(db, id, claire, `, given_name = 'Paul'`))).toBe(
          KYC_RULE_VIOLATION,
        );
        await approve(db, id, claire);
        expect(
          (await db.query('SELECT count(*)::int AS n FROM kyc_documents WHERE case_id = $1', [id]))
            .rows,
        ).toEqual([{ n: 3 }]);
      });
    });

    it('tant que le compte est ouvert, seul un dossier en préparation s’efface', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const draft = await completeDraft(db, user, 1);
        // Un brouillon ne s'efface qu'une fois ses pièces retirées : aucune ne reste orpheline.
        expect(await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [draft]))).toBe(
          RESTRICT_VIOLATION,
        );
        await db.query('DELETE FROM kyc_documents WHERE case_id = $1', [draft]);
        await db.query('DELETE FROM kyc_cases WHERE id = $1', [draft]);
        expect((await db.query('SELECT 1 FROM kyc_cases WHERE id = $1', [draft])).rowCount).toBe(0);

        // Un dossier refusé ne s'efface pas — pas même par le propriétaire du schéma.
        const other = await insertUser(db);
        const rejected = await submitted(db, other, 1);
        await reject(db, rejected, claire);
        expect(
          await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [rejected])),
        ).toBe(KYC_RULE_VIOLATION);
        expect(
          await asOwner((owner) =>
            sqlState(() => owner.query('DELETE FROM kyc_cases WHERE id = $1', [rejected])),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        // Le compte lui-même ne s'efface pas tant qu'il a un dossier.
        expect(await sqlState(() => db.query('DELETE FROM users WHERE id = $1', [other]))).toBe(
          RESTRICT_VIOLATION,
        );
        expect(await statusOf(db, rejected)).toBe('REJECTED');
      });
    });
  });

  describe('décision', () => {
    it('la décision vient d’un compte actif détenant kyc.review, jamais du titulaire', async () => {
      const suspendedOfficer = await asOwner(async (owner) => {
        const id = await insertStaff(owner, 'compliance');
        await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [id]);
        return id;
      });
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await submitted(db, user, 1);
        const stranger = await insertUser(db);

        for (const decider of [support, stranger, suspendedOfficer]) {
          expect(await sqlState(() => approve(db, id, decider))).toBe(KYC_RULE_VIOLATION);
          expect(await sqlState(() => reject(db, id, decider))).toBe(KYC_RULE_VIOLATION);
        }
        // Le titulaire ne décide pas de son propre dossier : il n'en a pas la permission…
        expect(await sqlState(() => approve(db, id, user))).toBe(KYC_RULE_VIOLATION);
        expect(await sqlState(() => reject(db, id, user))).toBe(KYC_RULE_VIOLATION);
        // … et, fût-il agent de conformité, une contrainte de la table le lui interdit.
        const ownCase = await submitted(db, claire, 1);
        expect(await sqlState(() => approve(db, ownCase, claire))).toBe(CHECK_VIOLATION);
        expect(await sqlState(() => reject(db, ownCase, claire))).toBe(CHECK_VIOLATION);
        expect(await statusOf(db, ownCase)).toBe('SUBMITTED');
        await approve(db, ownCase, david);

        // Une décision porte son auteur et sa date : sans auteur, personne n'est habilité ;
        // sans date, la table la refuse.
        for (const [assignment, expected] of [
          [`status = 'APPROVED'`, KYC_RULE_VIOLATION],
          [`status = 'APPROVED', decided_at = now()`, KYC_RULE_VIOLATION],
          [`status = 'APPROVED', decided_by = '${claire}'`, CHECK_VIOLATION],
        ] as const) {
          expect(
            await sqlState(() =>
              db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [id]),
            ),
          ).toBe(expected);
        }
        expect(await statusOf(db, id)).toBe('SUBMITTED');

        // L'administrateur détient toutes les permissions : il peut décider.
        await approve(db, id, admin);
        expect(await caseRow(db, id)).toMatchObject({ status: 'APPROVED', decided_by: admin });
      });
    });

    it('un refus est motivé ; une acceptation ne porte pas de motif de refus', async () => {
      await asApp(async (db) => {
        const id = await submitted(db, await insertUser(db), 1);
        const set = (assignment: string) =>
          db.query(
            `UPDATE kyc_cases
             SET decided_by = $2, decided_at = now(), updated_at = now(), ${assignment}
             WHERE id = $1`,
            [id, claire],
          );

        for (const [assignment, expected] of [
          // Sans motif, sans note, avec une note vide, avec trop de motifs.
          [`status = 'REJECTED', decision_note = 'note interne'`, CHECK_VIOLATION],
          [`status = 'REJECTED', rejection_reasons = '{OTHER}'`, CHECK_VIOLATION],
          [
            `status = 'REJECTED', rejection_reasons = '{OTHER}', decision_note = '  '`,
            CHECK_VIOLATION,
          ],
          [
            `status = 'REJECTED', decision_note = 'note', rejection_reasons =
             '{DOCUMENT_UNREADABLE,DOCUMENT_EXPIRED,DOCUMENT_NOT_ACCEPTED,DOCUMENT_INCOMPLETE,INFORMATION_MISMATCH,SELFIE_UNUSABLE}'`,
            CHECK_VIOLATION,
          ],
          // Une acceptation n'a pas de motif de refus…
          [`status = 'APPROVED', rejection_reasons = '{OTHER}'`, CHECK_VIOLATION],
          // … et une décision n'écrit rien de ce qui relève d'un retrait.
          [`status = 'APPROVED', revocation_reason = 'motif'`, KYC_RULE_VIOLATION],
          [`status = 'APPROVED', ended_at = now()`, KYC_RULE_VIOLATION],
          [`status = 'APPROVED', revoked_by = '${david}'`, KYC_RULE_VIOLATION],
        ] as const) {
          expect(await sqlState(() => set(assignment))).toBe(expected);
        }
        expect(await statusOf(db, id)).toBe('SUBMITTED');

        await reject(db, id, claire);
        expect(await statusOf(db, id)).toBe('REJECTED');
      });
    });

    it('un dossier refusé, remplacé ou retiré ne change plus', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const rejected = await submitted(db, user, 1);
        await reject(db, rejected, claire);
        const superseded = await approved(db, user, 1);
        await approved(db, user, 1);
        const revokedUser = await insertUser(db);
        const revoked = await approved(db, revokedUser, 1);
        await revoke(db, revoked, david);
        expect(await statusOf(db, superseded)).toBe('SUPERSEDED');

        for (const id of [rejected, superseded, revoked]) {
          for (const assignment of [
            `status = 'APPROVED'`,
            `status = 'SUBMITTED', decided_by = NULL, decided_at = NULL`,
            `decision_note = 'réécrite après coup'`,
            `updated_at = now()`,
            `given_name = 'Paul'`,
          ]) {
            expect(
              await sqlState(() =>
                db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [id]),
              ),
            ).toBe(KYC_RULE_VIOLATION);
          }
          expect(await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [id]))).toBe(
            KYC_RULE_VIOLATION,
          );
        }
        expect(await statusOf(db, rejected)).toBe('REJECTED');
        expect(await statusOf(db, superseded)).toBe('SUPERSEDED');
        expect(await statusOf(db, revoked)).toBe('REVOKED');
      });
    });

    it('accepter un nouveau dossier remplace l’ancien — et ce remplacement ne s’écrit pas à la main', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const first = await approved(db, user, 1);

        // Écriture directe du remplacement : refusée, y compris avec une date de fin.
        expect(
          await sqlState(() =>
            db.query(
              `UPDATE kyc_cases SET status = 'SUPERSEDED', ended_at = now(), updated_at = now()
               WHERE id = $1`,
              [first],
            ),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        // Un dossier accepté ne change pas autrement : ni sa déclaration, ni sa décision…
        for (const assignment of [
          `given_name = 'Paul'`,
          `decision_note = 'ajoutée après coup'`,
          `status = 'REJECTED', rejection_reasons = '{OTHER}', decision_note = 'x'`,
          `status = 'SUBMITTED', decided_by = NULL, decided_at = NULL`,
          // … ni son seul statut, ni les colonnes qu'un retrait ou un remplacement écrivent —
          // pas même sa date de modification.
          `status = 'REJECTED'`,
          `status = 'SUBMITTED'`,
          `status = 'DRAFT'`,
          `updated_at = now()`,
          `ended_at = now()`,
          `revoked_by = '${david}'`,
          `revocation_reason = 'sans retrait'`,
        ]) {
          expect(
            await sqlState(() =>
              db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [first]),
            ),
          ).toBe(KYC_RULE_VIOLATION);
        }
        const untouched = await db.query<{ updated_at: Date; decided_at: Date }>(
          'SELECT updated_at, decided_at FROM kyc_cases WHERE id = $1',
          [first],
        );
        expect(untouched.rows[0]?.updated_at).toEqual(untouched.rows[0]?.decided_at);

        const second = await submitted(db, user, 1);
        expect(await statusOf(db, first)).toBe('APPROVED');
        await approve(db, second, david);

        const replaced = await caseRow(db, first);
        expect(replaced.status).toBe('SUPERSEDED');
        expect(replaced.ended_at).not.toBeNull();
        expect(replaced.revoked_by).toBeNull();
        expect(await statusOf(db, second)).toBe('APPROVED');
        // Jamais deux dossiers acceptés pour un même niveau.
        const inForce = await db.query(
          `SELECT id FROM kyc_cases WHERE user_id = $1 AND level = 1 AND status = 'APPROVED'`,
          [user],
        );
        expect(inForce.rows).toEqual([{ id: second }]);
      });
    });

    it('un niveau ne s’accepte pas si le précédent n’est plus vérifié', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const identity = await approved(db, user, 1);
        const address = await submitted(db, user, 2);
        await revoke(db, identity, david);

        expect(await sqlState(() => approve(db, address, claire))).toBe(KYC_RULE_VIOLATION);
        // Il se refuse, pour vider la file.
        await reject(db, address, claire);
        expect(await statusOf(db, address)).toBe('REJECTED');
      });
    });

    it('une même pièce d’identité ne vérifie qu’un seul compte', async () => {
      await asApp(async (db) => {
        const digest = randomBytes(32);
        const first = await insertUser(db);
        const second = await insertUser(db);
        const firstCase = await approved(db, first, 1, { digest });
        const secondCase = await submitted(db, second, 1, { digest });

        expect(await sqlState(() => approve(db, secondCase, claire))).toBe(UNIQUE_VIOLATION);
        expect(await statusOf(db, secondCase)).toBe('SUBMITTED');

        // Même numéro, autre nature ou autre pays : une autre pièce.
        const third = await insertUser(db);
        const fourth = await insertUser(db);
        await approved(db, third, 1, {
          digest,
          columns: { document_type: 'NATIONAL_ID_CARD', document_expires_on: null },
        });
        await approved(db, fourth, 1, { digest, columns: { document_issuing_country: 'CG' } });

        // Le même compte renouvelle sa vérification avec la même pièce : l'ancien dossier est
        // remplacé avant que le nouveau ne soit écrit.
        const renewal = await submitted(db, first, 1, { digest });
        await approve(db, renewal, david);
        expect(await statusOf(db, firstCase)).toBe('SUPERSEDED');

        // La vérification retirée, la pièce peut vérifier l'autre compte.
        await revoke(db, renewal, david);
        await approve(db, secondCase, claire);
        expect(await statusOf(db, secondCase)).toBe('APPROVED');
      });
    });
  });

  describe('retrait', () => {
    it('seul un compte actif détenant kyc.revoke retire une vérification, jamais la sienne', async () => {
      const suspendedOfficer = await asOwner(async (owner) => {
        const id = await insertStaff(owner, 'compliance');
        await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [id]);
        return id;
      });
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await approved(db, user, 1);
        const stranger = await insertUser(db);

        for (const revoker of [support, stranger, suspendedOfficer]) {
          expect(await sqlState(() => revoke(db, id, revoker))).toBe(KYC_RULE_VIOLATION);
        }
        // Le titulaire ne retire pas sa propre vérification : il n'en a pas la permission…
        expect(await sqlState(() => revoke(db, id, user))).toBe(KYC_RULE_VIOLATION);
        // … et, fût-il agent de conformité, une contrainte de la table le lui interdit.
        const ownCase = await submitted(db, claire, 1);
        await approve(db, ownCase, david);
        expect(await sqlState(() => revoke(db, ownCase, claire))).toBe(CHECK_VIOLATION);
        expect(await statusOf(db, ownCase)).toBe('APPROVED');

        // Un retrait porte son auteur, sa date et son motif : sans auteur, personne n'est
        // habilité ; sans date ou sans motif, la table le refuse.
        for (const [assignment, expected] of [
          [`status = 'REVOKED'`, KYC_RULE_VIOLATION],
          [`status = 'REVOKED', ended_at = now(), revocation_reason = 'motif'`, KYC_RULE_VIOLATION],
          [`status = 'REVOKED', revoked_by = '${david}', ended_at = now()`, CHECK_VIOLATION],
          [
            `status = 'REVOKED', revoked_by = '${david}', revocation_reason = 'motif'`,
            CHECK_VIOLATION,
          ],
          [
            `status = 'REVOKED', revoked_by = '${david}', ended_at = now(), revocation_reason = '  '`,
            CHECK_VIOLATION,
          ],
        ] as const) {
          expect(
            await sqlState(() =>
              db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [id]),
            ),
          ).toBe(expected);
        }
        // Un retrait ne réécrit pas la décision d'origine.
        expect(
          await sqlState(() =>
            db.query(
              `UPDATE kyc_cases
               SET status = 'REVOKED', revoked_by = $2, ended_at = now(),
                   revocation_reason = 'motif', decided_by = $2
               WHERE id = $1`,
              [id, david],
            ),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        expect(await statusOf(db, id)).toBe('APPROVED');

        await revoke(db, id, david);
        expect(await caseRow(db, id)).toMatchObject({ status: 'REVOKED', revoked_by: david });
        // La décision d'origine reste lisible.
        expect((await caseRow(db, id)).decided_by).toBe(claire);

        // Seule une vérification en vigueur se retire.
        const pending = await submitted(db, user, 1);
        expect(await sqlState(() => revoke(db, pending, david))).toBe(KYC_RULE_VIOLATION);
      });
    });
  });

  describe('clôture du compte', () => {
    /** Ouvre une transaction où le compte vient d'être clôturé, ses dossiers restant à traiter. */
    async function closingAccount(db: pg.Client, user: string): Promise<void> {
      await db.query('BEGIN');
      await insertClosureRecord(db, user);
      await emptyAccount(db, user);
      await markAccountClosed(db, user);
    }

    /** Code de l'erreur de `action`, sans effet sur la transaction en cours. */
    async function tried(
      db: pg.Client,
      action: () => Promise<unknown>,
    ): Promise<string | undefined> {
      await db.query('SAVEPOINT tried');
      const state = await sqlState(action);
      await db.query('ROLLBACK TO SAVEPOINT tried');
      return state;
    }

    const endWithAccount = (db: pg.Client, id: string, assignments = 'ended_at = now()') =>
      db.query(
        `UPDATE kyc_cases SET status = 'ACCOUNT_CLOSED', updated_at = now(), ${assignments}
         WHERE id = $1`,
        [id],
      );

    it('une vérification en vigueur prend fin avec son compte — jamais avant, et sans rien changer d’autre', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await approved(db, user, 1);

        // Le compte est ouvert : la vérification ne peut pas « prendre fin avec lui ».
        expect(await sqlState(() => endWithAccount(db, id))).toBe(KYC_RULE_VIOLATION);

        await closingAccount(db, user);
        try {
          // Une date de fin, pas d'auteur de retrait, et rien d'autre ne change.
          expect(await tried(db, () => endWithAccount(db, id, 'ended_at = NULL'))).toBe(
            CHECK_VIOLATION,
          );
          expect(
            await tried(db, () =>
              endWithAccount(db, id, `ended_at = now(), revoked_by = '${claire}'`),
            ),
          ).toBe(CHECK_VIOLATION);
          for (const assignment of [
            `given_name = 'Paul'`,
            `decided_by = '${david}'`,
            `decision_note = 'Révisé'`,
            `submitted_at = now()`,
          ]) {
            expect({
              assignment,
              state: await tried(db, () =>
                endWithAccount(db, id, `ended_at = now(), ${assignment}`),
              ),
            }).toEqual({ assignment, state: KYC_RULE_VIOLATION });
          }
          await endWithAccount(db, id);
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        }

        expect(await caseRow(db, id)).toMatchObject({
          status: 'ACCOUNT_CLOSED',
          decided_by: claire,
          revoked_by: null,
        });
        expect((await caseRow(db, id)).ended_at).toBeInstanceOf(Date);
        // Le dossier est clos : il ne redevient pas valide, ne se retire pas, ne change plus.
        for (const assignment of [
          `status = 'APPROVED', ended_at = NULL`,
          `status = 'REVOKED', revoked_by = '${claire}', revocation_reason = 'Après coup'`,
          `ended_at = now()`,
          `given_name = 'Paul'`,
        ]) {
          expect({
            assignment,
            state: await sqlState(() =>
              db.query(`UPDATE kyc_cases SET ${assignment} WHERE id = $1`, [id]),
            ),
          }).toEqual({ assignment, state: KYC_RULE_VIOLATION });
        }
      });
    });

    it('seul un dossier accepté prend fin avec le compte : les autres gardent leur statut, ou s’effacent', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const rejected = await submitted(db, user, 1);
        await reject(db, rejected, claire);
        const revoked = await approved(db, user, 1);
        await revoke(db, revoked, david);
        const pending = await submitted(db, user, 1);
        const other = await insertUser(db);
        const draft = await completeDraft(db, other, 1);

        await closingAccount(db, user);
        try {
          for (const id of [rejected, revoked, pending]) {
            expect({ id, state: await tried(db, () => endWithAccount(db, id)) }).toEqual({
              id,
              state: KYC_RULE_VIOLATION,
            });
          }
        } finally {
          await db.query('ROLLBACK');
        }
        await closingAccount(db, other);
        try {
          expect(await tried(db, () => endWithAccount(db, draft))).toBe(KYC_RULE_VIOLATION);
        } finally {
          await db.query('ROLLBACK');
        }
      });
    });

    it('un dossier déposé mais jamais examiné ne s’efface qu’à la clôture de son compte', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const pending = await submitted(db, user, 1);
        const erase = async () => {
          await db.query('DELETE FROM kyc_documents WHERE case_id = $1', [pending]);
          await db.query('DELETE FROM kyc_cases WHERE id = $1', [pending]);
        };

        // Compte ouvert : ni ses pièces, ni lui.
        expect(
          await sqlState(() => db.query('DELETE FROM kyc_documents WHERE case_id = $1', [pending])),
        ).toBe(KYC_RULE_VIOLATION);
        expect(
          await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [pending])),
        ).toBe(KYC_RULE_VIOLATION);

        // La trace de la clôture ne suffit pas : il faut que le compte soit clôturé.
        await db.query('BEGIN');
        try {
          await insertClosureRecord(db, user);
          expect(await tried(db, erase)).toBe(KYC_RULE_VIOLATION);
          await emptyAccount(db, user);
          await markAccountClosed(db, user);
          await erase();
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        }
        expect((await db.query('SELECT 1 FROM kyc_cases WHERE id = $1', [pending])).rowCount).toBe(
          0,
        );
      });
    });

    it('un dossier examiné reste une preuve après la clôture : rien ne s’y ajoute, rien ne s’en retire avant le terme', async () => {
      const { user, cases } = await asApp(async (db) => {
        const account = await insertUser(db);
        const rejected = await submitted(db, account, 1);
        await reject(db, rejected, claire);
        const revoked = await approved(db, account, 1);
        await revoke(db, revoked, david);
        const superseded = await approved(db, account, 1);
        const current = await approved(db, account, 1);
        await closeAccountInSql(db, account);
        expect(await statusOf(db, current)).toBe('ACCOUNT_CLOSED');
        expect(await statusOf(db, superseded)).toBe('SUPERSEDED');
        return { user: account, cases: [rejected, revoked, superseded, current] };
      });

      for (const as of [asApp, asOwner]) {
        await as(async (db) => {
          for (const id of cases) {
            const documents = await db.query<{ id: string }>(
              'SELECT id FROM kyc_documents WHERE case_id = $1',
              [id],
            );
            expect(documents.rowCount).toBe(2);
            expect(
              await sqlState(() =>
                db.query('DELETE FROM kyc_documents WHERE id = $1', [documents.rows[0]!.id]),
              ),
            ).toBe(KYC_RULE_VIOLATION);
            expect(
              await sqlState(() => db.query('DELETE FROM kyc_cases WHERE id = $1', [id])),
            ).toBe(KYC_RULE_VIOLATION);
            expect(await sqlState(() => addDocument(db, id, 'IDENTITY_BACK'))).toBe(
              KYC_RULE_VIOLATION,
            );
          }
        });
      }

      // Dix ans et un jour plus tard : les pièces s'effacent, puis les dossiers.
      await asOwner((owner) => ageClosure(owner, user, '10 years 1 day'));
      await asApp(async (db) => {
        for (const id of cases) {
          await db.query('DELETE FROM kyc_documents WHERE case_id = $1', [id]);
          await db.query('DELETE FROM kyc_cases WHERE id = $1', [id]);
        }
        expect(
          (await db.query('SELECT 1 FROM kyc_cases WHERE user_id = $1', [user])).rowCount,
        ).toBe(0);
      });
    });

    it('la pièce d’identité d’un compte clôturé peut de nouveau vérifier un compte', async () => {
      await asApp(async (db) => {
        const digest = randomBytes(32);
        const first = await insertUser(db);
        await approved(db, first, 1, { digest });
        const second = await insertUser(db);
        const id = await submitted(db, second, 1, { digest });

        // Tant que le premier compte est vérifié avec cette pièce, le second ne l'est pas.
        expect(await sqlState(() => approve(db, id, claire))).toBe(UNIQUE_VIOLATION);
        await closeAccountInSql(db, first);
        await approve(db, id, claire);
        expect(await statusOf(db, id)).toBe('APPROVED');
      });
    });
  });

  describe('écritures simultanées', () => {
    /** Sessions bloquées en attente d'un verrou de ligne. */
    const waitingForRowLock = async (db: pg.Client): Promise<number> =>
      (
        await db.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_locks
           WHERE NOT granted AND locktype IN ('transactionid', 'tuple')
             AND database IS NOT DISTINCT FROM
               CASE WHEN locktype = 'tuple'
                 THEN (SELECT oid FROM pg_database WHERE datname = current_database())
               END`,
        )
      ).rows[0]!.waiting;

    const untilBlocked = async (observer: pg.Client): Promise<void> => {
      const deadline = Date.now() + 5000;
      while ((await waitingForRowLock(observer)) === 0) {
        if (Date.now() > deadline) {
          throw new Error('The second transaction never waited for the first.');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    it('une pièce ajoutée pendant un dépôt attend son issue : elle n’entre jamais dans un dossier déposé', async () => {
      const id = await asApp(async (db) => completeDraft(db, await insertUser(db), 1));

      await asApp(async (depositor) => {
        await asApp(async (uploader) => {
          await asApp(async (observer) => {
            await depositor.query('BEGIN');
            await submit(depositor, id);

            // Le dépôt n'est pas encore validé : l'ajout attend.
            const upload = sqlState(() => addDocument(uploader, id, 'IDENTITY_BACK'));
            await untilBlocked(observer);
            await depositor.query('COMMIT');

            expect(await upload).toBe(KYC_RULE_VIOLATION);
            expect(await statusOf(observer, id)).toBe('SUBMITTED');
            expect(
              (
                await observer.query(
                  'SELECT count(*)::int AS n FROM kyc_documents WHERE case_id = $1',
                  [id],
                )
              ).rows,
            ).toEqual([{ n: 2 }]);
          });
        });
      });
    });

    it('un dépôt lancé pendant le retrait d’une pièce obligatoire attend, puis est refusé', async () => {
      const [id, selfie] = await asApp(async (db) => {
        const draft = await insertCase(db, await insertUser(db), 1);
        await addDocument(db, draft, 'IDENTITY_FRONT');
        return [draft, await addDocument(db, draft, 'SELFIE')] as const;
      });

      await asApp(async (remover) => {
        await asApp(async (depositor) => {
          await asApp(async (observer) => {
            await remover.query('BEGIN');
            await remover.query('DELETE FROM kyc_documents WHERE id = $1', [selfie]);

            // Le retrait tient le dossier : le dépôt attend de savoir s'il aboutit.
            const submission = sqlState(() => submit(depositor, id));
            await untilBlocked(observer);
            await remover.query('COMMIT');

            expect(await submission).toBe(KYC_RULE_VIOLATION);
            expect(await statusOf(observer, id)).toBe('DRAFT');
          });
        });
      });
    });

    it('le même dépôt, annulé cette fois : le dossier est déposé avec toutes ses pièces', async () => {
      const [id, selfie] = await asApp(async (db) => {
        const draft = await insertCase(db, await insertUser(db), 1);
        await addDocument(db, draft, 'IDENTITY_FRONT');
        return [draft, await addDocument(db, draft, 'SELFIE')] as const;
      });

      await asApp(async (remover) => {
        await asApp(async (depositor) => {
          await asApp(async (observer) => {
            await remover.query('BEGIN');
            await remover.query('DELETE FROM kyc_documents WHERE id = $1', [selfie]);
            const submission = sqlState(() => submit(depositor, id));
            await untilBlocked(observer);
            await remover.query('ROLLBACK');

            expect(await submission).toBeUndefined();
            expect(await statusOf(observer, id)).toBe('SUBMITTED');
          });
        });
      });
    });

    it('deux décisions simultanées : la seconde attend, puis ne trouve plus rien à décider', async () => {
      const id = await asApp(async (db) => submitted(db, await insertUser(db), 1));

      await asApp(async (first) => {
        await asApp(async (second) => {
          await asApp(async (observer) => {
            await first.query('BEGIN');
            await approve(first, id, claire);

            const late = second.query(
              `UPDATE kyc_cases
               SET status = 'REJECTED', decided_by = $2, decided_at = now(), updated_at = now(),
                   rejection_reasons = '{OTHER}', decision_note = 'Décision arrivée trop tard'
               WHERE id = $1 AND status = 'SUBMITTED'`,
              [id, david],
            );
            await untilBlocked(observer);
            await first.query('COMMIT');

            // La condition est réévaluée après l'attente : plus aucune ligne ne correspond.
            expect((await late).rowCount).toBe(0);
            expect(await caseRow(observer, id)).toMatchObject({
              status: 'APPROVED',
              decided_by: claire,
            });
          });
        });
      });
    });

    it('la même pièce acceptée au même instant sur deux comptes : la seconde attend, puis échoue', async () => {
      const digest = randomBytes(32);
      const [firstCase, secondCase] = await asApp(async (db) => [
        await submitted(db, await insertUser(db), 1, { digest }),
        await submitted(db, await insertUser(db), 1, { digest }),
      ]);

      await asApp(async (first) => {
        await asApp(async (second) => {
          await asApp(async (observer) => {
            await first.query('BEGIN');
            await approve(first, firstCase, claire);
            const late = sqlState(() => approve(second, secondCase, david));
            await untilBlocked(observer);
            await first.query('COMMIT');

            expect(await late).toBe(UNIQUE_VIOLATION);
            expect(await statusOf(observer, firstCase)).toBe('APPROVED');
            expect(await statusOf(observer, secondCase)).toBe('SUBMITTED');
          });
        });
      });
    });
  });

  describe('dernier rempart : les index d’unicité', () => {
    it('même déclencheur neutralisé, jamais deux dossiers ouverts ni deux dossiers acceptés pour un niveau', async () => {
      await asOwner(async (owner) => {
        const user = await insertUser(owner);
        const first = await approved(owner, user, 1);
        const second = await submitted(owner, user, 1);

        // Le déclencheur n'est neutralisé que dans cette transaction, annulée à la fin : les
        // autres tests ne le voient jamais absent.
        await owner.query('BEGIN');
        try {
          await owner.query('ALTER TABLE kyc_cases DISABLE TRIGGER kyc_cases_enforce');
          const attempt = async (action: () => Promise<unknown>): Promise<string | undefined> => {
            await owner.query('SAVEPOINT attempt');
            const state = await sqlState(action);
            await owner.query('ROLLBACK TO SAVEPOINT attempt');
            return state;
          };

          // Plus rien ne remplace le dossier accepté en vigueur : l'index refuse le second.
          expect(await attempt(() => approve(owner, second, claire))).toBe(UNIQUE_VIOLATION);
          // Un second dossier ouvert pour le même niveau, quel que soit son statut.
          expect(await attempt(() => insertCase(owner, user, 1))).toBe(UNIQUE_VIOLATION);
          expect(
            await attempt(() =>
              owner.query(
                `UPDATE kyc_cases SET status = 'SUBMITTED', decided_by = NULL, decided_at = NULL
                 WHERE id = $1`,
                [first],
              ),
            ),
          ).toBe(UNIQUE_VIOLATION);
          // Le déclencheur était bien neutralisé : ce qu'il interdit passe, dans cette transaction.
          expect(
            await attempt(() =>
              owner.query(`UPDATE kyc_cases SET given_name = 'Paul' WHERE id = $1`, [first]),
            ),
          ).toBeUndefined();
        } finally {
          await owner.query('ROLLBACK');
        }

        // Transaction annulée : le déclencheur est de nouveau en place, rien n'a changé.
        expect(
          await sqlState(() =>
            owner.query(`UPDATE kyc_cases SET given_name = 'Paul' WHERE id = $1`, [first]),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        expect(await statusOf(owner, first)).toBe('APPROVED');
        expect(await statusOf(owner, second)).toBe('SUBMITTED');
      });
    });
  });

  describe('robustesse des fonctions', () => {
    it('les règles lisent les tables de l’application, pas des copies placées sur le chemin de recherche', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const intruder = await insertUser(db);
        const id = await submitted(db, user, 1);

        // L'intrus se fabrique, dans son schéma temporaire, des copies des tables consultées —
        // où il figure parmi les agents de conformité.
        await db.query(`CREATE TEMP TABLE users AS SELECT * FROM public.users`);
        await db.query(
          `CREATE TEMP TABLE user_roles AS
           SELECT user_id, role_id, granted_by, granted_at FROM public.user_roles
           UNION ALL
           SELECT $1::uuid, id, NULL::uuid, now() FROM public.roles WHERE key = 'compliance'`,
          [intruder],
        );
        await db.query(
          `CREATE TEMP TABLE role_permissions AS SELECT * FROM public.role_permissions`,
        );
        await db.query(`SET search_path = pg_temp, public`);
        const forged = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           WHERE u.id = $1 AND rp.permission_key = 'kyc.review'`,
          [intruder],
        );
        expect(forged.rows).toEqual([{ n: 1 }]);

        expect(
          await sqlState(() =>
            db.query(
              `UPDATE public.kyc_cases
               SET status = 'APPROVED', decided_by = $2, decided_at = now(), updated_at = now()
               WHERE id = $1`,
              [id, intruder],
            ),
          ),
        ).toBe(KYC_RULE_VIOLATION);
        await db.query(`RESET search_path`);
        expect(await statusOf(db, id)).toBe('SUBMITTED');
      });
    });
  });
});
