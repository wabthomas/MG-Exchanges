import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client.js';
import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import {
  type DirectoryEntry,
  type DirectoryFilter,
  UserDirectory,
} from '../application/user-directory.js';

const ENTRY_FIELDS = {
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
  updatedAt: true,
  roles: { select: { role: { select: { key: true } } } },
  totp: { select: { confirmedAt: true } },
} as const satisfies Prisma.UserSelect;

type EntryRow = Prisma.UserGetPayload<{ select: typeof ENTRY_FIELDS }>;

function toEntry({ roles, totp, ...account }: EntryRow): DirectoryEntry {
  return {
    ...account,
    roles: roles.map(({ role }) => role.key).sort(),
    secondFactorEnabled: totp !== null && totp.confirmedAt !== null,
  };
}

@Injectable()
export class PrismaUserDirectory extends UserDirectory {
  async search(db: DbClient, filter: DirectoryFilter): Promise<DirectoryEntry[]> {
    const rows = await db.user.findMany({
      where: {
        ...(filter.email === undefined ? {} : { email: filter.email }),
        ...(filter.phone === undefined ? {} : { phone: filter.phone }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
        // Les identifiants (UUID v7) suivent l'ordre de création : ils servent de curseur.
        id: {
          ...(filter.id === undefined ? {} : { equals: filter.id }),
          ...(filter.before === undefined ? {} : { lt: filter.before }),
        },
      },
      orderBy: { id: 'desc' },
      take: filter.limit,
      select: ENTRY_FIELDS,
    });
    return rows.map(toEntry);
  }

  async find(db: DbClient, userId: string): Promise<DirectoryEntry | null> {
    const row = await db.user.findUnique({ where: { id: userId }, select: ENTRY_FIELDS });
    return row === null ? null : toEntry(row);
  }
}
