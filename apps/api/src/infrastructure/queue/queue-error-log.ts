import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

/** Durée pendant laquelle une même erreur, répétée par le même objet, n'est pas réécrite. */
export const REPEATED_ERROR_WINDOW_MS = 30_000;

interface Written {
  /** Heure de la dernière ligne écrite pour cette erreur. */
  writtenAt: number;
  /** Heure à laquelle elle est survenue pour la dernière fois, écrite ou non. */
  seenAt: number;
  /** Répétitions passées sous silence depuis la dernière ligne. */
  silenced: number;
}

/**
 * Fait passer par les journaux structurés ce que les files de tâches de fond signalent hors
 * de toute requête : une connexion à Redis perdue, le verrou d'une tâche expiré, une exécution
 * périodique en échec.
 *
 * Sans écouteur, BullMQ écrit lui-même ces erreurs sur la sortie d'erreur, sans format ni
 * champ — dix par seconde quand Redis ne répond plus, chaque connexion réessayant de son
 * côté. D'où deux règles :
 *  - **tout objet est écouté** : les files le sont ici, d'office ; chaque exécutant l'est par
 *    son traitement (`@OnWorkerEvent('error')`), dès sa création. Un test parcourt
 *    l'application et échoue si l'un d'eux ne l'est pas ;
 *  - **une même erreur n'est écrite qu'une fois par période** : la première à l'instant où
 *    elle survient, puis une ligne toutes les trente secondes tant qu'elle se répète, avec le
 *    nombre de répétitions passées sous silence (`repeated`). Deux erreurs différentes, ou la
 *    même sur deux objets, ne se masquent jamais.
 */
@Injectable()
export class QueueErrorLog implements OnModuleInit {
  private readonly written = new Map<string, Written>();
  private readonly watched = new WeakSet<object>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueErrorLog.name);
  }

  /** Écoute chaque file de l'application : aucune n'a à s'en souvenir. */
  onModuleInit(): void {
    for (const provider of this.discovery.getProviders()) {
      const instance: unknown = provider.instance;
      if (!(instance instanceof Queue) || this.watched.has(instance)) {
        continue;
      }
      this.watched.add(instance);
      const { name } = instance;
      instance.on('error', (error) => {
        this.queueError(name, error);
      });
    }
  }

  /** Erreur signalée par une file : la connexion à Redis par laquelle les tâches sont déposées. */
  queueError(queue: string, error: unknown): void {
    this.write(`queue:${queue}`, error, { queue, source: 'queue' }, 'Background queue error');
  }

  /** Erreur signalée par l'exécutant d'une file : sa connexion à Redis, le verrou d'une tâche… */
  workerError(queue: string, error: unknown): void {
    this.write(`worker:${queue}`, error, { queue, source: 'worker' }, 'Background queue error');
  }

  /**
   * Exécution périodique en échec. Elle sera relancée à l'échéance suivante — chaque seconde
   * pour le relais de la boîte d'envoi : la même cause ne s'écrit donc pas à chaque fois.
   */
  runFailed(queue: string, error: unknown): void {
    this.write(`run:${queue}`, error, { queue }, 'Background job failed');
  }

  private write(
    origin: string,
    error: unknown,
    fields: Record<string, unknown>,
    message: string,
  ): void {
    const now = Date.now();
    const key = `${origin}\n${describe(error)}`;
    const previous = this.written.get(key);
    if (previous !== undefined && isWithinWindow(previous.writtenAt, now)) {
      previous.silenced += 1;
      previous.seenAt = now;
      return;
    }
    // Une erreur qui n'est plus survenue depuis une période est oubliée : la mémoire ne croît
    // pas. Celles qui se répètent encore gardent leur décompte, écrit à leur prochaine ligne.
    for (const [other, { seenAt }] of this.written) {
      if (!isWithinWindow(seenAt, now)) {
        this.written.delete(other);
      }
    }
    this.written.set(key, { writtenAt: now, seenAt: now, silenced: 0 });
    this.logger.error(
      {
        err: error,
        ...fields,
        ...(previous !== undefined && previous.silenced > 0 ? { repeated: previous.silenced } : {}),
      },
      message,
    );
  }
}

/** Vrai si `at` date de moins d'une période — une horloge qui recule n'y enferme pas. */
function isWithinWindow(at: number, now: number): boolean {
  const elapsed = now - at;
  return elapsed >= 0 && elapsed < REPEATED_ERROR_WINDOW_MS;
}

/** Ce qui fait qu'une erreur est « la même » : son nom et son message. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
