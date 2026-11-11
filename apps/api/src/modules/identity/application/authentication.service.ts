import { createHash } from 'node:crypto';

import type {
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  TokenPair,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { AppConfig } from '../../../config/app-config.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { decideRefresh, isSessionUsable, nextIdleExpiry } from '../domain/session-policy.js';
import { canUseSessions, type UserRecord } from '../domain/user.js';
import { LoginThrottle } from '../infrastructure/login-throttle.js';
import { hashPresentedToken, issueSessionToken } from '../infrastructure/session-tokens.js';
import { AccountService } from './account.service.js';
import type { ClientContext } from './client-context.js';
import { CONSUMED_TOKEN_RETENTION_MS } from './identity-policy.js';
import { PasswordHasher } from './password-hasher.js';
import { type NewTokenPair, SessionRepository } from './session.repository.js';
import { UserRepository } from './user.repository.js';

interface IssuedPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly record: NewTokenPair;
}

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Authentication is required.');
}

/** Empreinte courte d'un identifiant de connexion : corrélation dans l'audit, sans donnée personnelle. */
function identifierDigest(identifier: string): string {
  return createHash('sha256').update(identifier, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Connexion, renouvellement et fermeture des sessions ; authentification des requêtes.
 *
 * Les jetons sont opaques : ils ne valent que par leur enregistrement en base. Chaque
 * requête authentifiée vérifie donc l'état réel de la session et du compte — une révocation,
 * une suspension ou un changement de mot de passe prennent effet immédiatement.
 */
@Injectable()
export class AuthenticationService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly accounts: AccountService,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async login(request: LoginRequest, client: ClientContext): Promise<LoginResponse> {
    const clientAddress = client.ipAddress ?? 'unknown';

    // Pendant un blocage, aucun mot de passe n'est examiné — même le bon.
    const blockedFor = await this.throttle.blockedForSeconds(request.email, clientAddress);
    if (blockedFor > 0) {
      throw new AppError(
        'RATE_LIMITED',
        'Too many failed sign-in attempts. Please try again later.',
        { retryAfterSeconds: blockedFor },
      );
    }

    const found = await this.users.findByEmailWithPasswordHash(this.prisma, request.email);
    const passwordHash = found?.passwordHash ?? null;

    // Compte inconnu : une vérification factice de même coût, pour que le temps de réponse
    // ne distingue pas « compte inconnu » de « mot de passe erroné ».
    let passwordMatches = false;
    if (passwordHash === null) {
      await this.hasher.verifyAgainstDummy(request.password);
    } else {
      passwordMatches = await this.hasher.verify(passwordHash, request.password);
    }

    if (found === null || passwordHash === null || !passwordMatches) {
      await this.throttle.recordFailure(request.email, clientAddress);
      await this.audit.record(this.prisma, {
        actor: found === null ? { type: 'SYSTEM' } : { type: 'USER', id: found.user.id },
        action: 'session.login_failed',
        resource: found === null ? { type: 'user' } : { type: 'user', id: found.user.id },
        outcome: 'FAILURE',
        ...client,
        metadata: {
          identifierDigest: identifierDigest(request.email),
          reason: found === null ? 'UNKNOWN_ACCOUNT' : 'WRONG_PASSWORD',
        },
      });
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    // À partir d'ici le mot de passe est correct : l'état du compte peut être indiqué.
    const { user } = found;
    if (!canUseSessions(user.status)) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.id },
        action: 'session.login_denied',
        resource: { type: 'user', id: user.id },
        outcome: 'DENIED',
        ...client,
        metadata: { accountStatus: user.status },
      });
      throw user.status === 'PENDING_VERIFICATION'
        ? new AppError('EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.')
        : new AppError('ACCOUNT_DISABLED', 'This account is disabled. Please contact support.');
    }

    await this.throttle.recordSuccess(request.email, clientAddress);

    const now = new Date();
    if (this.hasher.needsRehash(passwordHash)) {
      // Les paramètres de hachage ont été renforcés depuis : l'empreinte est recalculée
      // maintenant, seul moment où le mot de passe est disponible.
      await this.users.replacePasswordHash(
        this.prisma,
        user.id,
        await this.hasher.hash(request.password),
      );
    }

    return this.openSession(user, request.deviceName ?? null, client, now);
  }

  async refresh(request: RefreshRequest, client: ClientContext): Promise<RefreshResponse> {
    const hash = hashPresentedToken('refresh', request.refreshToken);
    if (hash === null) {
      throw unauthenticated();
    }

    // La transaction retourne `null` au lieu de lever : en cas de réutilisation détectée,
    // la révocation de la session doit être validée, pas annulée.
    const tokens = await this.unitOfWork.run(async (tx): Promise<TokenPair | null> => {
      const found = await this.sessions.lockByRefreshTokenHash(tx, hash);
      // L'heure est prise une fois le verrou obtenu : elle est postérieure à tout ce que les
      // renouvellements précédents de cette session ont écrit.
      const now = new Date();
      if (found === null || !isSessionUsable(found, now) || !canUseSessions(found.userStatus)) {
        return null;
      }

      const decision = decideRefresh(found, now, this.config.auth.refreshReuseGraceMs);
      if (decision === 'REUSE_DETECTED') {
        await this.sessions.revoke(tx, found, 'TOKEN_REUSE', now);
        await this.audit.record(tx, {
          actor: { type: 'USER', id: found.userId },
          action: 'session.refresh_token_reused',
          resource: { type: 'session', id: found.sessionId },
          outcome: 'DENIED',
          ...client,
        });
        return null;
      }
      if (decision === 'ROTATE') {
        await this.sessions.markTokenConsumed(tx, found.tokenId, now);
      }

      const issued = this.issueTokens(now, found.expiresAt);
      const idleExpiresAt = nextIdleExpiry(now, found.expiresAt, this.config.auth.sessionIdleTtlMs);
      await this.sessions.addTokens(tx, found.sessionId, issued.record, { now, idleExpiresAt });
      await this.sessions.pruneConsumedTokens(
        tx,
        found.sessionId,
        new Date(now.getTime() - CONSUMED_TOKEN_RETENTION_MS),
      );
      return this.toTokenPair(issued, idleExpiresAt);
    });

    if (tokens === null) {
      throw unauthenticated();
    }
    return { tokens };
  }

  async logout(auth: AuthenticatedUser, client: ClientContext): Promise<void> {
    const now = new Date();
    await this.unitOfWork.run(async (tx) => {
      if (await this.sessions.revoke(tx, auth, 'LOGOUT', now)) {
        await this.audit.record(tx, {
          actor: { type: 'USER', id: auth.userId },
          action: 'session.closed',
          resource: { type: 'session', id: auth.sessionId },
          outcome: 'SUCCESS',
          ...client,
        });
      }
    });
  }

  /** Identité associée à un jeton d'accès, ou `null` s'il n'ouvre (plus) aucun droit. */
  async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    const hash = hashPresentedToken('access', accessToken);
    if (hash === null) {
      return null;
    }
    const owner = await this.sessions.findByAccessTokenHash(this.prisma, hash);
    if (owner === null) {
      return null;
    }
    const now = new Date();
    const usable =
      owner.accessExpiresAt > now &&
      isSessionUsable(owner, now) &&
      canUseSessions(owner.userStatus);
    return usable ? { userId: owner.userId, sessionId: owner.sessionId } : null;
  }

  private async openSession(
    user: UserRecord,
    deviceName: string | null,
    client: ClientContext,
    now: Date,
  ): Promise<LoginResponse> {
    const expiresAt = new Date(now.getTime() + this.config.auth.sessionAbsoluteTtlMs);
    const idleExpiresAt = nextIdleExpiry(now, expiresAt, this.config.auth.sessionIdleTtlMs);
    const issued = this.issueTokens(now, expiresAt);

    const sessionId = await this.unitOfWork.run(async (tx) => {
      const id = await this.sessions.create(tx, {
        userId: user.id,
        idleExpiresAt,
        expiresAt,
        ipAddress: client.ipAddress ?? null,
        userAgent: client.userAgent ?? null,
        deviceName,
        tokens: issued.record,
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'session.opened',
        resource: { type: 'session', id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { deviceName },
      });
      return id;
    });

    return {
      status: 'AUTHENTICATED',
      tokens: this.toTokenPair(issued, idleExpiresAt),
      sessionId,
      user: await this.accounts.describe(user),
    };
  }

  private issueTokens(now: Date, sessionExpiresAt: Date): IssuedPair {
    const access = issueSessionToken('access');
    const refresh = issueSessionToken('refresh');
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      record: {
        accessTokenHash: access.hash,
        // Un jeton d'accès ne survit jamais à sa session.
        accessExpiresAt: new Date(
          Math.min(now.getTime() + this.config.auth.accessTokenTtlMs, sessionExpiresAt.getTime()),
        ),
        refreshTokenHash: refresh.hash,
      },
    };
  }

  private toTokenPair(issued: IssuedPair, idleExpiresAt: Date): TokenPair {
    return {
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.record.accessExpiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: idleExpiresAt.toISOString(),
    };
  }
}
