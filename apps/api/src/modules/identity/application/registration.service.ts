import type {
  EmailOnlyRequest,
  RegisterRequest,
  VerificationPending,
  VerifyEmailRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { SECURITY_NOTICE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { isRegistrationCountry } from '../domain/registration-policy.js';
import type { ClientContext } from './client-context.js';
import { PasswordHasher } from './password-hasher.js';
import { assertAcceptablePassword } from './password-rules.js';
import { EmailAlreadyTakenError, UserRepository } from './user.repository.js';
import { invalidCodeError, VerificationService } from './verification.service.js';

/**
 * Inscription et vérification de l'adresse e-mail.
 *
 * Aucune réponse ne révèle si une adresse est déjà associée à un compte : la demande
 * d'inscription et le renvoi de code répondent toujours la même chose, et le titulaire d'un
 * compte existant est prévenu par e-mail.
 *
 * Un compte n'est activé que par la personne qui détient **à la fois** le code reçu dans la
 * boîte aux lettres et le mot de passe de l'inscription. Tant qu'il ne l'est pas, une
 * nouvelle inscription à la même adresse **remplace** entièrement la précédente. Un tiers ne
 * peut donc pas préparer un compte à l'adresse d'autrui — avec son mot de passe, son numéro —
 * et attendre que le titulaire de l'adresse l'active pour lui.
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly users: UserRepository,
    private readonly verification: VerificationService,
    private readonly hasher: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async register(request: RegisterRequest, client: ClientContext): Promise<VerificationPending> {
    if (!isRegistrationCountry(request.countryCode)) {
      throw new AppError(
        'COUNTRY_NOT_SUPPORTED',
        'Registration is not available in this country yet.',
      );
    }
    assertAcceptablePassword(request.password, request, 'password');
    this.verification.assertDeliveryAvailable();

    // Calculée avant toute lecture : le coût est le même que l'adresse soit déjà prise ou non.
    const passwordHash = await this.hasher.hash(request.password);

    try {
      await this.unitOfWork.run((tx) => this.createOrSignal(tx, request, passwordHash, client));
    } catch (error) {
      if (!(error instanceof EmailAlreadyTakenError)) {
        throw error;
      }
      // Deux inscriptions simultanées avec la même adresse : le compte existe désormais.
      await this.unitOfWork.run((tx) => this.createOrSignal(tx, request, passwordHash, client));
    }
    return this.pending();
  }

  async verifyEmail(request: VerifyEmailRequest, client: ClientContext): Promise<void> {
    const now = new Date();
    const user = await this.users.findByEmail(this.prisma, request.email);
    if (user === null) {
      throw invalidCodeError();
    }

    const failed = (reason: string): Promise<void> =>
      this.audit.record(this.prisma, {
        actor: { type: 'USER', id: user.id },
        action: 'user.email_verification_failed',
        resource: { type: 'user', id: user.id },
        outcome: 'FAILURE',
        ...client,
        metadata: { reason },
      });

    const challenge = await this.verification.check(
      user.id,
      'EMAIL_VERIFICATION',
      request.code,
      now,
    );
    // Le code ne vérifie que l'adresse à laquelle il a été envoyé.
    if (challenge?.target !== user.email) {
      await failed('WRONG_CODE');
      throw invalidCodeError();
    }

    // Le code prouve l'accès à la boîte aux lettres ; le mot de passe prouve que cette
    // personne est aussi celle qui s'est inscrite. Il n'est examiné qu'une fois le code
    // reconnu : cette route ne permet pas d'essayer des mots de passe sans lui.
    const passwordHash = await this.users.findPasswordHash(this.prisma, user.id);
    if (passwordHash === null || !(await this.hasher.verify(passwordHash, request.password))) {
      await failed('WRONG_PASSWORD');
      throw new AppError(
        'INVALID_CREDENTIALS',
        'The password is not the one chosen when signing up. Sign up again to choose a new one.',
      );
    }

    const verified = await this.unitOfWork.run(async (tx) => {
      if (!(await this.verification.consume(tx, challenge.id, now))) {
        return false;
      }
      await this.users.markEmailVerified(tx, user.id, now);
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.email_verified',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
      });
      return true;
    });
    if (!verified) {
      throw invalidCodeError();
    }
  }

  async resendEmailVerification(
    request: EmailOnlyRequest,
    client: ClientContext,
  ): Promise<VerificationPending> {
    this.verification.assertDeliveryAvailable();

    const user = await this.users.findByEmail(this.prisma, request.email);
    if (user?.status === 'PENDING_VERIFICATION') {
      await this.unitOfWork.run((tx) =>
        this.verification.request(tx, user, 'EMAIL_VERIFICATION', client),
      );
    }
    return this.pending();
  }

  private pending(): VerificationPending {
    return { nextStep: 'VERIFY_EMAIL', codeTtlSeconds: this.verification.codeTtlSeconds };
  }

  private async createOrSignal(
    tx: DbClient,
    request: RegisterRequest,
    passwordHash: string,
    client: ClientContext,
  ): Promise<void> {
    const existing = await this.users.findByEmail(tx, request.email);

    if (existing === null) {
      const user = await this.users.create(tx, {
        email: request.email,
        phone: request.phone ?? null,
        countryCode: request.countryCode,
        locale: request.locale ?? 'fr',
        accountType: 'INDIVIDUAL',
        status: 'PENDING_VERIFICATION',
        emailVerifiedAt: null,
        termsAcceptedAt: new Date(),
        passwordHash,
      });
      await this.verification.request(tx, user, 'EMAIL_VERIFICATION', client);
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.registered',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { countryCode: user.countryCode, accountType: user.accountType },
      });
      return;
    }

    if (existing.status === 'PENDING_VERIFICATION') {
      // Inscription restée inachevée : la nouvelle la remplace entièrement — mot de passe,
      // numéro, pays, langue, acceptation des conditions. Rien de ce qu'un précédent
      // demandeur a saisi ne subsiste, et seul le mot de passe d'aujourd'hui l'activera.
      const replaced = await this.users.replacePendingRegistration(tx, existing.id, {
        phone: request.phone ?? null,
        countryCode: request.countryCode,
        locale: request.locale ?? 'fr',
        termsAcceptedAt: new Date(),
        passwordHash,
      });
      if (replaced) {
        await this.verification.request(tx, existing, 'EMAIL_VERIFICATION', client);
        await this.audit.record(tx, {
          actor: { type: 'USER', id: existing.id },
          action: 'user.registration_replaced',
          resource: { type: 'user', id: existing.id },
          outcome: 'SUCCESS',
          ...client,
          metadata: { countryCode: request.countryCode },
        });
        return;
      }
    }

    // L'adresse appartient déjà à un compte : rien n'est créé et le mot de passe proposé est
    // ignoré. Seul le titulaire de la boîte aux lettres en est informé.
    await this.audit.record(tx, {
      actor: { type: 'SYSTEM' },
      action: 'user.registration_rejected',
      resource: { type: 'user', id: existing.id },
      outcome: 'DENIED',
      ...client,
      metadata: { reason: 'EMAIL_ALREADY_REGISTERED' },
    });

    if (existing.status === 'ACTIVE') {
      await this.outbox.append(tx, {
        aggregateType: 'user',
        aggregateId: existing.id,
        eventType: SECURITY_NOTICE_REQUESTED_EVENT,
        payload: { userId: existing.id, notice: 'ACCOUNT_ALREADY_EXISTS' },
        metadata: { requestId: client.requestId },
      });
    }
  }
}
