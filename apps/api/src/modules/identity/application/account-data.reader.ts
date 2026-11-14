import type { AccountType, UserStatus } from '@mgx/contracts';

import type { DbClient } from '../../../infrastructure/database/prisma.service.js';
import type { ProfileRecord } from './profile.repository.js';

/** Ce que l'identité détient sur un compte, pour la copie remise à son titulaire. */
export interface AccountData {
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly emailVerifiedAt: Date | null;
    readonly phone: string | null;
    readonly phoneVerifiedAt: Date | null;
    readonly countryCode: string;
    readonly locale: string;
    readonly accountType: AccountType;
    readonly status: UserStatus;
    readonly createdAt: Date;
    readonly roles: readonly string[];
  };
  readonly profile: ProfileRecord | null;
  readonly security: {
    readonly passwordChangedAt: Date | null;
    /** Date d'activation du second facteur ; `null` s'il n'est pas activé. */
    readonly secondFactorEnabledAt: Date | null;
    readonly recoveryCodesRemaining: number;
  };
  /** Sessions encore enregistrées, de la plus récente à la plus ancienne. */
  readonly sessions: readonly {
    readonly id: string;
    readonly createdAt: Date;
    readonly lastUsedAt: Date;
    readonly expiresAt: Date;
    readonly revokedAt: Date | null;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly deviceName: string | null;
  }[];
}

/**
 * Lecture de tout ce que l'identité détient sur un compte. Lecture seule ; ne donne jamais
 * accès à un secret d'authentification, ni à son empreinte.
 */
export abstract class AccountDataReader {
  abstract read(db: DbClient, userId: string): Promise<AccountData | null>;
}
