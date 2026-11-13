import type { PermissionKey } from '@mgx/contracts';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  ALLOWED_BEFORE_TERMS_ACCEPTANCE_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from '../../../common/auth/auth.decorators.js';
import { getAuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { TermsService } from '../application/terms.service.js';

/**
 * Garde globale des conditions d'utilisation — **refus par défaut**.
 *
 * Tant qu'un compte doit accepter la version en vigueur, ses routes lui répondent
 * `TERMS_ACCEPTANCE_REQUIRED`, sauf celles qui sont explicitement marquées
 * `@AllowBeforeTermsAcceptance()`. Une nouvelle route est donc fermée sans qu'il faille y
 * penser.
 *
 * Deux familles de routes ne sont pas concernées :
 *  - les routes publiques : personne n'y est identifié ;
 *  - le back-office (`@RequirePermissions()`) : le personnel y agit pour la plateforme, non
 *    comme client — et il doit pouvoir publier une version corrigée sans avoir accepté celle
 *    qu'elle remplace.
 */
@Injectable()
export class TermsAcceptanceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly terms: TermsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const user = getAuthenticatedUser(context.switchToHttp().getRequest<Request>());
    if (user === undefined) {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];
    const permissions = this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );
    if (permissions !== undefined && permissions.length > 0) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOWED_BEFORE_TERMS_ACCEPTANCE_KEY,
      targets,
    );
    if (allowed === true) {
      return true;
    }

    if (await this.terms.isAcceptanceRequired(user.userId)) {
      throw new AppError(
        'TERMS_ACCEPTANCE_REQUIRED',
        'The current version of the terms of use must be accepted before continuing.',
      );
    }
    return true;
  }
}
