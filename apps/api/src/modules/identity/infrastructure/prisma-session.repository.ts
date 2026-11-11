import type { UserStatus } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { Digest } from '../application/digest.js';
import {
  type AccessTokenOwner,
  type LockedRefreshToken,
  type NewSession,
  type NewTokenPair,
  SessionRepository,
  type SessionRevocationReason,
  type SessionSummary,
} from '../application/session.repository.js';

interface LockedRow {
  token_id: string;
  consumed_at: Date | null;
  session_id: string;
  user_id: string;
  idle_expires_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  user_status: UserStatus;
}

@Injectable()
export class PrismaSessionRepository extends SessionRepository {
  async create(tx: DbClient, session: NewSession): Promise<string> {
    const { tokens, ...data } = session;
    const created = await tx.userSession.create({
      data: { ...data, tokens: { create: tokens } },
      select: { id: true },
    });
    return created.id;
  }

  async findByAccessTokenHash(db: DbClient, hash: Digest): Promise<AccessTokenOwner | null> {
    const found = await db.sessionToken.findUnique({
      where: { accessTokenHash: hash },
      select: {
        accessExpiresAt: true,
        session: {
          select: {
            id: true,
            idleExpiresAt: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (found === null) {
      return null;
    }
    const { session } = found;
    return {
      sessionId: session.id,
      userId: session.user.id,
      userStatus: session.user.status,
      accessExpiresAt: found.accessExpiresAt,
      idleExpiresAt: session.idleExpiresAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    };
  }

  async lockByRefreshTokenHash(tx: DbClient, hash: Digest): Promise<LockedRefreshToken | null> {
    // 1. Verrouille la session propriétaire du jeton, jusqu'à la fin de la transaction.
    await tx.$queryRaw(Prisma.sql`
      SELECT s.id
      FROM user_sessions s
      WHERE s.id = (SELECT t.session_id FROM session_tokens t WHERE t.refresh_token_hash = ${hash})
      FOR UPDATE
    `);

    // 2. Lit l'état **après** l'obtention du verrou, par une instruction distincte : si une
    //    transaction concurrente vient de consommer ce jeton ou de révoquer la session, c'est
    //    son résultat qui est lu. (Lire dans l'instruction qui verrouille renverrait, pour la
    //    table non verrouillée, l'état antérieur à l'attente du verrou.)
    const rows = await tx.$queryRaw<LockedRow[]>(Prisma.sql`
      SELECT t.id::text         AS token_id,
             t.consumed_at      AS consumed_at,
             s.id::text         AS session_id,
             s.user_id::text    AS user_id,
             s.idle_expires_at  AS idle_expires_at,
             s.expires_at       AS expires_at,
             s.revoked_at       AS revoked_at,
             u.status::text     AS user_status
      FROM session_tokens t
      JOIN user_sessions s ON s.id = t.session_id
      JOIN users u ON u.id = s.user_id
      WHERE t.refresh_token_hash = ${hash}
    `);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      tokenId: row.token_id,
      consumedAt: row.consumed_at,
      sessionId: row.session_id,
      userId: row.user_id,
      userStatus: row.user_status,
      idleExpiresAt: row.idle_expires_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  async markTokenConsumed(tx: DbClient, tokenId: string, now: Date): Promise<void> {
    await tx.sessionToken.updateMany({
      where: { id: tokenId, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  async addTokens(
    tx: DbClient,
    sessionId: string,
    tokens: NewTokenPair,
    usage: { readonly now: Date; readonly idleExpiresAt: Date },
  ): Promise<void> {
    await tx.sessionToken.create({ data: { sessionId, ...tokens } });
    await tx.userSession.update({
      where: { id: sessionId },
      data: { lastUsedAt: usage.now, idleExpiresAt: usage.idleExpiresAt },
    });
  }

  async pruneConsumedTokens(tx: DbClient, sessionId: string, consumedBefore: Date): Promise<void> {
    await tx.sessionToken.deleteMany({
      where: { sessionId, consumedAt: { lt: consumedBefore } },
    });
  }

  async revoke(
    db: DbClient,
    target: { readonly sessionId: string; readonly userId: string },
    reason: SessionRevocationReason,
    now: Date,
  ): Promise<boolean> {
    const { count } = await db.userSession.updateMany({
      where: { id: target.sessionId, userId: target.userId, revokedAt: null },
      data: { revokedAt: now, revocationReason: reason },
    });
    return count === 1;
  }

  async revokeAllForUser(
    db: DbClient,
    userId: string,
    reason: SessionRevocationReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    const { count } = await db.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: now, revocationReason: reason },
    });
    return count;
  }

  listActive(db: DbClient, userId: string, now: Date): Promise<SessionSummary[]> {
    return db.userSession.findMany({
      where: { userId, revokedAt: null, idleExpiresAt: { gt: now }, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        idleExpiresAt: true,
        expiresAt: true,
      },
    });
  }
}
