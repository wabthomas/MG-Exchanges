import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ROLE_MANAGEMENT_PERMISSION, SYSTEM_ROLES } from '@mgx/contracts';
import type pg from 'pg';

import { closeAccountInSql } from '../support/account-closure.js';
import {
  createTestDatabase,
  sqlState,
  type TestDatabase,
  withConnection,
} from '../support/test-database.js';
import { TEST_APP_ROLE, TEST_OWNER_ROLE } from '../support/test-environment.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
/** Modification interdite d'une table en ajout seul (voir la migration init_foundations). */
const APPEND_ONLY_VIOLATION = 'MGX01';
/** Règle de la double validation enfreinte (déclencheur de `role_change_requests`). */
const ROLE_CHANGE_RULE_VIOLATION = 'MGX02';

interface RequestRow {
  user: string;
  role?: string;
  action?: 'GRANT' | 'REVOKE';
  requestedBy: string;
  reason?: string;
  requestedAt?: string;
  expiresAt?: string;
}

describe('Back-office — double validation des rôles portée par la base de données', () => {
  let database: TestDatabase;
  /** Deux administrateurs actifs (rôle super_admin) et un agent du support, créés une fois. */
  let alice: string;
  let bruno: string;
  let agent: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asOwner(async (db) => {
      alice = await insertStaff(db, 'super_admin');
      bruno = await insertStaff(db, 'super_admin');
      agent = await insertStaff(db, 'support');
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  const asApp = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.appUrl, work);
  const asOwner = <T>(work: (client: pg.Client) => Promise<T>): Promise<T> =>
    withConnection(database.ownerUrl, work);

  let sequence = 0;
  /** Compte actif (adresse vérifiée), sauf mention contraire. */
  async function insertUser(db: pg.Client, status = 'ACTIVE'): Promise<string> {
    sequence += 1;
    // Un compte ne naît pas clôturé : il est créé actif, puis clôturé.
    const created = status === 'CLOSED' ? 'ACTIVE' : status;
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, country_code, terms_accepted_at, status, email_verified_at)
       VALUES ($1, 'CD', now(), $2::user_status, CASE WHEN $2 = 'PENDING_VERIFICATION' THEN NULL ELSE now() END)
       RETURNING id`,
      [`backoffice${String(sequence)}@example.cd`, created],
    );
    const { id } = result.rows[0]!;
    if (status === 'CLOSED') {
      await closeAccountInSql(db, id);
    }
    return id;
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

  async function insertRequest(db: pg.Client, row: RequestRow): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO role_change_requests
         (user_id, role_id, action, reason, requested_by, requested_at, expires_at)
       SELECT $1, r.id, $3::role_change_action, $4, $5,
              COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now() + interval '72 hours')
       FROM roles r WHERE r.key = $2
       RETURNING id`,
      [
        row.user,
        row.role ?? 'support',
        row.action ?? 'GRANT',
        row.reason ?? 'Arrivée dans l’équipe du support',
        row.requestedBy,
        row.requestedAt ?? null,
        row.expiresAt ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Unknown role.');
    }
    return id;
  }

  const decide = (
    db: pg.Client,
    id: string,
    status: string,
    decidedBy: string | null,
    extra = '',
  ) =>
    db.query(
      `UPDATE role_change_requests
       SET status = $2::role_change_status, decided_by = $3, decided_at = now()${extra}
       WHERE id = $1`,
      [id, status, decidedBy],
    );

  const rolesOf = async (db: pg.Client, userId: string): Promise<string[]> =>
    (
      await db.query<{ key: string }>(
        `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 ORDER BY 1`,
        [userId],
      )
    ).rows.map((row) => row.key);

  const statusOf = async (db: pg.Client, id: string): Promise<string> =>
    (
      await db.query<{ status: string }>('SELECT status FROM role_change_requests WHERE id = $1', [
        id,
      ])
    ).rows[0]!.status;

  describe('catalogue', () => {
    it('chaque rôle système détient exactement les permissions que le code lui attribue', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ key: string; permissions: string[] }>(
          `SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS permissions
           FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
           GROUP BY r.key ORDER BY r.key`,
        );
        expect(Object.fromEntries(rows.map((row) => [row.key, row.permissions]))).toEqual(
          Object.fromEntries(
            Object.entries(SYSTEM_ROLES).map(([key, permissions]) => [
              key,
              [...permissions].sort(),
            ]),
          ),
        );
        // Le support ne gère pas les rôles et ne retire pas un second facteur.
        expect(SYSTEM_ROLES.support).not.toContain(ROLE_MANAGEMENT_PERMISSION);
        expect(SYSTEM_ROLES.support).not.toContain('users.reset_mfa');
      });
    });
  });

  describe('création d’une demande', () => {
    it.each([
      ['une justification vide', { reason: '   ' }],
      ['une échéance antérieure à la demande', { expiresAt: '2000-01-01T00:00:00Z' }],
    ])('refuse %s', async (_label, overrides) => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        expect(
          await sqlState(() => insertRequest(db, { user, requestedBy: alice, ...overrides })),
        ).toBe(CHECK_VIOLATION);
      });
    });

    it('nul ne demande un changement de ses propres rôles', async () => {
      await asApp(async (db) => {
        expect(await sqlState(() => insertRequest(db, { user: alice, requestedBy: alice }))).toBe(
          CHECK_VIOLATION,
        );
      });
    });

    it('une demande naît en attente : elle ne s’insère pas déjà approuvée', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const forged = () =>
          db.query(
            `INSERT INTO role_change_requests
               (user_id, role_id, action, reason, requested_by, expires_at, status, decided_by, decided_at)
             SELECT $1, id, 'GRANT', 'Demande forgée de toutes pièces', $2, now() + interval '1 day',
                    'APPROVED', $3, now()
             FROM roles WHERE key = 'super_admin'`,
            [user, alice, bruno],
          );
        expect(await sqlState(forged)).toBe(ROLE_CHANGE_RULE_VIOLATION);
        expect(await rolesOf(db, user)).toEqual([]);
      });
    });

    it('une seule demande en attente par compte et par rôle ; une demande close libère la place', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const first = await insertRequest(db, { user, requestedBy: alice });
        expect(await sqlState(() => insertRequest(db, { user, requestedBy: bruno }))).toBe(
          UNIQUE_VIOLATION,
        );
        // Un autre rôle, ou un autre compte, n'est pas un doublon.
        await insertRequest(db, { user, role: 'super_admin', requestedBy: bruno });
        await insertRequest(db, { user: await insertUser(db), requestedBy: alice });

        await decide(db, first, 'REJECTED', bruno);
        await insertRequest(db, { user, requestedBy: bruno });
      });
    });
  });

  describe('décision', () => {
    it('l’approbation par un second administrateur attribue le rôle — et elle seule', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertRequest(db, { user, requestedBy: alice });
        expect(await rolesOf(db, user)).toEqual([]);

        await decide(db, id, 'APPROVED', bruno);

        expect(await statusOf(db, id)).toBe('APPROVED');
        expect(await rolesOf(db, user)).toEqual(['support']);
        const grant = await db.query<{ granted_by: string }>(
          'SELECT granted_by FROM user_roles WHERE user_id = $1',
          [user],
        );
        // L'attribution retient l'auteur de la demande ; l'approbateur est dans la demande.
        expect(grant.rows[0]?.granted_by).toBe(alice);
      });
    });

    it('l’approbation d’un retrait retire le rôle, y compris à un compte suspendu', async () => {
      const [active, suspended] = await asOwner(async (db) => {
        const first = await insertStaff(db, 'support');
        const second = await insertStaff(db, 'support');
        await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [second]);
        return [first, second];
      });
      await asApp(async (db) => {
        for (const user of [active, suspended]) {
          const id = await insertRequest(db, { user, action: 'REVOKE', requestedBy: alice });
          await decide(db, id, 'APPROVED', bruno);
          expect(await rolesOf(db, user)).toEqual([]);
        }
      });
    });

    it('refus et retrait ne changent aucun rôle', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const rejected = await insertRequest(db, { user, requestedBy: alice });
        await decide(db, rejected, 'REJECTED', bruno, `, decision_note = 'Formation non terminée'`);
        const cancelled = await insertRequest(db, { user, requestedBy: alice });
        await decide(db, cancelled, 'CANCELLED', alice);

        expect(await rolesOf(db, user)).toEqual([]);
        expect([await statusOf(db, rejected), await statusOf(db, cancelled)]).toEqual([
          'REJECTED',
          'CANCELLED',
        ]);
      });
    });

    it('double validation : ni l’auteur de la demande ni l’intéressé ne l’approuvent ou ne la refusent', async () => {
      // L'intéressé est lui-même administrateur : seule la règle « pas ses propres rôles » l'arrête.
      const target = await asOwner((db) => insertStaff(db, 'super_admin'));
      await asApp(async (db) => {
        const id = await insertRequest(db, { user: target, requestedBy: alice });
        for (const status of ['APPROVED', 'REJECTED']) {
          expect(await sqlState(() => decide(db, id, status, alice))).toBe(CHECK_VIOLATION);
          expect(await sqlState(() => decide(db, id, status, target))).toBe(CHECK_VIOLATION);
        }
        // L'attribution tentée par le déclencheur a été annulée avec l'instruction.
        expect(await rolesOf(db, target)).toEqual(['super_admin']);
        expect(await statusOf(db, id)).toBe('PENDING');

        // Seul l'auteur retire sa demande.
        expect(await sqlState(() => decide(db, id, 'CANCELLED', bruno))).toBe(CHECK_VIOLATION);
        await decide(db, id, 'CANCELLED', alice);
      });
    });

    it('une décision est complète : datée, attribuée à son auteur — sauf l’échéance, qui n’a pas d’auteur', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertRequest(db, { user, requestedBy: alice });
        const set = (assignments: string, parameters: unknown[] = []) =>
          db.query(`UPDATE role_change_requests SET ${assignments} WHERE id = $1`, [
            id,
            ...parameters,
          ]);

        expect(await sqlState(() => set(`status = 'REJECTED', decided_at = now()`))).toBe(
          CHECK_VIOLATION,
        );
        expect(await sqlState(() => set(`status = 'REJECTED', decided_by = $2`, [bruno]))).toBe(
          CHECK_VIOLATION,
        );
        expect(
          await sqlState(() =>
            set(`status = 'EXPIRED', decided_at = now(), decided_by = $2`, [bruno]),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(await sqlState(() => set(`status = 'EXPIRED'`))).toBe(CHECK_VIOLATION);
        // Une demande en attente ne reçoit ni note ni date de décision.
        expect(await sqlState(() => set(`decision_note = 'Note prématurée'`))).toBe(
          ROLE_CHANGE_RULE_VIOLATION,
        );

        await set(`status = 'EXPIRED', decided_at = now()`);
        expect(await statusOf(db, id)).toBe('EXPIRED');
      });
    });

    it.each([
      ['un compte sans rôle', async (db: pg.Client) => insertUser(db)],
      ['un agent du support, qui ne gère pas les rôles', () => Promise.resolve(agent)],
      [
        'un administrateur suspendu',
        async () =>
          asOwner(async (owner) => {
            const id = await insertStaff(owner, 'super_admin');
            await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [id]);
            return id;
          }),
      ],
    ])('l’approbation est refusée à %s', async (_label, approver) => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertRequest(db, { user, role: 'super_admin', requestedBy: alice });
        const decidedBy = await approver(db);

        expect(await sqlState(() => decide(db, id, 'APPROVED', decidedBy))).toBe(
          ROLE_CHANGE_RULE_VIOLATION,
        );
        expect(await sqlState(() => decide(db, id, 'APPROVED', null))).toBe(
          ROLE_CHANGE_RULE_VIOLATION,
        );
        expect(await rolesOf(db, user)).toEqual([]);
        expect(await statusOf(db, id)).toBe('PENDING');
      });
    });

    it('l’approbation est refusée si l’auteur de la demande a, depuis, perdu sa qualité', async () => {
      const [demoted, suspended] = await asOwner(async (db) => [
        await insertStaff(db, 'super_admin'),
        await insertStaff(db, 'super_admin'),
      ]);
      const [fromDemoted, fromSuspended, user] = await asApp(async (db) => {
        const target = await insertUser(db);
        return [
          await insertRequest(db, { user: target, requestedBy: demoted }),
          await insertRequest(db, { user: target, role: 'super_admin', requestedBy: suspended }),
          target,
        ];
      });
      await asOwner(async (db) => {
        await db.query('DELETE FROM user_roles WHERE user_id = $1', [demoted]);
        await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);
      });

      await asApp(async (db) => {
        for (const id of [fromDemoted, fromSuspended]) {
          expect(await sqlState(() => decide(db, id, 'APPROVED', bruno))).toBe(
            ROLE_CHANGE_RULE_VIOLATION,
          );
        }
        expect(await rolesOf(db, user)).toEqual([]);
        // Une telle demande se refuse toujours.
        await decide(db, fromDemoted, 'REJECTED', bruno);
      });
    });

    it('une demande échue ne s’approuve plus, même si personne ne l’a encore close', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        const id = await insertRequest(db, {
          user,
          requestedBy: alice,
          requestedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });

        expect(await sqlState(() => decide(db, id, 'APPROVED', bruno))).toBe(
          ROLE_CHANGE_RULE_VIOLATION,
        );
        expect(await rolesOf(db, user)).toEqual([]);
        await db.query(
          `UPDATE role_change_requests SET status = 'EXPIRED', decided_at = now() WHERE id = $1`,
          [id],
        );
      });
    });

    it('un rôle ne s’attribue qu’à un compte actif', async () => {
      await asApp(async (db) => {
        for (const status of ['PENDING_VERIFICATION', 'SUSPENDED', 'CLOSED']) {
          const user = await insertUser(db, status);
          const id = await insertRequest(db, { user, requestedBy: alice });
          expect({
            status,
            state: await sqlState(() => decide(db, id, 'APPROVED', bruno)),
          }).toEqual({
            status,
            state: ROLE_CHANGE_RULE_VIOLATION,
          });
          expect(await rolesOf(db, user)).toEqual([]);
        }
      });
    });

    it('approuver l’attribution d’un rôle déjà détenu ne crée pas de doublon', async () => {
      const holder = await asOwner((db) => insertStaff(db, 'support'));
      await asApp(async (db) => {
        const id = await insertRequest(db, { user: holder, requestedBy: alice });
        await decide(db, id, 'APPROVED', bruno);
        expect(await rolesOf(db, holder)).toEqual(['support']);
      });
    });
  });

  describe('décisions simultanées', () => {
    /** Nombre de sessions qui attendent leur tour pour appliquer une approbation. */
    const queuedApprovals = async (db: pg.Client): Promise<number> =>
      (
        await db.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        )
      ).rows[0]!.waiting;

    it('deux approbations qui se retirent mutuellement un acteur ne passent pas ensemble : elles s’appliquent une à une', async () => {
      // Trois administrateurs. La première demande retire son rôle à `first` (demandée par
      // `second`, approuvée par `third`) ; la seconde le retire à `third` (demandée par `first`,
      // approuvée par `second`). Chacune prive l'autre d'un acteur : quel que soit l'ordre, une
      // seule est légitime. Vérifiées sur le même état de départ, elles passeraient toutes deux.
      const [first, second, third] = await asOwner(async (db) => [
        await insertStaff(db, 'super_admin'),
        await insertStaff(db, 'super_admin'),
        await insertStaff(db, 'super_admin'),
      ]);
      const [earlierRequest, laterRequest] = await asApp(async (db) => [
        await insertRequest(db, {
          user: first,
          role: 'super_admin',
          action: 'REVOKE',
          requestedBy: second,
        }),
        await insertRequest(db, {
          user: third,
          role: 'super_admin',
          action: 'REVOKE',
          requestedBy: first,
        }),
      ]);

      await asApp((earlier) =>
        asApp(async (later) => {
          await earlier.query('BEGIN');
          await decide(earlier, earlierRequest, 'APPROVED', third);

          // La première n'est pas encore validée ; la seconde arrive.
          await later.query('BEGIN');
          let settled: string | undefined;
          const outcome = sqlState(() => decide(later, laterRequest, 'APPROVED', second)).then(
            (code) => {
              settled = code ?? 'APPLIED';
              return settled;
            },
          );
          let waiting = 0;
          for (
            let attempt = 0;
            attempt < 150 && settled === undefined && waiting === 0;
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            waiting = await asOwner(queuedApprovals);
          }
          // Elle attend la première au lieu de se prononcer sur un état qui va changer.
          expect({ settled, waiting }).toEqual({ settled: undefined, waiting: 1 });

          await earlier.query('COMMIT');
          // À son tour, elle constate que l'auteur de sa demande n'est plus administrateur.
          expect(await outcome).toBe(ROLE_CHANGE_RULE_VIOLATION);
          await later.query('ROLLBACK');
        }),
      );

      await asApp(async (db) => {
        expect(await rolesOf(db, first)).toEqual([]);
        expect(await rolesOf(db, third)).toEqual(['super_admin']);
        expect(await statusOf(db, earlierRequest)).toBe('APPROVED');
        expect(await statusOf(db, laterRequest)).toBe('PENDING');
      });
    });

    it('huit approbations simultanées d’une même demande : une seule s’applique', async () => {
      const user = await asApp((db) => insertUser(db));
      const id = await asApp((db) => insertRequest(db, { user, requestedBy: alice }));

      const applied = await Promise.all(
        Array.from({ length: 8 }, () =>
          asApp(async (db) => {
            const result = await db.query(
              `UPDATE role_change_requests
               SET status = 'APPROVED', decided_by = $2, decided_at = now()
               WHERE id = $1 AND status = 'PENDING'`,
              [id, bruno],
            );
            return result.rowCount;
          }),
        ),
      );

      expect(applied.sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
      await asApp(async (db) => {
        expect(await statusOf(db, id)).toBe('APPROVED');
        const grants = await db.query('SELECT 1 FROM user_roles WHERE user_id = $1', [user]);
        expect(grants.rowCount).toBe(1);
      });
    });

    it('une approbation et un refus simultanés : la décision est unique, et le rôle la suit', async () => {
      for (let round = 0; round < 6; round++) {
        const user = await asApp((db) => insertUser(db));
        const id = await asApp((db) => insertRequest(db, { user, requestedBy: alice }));
        const conclude = (status: 'APPROVED' | 'REJECTED') =>
          asApp(async (db) => {
            const result = await db.query(
              `UPDATE role_change_requests
               SET status = $2::role_change_status, decided_by = $3, decided_at = now(),
                   decision_note = 'Décision prise en séance'
               WHERE id = $1 AND status = 'PENDING'`,
              [id, status, bruno],
            );
            return result.rowCount === 1 ? status : null;
          });

        const outcomes = await Promise.all(
          round % 2 === 0
            ? [conclude('APPROVED'), conclude('REJECTED')]
            : [conclude('REJECTED'), conclude('APPROVED')],
        );

        const decisions = outcomes.filter((outcome) => outcome !== null);
        expect(decisions).toHaveLength(1);
        await asApp(async (db) => {
          expect(await statusOf(db, id)).toBe(decisions[0]);
          expect(await rolesOf(db, user)).toEqual(decisions[0] === 'APPROVED' ? ['support'] : []);
        });
      }
    });
  });

  describe('intangibilité', () => {
    it('les termes d’une demande ne changent pas, même au moment de la décision', async () => {
      await asApp(async (db) => {
        const [user, other] = [await insertUser(db), await insertUser(db)];
        const id = await insertRequest(db, { user, requestedBy: alice });
        const approveWith = (assignment: string, parameter: unknown) =>
          db.query(
            `UPDATE role_change_requests
             SET status = 'APPROVED', decided_by = $2, decided_at = now(), ${assignment}
             WHERE id = $1`,
            [id, bruno, parameter],
          );

        // Approuver « support » en le transformant en « super_admin », ou pour un autre compte…
        const escalations: readonly (readonly [string, unknown])[] = [
          [`role_id = (SELECT id FROM roles WHERE key = $3)`, 'super_admin'],
          ['user_id = $3', other],
          [`action = $3::role_change_action`, 'REVOKE'],
          ['reason = $3', 'Justification réécrite après coup'],
          ['requested_by = $3', agent],
          ['requested_at = $3::timestamptz', '2020-01-01T00:00:00Z'],
          ['expires_at = $3::timestamptz', '2099-01-01T00:00:00Z'],
        ];
        for (const [assignment, parameter] of escalations) {
          expect({
            assignment,
            state: await sqlState(() => approveWith(assignment, parameter)),
          }).toEqual({ assignment, state: ROLE_CHANGE_RULE_VIOLATION });
        }
        expect(await rolesOf(db, user)).toEqual([]);
        expect(await rolesOf(db, other)).toEqual([]);
        // …ni en dehors de toute décision : une échéance ne se repousse pas.
        expect(
          await sqlState(() =>
            db.query(
              `UPDATE role_change_requests SET expires_at = now() + interval '10 years' WHERE id = $1`,
              [id],
            ),
          ),
        ).toBe(ROLE_CHANGE_RULE_VIOLATION);
      });
    });

    it('une demande décidée ne se rouvre pas, ne se redécide pas et ne s’efface pas', async () => {
      const ids = await asApp(async (db) => {
        const user = await insertUser(db);
        const approved = await insertRequest(db, { user, requestedBy: alice });
        await decide(db, approved, 'APPROVED', bruno);
        const rejected = await insertRequest(db, { user, role: 'super_admin', requestedBy: alice });
        await decide(db, rejected, 'REJECTED', bruno);

        for (const id of [approved, rejected]) {
          for (const statement of [
            () => decide(db, id, 'PENDING', null),
            () => decide(db, id, 'APPROVED', bruno),
            () => decide(db, id, 'CANCELLED', alice),
            () =>
              db.query(`UPDATE role_change_requests SET decision_note = 'Réécrit' WHERE id = $1`, [
                id,
              ]),
          ]) {
            expect(await sqlState(statement)).toBe(ROLE_CHANGE_RULE_VIOLATION);
          }
          // Le rôle applicatif n'a pas le droit de supprimer une demande.
          expect(
            await sqlState(() => db.query('DELETE FROM role_change_requests WHERE id = $1', [id])),
          ).toBe(INSUFFICIENT_PRIVILEGE);
        }
        expect(await sqlState(() => db.query('TRUNCATE role_change_requests'))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await rolesOf(db, user)).toEqual(['support']);
        return [approved, rejected];
      });

      // Même le propriétaire de la table bute sur le déclencheur.
      await asOwner(async (db) => {
        expect(
          await sqlState(() =>
            db.query('DELETE FROM role_change_requests WHERE id = ANY($1)', [ids]),
          ),
        ).toBe(APPEND_ONLY_VIOLATION);
        expect(await sqlState(() => db.query('TRUNCATE role_change_requests'))).toBe(
          APPEND_ONLY_VIOLATION,
        );
      });
    });
  });

  describe('droits du rôle applicatif', () => {
    it('l’API n’écrit jamais directement une attribution : l’approbation est le seul chemin', async () => {
      await asApp(async (db) => {
        const user = await insertUser(db);
        for (const statement of [
          () =>
            db.query(
              `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'super_admin'`,
              [user],
            ),
          () => db.query('DELETE FROM user_roles WHERE user_id = $1', [alice]),
          () => db.query('UPDATE user_roles SET user_id = $1 WHERE user_id = $2', [user, alice]),
          () =>
            db.query(`INSERT INTO role_permissions (role_id, permission_key)
                          SELECT id, 'roles.manage' FROM roles WHERE key = 'support'`),
          () =>
            db.query(
              'ALTER TABLE role_change_requests DISABLE TRIGGER role_change_requests_enforce',
            ),
          () => db.query('DROP TRIGGER role_change_requests_enforce ON role_change_requests'),
          () =>
            db.query(`CREATE OR REPLACE FUNCTION mgx_enforce_role_change() RETURNS trigger
                      LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`),
          () => db.query('ALTER FUNCTION mgx_enforce_role_change() SECURITY INVOKER'),
        ]) {
          expect(await sqlState(statement)).toBe(INSUFFICIENT_PRIVILEGE);
        }
        expect(await rolesOf(db, user)).toEqual([]);
        expect(await rolesOf(db, alice)).toEqual(['super_admin']);
      });
    });

    it('la fonction qui applique les changements s’exécute avec les droits du propriétaire, sur un chemin de recherche figé', async () => {
      await asOwner(async (db) => {
        const { rows } = await db.query<{
          security_definer: boolean;
          owner: string;
          settings: string[] | null;
          public_execute: boolean;
          app_execute: boolean;
        }>(
          `SELECT p.prosecdef AS security_definer,
                  pg_get_userbyid(p.proowner) AS owner,
                  p.proconfig AS settings,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                  has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute
           FROM pg_proc p WHERE p.proname = 'mgx_enforce_role_change'`,
          [TEST_APP_ROLE],
        );
        expect(rows).toEqual([
          {
            security_definer: true,
            owner: TEST_OWNER_ROLE,
            settings: ['search_path=public, pg_temp'],
            public_execute: false,
            app_execute: false,
          },
        ]);

        const triggers = await db.query<{ tgname: string; enabled: string }>(
          `SELECT tgname, tgenabled AS enabled FROM pg_trigger
           WHERE tgrelid = 'role_change_requests'::regclass AND NOT tgisinternal ORDER BY 1`,
        );
        expect(triggers.rows).toEqual([
          { tgname: 'role_change_requests_enforce', enabled: 'O' },
          { tgname: 'role_change_requests_no_delete', enabled: 'O' },
          { tgname: 'role_change_requests_no_truncate', enabled: 'O' },
        ]);
      });
    });

    it('des tables temporaires homonymes ne trompent pas la fonction', async () => {
      await asApp(async (db) => {
        const [intruder, user] = [await insertUser(db), await insertUser(db)];
        const id = await insertRequest(db, { user, role: 'super_admin', requestedBy: alice });

        // L'intrus se fabrique, dans son schéma temporaire, des copies des tables consultées par
        // la fonction — où il figure, lui aussi, parmi les administrateurs. Si la fonction les
        // lisait, tout serait en règle : auteur et approbateur y détiennent `roles.manage`.
        await db.query(`CREATE TEMP TABLE users AS SELECT * FROM public.users`);
        await db.query(
          `CREATE TEMP TABLE user_roles AS
           SELECT user_id, role_id, granted_by, granted_at FROM public.user_roles
           UNION ALL
           SELECT $1::uuid, id, NULL::uuid, now() FROM public.roles WHERE key = 'super_admin'`,
          [intruder],
        );
        await db.query(
          `CREATE TEMP TABLE role_permissions AS SELECT * FROM public.role_permissions`,
        );
        const forged = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           WHERE u.id = ANY($1) AND u.status = 'ACTIVE' AND rp.permission_key = 'roles.manage'`,
          [[intruder, alice]],
        );
        // Vue de la session de l'intrus, la règle est satisfaite pour les deux intervenants.
        expect(forged.rows[0]).toEqual({ n: 2 });

        expect(await sqlState(() => decide(db, id, 'APPROVED', intruder))).toBe(
          ROLE_CHANGE_RULE_VIOLATION,
        );
        expect(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM public.user_roles WHERE user_id = ANY($1)',
              [[intruder, user]],
            )
          ).rows[0],
        ).toEqual({ n: 0 });

        // Une approbation légitime écrit bien dans la vraie table, pas dans la table temporaire.
        await decide(db, id, 'APPROVED', bruno);
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM public.user_roles WHERE user_id = $1', [
              user,
            ])
          ).rows[0],
        ).toEqual({ n: 1 });
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM pg_temp.user_roles WHERE user_id = $1', [
              user,
            ])
          ).rows[0],
        ).toEqual({ n: 0 });
      });
    });

    it('les index de la purge et de l’unicité des demandes en attente existent', async () => {
      await asApp(async (db) => {
        const { rows } = await db.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname IN ('role_change_requests_pending_key', 'users_pending_registration_idx',
                               'user_sessions_idle_expires_at_idx', 'verification_challenges_expires_at_idx',
                               'users_phone_idx')
           ORDER BY 1`,
        );
        expect(rows.map((row) => row.indexname)).toEqual([
          'role_change_requests_pending_key',
          'user_sessions_idle_expires_at_idx',
          'users_pending_registration_idx',
          'users_phone_idx',
          'verification_challenges_expires_at_idx',
        ]);
        const definitions = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
        expect(definitions['role_change_requests_pending_key']).toMatch(
          /UNIQUE INDEX .* \(user_id, role_id\) WHERE \(status = 'PENDING'::role_change_status\)/,
        );
        expect(definitions['users_pending_registration_idx']).toMatch(
          /\(terms_accepted_at\) WHERE \(status = 'PENDING_VERIFICATION'::user_status\)/,
        );
      });
    });
  });
});
