import {
  type MfaStatus,
  type RecoveryCodes as RecoveryCodesView,
  type RecoveryCodesRegenerationRequest,
  type SecondFactorMethod,
  TOTP_PARAMETERS,
  type TotpConfirmationRequest,
  type TotpDisableRequest,
  type TotpEnrollment,
  type TotpEnrollmentRequest,
} from '@mgx/contracts';
import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { Clock } from '../../../common/clock.js';
import { AppError } from '../../../common/errors/app-error.js';
import { AppConfig } from '../../../config/app-config.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { SECURITY_NOTICE_REQUESTED_EVENT, type SecurityNotice } from '../domain/identity-events.js';
import { type SecondFactorProof, toSecondFactorProof } from '../domain/mfa-policy.js';
import { RecoveryCodes } from '../infrastructure/recovery-codes.js';
import { SecondFactorThrottle } from '../infrastructure/second-factor-throttle.js';
import { SecretCipher } from '../infrastructure/secret-cipher.js';
import {
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
} from '../infrastructure/totp.js';
import type { ClientContext } from './client-context.js';
import { TOTP_ENROLLMENT_TTL_MS } from './identity-policy.js';
import { MfaRepository, type TotpCredential } from './mfa.repository.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { SessionRepository } from './session.repository.js';
import { invalidCodeError } from './verification.service.js';

const PRODUCT = 'MG-Exchange';

function alreadyEnabled(): AppError {
  return new AppError('CONFLICT', 'Two-step verification is already enabled.');
}

function notEnabled(): AppError {
  return new AppError('CONFLICT', 'Two-step verification is not enabled.');
}

/**
 * Second facteur (validation en deux étapes) : application d'authentification (TOTP) et
 * codes de secours.
 *
 *  - l'activer, le désactiver ou renouveler les codes de secours exige le mot de passe ;
 *    le désactiver exige en plus une preuve du second facteur lui-même ;
 *  - un code n'est accepté qu'une fois ; les essais erronés sont bornés par compte, et le
 *    titulaire est prévenu lorsqu'ils bloquent la seconde étape : quelqu'un connaît son mot
 *    de passe ;
 *  - toute modification ferme les autres sessions et prévient le titulaire par e-mail ;
 *  - la réinitialisation du mot de passe ne désactive **pas** le second facteur : l'accès à
 *    la boîte aux lettres ne suffit pas à le contourner.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly mfa: MfaRepository,
    private readonly sessions: SessionRepository,
    private readonly reauthentication: ReauthenticationService,
    private readonly cipher: SecretCipher,
    private readonly recoveryCodes: RecoveryCodes,
    private readonly throttle: SecondFactorThrottle,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfig,
  ) {}

  /** Vrai si la connexion à ce compte exige une seconde étape. */
  isEnabled(userId: string): Promise<boolean> {
    return this.mfa.isTotpEnabled(this.prisma, userId);
  }

  async status(userId: string): Promise<MfaStatus> {
    const totp = await this.mfa.findTotp(this.prisma, userId);
    const enabledAt = totp?.confirmedAt ?? null;
    return {
      totp: { enabled: enabledAt !== null, enabledAt: enabledAt?.toISOString() ?? null },
      recoveryCodesRemaining:
        enabledAt === null ? 0 : await this.mfa.countUnusedRecoveryCodes(this.prisma, userId),
    };
  }

  /**
   * Première étape de l'activation : crée le secret à enregistrer dans l'application
   * d'authentification. Rien n'est exigé à la connexion tant qu'un premier code n'a pas
   * confirmé que l'application est bien configurée.
   */
  async startTotpEnrollment(
    auth: AuthenticatedUser,
    request: TotpEnrollmentRequest,
    client: ClientContext,
  ): Promise<TotpEnrollment> {
    const user = await this.reauthentication.confirmPassword(
      auth,
      request.currentPassword,
      client,
      'mfa.enrollment_failed',
    );

    const secret = generateTotpSecret();
    const saved = await this.mfa.savePendingTotp(
      this.prisma,
      user.id,
      this.cipher.encrypt(secret, this.secretContext(user.id)),
    );
    if (!saved) {
      throw alreadyEnabled();
    }
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', id: user.id },
      action: 'mfa.enrollment_started',
      resource: { type: 'user', id: user.id },
      outcome: 'SUCCESS',
      ...client,
      metadata: { method: 'TOTP' },
    });

    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri({ issuer: this.issuer, accountName: user.email, secret }),
      ...TOTP_PARAMETERS,
    };
  }

  /**
   * Seconde étape de l'activation : un code valide prouve que l'application d'authentification
   * détient le secret. Le second facteur est dès lors exigé à chaque connexion ; les codes de
   * secours sont remis — une seule fois.
   */
  async confirmTotpEnrollment(
    auth: AuthenticatedUser,
    request: TotpConfirmationRequest,
    client: ClientContext,
  ): Promise<RecoveryCodesView> {
    const pending = await this.mfa.findTotp(this.prisma, auth.userId);
    if (pending === null) {
      throw new AppError('CONFLICT', 'No two-step verification setup is in progress.');
    }
    if (pending.confirmedAt !== null) {
      throw alreadyEnabled();
    }
    // Un enrôlement se confirme dans la foulée. Passé ce délai il faut le recommencer, donc
    // présenter à nouveau le mot de passe : une session dérobée ne peut pas s'acharner sur un
    // enrôlement abandonné.
    if (Date.now() - pending.createdAt.getTime() > TOTP_ENROLLMENT_TTL_MS) {
      throw new AppError(
        'CONFLICT',
        'The two-step verification setup has expired. Please start it again.',
      );
    }

    // Les essais sont bornés ici aussi : deviner le code d'un enrôlement resté inachevé
    // livrerait des codes de secours à qui ne détient pas le secret.
    await this.assertNotBlocked(auth.userId);
    const step = matchTotpStep(this.secretOf(pending), request.code, this.clock.now(), null);
    if (step === null) {
      await this.recordFailure(auth.userId, 'TOTP', client, 'mfa.enrollment_failed', false);
      throw invalidCodeError();
    }

    const codes = this.recoveryCodes.generate();
    const now = new Date();
    const confirmed = await this.unitOfWork.run(async (tx) => {
      if (!(await this.mfa.confirmTotp(tx, auth.userId, step, now))) {
        return false;
      }
      await this.mfa.replaceRecoveryCodes(tx, auth.userId, this.hashesOf(auth.userId, codes));
      // Les sessions ouvertes avec le seul mot de passe sont fermées : elles n'ont jamais
      // franchi la seconde étape.
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        auth.userId,
        'SECOND_FACTOR_CHANGED',
        now,
        auth.sessionId,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: auth.userId },
        action: 'mfa.enabled',
        resource: { type: 'user', id: auth.userId },
        outcome: 'SUCCESS',
        ...client,
        metadata: { method: 'TOTP', revokedSessions },
      });
      await this.notify(tx, auth.userId, 'TWO_FACTOR_ENABLED', client);
      return true;
    });
    if (!confirmed) {
      throw alreadyEnabled();
    }
    await this.throttle.clear(auth.userId);

    return { recoveryCodes: codes.map((code) => this.recoveryCodes.format(code)) };
  }

  async disableTotp(
    auth: AuthenticatedUser,
    request: TotpDisableRequest,
    client: ClientContext,
  ): Promise<void> {
    const user = await this.reauthentication.confirmPassword(
      auth,
      request.currentPassword,
      client,
      'mfa.disable_failed',
    );
    const proof = toSecondFactorProof(request);
    if (proof === null || !(await this.isEnabled(user.id))) {
      throw notEnabled();
    }
    await this.assertSecondFactor(user.id, proof, client, 'mfa.disable_failed');

    const now = new Date();
    await this.unitOfWork.run(async (tx) => {
      await this.mfa.deleteTotp(tx, user.id);
      const revokedSessions = await this.sessions.revokeAllForUser(
        tx,
        user.id,
        'SECOND_FACTOR_CHANGED',
        now,
        auth.sessionId,
      );
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'mfa.disabled',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
        metadata: { method: 'TOTP', revokedSessions },
      });
      await this.notify(tx, user.id, 'TWO_FACTOR_DISABLED', client);
    });
    await this.throttle.clear(user.id);
  }

  /** Remplace les codes de secours : les précédents cessent tous de fonctionner. */
  async regenerateRecoveryCodes(
    auth: AuthenticatedUser,
    request: RecoveryCodesRegenerationRequest,
    client: ClientContext,
  ): Promise<RecoveryCodesView> {
    const failureAction = 'mfa.recovery_codes_regeneration_failed';
    const user = await this.reauthentication.confirmPassword(
      auth,
      request.currentPassword,
      client,
      failureAction,
    );
    if (!(await this.isEnabled(user.id))) {
      throw notEnabled();
    }
    await this.assertSecondFactor(
      user.id,
      { method: 'TOTP', code: request.code },
      client,
      failureAction,
    );

    const codes = this.recoveryCodes.generate();
    await this.unitOfWork.run(async (tx) => {
      await this.mfa.replaceRecoveryCodes(tx, user.id, this.hashesOf(user.id, codes));
      await this.audit.record(tx, {
        actor: { type: 'USER', id: user.id },
        action: 'mfa.recovery_codes_regenerated',
        resource: { type: 'user', id: user.id },
        outcome: 'SUCCESS',
        ...client,
      });
    });
    return { recoveryCodes: codes.map((code) => this.recoveryCodes.format(code)) };
  }

  /**
   * Exige une preuve valide du second facteur. Une preuve acceptée est **consommée** : le
   * même code ne sera pas accepté une seconde fois.
   *
   * @param failureAction action inscrite au journal d'audit si la preuve est refusée.
   * @throws AppError `INVALID_OR_EXPIRED_CODE` si la preuve est refusée ; `RATE_LIMITED`
   *   après trop d'essais erronés sur ce compte.
   */
  async assertSecondFactor(
    userId: string,
    proof: SecondFactorProof,
    client: ClientContext,
    failureAction: string,
  ): Promise<SecondFactorMethod> {
    await this.assertNotBlocked(userId);
    if (!(await this.accepts(userId, proof, client))) {
      await this.recordFailure(userId, proof.method, client, failureAction, true);
      throw invalidCodeError();
    }
    await this.throttle.recordSuccess(userId);
    return proof.method;
  }

  private async accepts(
    userId: string,
    proof: SecondFactorProof,
    client: ClientContext,
  ): Promise<boolean> {
    const totp = await this.mfa.findTotp(this.prisma, userId);
    if (totp === null) {
      return false;
    }
    if (totp.confirmedAt === null) {
      // Enrôlement inachevé : il n'y a pas encore de second facteur à présenter.
      return false;
    }
    if (proof.method === 'RECOVERY_CODE') {
      return this.useRecoveryCode(userId, proof.code, client);
    }
    const step = matchTotpStep(
      this.secretOf(totp),
      proof.code,
      this.clock.now(),
      totp.lastUsedStep,
    );
    return step !== null && (await this.mfa.markTotpStepUsed(this.prisma, userId, step));
  }

  /**
   * Consomme un code de secours. Il ne sert qu'en l'absence de l'application
   * d'authentification : son usage est inscrit au journal et signalé au titulaire, avec le
   * nombre de codes qu'il lui reste — dans la transaction qui le consomme.
   */
  private useRecoveryCode(userId: string, code: string, client: ClientContext): Promise<boolean> {
    return this.unitOfWork.run(async (tx) => {
      const hash = this.recoveryCodes.hash(userId, code);
      if (!(await this.mfa.useRecoveryCode(tx, userId, hash, new Date()))) {
        return false;
      }
      const remaining = await this.mfa.countUnusedRecoveryCodes(tx, userId);
      await this.audit.record(tx, {
        actor: { type: 'USER', id: userId },
        action: 'mfa.recovery_code_used',
        resource: { type: 'user', id: userId },
        outcome: 'SUCCESS',
        ...client,
        metadata: { remaining },
      });
      await this.notify(tx, userId, 'RECOVERY_CODE_USED', client, { remaining });
      return true;
    });
  }

  private async assertNotBlocked(userId: string): Promise<void> {
    const blockedFor = await this.throttle.blockedForSeconds(userId);
    if (blockedFor > 0) {
      throw new AppError('RATE_LIMITED', 'Too many incorrect codes. Please try again later.', {
        retryAfterSeconds: blockedFor,
      });
    }
  }

  /**
   * @param secondFactorInPlace vrai si l'échec porte sur un second facteur déjà activé : le
   *   blocage qu'il déclenche est alors signalé au titulaire — quelqu'un connaît son mot de passe.
   */
  private async recordFailure(
    userId: string,
    method: SecondFactorMethod,
    client: ClientContext,
    action: string,
    secondFactorInPlace: boolean,
  ): Promise<void> {
    const blockedSeconds = await this.throttle.recordFailure(userId);
    await this.unitOfWork.run(async (tx) => {
      await this.audit.record(tx, {
        actor: { type: 'USER', id: userId },
        action,
        resource: { type: 'user', id: userId },
        outcome: 'FAILURE',
        ...client,
        metadata: { reason: 'WRONG_SECOND_FACTOR', method, blockedSeconds },
      });
      if (blockedSeconds > 0 && secondFactorInPlace) {
        await this.notify(tx, userId, 'SECOND_FACTOR_BLOCKED', client, {
          blockedMinutes: Math.ceil(blockedSeconds / 60),
        });
      }
    });
  }

  private async notify(
    tx: DbClient,
    userId: string,
    notice: SecurityNotice,
    client: ClientContext,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.outbox.append(tx, {
      aggregateType: 'user',
      aggregateId: userId,
      eventType: SECURITY_NOTICE_REQUESTED_EVENT,
      payload: { userId, notice, details },
      metadata: { requestId: client.requestId },
    });
  }

  private hashesOf(userId: string, codes: readonly string[]) {
    return codes.map((code) => this.recoveryCodes.hash(userId, code));
  }

  private secretOf(credential: TotpCredential): Buffer {
    return this.cipher.decrypt(credential.secretCiphertext, this.secretContext(credential.userId));
  }

  /** Contexte authentifié avec le secret chiffré : il ne se déchiffre que pour ce compte. */
  private secretContext(userId: string): string {
    return `totp:${userId}`;
  }

  /** Nom affiché par l'application d'authentification ; il distingue les environnements. */
  private get issuer(): string {
    return this.config.isProduction ? PRODUCT : `${PRODUCT} (${this.config.app.environment})`;
  }
}
