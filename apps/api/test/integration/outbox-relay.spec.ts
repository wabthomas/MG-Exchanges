import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { UnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import {
  DOMAIN_EVENTS_QUEUE,
  OUTBOX_RELAY_QUEUE,
} from '../../src/infrastructure/queue/queue.constants.js';
import { DomainEventHandlerRegistry } from '../../src/modules/outbox/application/domain-event-handler.registry.js';
import { OutboxRelayService } from '../../src/modules/outbox/application/outbox-relay.service.js';
import { OutboxService } from '../../src/modules/outbox/application/outbox.service.js';
import type { DomainEventEnvelope } from '../../src/modules/outbox/domain/domain-event.js';
import { createTestApp, eventually, type TestApp } from '../support/test-app.js';

describe('Boîte d’envoi transactionnelle (PostgreSQL, Redis et BullMQ réels)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  let unitOfWork: UnitOfWork;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let registry: DomainEventHandlerRegistry;
  let eventsQueue: Queue;

  const append = (
    aggregateId: string,
    eventType = 'probe.happened',
    payload = {},
  ): Promise<string> =>
    unitOfWork.run((tx) =>
      outbox.append(tx, { aggregateType: 'probe', aggregateId, eventType, payload }),
    );

  const statusOf = async (id: string) =>
    prisma.outboxEvent.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        attempts: true,
        lastError: true,
        publishedAt: true,
        availableAt: true,
      },
    });

  beforeAll(async () => {
    testApp = await createTestApp({ env: { OUTBOX_MAX_ATTEMPTS: '3', OUTBOX_BATCH_SIZE: '50' } });
    prisma = testApp.app.get(PrismaService);
    unitOfWork = testApp.app.get(UnitOfWork);
    outbox = testApp.app.get(OutboxService);
    relay = testApp.app.get(OutboxRelayService);
    registry = testApp.app.get(DomainEventHandlerRegistry);
    eventsQueue = testApp.app.get<Queue>(getQueueToken(DOMAIN_EVENTS_QUEUE));

    // Le planificateur est arrêté : chaque test déclenche le relais lui-même, de façon déterministe.
    const relayQueue = testApp.app.get<Queue>(getQueueToken(OUTBOX_RELAY_QUEUE));
    await relayQueue.removeJobScheduler('outbox-relay');
    await relayQueue.pause();
    await relayQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('remet à son consommateur un événement validé, puis le marque publié', async () => {
    const received: DomainEventEnvelope[] = [];
    registry.register({
      name: 'test.collector',
      eventType: 'probe.delivered',
      handle: async (event) => {
        received.push(event);
      },
    });

    const id = await append('delivery-1', 'probe.delivered', { answer: 42 });
    expect(await statusOf(id)).toMatchObject({ status: 'PENDING', attempts: 0, publishedAt: null });

    const result = await relay.relayPendingBatch();
    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });

    await eventually(async () => received.length === 1);
    expect(received[0]).toMatchObject({
      id,
      aggregateType: 'probe',
      aggregateId: 'delivery-1',
      eventType: 'probe.delivered',
      payload: { answer: 42 },
    });

    const published = await statusOf(id);
    expect(published).toMatchObject({ status: 'PUBLISHED', attempts: 1, lastError: null });
    expect(published.publishedAt).toBeInstanceOf(Date);

    // Un second passage ne republie rien.
    expect(await relay.relayPendingBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it('ne publie jamais un événement dont la transaction a été annulée', async () => {
    await expect(
      unitOfWork.run(async (tx) => {
        await outbox.append(tx, {
          aggregateType: 'probe',
          aggregateId: 'rolled-back',
          eventType: 'probe.happened',
          payload: {},
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await prisma.outboxEvent.count({ where: { aggregateId: 'rolled-back' } })).toBe(0);
    expect(await relay.relayPendingBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it('des relais concurrents publient chaque événement exactement une fois', async () => {
    const add = jest.spyOn(eventsQueue, 'add');
    const ids = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) => append(`concurrent-${index}`)),
    );

    const results = await Promise.all(Array.from({ length: 6 }, () => relay.relayPendingBatch()));

    expect(results.reduce((total, result) => total + result.published, 0)).toBe(ids.length);
    expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);

    const publishedIds = add.mock.calls.map((call) => call[2]?.jobId);
    expect(publishedIds).toHaveLength(ids.length);
    expect(new Set(publishedIds)).toEqual(new Set(ids));

    const statuses = await prisma.outboxEvent.groupBy({
      by: ['status'],
      where: { id: { in: ids } },
      _count: true,
    });
    expect(statuses).toEqual([{ status: 'PUBLISHED', _count: ids.length }]);
  });

  it('retente une publication en échec, puis abandonne explicitement après le maximum de tentatives', async () => {
    const id = await append('failing-1');
    const add = jest.spyOn(eventsQueue, 'add').mockRejectedValue(new Error('queue unavailable'));

    // 1re tentative : échec, nouvelle tentative programmée plus tard.
    expect(await relay.relayPendingBatch()).toEqual({ claimed: 1, published: 0, failed: 1 });
    const afterFirst = await statusOf(id);
    expect(afterFirst).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'queue unavailable',
    });
    expect(afterFirst.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Tant que le délai n'est pas écoulé, l'événement n'est pas repris.
    expect(await relay.relayPendingBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });

    // Le délai est écoulé (simulé) : 2e puis 3e et dernière tentative.
    const makeAvailable = () =>
      prisma.$executeRaw`UPDATE outbox_events SET available_at = now() WHERE id = ${id}::uuid`;
    await makeAvailable();
    await relay.relayPendingBatch();
    expect(await statusOf(id)).toMatchObject({ status: 'PENDING', attempts: 2 });

    await makeAvailable();
    await relay.relayPendingBatch();
    expect(await statusOf(id)).toMatchObject({ status: 'DEAD', attempts: 3, publishedAt: null });

    // Un événement abandonné n'est plus jamais repris automatiquement.
    await makeAvailable();
    expect(await relay.relayPendingBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(add).toHaveBeenCalledTimes(3);
  });

  it('un échec isolé ne bloque pas les autres événements du lot', async () => {
    const failingId = await append('mixed-failing');
    const healthyId = await append('mixed-healthy');

    const original = eventsQueue.add.bind(eventsQueue);
    jest.spyOn(eventsQueue, 'add').mockImplementation((name, data, options) => {
      if (options?.jobId === failingId) {
        return Promise.reject(new Error('boom'));
      }
      return original(name, data, options);
    });

    expect(await relay.relayPendingBatch()).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(await statusOf(healthyId)).toMatchObject({ status: 'PUBLISHED' });
    expect(await statusOf(failingId)).toMatchObject({ status: 'PENDING', attempts: 1 });
  });

  it('refuse un type d’événement mal formé (erreur de programmation)', async () => {
    await expect(append('bad', 'NotAnEvent')).rejects.toThrow(/Invalid event type/);
  });
});
