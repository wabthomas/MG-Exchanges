import type { PermissionKey } from '@mgx/contracts';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

import { type AuthenticatedUser, getAuthenticatedUser } from './authenticated-user.js';

export const IS_PUBLIC_KEY = 'mgx:public-route';
export const REQUIRED_PERMISSIONS_KEY = 'mgx:required-permissions';
export const ALLOWED_BEFORE_TERMS_ACCEPTANCE_KEY = 'mgx:allowed-before-terms-acceptance';

/**
 * Ouvre la route (ou le contrôleur) aux requêtes non authentifiées.
 *
 * L'authentification est exigée **par défaut** sur toutes les routes : une route n'est
 * publique que si elle le déclare explicitement.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Réserve la route (ou le contrôleur) aux comptes détenant **toutes** les permissions citées.
 * Les permissions proviennent des rôles du back-office ; un utilisateur final n'en a aucune.
 */
export const RequirePermissions = (
  ...permissions: [PermissionKey, ...PermissionKey[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Laisse la route (ou le contrôleur) accessible à un compte qui doit encore accepter la
 * version en vigueur des conditions d'utilisation.
 *
 * Une route authentifiée lui est fermée **par défaut** (`TERMS_ACCEPTANCE_REQUIRED`) : ne lui
 * restent ouvertes que celles qui le déclarent — consulter son compte, le sécuriser, obtenir
 * la copie de ses données, le clôturer, lire et accepter les conditions. Toute nouvelle
 * fonctionnalité est donc fermée sans qu'il faille y penser.
 */
export const AllowBeforeTermsAcceptance = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWED_BEFORE_TERMS_ACCEPTANCE_KEY, true);

/** Injecte l'identité de l'appelant. À n'utiliser que sur une route authentifiée. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = getAuthenticatedUser(context.switchToHttp().getRequest<Request>());
    if (user === undefined) {
      // Erreur de programmation : `@CurrentUser()` sur une route marquée `@Public()`.
      throw new Error('@CurrentUser() used on a route that is not authenticated.');
    }
    return user;
  },
);
