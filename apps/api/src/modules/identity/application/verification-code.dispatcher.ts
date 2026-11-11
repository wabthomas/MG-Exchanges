import { localeSchema } from '@mgx/validation';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { AppConfig } from '../../../config/app-config.js';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { NotificationService } from '../../notifications/application/notification.service.js';
import { DomainEventHandlerRegistry } from '../../outbox/application/domain-event-handler.registry.js';
import type { DomainEventEnvelope, DomainEventHandler } from '../../outbox/domain/domain-event.js';
import { VERIFICATION_CODE_REQUESTED_EVENT } from '../domain/identity-events.js';
import { VerificationCodes } from '../infrastructure/verification-codes.js';
import { ChallengeRepository } from './challenge.repository.js';
import { UserRepository } from './user.repository.js';

const payloadSchema = z.object({ challengeId: z.uuid() });

/**
 * Émet et envoie le code d'un défi.
 *
 * Le code est tiré au sort ici, au moment de l'envoi : il ne transite ni par la boîte
 * d'envoi, ni par la file de traitement, et n'est jamais écrit en clair. Si le traitement
 * est rejoué (remise « au moins une fois »), un nouveau code remplace le précédent : le
 * dernier message reçu est toujours celui qui fait foi.
 */
@Injectable()
export class VerificationCodeDispatcher implements DomainEventHandler, OnModuleInit {
  readonly name = 'identity.send-verification-code';
  readonly eventType = VERIFICATION_CODE_REQUESTED_EVENT;

  constructor(
    private readonly registry: DomainEventHandlerRegistry,
    private readonly challenges: ChallengeRepository,
    private readonly users: UserRepository,
    private readonly codes: VerificationCodes,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope): Promise<void> {
    const { challengeId } = payloadSchema.parse(event.payload);

    const challenge = await this.challenges.findActiveById(this.prisma, challengeId);
    if (challenge === null || challenge.expiresAt <= new Date()) {
      // Défi remplacé, utilisé ou expiré entre-temps : il n'y a plus rien à envoyer.
      return;
    }
    const user = await this.users.findById(this.prisma, challenge.userId);
    if (user === null) {
      return;
    }

    const code = this.codes.generate();
    if (
      !(await this.challenges.setCodeHash(
        this.prisma,
        challenge.id,
        this.codes.hash(challenge.id, code),
      ))
    ) {
      return;
    }

    await this.notifications.send({
      channel: 'EMAIL',
      recipient: challenge.target,
      locale: localeSchema.catch('fr').parse(user.locale),
      content: {
        template:
          challenge.purpose === 'EMAIL_VERIFICATION'
            ? 'email_verification_code'
            : 'password_reset_code',
        code,
        ttlMinutes: Math.round(this.config.auth.codeTtlSeconds / 60),
      },
    });
  }
}
