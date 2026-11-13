import type { PermissionKey } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { MfaRepository } from './mfa.repository.js';
import { UserRepository } from './user.repository.js';

/**
 * Autorisations du back-office. Les droits sont relus en base à chaque vérification :
 * le retrait d'un rôle prend effet immédiatement, sans attendre l'expiration d'un jeton.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly users: UserRepository,
    private readonly mfa: MfaRepository,
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

  /**
   * Le back-office exige la validation en deux étapes : un mot de passe d'administrateur
   * dérobé ne doit pas suffire. Dès qu'elle est activée, toute connexion passe par la seconde
   * étape et les sessions antérieures sont fermées — l'avoir activée garantit donc que la
   * session en cours l'a franchie.
   */
  hasSecondFactor(userId: string): Promise<boolean> {
    return this.mfa.isTotpEnabled(this.prisma, userId);
  }
}
