import { type PermissionKey, permissionKeySchema } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  EmailAlreadyTakenError,
  type NewUser,
  type UserAccess,
  UserRepository,
  type UserWithPasswordHash,
} from '../application/user.repository.js';
import type { UserRecord } from '../domain/user.js';

const USER_FIELDS = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  phone: true,
  phoneVerifiedAt: true,
  countryCode: true,
  locale: true,
  accountType: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class PrismaUserRepository extends UserRepository {
  findById(db: DbClient, userId: string): Promise<UserRecord | null> {
    return db.user.findUnique({ where: { id: userId }, select: USER_FIELDS });
  }

  findByEmail(db: DbClient, email: string): Promise<UserRecord | null> {
    return db.user.findUnique({ where: { email }, select: USER_FIELDS });
  }

  async findByEmailWithPasswordHash(
    db: DbClient,
    email: string,
  ): Promise<UserWithPasswordHash | null> {
    const found = await db.user.findUnique({
      where: { email },
      select: { ...USER_FIELDS, credential: { select: { passwordHash: true } } },
    });
    if (found === null) {
      return null;
    }
    const { credential, ...user } = found;
    return { user, passwordHash: credential?.passwordHash ?? null };
  }

  async findPasswordHash(db: DbClient, userId: string): Promise<string | null> {
    const credential = await db.userCredential.findUnique({
      where: { userId },
      select: { passwordHash: true },
    });
    return credential?.passwordHash ?? null;
  }

  async create(tx: DbClient, user: NewUser): Promise<UserRecord> {
    const { passwordHash, ...account } = user;
    try {
      return await tx.user.create({
        data: { ...account, credential: { create: { passwordHash } } },
        select: USER_FIELDS,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyTakenError();
      }
      throw error;
    }
  }

  async markEmailVerified(tx: DbClient, userId: string, now: Date): Promise<void> {
    await tx.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
    await tx.user.updateMany({
      where: { id: userId, status: 'PENDING_VERIFICATION' },
      data: { status: 'ACTIVE' },
    });
  }

  async updatePasswordHash(
    db: DbClient,
    userId: string,
    passwordHash: string,
    now: Date,
  ): Promise<void> {
    await db.userCredential.update({
      where: { userId },
      data: { passwordHash, passwordChangedAt: now },
    });
  }

  async replacePasswordHash(db: DbClient, userId: string, passwordHash: string): Promise<void> {
    await db.userCredential.update({ where: { userId }, data: { passwordHash } });
  }

  async findAccess(db: DbClient, userId: string): Promise<UserAccess> {
    const grants = await db.userRole.findMany({
      where: { userId },
      select: {
        role: { select: { key: true, permissions: { select: { permissionKey: true } } } },
      },
    });

    const roles = grants.map((grant) => grant.role.key).sort();
    // Une permission présente en base mais inconnue du code n'ouvre aucun droit.
    const permissions = new Set<PermissionKey>();
    for (const grant of grants) {
      for (const { permissionKey } of grant.role.permissions) {
        const parsed = permissionKeySchema.safeParse(permissionKey);
        if (parsed.success) {
          permissions.add(parsed.data);
        }
      }
    }
    return { roles, permissions: [...permissions].sort() };
  }

  async grantRole(
    tx: DbClient,
    userId: string,
    roleKey: string,
    grantedBy: string | null,
  ): Promise<void> {
    const role = await tx.role.findUnique({ where: { key: roleKey }, select: { id: true } });
    if (role === null) {
      throw new Error(`Unknown role "${roleKey}".`);
    }
    await tx.userRole.create({ data: { userId, roleId: role.id, grantedBy } });
  }
}
