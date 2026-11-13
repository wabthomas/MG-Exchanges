import type { CurrentUser } from '@mgx/contracts';
import { localeSchema } from '@mgx/validation';
import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import type { UserRecord } from '../domain/user.js';
import { MfaRepository } from './mfa.repository.js';
import { TermsService } from './terms.service.js';
import { UserRepository } from './user.repository.js';
import { VerificationStatusReader } from './verification-status.reader.js';

/** Présentation d'un compte à son titulaire. */
@Injectable()
export class AccountService {
  constructor(
    private readonly users: UserRepository,
    private readonly mfa: MfaRepository,
    private readonly verification: VerificationStatusReader,
    private readonly terms: TermsService,
    private readonly prisma: PrismaService,
  ) {}

  async getCurrent(userId: string): Promise<CurrentUser> {
    const user = await this.users.findById(this.prisma, userId);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }
    return this.describe(user);
  }

  async describe(user: UserRecord): Promise<CurrentUser> {
    const [access, secondFactorEnabled, verificationLevel, terms] = await Promise.all([
      this.users.findAccess(this.prisma, user.id),
      this.mfa.isTotpEnabled(this.prisma, user.id),
      this.verification.level(this.prisma, user.id),
      this.terms.accountTerms(this.prisma, user.id),
    ]);
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      phone: user.phone,
      phoneVerified: user.phoneVerifiedAt !== null,
      countryCode: user.countryCode,
      locale: localeSchema.catch('fr').parse(user.locale),
      accountType: user.accountType,
      status: user.status,
      roles: [...access.roles],
      permissions: [...access.permissions],
      secondFactorEnabled,
      verificationLevel,
      termsAcceptanceRequired: terms.acceptanceRequired,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
