import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QueueErrorLog } from './queue-error-log.js';

/** Intervalle entre deux vérifications des tâches planifiées. */
export const SCHEDULE_CHECK_INTERVAL_MS = 30_000;

/**
 * Retard au-delà duquel une tâche planifiée est tenue pour perdue, et réinscrite. Il doit
 * dépasser la durée d'un passage : pendant qu'une tâche s'exécute, sa prochaine échéance peut
 * être passée de toute cette durée — la transaction d'un passage du relais, la plus fréquente
 * des tâches, est bornée à trente secondes.
 */
export const SCHEDULE_LATE_AFTER_MS = 60_000;

/** Une tâche de fond périodique : la file qui la porte, son identifiant, sa période. */
export interface JobSchedule {
  readonly queue: Queue;
  /** Identifiant du planificateur, unique dans sa file. */
  readonly id: string;
  /** Nom donné à chaque exécution. */
  readonly jobName: string;
  readonly everyMs: number;
}

/** Pourquoi une tâche planifiée a dû être réinscrite. */
export type ScheduleDefect = 'missing' | 'late';

/**
 * Inscrit les tâches de fond périodiques dans Redis, et veille à ce qu'elles y restent.
 *
 * Une tâche planifiée n'existe que dans Redis : un planificateur BullMQ, partagé par toutes
 * les instances, et sa prochaine exécution. Inscrite au seul démarrage, elle disparaissait
 * avec les données de Redis — persistance absente, volume perdu, bascule vers une instance
 * neuve — sans que rien le signale : l'API se reconnectait, répondait, et plus aucun
 * événement n'était relayé jusqu'à son redémarrage.
 *
 * Chaque instance vérifie donc ses tâches toutes les trente secondes, et réinscrit celle qui
 *  - **manque** : son planificateur n'est plus dans Redis ;
 *  - **est en retard** de plus d'une minute : le planificateur est là, mais sa prochaine
 *    exécution ne l'est plus (clés évincées ou supprimées à la main), personne ne l'exécute,
 *    ou Redis vient de rester injoignable plus d'une minute.
 *
 * Réinscrire une tâche saine ne la décale pas : BullMQ garde le créneau de l'exécution en
 * attente. Deux instances peuvent donc réparer en même temps sans se gêner.
 *
 * Chaque réparation écrit une ligne d'erreur. « Absente », elle dit que Redis a perdu des
 * données, ce que l'exploitant doit savoir : les tâches déjà déposées dans les files ont
 * disparu avec elles. « En retard » et répétée, elle dit que personne n'exécute la tâche.
 */
@Injectable()
export class JobSchedules implements OnModuleDestroy {
  private readonly schedules: JobSchedule[] = [];
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private stopped = false;

  constructor(
    private readonly queueErrors: QueueErrorLog,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JobSchedules.name);
  }

  /**
   * Inscrit la tâche, puis la surveille. Seule façon d'en créer une : une tâche inscrite
   * ailleurs ne serait pas surveillée — un test parcourt Redis et échoue s'il en trouve une.
   */
  async register(schedule: JobSchedule): Promise<void> {
    await this.inscribe(schedule);
    this.schedules.push(schedule);
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.checkAll();
      }, SCHEDULE_CHECK_INTERVAL_MS);
      // La surveillance ne retient pas le processus : elle s'arrête avec lui.
      this.timer.unref();
    }
  }

  /** Les tâches surveillées : la file et l'identifiant de chacune. */
  registered(): readonly { queue: string; id: string }[] {
    return this.schedules.map(({ queue, id }) => ({ queue: queue.name, id }));
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Cesse de surveiller, définitivement : à l'arrêt de l'application — et dans les tests qui
   * retirent une tâche exprès, pour qu'elle ne revienne pas.
   */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Vérifie chaque tâche. Une vérification encore en cours n'est pas doublée : quand Redis
   * ne répond plus, la sienne attend la reconnexion — et répare dès qu'elle a lieu.
   */
  async checkAll(): Promise<void> {
    if (this.checking || this.stopped) {
      return;
    }
    this.checking = true;
    try {
      for (const schedule of this.schedules) {
        await this.check(schedule);
      }
    } finally {
      this.checking = false;
    }
  }

  private async check(schedule: JobSchedule): Promise<void> {
    try {
      const defect = await this.defectOf(schedule);
      if (defect === undefined || this.stopped) {
        return;
      }
      await this.inscribe(schedule);
      this.logger.error(
        { queue: schedule.queue.name, scheduler: schedule.id, reason: defect },
        'Background schedule registered again',
      );
    } catch (error) {
      if (!this.stopped) {
        this.queueErrors.queueError(schedule.queue.name, error);
      }
    }
  }

  private async defectOf(schedule: JobSchedule): Promise<ScheduleDefect | undefined> {
    const found = await schedule.queue.getJobScheduler(schedule.id);
    // `undefined` et non « faux » : un planificateur absent n'a aucune de ses clés.
    if (found === undefined) {
      return 'missing';
    }
    const next: unknown = found.next;
    if (typeof next !== 'number' || Date.now() - next > SCHEDULE_LATE_AFTER_MS) {
      return 'late';
    }
    return undefined;
  }

  private async inscribe({ queue, id, jobName, everyMs }: JobSchedule): Promise<void> {
    await queue.upsertJobScheduler(
      id,
      { every: everyMs },
      {
        name: jobName,
        // Une exécution en échec n'est pas relancée : la suivante a lieu à l'échéance.
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
      },
    );
  }
}
