import type { PermissionKey } from '@mgx/contracts';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRED_PERMISSIONS_KEY } from '../../../common/auth/auth.decorators.js';
import { getAuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { toRequestContext } from '../../../common/http/request-context.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { AuthorizationService } from '../application/authorization.service.js';

/**
 * Garde globale d'autorisation : applique `@RequirePermissions()`. Une route du back-office
 * exige les permissions citées **et** un compte protégé par la validation en deux étapes.
 * Un refus est inscrit au journal d'audit (tentative d'accès au back-office).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const required = this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = getAuthenticatedUser(request);
    if (user === undefined) {
      // Route à la fois publique et soumise à permission : erreur de programmation. Refus.
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }

    const route = `${request.method} ${request.originalUrl.split('?')[0] ?? ''}`;
    const missing = await this.authorization.missingPermissions(user.userId, required);
    if (missing.length > 0) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.userId },
        action: 'authorization.denied',
        resource: { type: 'route', id: route },
        outcome: 'DENIED',
        ...toRequestContext(request),
        metadata: { missingPermissions: missing },
      });
      throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    }

    if (!(await this.authorization.hasSecondFactor(user.userId))) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.userId },
        action: 'authorization.denied',
        resource: { type: 'route', id: route },
        outcome: 'DENIED',
        ...toRequestContext(request),
        metadata: { reason: 'SECOND_FACTOR_NOT_ENABLED' },
      });
      throw new AppError(
        'MFA_ENROLLMENT_REQUIRED',
        'Two-step verification must be enabled to use the back office.',
      );
    }
    return true;
  }
}
