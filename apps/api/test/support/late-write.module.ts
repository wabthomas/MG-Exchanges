import { Controller, Injectable, Module, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../src/common/auth/auth.decorators.js';
import type { AuthenticatedUser } from '../../src/common/auth/authenticated-user.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';

/**
 * Porte tenue par le test : la requête qui s'y présente a déjà été authentifiée, et n'écrit
 * qu'une fois la porte ouverte. Le test peut ainsi faire quelque chose — clôturer le compte —
 * entre l'authentification d'une requête et son écriture.
 */
@Injectable()
export class LateWriteGate {
  private arrived: (() => void) | undefined;
  private opened: (() => void) | undefined;
  private waiting: Promise<void> | undefined;

  /** Ferme la porte. @returns une promesse tenue dès qu'une requête s'y présente. */
  close(): Promise<void> {
    this.waiting = new Promise<void>((resolve) => {
      this.opened = resolve;
    });
    return new Promise<void>((resolve) => {
      this.arrived = resolve;
    });
  }

  open(): void {
    this.opened?.();
  }

  /** Appelé par la route : signale l'arrivée de la requête, puis attend l'ouverture. */
  async pass(): Promise<void> {
    this.arrived?.();
    await this.waiting;
  }
}

/**
 * Route de test uniquement : une requête authentifiée qui écrit **tard** — comme le ferait
 * une requête ordinaire encore en cours au moment où son compte est clôturé.
 */
@Controller({ path: 'probe-private/late-write', version: '1' })
class LateWriteController {
  constructor(
    private readonly gate: LateWriteGate,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':target')
  async write(
    @CurrentUser() user: AuthenticatedUser,
    @Param('target') target: string,
  ): Promise<{ written: true }> {
    await this.gate.pass();
    const userId = user.userId;
    switch (target) {
      case 'profile':
        // Une ligne ajoutée au compte.
        await this.prisma.userProfile.create({ data: { userId, city: 'Goma' } });
        break;
      case 'challenge':
        await this.prisma.verificationChallenge.create({
          data: {
            userId,
            purpose: 'PHONE_VERIFICATION',
            target: '+243990000042',
            maxAttempts: 5,
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        break;
      default:
        // Le compte lui-même, modifié.
        await this.prisma.user.update({ where: { id: userId }, data: { locale: 'en' } });
    }
    return { written: true };
  }
}

@Module({ controllers: [LateWriteController], providers: [LateWriteGate] })
export class LateWriteModule {}
