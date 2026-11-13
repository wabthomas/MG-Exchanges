import { permissionKeySchema } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client.js';
import { isUniqueViolation, sqlStateOf } from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type NewRoleChange,
  PendingRoleChangeExistsError,
  type RoleChangeDecision,
  type RoleChangePage,
  type RoleChangeRecord,
  RoleChangeRepository,
  RoleChangeRuleViolationError,
  type RoleRecord,
} from '../application/role-change.repository.js';

/** SQLSTATE levé par le déclencheur `role_change_requests_enforce` (voir la migration). */
const ROLE_CHANGE_RULE_VIOLATION = 'MGX02';
/** Violation d'une contrainte CHECK — la règle de la double validation en compte plusieurs. */
const CHECK_VIOLATION = '23514';

const ACCOUNT_REFERENCE = { select: { id: true, email: true } } as const;

const ROLE_CHANGE_FIELDS = {
  id: true,
  action: true,
  reason: true,
  status: true,
  requestedAt: true,
  expiresAt: true,
  decidedAt: true,
  decisionNote: true,
  user: ACCOUNT_REFERENCE,
  role: { select: { key: true, name: true } },
  requester: ACCOUNT_REFERENCE,
  decider: ACCOUNT_REFERENCE,
} as const satisfies Prisma.RoleChangeRequestSelect;

type RoleChangeRow = Prisma.RoleChangeRequestGetPayload<{ select: typeof ROLE_CHANGE_FIELDS }>;

function toRecord({ requester, decider, ...row }: RoleChangeRow): RoleChangeRecord {
  return { ...row, requestedBy: requester, decidedBy: decider };
}

@Injectable()
export class PrismaRoleChangeRepository extends RoleChangeRepository {
  async listRoles(db: DbClient): Promise<RoleRecord[]> {
    const roles = await db.role.findMany({
      orderBy: { key: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        isSystem: true,
        permissions: { select: { permissionKey: true }, orderBy: { permissionKey: 'asc' } },
        _count: { select: { users: true } },
      },
    });
    return roles.map(({ permissions, _count, ...role }) => ({
      ...role,
      // Une clé inconnue du code (catalogue en avance sur le déploiement) n'ouvre aucun droit.
      permissions: permissions.flatMap(({ permissionKey }) => {
        const parsed = permissionKeySchema.safeParse(permissionKey);
        return parsed.success ? [parsed.data] : [];
      }),
      holders: _count.users,
    }));
  }

  findRoleByKey(db: DbClient, key: string): Promise<{ id: string; key: string } | null> {
    return db.role.findUnique({ where: { key }, select: { id: true, key: true } });
  }

  async holdsRole(db: DbClient, userId: string, roleId: string): Promise<boolean> {
    return (await db.userRole.count({ where: { userId, roleId } })) === 1;
  }

  async create(tx: DbClient, request: NewRoleChange): Promise<string> {
    try {
      const created = await tx.roleChangeRequest.create({ data: request, select: { id: true } });
      return created.id;
    } catch (error) {
      // Index unique partiel `role_change_requests_pending_key`.
      if (isUniqueViolation(error)) {
        throw new PendingRoleChangeExistsError();
      }
      throw error;
    }
  }

  async find(db: DbClient, id: string): Promise<RoleChangeRecord | null> {
    const row = await db.roleChangeRequest.findUnique({
      where: { id },
      select: ROLE_CHANGE_FIELDS,
    });
    return row === null ? null : toRecord(row);
  }

  async list(db: DbClient, page: RoleChangePage): Promise<RoleChangeRecord[]> {
    const rows = await db.roleChangeRequest.findMany({
      where: {
        ...(page.status === undefined ? {} : { status: page.status }),
        ...(page.before === undefined ? {} : { id: { lt: page.before } }),
      },
      orderBy: { id: 'desc' },
      take: page.limit,
      select: ROLE_CHANGE_FIELDS,
    });
    return rows.map(toRecord);
  }

  async decide(tx: DbClient, id: string, decision: RoleChangeDecision): Promise<boolean> {
    try {
      // La condition et l'écriture sont une seule instruction : de deux décisions simultanées,
      // une seule s'applique. Le déclencheur de la table applique le changement de rôle.
      const { count } = await tx.roleChangeRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: decision.status,
          decidedBy: decision.decidedBy,
          decidedAt: decision.decidedAt,
          decisionNote: decision.note,
        },
      });
      return count === 1;
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState === ROLE_CHANGE_RULE_VIOLATION || sqlState === CHECK_VIOLATION) {
        throw new RoleChangeRuleViolationError({ cause: error });
      }
      throw error;
    }
  }

  async expireOverdue(db: DbClient, now: Date): Promise<number> {
    const { count } = await db.roleChangeRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', decidedAt: now },
    });
    return count;
  }
}
