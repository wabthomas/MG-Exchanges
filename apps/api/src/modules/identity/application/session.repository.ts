import type { UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { SessionState } from '../domain/session-policy.js';
import type { Digest } from './digest.js';

export type SessionRevocationReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'TOKEN_REUSE'
  | 'ACCOUNT_DISABLED'
  | 'ADMIN_REVOKED';

export interface NewTokenPair {
  readonly accessTokenHash: Digest;
  readonly accessExpiresAt: Date;
  readonly refreshTokenHash: Digest;
}

export interface NewSession {
  readonly userId: string;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceName: string | null;
  readonly tokens: NewTokenPair;
}

/** Ce que la présentation d'un jeton d'accès permet d'établir. */
export interface AccessTokenOwner extends SessionState {
  readonly sessionId: string;
  readonly userId: string;
  readonly userStatus: UserStatus;
  readonly accessExpiresAt: Date;
}

/** Paire de jetons retrouvée par son jeton de renouvellement, session verrouillée. */
export interface LockedRefreshToken extends SessionState {
  readonly tokenId: string;
  readonly consumedAt: Date | null;
  readonly sessionId: string;
  readonly userId: string;
  readonly userStatus: UserStatus;
}

export interface SessionSummary {
  readonly id: string;
  readonly deviceName: string | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
}

/** Port de persistance des sessions et de leurs jetons (empreintes uniquement). */
export abstract class SessionRepository {
  /** @returns l'identifiant de la session créée. */
  abstract create(tx: DbClient, session: NewSession): Promise<string>;

  abstract findByAccessTokenHash(db: DbClient, hash: Digest): Promise<AccessTokenOwner | null>;

  /**
   * Retrouve une paire de jetons par son jeton de renouvellement et **verrouille sa session**
   * pour la durée de la transaction : deux renouvellements simultanés sont traités l'un après l'autre.
   */
  abstract lockByRefreshTokenHash(tx: DbClient, hash: Digest): Promise<LockedRefreshToken | null>;

  abstract markTokenConsumed(tx: DbClient, tokenId: string, now: Date): Promise<void>;

  /** Ajoute une paire de jetons à la session et repousse son échéance d'inactivité. */
  abstract addTokens(
    tx: DbClient,
    sessionId: string,
    tokens: NewTokenPair,
    usage: { readonly now: Date; readonly idleExpiresAt: Date },
  ): Promise<void>;

  /** Supprime les paires consommées avant la date donnée (elles ne servent plus à rien). */
  abstract pruneConsumedTokens(
    tx: DbClient,
    sessionId: string,
    consumedBefore: Date,
  ): Promise<void>;

  /** @returns faux si la session n'existe pas, n'appartient pas au compte ou est déjà révoquée. */
  abstract revoke(
    db: DbClient,
    target: { readonly sessionId: string; readonly userId: string },
    reason: SessionRevocationReason,
    now: Date,
  ): Promise<boolean>;

  /** Révoque toutes les sessions actives du compte, sauf éventuellement une. @returns leur nombre. */
  abstract revokeAllForUser(
    db: DbClient,
    userId: string,
    reason: SessionRevocationReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<number>;

  /** Sessions utilisables du compte, de la plus récemment utilisée à la plus ancienne. */
  abstract listActive(db: DbClient, userId: string, now: Date): Promise<SessionSummary[]>;
}
