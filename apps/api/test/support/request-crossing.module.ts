import { AsyncLocalStorage } from 'node:async_hooks';

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Module,
  type NestInterceptor,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';

import { getAuthenticatedUser } from '../../src/common/auth/authenticated-user.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';

/**
 * Moment du traitement d'une requête où le test intervient : une fois la requête authentifiée
 * et avant tout traitement, ou à l'ouverture de sa première transaction — après ses lectures,
 * avant ses écritures.
 */
export type CrossingMoment = 'BEFORE_HANDLING' | 'FIRST_TRANSACTION';

interface ArmedCrossing {
  readonly userId: string;
  readonly moment: CrossingMoment;
  readonly cross: () => Promise<void>;
}

/**
 * Croisement tenu par le test : au moment choisi du traitement de la prochaine requête d'un
 * compte, le test fait ce qu'il veut — clôturer ce compte, par exemple. La requête est partie
 * avant la clôture ; elle est traitée, ou écrit, après.
 */
@Injectable()
export class RequestCrossing {
  private armed: ArmedCrossing | undefined;
  /** Compte de la requête en cours de traitement : ses transactions sont reconnues comme siennes. */
  private readonly handling = new AsyncLocalStorage<string>();

  arm(userId: string, moment: CrossingMoment, cross: () => Promise<void>): void {
    this.armed = { userId, moment, cross };
  }

  disarm(): void {
    this.armed = undefined;
  }

  /** Exécute `work` comme le traitement d'une requête du compte `userId`. */
  handle<T>(userId: string | undefined, work: () => T): T {
    return userId === undefined ? work() : this.handling.run(userId, work);
  }

  /** Le traitement atteint `moment` : le croisement armé pour ce compte, s'il y en a un, a lieu. */
  async reach(moment: CrossingMoment, userId = this.handling.getStore()): Promise<void> {
    const armed = this.armed;
    if (armed?.moment !== moment || armed.userId !== userId) {
      return;
    }
    this.armed = undefined;
    await armed.cross();
  }
}

@Injectable()
class CrossingInterceptor implements NestInterceptor {
  constructor(private readonly crossing: RequestCrossing) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    // Les gardes sont passées : la requête est authentifiée, sa session existe encore.
    const userId = getAuthenticatedUser(context.switchToHttp().getRequest<Request>())?.userId;
    await this.crossing.reach('BEFORE_HANDLING', userId);
    return new Observable((subscriber) =>
      this.crossing.handle(userId, () => next.handle().subscribe(subscriber)),
    );
  }
}

/** Fait passer chaque transaction de l'application par le croisement. */
@Injectable()
class TransactionCrossing implements OnModuleInit {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly crossing: RequestCrossing,
  ) {}

  onModuleInit(): void {
    const { crossing, unitOfWork } = this;
    const run = unitOfWork.run.bind(unitOfWork);
    unitOfWork.run = (async (...args: Parameters<UnitOfWork['run']>) => {
      await crossing.reach('FIRST_TRANSACTION');
      return run(...args);
    }) as UnitOfWork['run'];
  }
}

/**
 * Module de test uniquement : permet à un test d'intervenir à un moment précis du traitement
 * d'une requête (voir `RequestCrossing`).
 */
@Module({
  providers: [
    RequestCrossing,
    TransactionCrossing,
    { provide: APP_INTERCEPTOR, useClass: CrossingInterceptor },
  ],
  exports: [RequestCrossing],
})
export class RequestCrossingModule {}
