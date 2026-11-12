import type { PermissionKey, RoleChangeAction, RoleChangeStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';

export interface RoleRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
  /** Nombre de comptes détenant ce rôle. */
  readonly holders: number;
}

interface AccountReference {
  readonly id: string;
  readonly email: string;
}

export interface RoleChangeRecord {
  readonly id: string;
  readonly user: AccountReference;
  readonly role: { readonly key: string; readonly name: string };
  readonly action: RoleChangeAction;
  readonly reason: string;
  readonly status: RoleChangeStatus;
  readonly requestedBy: AccountReference;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly decidedBy: AccountReference | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
}

export interface NewRoleChange {
  readonly userId: string;
  readonly roleId: string;
  readonly action: RoleChangeAction;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export interface RoleChangeDecision {
  readonly status: 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly note: string | null;
}

export interface RoleChangePage {
  readonly status?: RoleChangeStatus | undefined;
  readonly limit: number;
  readonly before?: string | undefined;
}

/** Une demande est déjà en attente pour ce compte et ce rôle. La transaction est inutilisable. */
export class PendingRoleChangeExistsError extends Error {
  constructor() {
    super('A role change is already pending for this account and this role.');
    this.name = 'PendingRoleChangeExistsError';
  }
}

/**
 * La base de données a refusé la décision : une règle de la double validation n'est pas (ou
 * plus) respectée — demande échue, intervenant qui n'a plus qualité, compte concerné inactif.
 * La transaction est inutilisable.
 */
export class RoleChangeRuleViolationError extends Error {
  constructor(options?: ErrorOptions) {
    super('The database refused the role change decision.', options);
    this.name = 'RoleChangeRuleViolationError';
  }
}

/**
 * Port de persistance des rôles et des demandes de changement de rôle.
 *
 * Il n'expose **aucune** écriture directe des attributions : un rôle n'est attribué ou retiré
 * que par l'approbation d'une demande, que la base de données applique elle-même.
 */
export abstract class RoleChangeRepository {
  abstract listRoles(db: DbClient): Promise<RoleRecord[]>;

  abstract findRoleByKey(
    db: DbClient,
    key: string,
  ): Promise<{ readonly id: string; readonly key: string } | null>;

  abstract holdsRole(db: DbClient, userId: string, roleId: string): Promise<boolean>;

  /**
   * Enregistre une demande en attente. @returns son identifiant.
   * @throws PendingRoleChangeExistsError si une demande est déjà en attente pour ce compte et ce rôle.
   */
  abstract create(tx: DbClient, request: NewRoleChange): Promise<string>;

  abstract find(db: DbClient, id: string): Promise<RoleChangeRecord | null>;

  /** Demandes, de la plus récente à la plus ancienne. */
  abstract list(db: DbClient, page: RoleChangePage): Promise<RoleChangeRecord[]>;

  /**
   * Enregistre la décision prise sur une demande **en attente**. Une approbation applique le
   * changement de rôle.
   * @returns faux si la demande n'était plus en attente (décision concurrente).
   * @throws RoleChangeRuleViolationError si la base refuse la décision.
   */
  abstract decide(tx: DbClient, id: string, decision: RoleChangeDecision): Promise<boolean>;

  /** Clôt les demandes restées sans décision jusqu'à leur échéance. @returns leur nombre. */
  abstract expireOverdue(db: DbClient, now: Date): Promise<number>;
}
