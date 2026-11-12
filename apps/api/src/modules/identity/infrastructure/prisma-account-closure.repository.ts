import type { AccountClosureOrigin, UserStatus } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import { sqlStateOf } from '../../../infrastructure/database/database-errors.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  AccountClosureRepository,
  type ClosureRecord,
  ClosureRuleViolationError,
  type LockedAccount,
  type NewClosure,
} from '../application/account-closure.repository.js';
import { closedAccountEmail } from '../domain/account-closure.js';

/** SQLSTATE levé par la base lorsqu'une règle de clôture est enfreinte (voir la migration). */
const CLOSURE_RULE_VIOLATION = 'MGX04';

const CLOSURE_FIELDS = {
  userId: true,
  closedAt: true,
  origin: true,
  closedBy: true,
  email: true,
  phone: true,
  legalRetentionUntil: true,
  erasureDueAt: true,
  erasedAt: true,
} as const satisfies Prisma.AccountClosureSelect;

async function refusedByDatabase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (sqlStateOf(error) === CLOSURE_RULE_VIOLATION) {
      throw new ClosureRuleViolationError({ cause: error });
    }
    throw error;
  }
}

@Injectable()
export class PrismaAccountClosureRepository extends AccountClosureRepository {
  async lockAccount(tx: DbClient, userId: string): Promise<LockedAccount | null> {
    // Le verrou d'abord, en une instruction ; les rôles ensuite : une attribution en cours a
    // dû attendre ce verrou, ou s'est achevée avant lui.
    const rows = await tx.$queryRaw<
      { status: UserStatus; email: string; phone: string | null; locale: string }[]
    >(Prisma.sql`
      SELECT "status"::text AS "status", "email", "phone", "locale"
      FROM "users"
      WHERE "id" = ${userId}::uuid
      FOR UPDATE
    `);
    const account = rows[0];
    if (account === undefined) {
      return null;
    }
    const roles = await tx.userRole.count({ where: { userId } });
    return { ...account, holdsRole: roles > 0 };
  }

  close(tx: DbClient, closure: NewClosure): Promise<number> {
    const { userId } = closure;
    return refusedByDatabase(async () => {
      // La trace d'abord : la base refuse de clôturer un compte qui n'en a pas.
      await tx.accountClosure.create({
        data: {
          userId,
          closedAt: closure.closedAt,
          origin: closure.origin,
          closedBy: closure.closedBy,
          email: closure.email,
          phone: closure.phone,
          legalRetentionUntil: closure.legalRetentionUntil,
          erasureDueAt: closure.erasureDueAt,
        },
      });
      // Puis tout ce que le compte portait : la base refuse de clôturer un compte qui garde un
      // secret, une session, un code ou un profil.
      await tx.userRecoveryCode.deleteMany({ where: { userId } });
      await tx.userTotpCredential.deleteMany({ where: { userId } });
      await tx.userCredential.deleteMany({ where: { userId } });
      await tx.verificationChallenge.deleteMany({ where: { userId } });
      await tx.userProfile.deleteMany({ where: { userId } });
      const sessions = await tx.userSession.deleteMany({ where: { userId } });
      // Enfin le compte lui-même : il perd son adresse et son numéro, pour toujours.
      const closed = await tx.user.updateMany({
        where: { id: userId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
        data: {
          status: 'CLOSED',
          email: closedAccountEmail(userId),
          emailVerifiedAt: null,
          phone: null,
          phoneVerifiedAt: null,
        },
      });
      if (closed.count !== 1) {
        throw new ClosureRuleViolationError();
      }
      return sessions.count;
    });
  }

  async find(db: DbClient, userId: string): Promise<ClosureRecord | null> {
    const found = await db.accountClosure.findUnique({
      where: { userId },
      select: CLOSURE_FIELDS,
    });
    return found === null ? null : toRecord(found);
  }

  async findByFormerIdentifier(
    db: DbClient,
    identifier: { readonly email?: string | undefined; readonly phone?: string | undefined },
    limit: number,
  ): Promise<string[]> {
    if (identifier.email === undefined && identifier.phone === undefined) {
      return [];
    }
    const rows = await db.accountClosure.findMany({
      where: {
        ...(identifier.email === undefined ? {} : { email: identifier.email }),
        ...(identifier.phone === undefined ? {} : { phone: identifier.phone }),
      },
      orderBy: [{ closedAt: 'desc' }, { userId: 'desc' }],
      take: limit,
      select: { userId: true },
    });
    return rows.map(({ userId }) => userId);
  }

  async findDueForErasure(db: DbClient, now: Date, limit: number): Promise<ClosureRecord[]> {
    const rows = await db.accountClosure.findMany({
      where: { erasedAt: null, erasureDueAt: { lte: now } },
      orderBy: [{ erasureDueAt: 'asc' }, { userId: 'asc' }],
      take: limit,
      select: CLOSURE_FIELDS,
    });
    return rows.map(toRecord);
  }

  markErased(tx: DbClient, userId: string, now: Date): Promise<boolean> {
    return refusedByDatabase(async () => {
      const { count } = await tx.accountClosure.updateMany({
        where: { userId, erasedAt: null },
        data: { erasedAt: now, email: null, phone: null },
      });
      return count === 1;
    });
  }
}

function toRecord(row: {
  userId: string;
  closedAt: Date;
  origin: AccountClosureOrigin;
  closedBy: string;
  email: string | null;
  phone: string | null;
  legalRetentionUntil: Date | null;
  erasureDueAt: Date;
  erasedAt: Date | null;
}): ClosureRecord {
  return { ...row };
}
