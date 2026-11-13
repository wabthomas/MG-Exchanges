import { createHash } from 'node:crypto';

import type {
  PhoneVerificationPending,
  PhoneVerificationRequest,
  VerifyPhoneRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { isVerifiablePhoneNumber, maskPhoneNumber } from '../domain/phone-policy.js';
import type { ClientContext } from './client-context.js';
import { CODE_REQUESTS_PER_ACCOUNT, SMS_CODES_PER_NUMBER } from './identity-policy.js';
import { PhoneAlreadyVerifiedError, UserRepository } from './user.repository.js';
import { invalidCodeError, VerificationService } from './verification.service.js';

function tooManyCodes(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 'Too many codes requested. Please try again later.', {
    retryAfterSeconds,
  });
}

/**
 * Vérification du numéro de téléphone par un code envoyé par SMS.
 *
 * Le numéro du compte ne change qu'**une fois le nouveau numéro vérifié** : un numéro déjà
 * vérifié reste en place tant que la vérification du suivant n'a pas abouti. Un numéro vérifié
 * n'appartient qu'à un seul compte — ce que seule la personne qui reçoit le SMS peut apprendre.
 */
@Injectable()
export class PhoneService {
  constructor(
    private readonly users: UserRepository,
    private readonly verification: VerificationService,
    private readonly limiter: RedisRateLimiter,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async requestVerification(
    auth: AuthenticatedUser,
    request: PhoneVerificationRequest,
    client: ClientContext,
  ): Promise<PhoneVerificationPending> {
    if (!isVerifiablePhoneNumber(request.phone)) {
      throw new AppError(
        'COUNTRY_NOT_SUPPORTED',
        'Only mobile numbers of supported countries can be verified (currently DR Congo, +243).',
      );
    }
    this.verification.assertDeliveryAvailable('SMS');

    const user = await this.users.findById(this.prisma, auth.userId);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }
    if (user.phone === request.phone && user.phoneVerifiedAt !== null) {
      throw new AppError('CONFLICT', 'This phone number is already verified on your account.');
    }

    // Un SMS a un coût et dérange son destinataire : les envois sont bornés par compte, et
    // par numéro quel que soit le compte qui les demande.
    const perAccount = await this.limiter.consume(
      this.verification.requestsKey('PHONE_VERIFICATION', user.id),
      CODE_REQUESTS_PER_ACCOUNT,
    );
    if (perAccount.blocked) {
      throw tooManyCodes(perAccount.retryAfterSeconds);
    }
    const numberDigest = createHash('sha256').update(request.phone, 'utf8').digest('hex');
    const perNumber = await this.limiter.consume(
      `sms-codes:${numberDigest.slice(0, 32)}`,
      SMS_CODES_PER_NUMBER,
    );
    if (perNumber.blocked) {
      throw tooManyCodes(perNumber.retryAfterSeconds);
    }

    await this.unitOfWork.run(async (tx) => {
      await this.verification.open(
        tx,
        { userId: user.id, target: request.phone },
        'PHONE_VERIFICATION',
        client,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'user.phone_verification_requested',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { phone: maskPhoneNumber(request.phone) },
      });
    });
    return { nextStep: 'VERIFY_PHONE', codeTtlSeconds: this.verification.codeTtlSeconds };
  }

  async verify(
    auth: AuthenticatedUser,
    request: VerifyPhoneRequest,
    client: ClientContext,
  ): Promise<void> {
    const failed = (reason: string): Promise<void> =>
      this.audit.record(this.prisma, {
        actor: { type: 'USER', id: auth.userId },
        action: 'user.phone_verification_failed',
        resource: { type: 'user', id: auth.userId },
        outcome: 'FAILURE',
        ...client,
        metadata: { reason },
      });

    const now = new Date();
    const challenge = await this.verification.check(
      auth.userId,
      'PHONE_VERIFICATION',
      request.code,
      now,
    );
    if (challenge === null) {
      await failed('WRONG_CODE');
      throw invalidCodeError();
    }

    let verified: boolean;
    try {
      verified = await this.unitOfWork.run(async (tx) => {
        if (!(await this.verification.consume(tx, challenge.id, now))) {
          return false;
        }
        // Le numéro vérifié est celui auquel le code a été envoyé — et lui seul.
        await this.users.setVerifiedPhone(tx, auth.userId, challenge.target, now);
        await this.audit.record(tx, {
          actor: { type: 'USER', id: auth.userId },
          action: 'user.phone_verified',
          resource: { type: 'user', id: auth.userId },
          outcome: 'SUCCESS',
          ...client,
          metadata: { phone: maskPhoneNumber(challenge.target) },
        });
        return true;
      });
    } catch (error) {
      if (!(error instanceof PhoneAlreadyVerifiedError)) {
        throw error;
      }
      // Seule la personne qui a reçu le SMS — donc qui détient ce numéro — apprend qu'il est
      // déjà rattaché à un autre compte.
      await failed('PHONE_ALREADY_IN_USE');
      throw new AppError(
        'CONFLICT',
        'This phone number is already verified on another account. Please contact support.',
      );
    }
    if (!verified) {
      throw invalidCodeError();
    }
  }
}
