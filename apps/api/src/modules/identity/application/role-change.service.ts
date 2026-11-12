import {
  type ApproveRoleChangeRequest,
  type CreateRoleChangeRequest,
  type RejectRoleChangeRequest,
  ROLE_CHANGE_TTL_HOURS,
  type RoleChange,
  type RoleChangeList,
  type RoleChangeListQuery,
  type RoleList,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { StaffActor } from './admin-users.service.js';
import {
  PendingRoleChangeExistsError,
  type RoleChangeRecord,
  RoleChangeRepository,
  RoleChangeRuleViolationError,
} from './role-change.repository.js';
import { UserDirectory } from './user-directory.js';

const ROLE_CHANGE_TTL_MS = ROLE_CHANGE_TTL_HOURS * 60 * 60 * 1000;

function toView(record: RoleChangeRecord): RoleChange {
  return {
    id: record.id,
    user: record.user,
    role: record.role,
    action: record.action,
    reason: record.reason,
    status: record.status,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionNote: record.decisionNote,
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Role change request not found.');
}

function alreadyClosed(record: RoleChangeRecord): AppError {
  return new AppError(
    'CONFLICT',
    `This request is no longer pending (${record.status.toLowerCase()}).`,
  );
}

/** Une autre décision, simultanée, est passée la première. */
function decidedMeanwhile(): AppError {
  return new AppError('CONFLICT', 'This request has just been decided by someone else.');
}

/**
 * Attribution et retrait des rôles du back-office, sous **double validation** : un
 * administrateur demande le changement, un second l'approuve, et c'est alors la base de données
 * qui l'applique — l'API n'a aucun droit d'écriture sur les attributions de rôles.
 *
 * Nul ne prend part à un changement de ses propres rôles. Les contrôles faits ici donnent des
 * réponses claires ; les mêmes règles sont imposées par la base (contraintes et déclencheur de
 * `role_change_requests`), qui a le dernier mot.
 */
@Injectable()
export class RoleChangeService {
  constructor(
    private readonly roleChanges: RoleChangeRepository,
    private readonly directory: UserDirectory,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async listRoles(): Promise<RoleList> {
    const roles = await this.roleChanges.listRoles(this.prisma);
    return {
      roles: roles.map(({ key, name, description, isSystem, permissions, holders }) => ({
        key,
        name,
        description,
        isSystem,
        permissions: [...permissions],
        holders,
      })),
    };
  }

  async list(query: RoleChangeListQuery): Promise<RoleChangeList> {
    await this.closeOverdue();
    const found = await this.roleChanges.list(this.prisma, { ...query, limit: query.limit + 1 });
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    return {
      roleChanges: page.map(toView),
      nextCursor: found.length > query.limit && last !== undefined ? last.id : null,
    };
  }

  async get(id: string): Promise<RoleChange> {
    await this.closeOverdue();
    return toView(await this.find(id));
  }

  /** Demande l'attribution ou le retrait d'un rôle. Rien ne change tant qu'elle n'est pas approuvée. */
  async request(body: CreateRoleChangeRequest, actor: StaffActor): Promise<RoleChange> {
    if (body.userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'You cannot request a change of your own roles.');
    }
    const [target, role] = await Promise.all([
      this.directory.find(this.prisma, body.userId),
      this.roleChanges.findRoleByKey(this.prisma, body.roleKey),
    ]);
    if (target === null) {
      throw new AppError('UNPROCESSABLE_ENTITY', 'Unknown account.');
    }
    if (role === null) {
      throw new AppError('UNPROCESSABLE_ENTITY', 'Unknown role.');
    }
    const holdsRole = await this.roleChanges.holdsRole(this.prisma, target.id, role.id);
    if (body.action === 'GRANT') {
      if (target.status !== 'ACTIVE') {
        throw new AppError('CONFLICT', 'A role can only be granted to an active account.');
      }
      if (holdsRole) {
        throw new AppError('CONFLICT', 'The account already holds this role.');
      }
    } else if (!holdsRole) {
      throw new AppError('CONFLICT', 'The account does not hold this role.');
    }

    const now = this.clock.now();
    await this.closeOverdue(now);
    let id: string;
    try {
      id = await this.unitOfWork.run(async (tx) => {
        const created = await this.roleChanges.create(tx, {
          userId: target.id,
          roleId: role.id,
          action: body.action,
          reason: body.reason,
          requestedBy: actor.userId,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + ROLE_CHANGE_TTL_MS),
        });
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'role_change.requested',
          resource: { type: 'role_change_request', id: created },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: {
            userId: target.id,
            role: role.key,
            change: body.action,
            reason: body.reason,
          },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof PendingRoleChangeExistsError) {
        throw new AppError(
          'CONFLICT',
          'A change of this role is already awaiting approval for this account.',
        );
      }
      throw error;
    }
    return toView(await this.find(id));
  }

  /** Approuve une demande : le changement de rôle est appliqué dans la même transaction. */
  async approve(
    id: string,
    body: ApproveRoleChangeRequest,
    actor: StaffActor,
  ): Promise<RoleChange> {
    const now = this.clock.now();
    const pending = await this.pendingOf(id, now);
    this.assertSecondPerson(pending, actor, 'approved');

    try {
      await this.unitOfWork.run(async (tx) => {
        const applied = await this.roleChanges.decide(tx, id, {
          status: 'APPROVED',
          decidedBy: actor.userId,
          decidedAt: now,
          note: body.note ?? null,
        });
        if (!applied) {
          throw decidedMeanwhile();
        }
        const change = {
          role: pending.role.key,
          requestId: id,
          requestedBy: pending.requestedBy.id,
        };
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: 'role_change.approved',
          resource: { type: 'role_change_request', id },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: { userId: pending.user.id, change: pending.action, ...change },
        });
        // Seconde entrée, rattachée au compte : son historique dit quels rôles il a détenus.
        await this.audit.record(tx, {
          actor: { type: 'USER', id: actor.userId },
          action: pending.action === 'GRANT' ? 'user.role_granted' : 'user.role_revoked',
          resource: { type: 'user', id: pending.user.id },
          outcome: 'SUCCESS',
          ...actor.client,
          metadata: change,
        });
      });
    } catch (error) {
      if (error instanceof RoleChangeRuleViolationError) {
        await this.audit.record(this.prisma, {
          actor: { type: 'USER', id: actor.userId },
          action: 'role_change.approval_refused',
          resource: { type: 'role_change_request', id },
          outcome: 'DENIED',
          ...actor.client,
          metadata: { reason: 'DATABASE_RULE' },
        });
        throw new AppError(
          'CONFLICT',
          'This role change can no longer be approved: the request has expired, or its author, ' +
            'you, or the account concerned is no longer eligible.',
        );
      }
      throw error;
    }
    return toView(await this.find(id));
  }

  /** Refuse une demande. Le refus est motivé. */
  async reject(id: string, body: RejectRoleChangeRequest, actor: StaffActor): Promise<RoleChange> {
    const now = this.clock.now();
    const pending = await this.pendingOf(id, now);
    this.assertSecondPerson(pending, actor, 'rejected');
    await this.close(pending, actor, { status: 'REJECTED', note: body.note, now });
    return toView(await this.find(id));
  }

  /** Retire une demande ; seul son auteur le peut. */
  async cancel(id: string, actor: StaffActor): Promise<RoleChange> {
    const now = this.clock.now();
    const pending = await this.pendingOf(id, now);
    if (pending.requestedBy.id !== actor.userId) {
      throw new AppError('FORBIDDEN', 'Only the author of a request can cancel it.');
    }
    await this.close(pending, actor, { status: 'CANCELLED', note: null, now });
    return toView(await this.find(id));
  }

  private async close(
    pending: RoleChangeRecord,
    actor: StaffActor,
    outcome: {
      readonly status: 'REJECTED' | 'CANCELLED';
      readonly note: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const applied = await this.roleChanges.decide(tx, pending.id, {
        status: outcome.status,
        decidedBy: actor.userId,
        decidedAt: outcome.now,
        note: outcome.note,
      });
      if (!applied) {
        throw decidedMeanwhile();
      }
      await this.audit.record(tx, {
        actor: { type: 'USER', id: actor.userId },
        action: outcome.status === 'REJECTED' ? 'role_change.rejected' : 'role_change.cancelled',
        resource: { type: 'role_change_request', id: pending.id },
        outcome: 'SUCCESS',
        ...actor.client,
        metadata: {
          userId: pending.user.id,
          role: pending.role.key,
          change: pending.action,
          ...(outcome.note === null ? {} : { note: outcome.note }),
        },
      });
    });
  }

  /** La décision appartient à une autre personne que l'auteur de la demande et que l'intéressé. */
  private assertSecondPerson(
    pending: RoleChangeRecord,
    actor: StaffActor,
    decision: 'approved' | 'rejected',
  ): void {
    if (pending.requestedBy.id === actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        `A role change must be ${decision} by a second administrator; you can cancel your own request.`,
      );
    }
    if (pending.user.id === actor.userId) {
      throw new AppError('FORBIDDEN', 'You cannot decide on a change of your own roles.');
    }
  }

  private async pendingOf(id: string, now: Date): Promise<RoleChangeRecord> {
    await this.closeOverdue(now);
    const record = await this.find(id);
    if (record.status !== 'PENDING') {
      throw alreadyClosed(record);
    }
    return record;
  }

  private async find(id: string): Promise<RoleChangeRecord> {
    const record = await this.roleChanges.find(this.prisma, id);
    if (record === null) {
      throw notFound();
    }
    return record;
  }

  /**
   * Clôt les demandes échues avant toute lecture ou décision : une demande affichée « en
   * attente » peut réellement être approuvée. La purge périodique fait de même.
   */
  private async closeOverdue(now: Date = this.clock.now()): Promise<void> {
    await this.roleChanges.expireOverdue(this.prisma, now);
  }
}
