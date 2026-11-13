import type { AccountType, UserStatus } from '@mgx/contracts';

/** Compte utilisateur tel que manipulé par l'application (jamais son secret d'authentification). */
export interface UserRecord {
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
}

/** Seul un compte actif peut ouvrir ou utiliser une session. */
export function canUseSessions(status: UserStatus): boolean {
  return status === 'ACTIVE';
}
