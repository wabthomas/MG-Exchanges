import type { PermissionKey } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UserRepository } from './user.repository.js';

/**
 * Autorisations du back-office. Les droits sont relus en base à chaque vérification :
 * le retrait d'un rôle prend effet immédiatement, sans attendre l'expiration d'un jeton.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly users: UserRepository,
    private readonly prisma: PrismaService,
  ) {}

  /** Permissions manquantes parmi celles exigées (vide si le compte les détient toutes). */
  async missingPermissions(
    userId: string,
    required: readonly PermissionKey[],
  ): Promise<PermissionKey[]> {
    const { permissions } = await this.users.findAccess(this.prisma, userId);
    return required.filter((permission) => !permissions.includes(permission));
  }
}
