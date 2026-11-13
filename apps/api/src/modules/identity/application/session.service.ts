import type { SessionList } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { ClientContext } from './client-context.js';
import { SessionRepository } from './session.repository.js';

/** Gestion de ses propres sessions par l'utilisateur (« mes appareils »). */
@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: AuthenticatedUser): Promise<SessionList> {
    const sessions = await this.sessions.listActive(this.prisma, auth.userId, new Date());
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === auth.sessionId,
        deviceName: session.deviceName,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
        // Première des deux échéances : inactivité ou durée de vie maximale.
        expiresAt: new Date(
          Math.min(session.idleExpiresAt.getTime(), session.expiresAt.getTime()),
        ).toISOString(),
      })),
    };
  }

  /** Ferme l'une de ses sessions. Une session d'un autre compte est, pour l'appelant, inexistante. */
  async revoke(auth: AuthenticatedUser, sessionId: string, client: ClientContext): Promise<void> {
    const now = new Date();
    const revoked = await this.unitOfWork.run(async (tx) => {
      const done = await this.sessions.revoke(
        tx,
        { sessionId, userId: auth.userId },
        sessionId === auth.sessionId ? 'LOGOUT' : 'USER_REVOKED',
        now,
      );
      if (done) {
        await this.audit.record(tx, {
          actor: { type: 'USER', id: auth.userId },
          action: 'session.revoked',
          resource: { type: 'session', id: sessionId },
          outcome: 'SUCCESS',
          ...client,
        });
      }
      return done;
    });
    if (!revoked) {
      throw new AppError('NOT_FOUND', 'Session not found.');
    }
  }

  /** Ferme toutes ses autres sessions. @returns leur nombre. */
  async revokeOthers(auth: AuthenticatedUser, client: ClientContext): Promise<number> {
    const now = new Date();
    return this.unitOfWork.run(async (tx) => {
      const count = await this.sessions.revokeAllForUser(
        tx,
        auth.userId,
        'USER_REVOKED',
        now,
        auth.sessionId,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: auth.userId },
        action: 'session.others_revoked',
        resource: { type: 'user', id: auth.userId },
        outcome: 'SUCCESS',
        ...client,
        metadata: { revokedCount: count },
      });
      return count;
    });
  }
}
