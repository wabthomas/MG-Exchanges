import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { Clock, SystemClock } from '../../common/clock.js';
import { AppConfig } from '../../config/app-config.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { AccountClosureRepository } from './application/account-closure.repository.js';
import { AccountClosureService } from './application/account-closure.service.js';
import { AccountDataReader } from './application/account-data.reader.js';
import { AccountDataRegistry } from './application/account-data.registry.js';
import { AccountErasure } from './application/account-erasure.js';
import { AccountMaintenanceService } from './application/account-maintenance.service.js';
import { AccountService } from './application/account.service.js';
import { AdminUsersService } from './application/admin-users.service.js';
import { ActivityService } from './application/activity.service.js';
import { AuthenticationService } from './application/authentication.service.js';
import { AuthorizationService } from './application/authorization.service.js';
import { ChallengeRepository } from './application/challenge.repository.js';
import { DataExportService } from './application/data-export.service.js';
import { HolderProofService } from './application/holder-proof.service.js';
import { MaintenanceStepRegistry } from './application/maintenance-step.registry.js';
import { MfaRepository } from './application/mfa.repository.js';
import { MfaService } from './application/mfa.service.js';
import { PasswordHasher } from './application/password-hasher.js';
import { PasswordService } from './application/password.service.js';
import { PendingLoginStore } from './application/pending-login.store.js';
import { PhoneService } from './application/phone.service.js';
import { ProfileRepository } from './application/profile.repository.js';
import { ProfileService } from './application/profile.service.js';
import { PublishedEventsPurge } from './application/published-events-purge.js';
import { ReauthenticationService } from './application/reauthentication.service.js';
import { RegistrationService } from './application/registration.service.js';
import { RoleChangeRepository } from './application/role-change.repository.js';
import { RoleChangeService } from './application/role-change.service.js';
import { SecurityNoticeDispatcher } from './application/security-notice.dispatcher.js';
import { SessionRepository } from './application/session.repository.js';
import { SessionService } from './application/session.service.js';
import { UserDirectory } from './application/user-directory.js';
import { UserRepository } from './application/user.repository.js';
import { VerificationCodeDispatcher } from './application/verification-code.dispatcher.js';
import { VerificationStatusReader } from './application/verification-status.reader.js';
import { VerificationService } from './application/verification.service.js';
import { AccountMaintenanceProcessor } from './infrastructure/account-maintenance.processor.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher.js';
import { LoginThrottle } from './infrastructure/login-throttle.js';
import { PrismaAccountClosureRepository } from './infrastructure/prisma-account-closure.repository.js';
import { PrismaAccountDataReader } from './infrastructure/prisma-account-data.reader.js';
import { PrismaChallengeRepository } from './infrastructure/prisma-challenge.repository.js';
import { PrismaMfaRepository } from './infrastructure/prisma-mfa.repository.js';
import { PrismaProfileRepository } from './infrastructure/prisma-profile.repository.js';
import { PrismaRoleChangeRepository } from './infrastructure/prisma-role-change.repository.js';
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository.js';
import { PrismaUserDirectory } from './infrastructure/prisma-user-directory.js';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository.js';
import { PrismaVerificationStatusReader } from './infrastructure/prisma-verification-status.reader.js';
import { RecoveryCodes } from './infrastructure/recovery-codes.js';
import { RedisPendingLoginStore } from './infrastructure/redis-pending-login.store.js';
import { SecondFactorThrottle } from './infrastructure/second-factor-throttle.js';
import { SecretCipher } from './infrastructure/secret-cipher.js';
import { VerificationCodes } from './infrastructure/verification-codes.js';
import { AccountLifecycleController } from './presentation/account-lifecycle.controller.js';
import { AdminRolesController } from './presentation/admin-roles.controller.js';
import { AdminUsersController } from './presentation/admin-users.controller.js';
import { AuthController } from './presentation/auth.controller.js';
import { AuthenticationGuard } from './presentation/authentication.guard.js';
import { MeController } from './presentation/me.controller.js';
import { MfaController } from './presentation/mfa.controller.js';
import { PermissionsGuard } from './presentation/permissions.guard.js';
import { ProfileController } from './presentation/profile.controller.js';

/**
 * Identité : comptes, authentification, second facteur, sessions, profil, autorisations et
 * administration des comptes par le back-office, copie des données, clôture et effacement,
 * purge périodique.
 *
 * Ce module installe les deux gardes globales d'accès — authentification (refus par
 * défaut), puis permissions. Elles s'exécutent après la limitation de débit et la garde
 * de maintenance (ordre d'import des modules dans `AppModule`).
 */
@Module({
  imports: [AuditModule, OutboxModule, NotificationsModule, RateLimitModule],
  controllers: [
    AuthController,
    MeController,
    MfaController,
    ProfileController,
    AccountLifecycleController,
    AdminUsersController,
    AdminRolesController,
  ],
  providers: [
    { provide: UserRepository, useClass: PrismaUserRepository },
    { provide: SessionRepository, useClass: PrismaSessionRepository },
    { provide: ChallengeRepository, useClass: PrismaChallengeRepository },
    { provide: MfaRepository, useClass: PrismaMfaRepository },
    { provide: ProfileRepository, useClass: PrismaProfileRepository },
    { provide: UserDirectory, useClass: PrismaUserDirectory },
    { provide: RoleChangeRepository, useClass: PrismaRoleChangeRepository },
    { provide: VerificationStatusReader, useClass: PrismaVerificationStatusReader },
    { provide: AccountClosureRepository, useClass: PrismaAccountClosureRepository },
    { provide: AccountDataReader, useClass: PrismaAccountDataReader },
    { provide: PendingLoginStore, useClass: RedisPendingLoginStore },
    { provide: Clock, useClass: SystemClock },
    {
      provide: PasswordHasher,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PasswordHasher =>
        new Argon2PasswordHasher(config.auth.passwordHash),
    },
    VerificationCodes,
    RecoveryCodes,
    SecretCipher,
    LoginThrottle,
    SecondFactorThrottle,
    VerificationService,
    ReauthenticationService,
    AccountService,
    MfaService,
    RegistrationService,
    AuthenticationService,
    SessionService,
    PasswordService,
    ProfileService,
    PhoneService,
    ActivityService,
    AuthorizationService,
    AdminUsersService,
    RoleChangeService,
    MaintenanceStepRegistry,
    AccountDataRegistry,
    HolderProofService,
    AccountClosureService,
    DataExportService,
    AccountErasure,
    PublishedEventsPurge,
    AccountMaintenanceService,
    AccountMaintenanceProcessor,
    VerificationCodeDispatcher,
    SecurityNoticeDispatcher,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [
    AuthenticationService,
    AuthorizationService,
    AccountService,
    // À l'usage du module de vérification d'identité, qui s'appuie sur les comptes.
    Clock,
    UserRepository,
    UserDirectory,
    VerificationStatusReader,
    MaintenanceStepRegistry,
    AccountDataRegistry,
  ],
})
export class IdentityModule {}
