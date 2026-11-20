import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import {
  JobSchedules,
  SCHEDULE_LATE_AFTER_MS,
} from '../../src/infrastructure/queue/job-schedules.js';
import {
  ACCOUNT_MAINTENANCE_QUEUE,
  OUTBOX_RELAY_QUEUE,
} from '../../src/infrastructure/queue/queue.constants.js';
import { OutboxService } from '../../src/modules/outbox/application/outbox.service.js';
import { createTestApp, eventually, type TestApp } from '../support/test-app.js';
import { redisUrl } from '../support/test-environment.js';

const RELAY = { queue: OUTBOX_RELAY_QUEUE, id: 'outbox-relay' };
const PURGE = { queue: ACCOUNT_MAINTENANCE_QUEUE, id: 'account-maintenance' };
const REGISTERED_AGAIN = 'Background schedule registered again';
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Les tâches de fond périodiques n'existent que dans Redis. Ce fichier leur fait perdre ce
 * que Redis en sait — tout, puis la seule exécution en attente — et vérifie que l'application
 * les réinscrit sans être redémarrée, et que le relais de la boîte d'envoi repart.
 */
describe('Tâches planifiées — réinscrites quand Redis les perd (Redis réel)', () => {
  let testApp: TestApp;
  let schedules: JobSchedules;
  let queues: Queue[];
  let relayQueue: Queue;
  let purgeQueue: Queue;
  let redis: Redis;
  let prisma: PrismaService;
  let logged: jest.SpiedFunction<PinoLogger['error']>;

  const linesOf = (message: string): Record<string, unknown>[] =>
    logged.mock.calls
      .filter(([, text]) => text === message)
      .map(([fields]) => fields as Record<string, unknown>);

  /** Écrit un événement dans la boîte d'envoi ; rend son identifiant. */
  const append = (): Promise<string> =>
    testApp.app.get(UnitOfWork).run((tx) =>
      testApp.app.get(OutboxService).append(tx, {
        aggregateType: 'probe',
        aggregateId: randomUUID(),
        eventType: 'probe.schedule_checked',
        payload: {},
      }),
    );

  const statusOf = async (id: string): Promise<string> =>
    (await prisma.outboxEvent.findUniqueOrThrow({ where: { id }, select: { status: true } }))
      .status;

  /** Les planificateurs que Redis connaît, file par file. */
  const schedulersInRedis = async (): Promise<{ queue: string; id: string }[]> => {
    const found: { queue: string; id: string }[] = [];
    for (const queue of queues) {
      for (const scheduler of await queue.getJobSchedulers()) {
        found.push({ queue: queue.name, id: scheduler.key });
      }
    }
    return found;
  };

  /** La période inscrite dans Redis pour chacune des deux tâches, en millisecondes. */
  const periods = async (): Promise<{ relay: unknown; purge: unknown }> => ({
    relay: (await relayQueue.getJobScheduler(RELAY.id))?.every,
    purge: (await purgeQueue.getJobScheduler(PURGE.id))?.every,
  });

  beforeAll(async () => {
    testApp = await createTestApp();
    schedules = testApp.app.get(JobSchedules);
    prisma = testApp.app.get(PrismaService);
    relayQueue = testApp.app.get<Queue>(getQueueToken(OUTBOX_RELAY_QUEUE));
    purgeQueue = testApp.app.get<Queue>(getQueueToken(ACCOUNT_MAINTENANCE_QUEUE));
    queues = testApp.app
      .get(DiscoveryService)
      .getProviders()
      .map((provider): unknown => provider.instance)
      .filter((instance): instance is Queue => instance instanceof Queue);
    redis = new Redis(redisUrl());
  });

  beforeEach(() => {
    // Jest défait les espions avant chaque test : celui-ci est posé à chaque fois.
    logged = jest.spyOn(PinoLogger.prototype, 'error');
  });

  afterAll(async () => {
    await redis.quit();
    await testApp.close();
  });

  it('toute tâche planifiée de l’application est surveillée', async () => {
    const inRedis = await schedulersInRedis();

    // Les deux tâches connues existent ; toute autre, inscrite ailleurs, ferait échouer ce test.
    expect(inRedis).toEqual(expect.arrayContaining([RELAY, PURGE]));
    expect([...schedules.registered()].sort((a, b) => a.queue.localeCompare(b.queue))).toEqual(
      [...inRedis].sort((a, b) => a.queue.localeCompare(b.queue)),
    );
    // Chacune à sa cadence : le relais à celle de la configuration, la purge toutes les heures.
    expect(testApp.config.outbox.pollIntervalMs).toBe(100);
    expect(await periods()).toEqual({ relay: 100, purge: ONE_HOUR_MS });
  });

  it('une vérification ne touche pas des tâches saines', async () => {
    const purgeBefore = await purgeQueue.getJobScheduler(PURGE.id);
    expect(typeof purgeBefore?.next).toBe('number');

    await schedules.checkAll();

    expect(linesOf(REGISTERED_AGAIN)).toEqual([]);
    // La purge horaire garde son créneau : rien n'a été réinscrit.
    expect((await purgeQueue.getJobScheduler(PURGE.id))?.next).toBe(purgeBefore?.next);
  });

  it('Redis perd toutes ses données : les tâches sont réinscrites, le relais repart', async () => {
    await redis.flushdb();
    expect(await schedulersInRedis()).toEqual([]);
    // Sans planificateur, rien n'est relayé : l'événement attend.
    const stranded = await append();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await statusOf(stranded)).toBe('PENDING');

    await schedules.checkAll();

    expect(await schedulersInRedis()).toEqual(expect.arrayContaining([RELAY, PURGE]));
    expect(linesOf(REGISTERED_AGAIN)).toEqual([
      { queue: RELAY.queue, scheduler: RELAY.id, reason: 'missing' },
      { queue: PURGE.queue, scheduler: PURGE.id, reason: 'missing' },
    ]);
    // Réinscrites comme au démarrage : mêmes cadences.
    expect(await periods()).toEqual({ relay: 100, purge: ONE_HOUR_MS });
    // Sans redémarrage : l'événement resté en attente part, le suivant aussi.
    await eventually(async () => (await statusOf(stranded)) === 'PUBLISHED');
    const next = await append();
    await eventually(async () => (await statusOf(next)) === 'PUBLISHED');
  });

  it('seule l’exécution en attente est perdue : la tâche, en retard, est réinscrite', async () => {
    const prefix = `${testApp.config.redis.keyPrefix}queues:${OUTBOX_RELAY_QUEUE}`;
    // Le relais est suspendu le temps de retirer son exécution en attente, pour qu'il ne la
    // prenne pas entre la lecture et le retrait ; le passage en cours, s'il y en a un, s'achève.
    await relayQueue.pause();
    await eventually(async () => (await relayQueue.getActiveCount()) === 0, { intervalMs: 10 });
    const scheduler = await relayQueue.getJobScheduler(RELAY.id);
    const pending = `repeat:${RELAY.id}:${String(scheduler?.next)}`;
    // Elle attend son heure, ou, son heure venue, son tour — dans l'une des deux listes d'une
    // file suspendue.
    const removed =
      (await redis.zrem(`${prefix}:delayed`, pending)) +
      (await redis.lrem(`${prefix}:wait`, 0, pending)) +
      (await redis.lrem(`${prefix}:paused`, 0, pending));
    expect(removed).toBe(1);
    expect(await redis.del(`${prefix}:${pending}`)).toBe(1);
    // Le planificateur demeure, mais son échéance est passée depuis plus d'une minute.
    await redis.zadd(`${prefix}:repeat`, Date.now() - SCHEDULE_LATE_AFTER_MS - 1000, RELAY.id);
    await relayQueue.resume();
    const stranded = await append();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await statusOf(stranded)).toBe('PENDING');

    await schedules.checkAll();

    expect(linesOf(REGISTERED_AGAIN)).toEqual([
      { queue: RELAY.queue, scheduler: RELAY.id, reason: 'late' },
    ]);
    await eventually(async () => (await statusOf(stranded)) === 'PUBLISHED');
    const after = await relayQueue.getJobScheduler(RELAY.id);
    expect(Date.now() - (after?.next ?? 0)).toBeLessThan(SCHEDULE_LATE_AFTER_MS);
  });
});
