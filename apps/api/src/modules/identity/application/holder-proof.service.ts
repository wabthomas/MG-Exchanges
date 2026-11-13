import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { toSecondFactorProof } from '../domain/mfa-policy.js';
import type { UserRecord } from '../domain/user.js';
import type { ClientContext } from './client-context.js';
import { MfaRepository } from './mfa.repository.js';
import { MfaService } from './mfa.service.js';
import { ReauthenticationService } from './reauthentication.service.js';

/** Ce que le titulaire présente à nouveau : son mot de passe et, s'il y a lieu, son second facteur. */
export interface HolderProof {
  readonly currentPassword: string;
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
}

/**
 * Preuve que la requête vient bien du titulaire du compte, exigée avant une opération
 * définitive (clôture) ou qui rassemble toutes ses données (copie).
 *
 * Une session ouverte ne suffit pas : le mot de passe est présenté à nouveau, et — si la
 * validation en deux étapes est activée — le second facteur aussi. Qui a dérobé un jeton, ou
 * même le mot de passe d'un compte protégé, ne peut ni le clôturer, ni en emporter les données.
 * Les essais erronés sont bornés par compte, comme pour toute opération sensible.
 */
@Injectable()
export class HolderProofService {
  constructor(
    private readonly reauthentication: ReauthenticationService,
    private readonly mfa: MfaService,
    private readonly mfaRepository: MfaRepository,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * @param failureAction action inscrite au journal d'audit si la preuve est refusée.
   * @returns le compte de l'appelant.
   * @throws AppError `INVALID_CREDENTIALS` (mot de passe erroné), `UNPROCESSABLE_ENTITY` (second
   *   facteur exigé mais absent), `INVALID_OR_EXPIRED_CODE` (second facteur refusé),
   *   `RATE_LIMITED` (trop d'essais erronés).
   */
  async confirm(
    auth: AuthenticatedUser,
    proof: HolderProof,
    client: ClientContext,
    failureAction: string,
  ): Promise<UserRecord> {
    const user = await this.reauthentication.confirmPassword(
      auth,
      proof.currentPassword,
      client,
      failureAction,
    );
    if (!(await this.mfaRepository.isTotpEnabled(this.prisma, user.id))) {
      return user;
    }
    const secondFactor = toSecondFactorProof(proof);
    if (secondFactor === null) {
      throw new AppError(
        'UNPROCESSABLE_ENTITY',
        'Two-step verification is enabled on this account: provide "code" or "recoveryCode".',
      );
    }
    await this.mfa.assertSecondFactor(user.id, secondFactor, client, failureAction);
    return user;
  }
}
