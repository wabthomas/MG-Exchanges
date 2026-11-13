import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { UserRecord } from '../domain/user.js';
import type { ClientContext } from './client-context.js';
import { PASSWORD_CONFIRMATION_FAILURES_PER_ACCOUNT } from './identity-policy.js';
import { PasswordHasher } from './password-hasher.js';
import { UserRepository } from './user.repository.js';

/**
 * Nouvelle présentation du mot de passe avant une opération sensible (changement de mot de
 * passe, gestion du second facteur).
 *
 * Une session ouverte ne suffit pas : un appareil laissé déverrouillé ou un jeton dérobé ne
 * doivent permettre ni de changer le mot de passe, ni d'installer un second facteur qui
 * exclurait le titulaire de son propre compte. Les essais erronés sont bornés par compte,
 * toutes opérations confondues.
 */
@Injectable()
export class ReauthenticationService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly limiter: RedisRateLimiter,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * @param failureAction action inscrite au journal d'audit si le mot de passe est erroné.
   * @returns le compte de l'appelant.
   * @throws AppError `INVALID_CREDENTIALS` si le mot de passe est erroné ; `RATE_LIMITED`
   *   après trop d'essais erronés.
   */
  async confirmPassword(
    auth: AuthenticatedUser,
    password: string,
    client: ClientContext,
    failureAction: string,
  ): Promise<UserRecord> {
    const failuresKey = `password-confirmation-failures:${auth.userId}`;
    const blockedFor = await this.limiter.blockedForSeconds(failuresKey);
    if (blockedFor > 0) {
      throw new AppError('RATE_LIMITED', 'Too many failed attempts. Please try again later.', {
        retryAfterSeconds: blockedFor,
      });
    }

    const user = await this.users.findById(this.prisma, auth.userId);
    const currentHash = await this.users.findPasswordHash(this.prisma, auth.userId);
    if (user === null || currentHash === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }

    if (!(await this.hasher.verify(currentHash, password))) {
      await this.limiter.consume(failuresKey, PASSWORD_CONFIRMATION_FAILURES_PER_ACCOUNT);
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.id },
        action: failureAction,
        resource: { type: 'user', id: user.id },
        outcome: 'FAILURE',
        ...client,
        metadata: { reason: 'WRONG_PASSWORD' },
      });
      throw new AppError('INVALID_CREDENTIALS', 'The current password is incorrect.');
    }

    await this.limiter.reset(failuresKey);
    return user;
  }
}
