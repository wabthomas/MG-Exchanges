import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfig } from '../../config/app-config.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { AccountService } from './application/account.service.js';
import { AuthenticationService } from './application/authentication.service.js';
import { AuthorizationService } from './application/authorization.service.js';
import { ChallengeRepository } from './application/challenge.repository.js';
import { PasswordHasher } from './application/password-hasher.js';
import { PasswordService } from './application/password.service.js';
import { RegistrationService } from './application/registration.service.js';
import { SecurityNoticeDispatcher } from './application/security-notice.dispatcher.js';
import { SessionRepository } from './application/session.repository.js';
import { SessionService } from './application/session.service.js';
import { UserRepository } from './application/user.repository.js';
import { VerificationCodeDispatcher } from './application/verification-code.dispatcher.js';
import { VerificationService } from './application/verification.service.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { LoginThrottle } from './infrastructure/login-throttle.js';
import { PrismaChallengeRepository } from './infrastructure/prisma-challenge.repository.js';
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository.js';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository.js';
import { VerificationCodes } from './infrastructure/verification-codes.js';
import { AuthController } from './presentation/auth.controller.js';
import { AuthenticationGuard } from './presentation/authentication.guard.js';
import { MeController } from './presentation/me.controller.js';
import { PermissionsGuard } from './presentation/permissions.guard.js';

/**
 * Identité : comptes, authentification, sessions, autorisations du back-office.
 *
 * Ce module installe les deux gardes globales d'accès — authentification (refus par
 * défaut), puis permissions. Elles s'exécutent après la limitation de débit et la garde
 * de maintenance (ordre d'import des modules dans `AppModule`).
 */
@Module({
  imports: [AuditModule, OutboxModule, NotificationsModule, RateLimitModule],
  controllers: [AuthController, MeController],
  providers: [
    { provide: UserRepository, useClass: PrismaUserRepository },
    { provide: SessionRepository, useClass: PrismaSessionRepository },
    { provide: ChallengeRepository, useClass: PrismaChallengeRepository },
    {
      provide: PasswordHasher,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PasswordHasher =>
        new Argon2PasswordHasher(config.auth.passwordHash),
    },
    VerificationCodes,
    LoginThrottle,
    VerificationService,
    AccountService,
    RegistrationService,
    AuthenticationService,
    SessionService,
    PasswordService,
    AuthorizationService,
    VerificationCodeDispatcher,
    SecurityNoticeDispatcher,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthenticationService, AuthorizationService, AccountService],
})
export class IdentityModule {}
