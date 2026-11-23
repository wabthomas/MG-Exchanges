import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getQueueToken, WorkerHost } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCOUNT_MAINTENANCE_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  OUTBOX_RELAY_QUEUE,
} from '../../src/infrastructure/queue/queue.constants.js';
import { AccountMaintenanceService } from '../../src/modules/identity/application/account-maintenance.service.js';
import { DomainEventHandlerRegistry } from '../../src/modules/outbox/application/domain-event-handler.registry.js';
import { OutboxRelayService } from '../../src/modules/outbox/application/outbox-relay.service.js';
import type { DomainEventEnvelope } from '../../src/modules/outbox/domain/domain-event.js';
import { createTestApp, eventually, type TestApp } from '../support/test-app.js';

const QUEUES = [ACCOUNT_MAINTENANCE_QUEUE, DOMAIN_EVENTS_QUEUE, OUTBOX_RELAY_QUEUE];

/**
 * L'application de test n'écrit rien (`LOG_LEVEL=silent`) : ce fichier observe ce qui est
 * confié au journal structuré. Ce que BullMQ écrit de lui-même sur la sortie d'erreur, faute
 * d'écouteur, n'y passe pas — c'est ce que ces tests excluent.
 */
describe('Files de tâches de fond — erreurs et journaux structurés (Redis réel)', () => {
  let testApp: TestApp;
  let queues: Queue[];
  let hosts: WorkerHost[];
  let logged: jest.SpiedFunction<PinoLogger['error']>;

  /** Champs des lignes d'erreur portant ce message. */
  const linesOf = (message: string): Record<string, unknown>[] =>
    logged.mock.calls
      .filter(([, text]) => text === message)
      .map(([fields]) => fields as Record<string, unknown>);

  beforeAll(async () => {
    testApp = await createTestApp();
    const instances = testApp.app
      .get(DiscoveryService)
      .getProviders()
      .map((provider): unknown => provider.instance);
    queues = instances.filter((instance): instance is Queue => instance instanceof Queue);
    hosts = instances.filter((instance): instance is WorkerHost => instance instanceof WorkerHost);
  });

  beforeEach(() => {
    // Jest défait les espions avant chaque test : celui-ci est posé à chaque fois.
    logged = jest.spyOn(PinoLogger.prototype, 'error');
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('aucune file ni aucun exécutant de l’application n’est sans écoute', () => {
    // Les trois files connues sont bien trouvées ; toute autre est vérifiée de même.
    expect(queues.map((queue) => queue.name)).toEqual(expect.arrayContaining(QUEUES));
    expect(hosts.map((host) => host.worker.name)).toEqual(expect.arrayContaining(QUEUES));

    expect(
      queues.map((queue) => ({ queue: queue.name, error: queue.listenerCount('error') })),
    ).toEqual(queues.map((queue) => ({ queue: queue.name, error: 1 })));
    expect(
      hosts.map(({ worker }) => ({
        worker: worker.name,
        error: worker.listenerCount('error'),
        failed: worker.listenerCount('failed'),
      })),
    ).toEqual(hosts.map(({ worker }) => ({ worker: worker.name, error: 1, failed: 1 })));
  });

  it('ce que signale un exécutant est écrit avec le nom de sa file', () => {
    const signalled = hosts.map(({ worker }) => ({
      worker,
      error: new Error(`probe: lock of a ${worker.name} job lost`),
    }));
    for (const { worker, error } of signalled) {
      worker.emit('error', error);
    }

    expect(linesOf('Background queue error')).toEqual(
      signalled.map(({ worker, error }) => ({ err: error, queue: worker.name, source: 'worker' })),
    );
  });

  it('ce que signale une file est écrit avec son nom', () => {
    const signalled = queues.map((queue) => ({
      queue,
      error: new Error(`probe: ${queue.name} lost its connection`),
    }));
    for (const { queue, error } of signalled) {
      queue.emit('error', error);
    }

    expect(linesOf('Background queue error')).toEqual(
      signalled.map(({ queue, error }) => ({ err: error, queue: queue.name, source: 'queue' })),
    );
  });

  it('un passage du relais en échec est écrit — une fois, bien qu’il échoue à chaque échéance', async () => {
    const relay = testApp.app.get(OutboxRelayService);
    const unavailable = new Error('probe: the database is not reachable');
    const run = jest.spyOn(relay, 'relayPendingBatch').mockRejectedValue(unavailable);
    try {
      // Le relais passe dix fois par seconde dans l'application de test.
      await eventually(async () => run.mock.calls.length >= 5);
      await eventually(async () => linesOf('Background job failed').length > 0);
    } finally {
      run.mockRestore();
    }

    expect(linesOf('Background job failed')).toEqual([
      { err: unavailable, queue: OUTBOX_RELAY_QUEUE },
    ]);
  });

  it('un passage de la purge en échec est écrit', async () => {
    const maintenance = testApp.app.get(AccountMaintenanceService);
    const queue = testApp.app.get<Queue>(getQueueToken(ACCOUNT_MAINTENANCE_QUEUE));
    const broken = new Error('probe: the purge could not run');
    const run = jest.spyOn(maintenance, 'run').mockRejectedValue(broken);
    try {
      await queue.add('purge', {}, { attempts: 1, removeOnComplete: true, removeOnFail: true });
      await eventually(async () => linesOf('Background job failed').length > 0);
    } finally {
      run.mockRestore();
    }

    expect(linesOf('Background job failed')).toEqual([
      { err: broken, queue: ACCOUNT_MAINTENANCE_QUEUE },
    ]);
  });

  it('un événement dont le traitement échoue est écrit avec son identité, à chaque fois', async () => {
    const registry = testApp.app.get(DomainEventHandlerRegistry);
    const queue = testApp.app.get<Queue>(getQueueToken(DOMAIN_EVENTS_QUEUE));
    const refused = new Error('probe: the consumer refused the event');
    registry.register({
      name: 'test.refusing',
      eventType: 'probe.refused',
      handle: async () => {
        throw refused;
      },
    });
    const envelopes = [randomUUID(), randomUUID()].map((id): DomainEventEnvelope => ({
      id,
      aggregateType: 'probe',
      aggregateId: 'refused',
      eventType: 'probe.refused',
      payload: {},
      metadata: {},
      occurredAt: new Date().toISOString(),
    }));

    for (const envelope of envelopes) {
      await queue.add(envelope.eventType, envelope, { jobId: envelope.id, attempts: 1 });
    }
    await eventually(async () => linesOf('Domain event handling failed').length >= 2);

    // Même erreur, deux événements : deux lignes — celles-ci ne sont jamais regroupées.
    const lines = linesOf('Domain event handling failed');
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining(
        envelopes.map(({ id }) => ({
          err: refused,
          eventId: id,
          eventType: 'probe.refused',
          attemptsMade: 1,
        })),
      ),
    );
  });
});
