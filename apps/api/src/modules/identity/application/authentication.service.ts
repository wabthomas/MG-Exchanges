import {
  type AuthenticatedLogin,
  type LoginRequest,
  type LoginResponse,
  type MfaLoginRequest,
  type RefreshRequest,
  type RefreshResponse,
  SECOND_FACTOR_METHODS,
  type SecondFactorMethod,
  type TokenPair,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { AppConfig } from '../../../config/app-config.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { describeUserAgent } from '../domain/device-description.js';
import { identifierDigest } from '../domain/identifier-digest.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import {
  MFA_LOGIN_MAX_ATTEMPTS,
  MFA_LOGIN_TTL_SECONDS,
  toSecondFactorProof,
} from '../domain/mfa-policy.js';
import { decideRefresh, isSessionUsable, nextIdleExpiry } from '../domain/session-policy.js';
import { canUseSessions, type UserRecord } from '../domain/user.js';
import { deviceFingerprint } from '../infrastructure/device-fingerprint.js';
import { LoginThrottle } from '../infrastructure/login-throttle.js';
import { hashPresentedToken, issueSessionToken } from '../infrastructure/session-tokens.js';
import { AccountService } from './account.service.js';
import type { ClientContext } from './client-context.js';
import type { Digest } from './digest.js';
import { CONSUMED_TOKEN_RETENTION_MS } from './identity-policy.js';
import { MfaService } from './mfa.service.js';
import { PasswordHasher } from './password-hasher.js';
import { PendingLoginStore } from './pending-login.store.js';
import { type NewTokenPair, SessionRepository } from './session.repository.js';
import { UserRepository } from './user.repository.js';

interface IssuedPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly record: NewTokenPair;
}

/** L'appareil qui se connecte : son nom d'affichage et l'empreinte qui permet de le reconnaître. */
interface LoginDevice {
  readonly name: string | null;
  readonly fingerprint: Digest | null;
}

function signInExpired(): AppError {
  return new AppError('UNAUTHENTICATED', 'This sign-in attempt has expired. Please sign in again.');
}

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Authentication is required.');
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
    private readonly mfa: MfaService,
    private readonly pendingLogins: PendingLoginStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
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

    const device: LoginDevice = {
      name: request.deviceName ?? null,
      fingerprint: deviceFingerprint(request.deviceId, client.userAgent),
    };
    if (await this.mfa.isEnabled(user.id)) {
      return this.requireSecondFactor(user, device, client);
    }
    return this.openSession(user, device, client, now, null);
  }

  /**
   * Seconde étape de la connexion d'un compte protégé par un second facteur : le jeton reçu à
   * la première étape, et un code de l'application d'authentification ou un code de secours.
   */
  async completeMfaLogin(
    request: MfaLoginRequest,
    client: ClientContext,
  ): Promise<AuthenticatedLogin> {
    const proof = toSecondFactorProof(request);
    // Chaque présentation du jeton compte pour un essai, avant tout examen du code.
    const pending = await this.pendingLogins.registerAttempt(
      request.mfaToken,
      MFA_LOGIN_MAX_ATTEMPTS,
    );
    if (pending === null || proof === null) {
      throw signInExpired();
    }

    const user = await this.users.findById(this.prisma, pending.userId);
    if (user === null || !canUseSessions(user.status)) {
      // Compte suspendu depuis la première étape : la connexion en attente ne vaut plus rien.
      await this.pendingLogins.consume(request.mfaToken);
      throw signInExpired();
    }

    const method = await this.mfa.assertSecondFactor(
      user.id,
      proof,
      client,
      'session.second_factor_failed',
    );
    // Le jeton ne sert qu'une fois : de deux requêtes simultanées, une seule ouvre une session.
    if (!(await this.pendingLogins.consume(request.mfaToken))) {
      throw signInExpired();
    }

    const device: LoginDevice = {
      name: pending.deviceName,
      fingerprint:
        pending.deviceFingerprint === null
          ? null
          : new Uint8Array(Buffer.from(pending.deviceFingerprint, 'hex')),
    };
    return this.openSession(user, device, client, new Date(), method);
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

  /** Mot de passe correct, second facteur exigé : aucune session n'est ouverte à ce stade. */
  private async requireSecondFactor(
    user: UserRecord,
    device: LoginDevice,
    client: ClientContext,
  ): Promise<LoginResponse> {
    const pending = await this.pendingLogins.create(
      {
        userId: user.id,
        deviceName: device.name,
        deviceFingerprint:
          device.fingerprint === null ? null : Buffer.from(device.fingerprint).toString('hex'),
      },
      MFA_LOGIN_TTL_SECONDS,
    );
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: user.id },
      action: 'session.second_factor_required',
      resource: { type: 'user', id: user.id },
      outcome: 'SUCCESS',
      ...client,
    });
    return {
      status: 'MFA_REQUIRED',
      mfaToken: pending.token,
      mfaTokenExpiresAt: pending.expiresAt.toISOString(),
      methods: [...SECOND_FACTOR_METHODS],
    };
  }

  private async openSession(
    user: UserRecord,
    device: LoginDevice,
    client: ClientContext,
    now: Date,
    secondFactor: SecondFactorMethod | null,
  ): Promise<AuthenticatedLogin> {
    const expiresAt = new Date(now.getTime() + this.config.auth.sessionAbsoluteTtlMs);
    const idleExpiresAt = nextIdleExpiry(now, expiresAt, this.config.auth.sessionIdleTtlMs);
    const issued = this.issueTokens(now, expiresAt);

    const sessionId = await this.unitOfWork.run(async (tx) => {
      const history = await this.sessions.deviceHistory(tx, user.id, device.fingerprint);
      // La toute première connexion d'un compte n'a rien d'inhabituel ; ensuite, un appareil
      // jamais vu est signalé au titulaire.
      const newDevice = history.hasSessions && !history.knownDevice;

      const id = await this.sessions.create(tx, {
        userId: user.id,
        idleExpiresAt,
        expiresAt,
        ipAddress: client.ipAddress ?? null,
        userAgent: client.userAgent ?? null,
        deviceName: device.name,
        deviceFingerprint: device.fingerprint,
        tokens: issued.record,
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'session.opened',
        resource: { type: 'session', id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { deviceName: device.name, secondFactor, newDevice },
      });
      if (newDevice) {
        await this.outbox.append(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: SECURITY_NOTICE_REQUESTED_EVENT,
          payload: {
            userId: user.id,
            notice: 'NEW_SIGN_IN',
            details: {
              occurredAt: now.toISOString(),
              ipAddress: client.ipAddress ?? null,
              device: describeUserAgent(client.userAgent),
            },
          },
          metadata: { requestId: client.requestId },
        });
      }
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
