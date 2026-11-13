import { Injectable } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error.js';
import { AppConfig } from '../../../config/app-config.js';
import { type DbClient, PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { RedisRateLimiter } from '../../../infrastructure/rate-limit/redis-rate-limiter.js';
import { NotificationService } from '../../notifications/application/notification.service.js';
import type { NotificationChannel } from '../../notifications/domain/notification.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import { VERIFICATION_CODE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { VerificationCodes } from '../infrastructure/verification-codes.js';
import {
  type ChallengePurpose,
  type ChallengeRecord,
  ChallengeRepository,
} from './challenge.repository.js';
import type { ClientContext } from './client-context.js';
import { CODE_MAX_ATTEMPTS, CODE_REQUESTS_PER_ACCOUNT } from './identity-policy.js';

/**
 * Codes à usage unique : demande, vérification, consommation.
 *
 * Le code n'existe en clair qu'au moment de son envoi : il est tiré au sort par le
 * traitement asynchrone qui expédie le message, et seule son empreinte est conservée.
 * La réponse à la requête qui le demande ne dépend donc ni de l'envoi, ni de son délai.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly challenges: ChallengeRepository,
    private readonly codes: VerificationCodes,
    private readonly outbox: OutboxService,
    private readonly limiter: RedisRateLimiter,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  get codeTtlSeconds(): number {
    return this.config.auth.codeTtlSeconds;
  }

  /**
   * Refuse d'emblée un parcours qui dépend d'un message lorsqu'aucun moyen de remise n'est
   * configuré pour ce canal : mieux vaut une erreur claire qu'un utilisateur attendant un code
   * qui ne partira jamais.
   */
  assertDeliveryAvailable(channel: NotificationChannel = 'EMAIL'): void {
    if (!this.notifications.canDeliver(channel)) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Verification messages cannot be sent at the moment. Please try again later.',
      );
    }
  }

  /**
   * Ouvre un défi sur l'adresse e-mail du compte et programme l'envoi de son code, dans la
   * transaction de l'appelant.
   * @returns faux si trop de codes ont été demandés récemment pour ce compte (rien n'est fait).
   */
  async request(
    tx: DbClient,
    user: { readonly id: string; readonly email: string },
    purpose: ChallengePurpose,
    client: ClientContext,
  ): Promise<boolean> {
    const decision = await this.limiter.consume(
      this.requestsKey(purpose, user.id),
      CODE_REQUESTS_PER_ACCOUNT,
    );
    if (decision.blocked) {
      return false;
    }
    await this.open(tx, { userId: user.id, target: user.email }, purpose, client);
    return true;
  }

  /** Clé du compteur de codes demandés par un compte pour un usage. */
  requestsKey(purpose: ChallengePurpose, userId: string): string {
    return `verification-code:${purpose}:${userId}`;
  }

  /**
   * Ouvre un défi pour le destinataire désigné et programme l'envoi de son code, **sans
   * appliquer de limite** : l'appelant applique les siennes.
   */
  async open(
    tx: DbClient,
    recipient: { readonly userId: string; readonly target: string },
    purpose: ChallengePurpose,
    client: ClientContext,
  ): Promise<void> {
    const challengeId = await this.challenges.replaceActive(tx, {
      userId: recipient.userId,
      purpose,
      target: recipient.target,
      maxAttempts: CODE_MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + this.codeTtlSeconds * 1000),
    });
    await this.outbox.append(tx, {
      aggregateType: 'verification_challenge',
      aggregateId: challengeId,
      eventType: VERIFICATION_CODE_REQUESTED_EVENT,
      payload: { challengeId },
      metadata: { requestId: client.requestId },
    });
  }

  /**
   * Examine un code présenté. L'essai est **compté avant d'être examiné**, de façon
   * atomique et hors de toute transaction : il reste compté quoi qu'il arrive ensuite.
   *
   * @returns le défi si le code est le bon ; `null` dans tous les autres cas (aucun défi en
   *   cours, code pas encore émis, expiré, trop d'essais, code erroné), sans distinction.
   */
  async check(
    userId: string,
    purpose: ChallengePurpose,
    code: string,
    now: Date,
  ): Promise<ChallengeRecord | null> {
    const challenge = await this.challenges.findActive(this.prisma, userId, purpose);
    if (!challenge?.codeHash || challenge.expiresAt <= now) {
      return null;
    }
    if (!(await this.challenges.registerAttempt(this.prisma, challenge.id))) {
      return null;
    }
    return this.codes.matches(challenge.codeHash, challenge.id, code) ? challenge : null;
  }

  /** @returns faux si le défi a été utilisé entre-temps par une requête concurrente. */
  consume(tx: DbClient, challengeId: string, now: Date): Promise<boolean> {
    return this.challenges.consume(tx, challengeId, now);
  }
}

/** Erreur unique pour tout code refusé : sa cause n'est jamais précisée. */
export function invalidCodeError(): AppError {
  return new AppError('INVALID_OR_EXPIRED_CODE', 'The code is invalid or has expired.');
}
