import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import {
  type JobSchedule,
  JobSchedules,
  SCHEDULE_CHECK_INTERVAL_MS,
  SCHEDULE_LATE_AFTER_MS,
} from './job-schedules.js';
import type { QueueErrorLog } from './queue-error-log.js';

interface Line {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

/** Ce que Redis sait d'un planificateur : rien, ou l'heure de sa prochaine exécution. */
type Stored = { next: number | null } | undefined;

/** Laisse s'exécuter ce que les promesses déjà résolues ont mis en attente. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

describe('JobSchedules', () => {
  let lines: Line[];
  let queueErrors: { queue: string; error: unknown }[];
  let schedules: JobSchedules;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    lines = [];
    queueErrors = [];
    const logger = {
      setContext: (): void => undefined,
      error: (fields: Record<string, unknown>, message: string): void => {
        lines.push({ fields, message });
      },
    } as unknown as PinoLogger;
    const errorLog = {
      queueError: (queue: string, error: unknown): void => {
        queueErrors.push({ queue, error });
      },
    } as unknown as QueueErrorLog;
    schedules = new JobSchedules(errorLog, logger);
  });

  afterEach(() => {
    schedules.onModuleDestroy();
    jest.useRealTimers();
  });

  /**
   * Une file qui retient ce qu'on y inscrit. Une inscription y remet le planificateur, à
   * l'heure, comme le fait BullMQ.
   */
  function queueNamed(name: string): {
    queue: Queue;
    stored: { value: Stored };
    upserts: unknown[][];
    reads: string[];
    failWith: (error: Error | undefined) => void;
  } {
    const stored: { value: Stored } = { value: undefined };
    const upserts: unknown[][] = [];
    const reads: string[] = [];
    let failure: Error | undefined;
    const queue = {
      name,
      getJobScheduler: (id: string): Promise<Stored> => {
        reads.push(id);
        return failure === undefined ? Promise.resolve(stored.value) : Promise.reject(failure);
      },
      upsertJobScheduler: (...args: unknown[]): Promise<void> => {
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        upserts.push(args);
        stored.value = { next: Date.now() + 1000 };
        return Promise.resolve();
      },
    } as unknown as Queue;
    return {
      queue,
      stored,
      upserts,
      reads,
      failWith: (error) => {
        failure = error;
      },
    };
  }

  /**
   * Dans l'application, une tâche porte le nom de sa file ; ici non, pour que les confondre
   * se voie.
   */
  function relayOn(queue: Queue): JobSchedule {
    return { queue, id: 'relay-schedule', jobName: 'relay', everyMs: 1000 };
  }

  it('inscrit la tâche : sa période, son nom, une exécution en échec non relancée', async () => {
    const { queue, upserts } = queueNamed('outbox-relay');

    await schedules.register(relayOn(queue));

    expect(upserts).toEqual([
      [
        'relay-schedule',
        { every: 1000 },
        {
          name: 'relay',
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
        },
      ],
    ]);
    expect(schedules.registered()).toEqual([{ queue: 'outbox-relay', id: 'relay-schedule' }]);
    expect(lines).toEqual([]);
  });

  it('ne surveille pas une tâche dont l’inscription a échoué : le démarrage échoue avec elle', async () => {
    const { queue, failWith } = queueNamed('outbox-relay');
    failWith(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    await expect(schedules.register(relayOn(queue))).rejects.toThrow('ECONNREFUSED');

    expect(schedules.registered()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('laisse en paix une tâche à l’heure', async () => {
    const { queue, upserts, stored } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));

    // En retard d'une minute tout juste : la limite n'est pas franchie.
    stored.value = { next: Date.now() - SCHEDULE_LATE_AFTER_MS };
    await schedules.checkAll();
    // Attendue dans une heure, comme la purge : une échéance lointaine n'est pas un retard.
    stored.value = { next: Date.now() + 60 * 60 * 1000 };
    await schedules.checkAll();

    expect(upserts).toHaveLength(1);
    expect(lines).toEqual([]);
    expect(queueErrors).toEqual([]);
  });

  it('réinscrit la tâche que Redis n’a plus, et l’écrit', async () => {
    const { queue, upserts, stored } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));

    stored.value = undefined;
    await schedules.checkAll();

    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toEqual(upserts[0]);
    expect(lines).toEqual([
      {
        fields: { queue: 'outbox-relay', scheduler: 'relay-schedule', reason: 'missing' },
        message: 'Background schedule registered again',
      },
    ]);

    // Réparée, elle n'est plus touchée.
    await schedules.checkAll();
    expect(upserts).toHaveLength(2);
    expect(lines).toHaveLength(1);
  });

  it('réinscrit la tâche en retard de plus d’une minute, ou sans prochaine exécution', async () => {
    const { queue, upserts, stored } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));

    stored.value = { next: Date.now() - SCHEDULE_LATE_AFTER_MS - 1 };
    await schedules.checkAll();
    stored.value = { next: null };
    await schedules.checkAll();

    expect(upserts).toHaveLength(3);
    expect(lines).toEqual([
      {
        fields: { queue: 'outbox-relay', scheduler: 'relay-schedule', reason: 'late' },
        message: 'Background schedule registered again',
      },
      {
        fields: { queue: 'outbox-relay', scheduler: 'relay-schedule', reason: 'late' },
        message: 'Background schedule registered again',
      },
    ]);
    expect(SCHEDULE_LATE_AFTER_MS).toBe(60_000);
  });

  it('vérifie chaque tâche, chacune dans sa file : l’une réparée, l’autre intacte', async () => {
    const relay = queueNamed('outbox-relay');
    const purge = queueNamed('account-maintenance');
    await schedules.register(relayOn(relay.queue));
    await schedules.register({
      queue: purge.queue,
      id: 'purge-schedule',
      jobName: 'purge',
      everyMs: 3_600_000,
    });

    purge.stored.value = undefined;
    await schedules.checkAll();

    expect(relay.reads).toEqual(['relay-schedule']);
    expect(purge.reads).toEqual(['purge-schedule']);
    expect(relay.upserts).toHaveLength(1);
    expect(purge.upserts).toHaveLength(2);
    expect(purge.upserts[1]).toEqual([
      'purge-schedule',
      { every: 3_600_000 },
      {
        name: 'purge',
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
      },
    ]);
    expect(lines.map((line) => line.fields)).toEqual([
      { queue: 'account-maintenance', scheduler: 'purge-schedule', reason: 'missing' },
    ]);
  });

  it('Redis injoignable : l’erreur va au journal des files, les autres tâches sont vérifiées', async () => {
    const relay = queueNamed('outbox-relay');
    const purge = queueNamed('account-maintenance');
    await schedules.register(relayOn(relay.queue));
    await schedules.register({
      queue: purge.queue,
      id: 'purge-schedule',
      jobName: 'purge',
      everyMs: 3_600_000,
    });
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:6379');

    relay.failWith(refused);
    purge.stored.value = undefined;
    await expect(schedules.checkAll()).resolves.toBeUndefined();

    expect(queueErrors).toEqual([{ queue: 'outbox-relay', error: refused }]);
    expect(purge.upserts).toHaveLength(2);
    expect(lines).toHaveLength(1);
  });

  it('une réinscription qui échoue n’est pas annoncée comme faite', async () => {
    const { queue, stored, failWith } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));
    stored.value = undefined;
    const original = queue.getJobScheduler.bind(queue);
    const refused = new Error('READONLY You can’t write against a read only replica.');
    // La lecture aboutit, l'écriture non.
    queue.getJobScheduler = (async (id: string) => {
      const found = await original(id);
      failWith(refused);
      return found;
    }) as Queue['getJobScheduler'];

    await schedules.checkAll();

    expect(lines).toEqual([]);
    expect(queueErrors).toEqual([{ queue: 'outbox-relay', error: refused }]);
  });

  it('vérifie toutes les trente secondes, sans retenir le processus', async () => {
    const { queue, reads, stored } = queueNamed('outbox-relay');
    const unref = jest.spyOn(globalThis, 'setInterval');
    await schedules.register(relayOn(queue));
    stored.value = { next: Number.MAX_SAFE_INTEGER };

    expect(unref).toHaveBeenCalledTimes(1);
    expect(unref.mock.calls[0]?.[1]).toBe(SCHEDULE_CHECK_INTERVAL_MS);
    expect((unref.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);
    expect(SCHEDULE_CHECK_INTERVAL_MS).toBe(30_000);

    jest.advanceTimersByTime(SCHEDULE_CHECK_INTERVAL_MS - 1);
    await settle();
    expect(reads).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await settle();
    expect(reads).toHaveLength(1);
    jest.advanceTimersByTime(SCHEDULE_CHECK_INTERVAL_MS);
    await settle();
    jest.advanceTimersByTime(SCHEDULE_CHECK_INTERVAL_MS);
    await settle();
    expect(reads).toHaveLength(3);
  });

  it('une seule surveillance pour toutes les tâches', async () => {
    const relay = queueNamed('outbox-relay');
    const purge = queueNamed('account-maintenance');

    await schedules.register(relayOn(relay.queue));
    await schedules.register({
      queue: purge.queue,
      id: 'purge-schedule',
      jobName: 'purge',
      everyMs: 3_600_000,
    });

    expect(jest.getTimerCount()).toBe(1);
  });

  it('ne double pas une vérification encore en cours : elle attend Redis, puis répare', async () => {
    const { queue, upserts, reads } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));
    // Redis ne répond plus : la lecture reste en attente, comme une commande BullMQ.
    let answer!: (stored: Stored) => void;
    queue.getJobScheduler = ((id: string) => {
      reads.push(id);
      return new Promise<Stored>((resolve) => {
        answer = resolve;
      });
    }) as Queue['getJobScheduler'];

    jest.advanceTimersByTime(4 * SCHEDULE_CHECK_INTERVAL_MS);
    await settle();
    expect(reads).toHaveLength(1);

    // Redis revient, vide.
    answer(undefined);
    await settle();
    expect(upserts).toHaveLength(2);
    expect(lines.map((line) => line.fields['reason'])).toEqual(['missing']);

    // La vérification suivante a lieu de nouveau.
    jest.advanceTimersByTime(SCHEDULE_CHECK_INTERVAL_MS);
    await settle();
    expect(reads).toHaveLength(2);
  });

  it('s’arrête avec l’application : plus de vérification, plus de réparation, plus de ligne', async () => {
    const { queue, upserts, reads, stored } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));
    let answer!: (stored: Stored) => void;
    const original = queue.getJobScheduler.bind(queue);
    queue.getJobScheduler = ((id: string) => {
      reads.push(id);
      return new Promise<Stored>((resolve) => {
        answer = resolve;
      });
    }) as Queue['getJobScheduler'];
    const pending = schedules.checkAll();

    schedules.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    // Une vérification en cours à l'arrêt ne répare plus.
    answer(undefined);
    await pending;
    expect(upserts).toHaveLength(1);
    expect(lines).toEqual([]);

    // Ni les suivantes, même appelées à la main.
    queue.getJobScheduler = original;
    stored.value = undefined;
    await schedules.checkAll();
    jest.advanceTimersByTime(4 * SCHEDULE_CHECK_INTERVAL_MS);
    await settle();
    expect(reads).toHaveLength(1);
    expect(upserts).toHaveLength(1);
  });

  it('une erreur survenue pendant l’arrêt n’est pas écrite', async () => {
    const { queue } = queueNamed('outbox-relay');
    await schedules.register(relayOn(queue));
    let refuse!: (error: Error) => void;
    queue.getJobScheduler = (() =>
      new Promise<Stored>((_resolve, reject) => {
        refuse = reject;
      })) as Queue['getJobScheduler'];
    const pending = schedules.checkAll();

    schedules.onModuleDestroy();
    refuse(new Error('Connection is closed.'));
    await pending;

    expect(queueErrors).toEqual([]);
  });
});
