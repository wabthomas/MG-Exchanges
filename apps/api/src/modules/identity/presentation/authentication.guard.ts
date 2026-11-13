import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../../../common/auth/auth.decorators.js';
import { setAuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { AuthenticationService } from '../application/authentication.service.js';

// Le nom du schéma d'authentification est insensible à la casse (RFC 9110).
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{1,256})$/i;

/**
 * Garde globale d'authentification — **refus par défaut**.
 *
 * Toute route exige un jeton d'accès valide (`Authorization: Bearer …`), sauf si elle est
 * explicitement marquée `@Public()`. Oublier de protéger une nouvelle route est donc
 * impossible : c'est l'ouvrir qui demande un geste.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authentication: AuthenticationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = BEARER_PATTERN.exec(request.get('authorization') ?? '')?.[1];
    const user = token === undefined ? null : await this.authentication.authenticate(token);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }

    setAuthenticatedUser(request, user);
    return true;
  }
}
