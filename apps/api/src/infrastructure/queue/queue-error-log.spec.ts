import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { QueueErrorLog, REPEATED_ERROR_WINDOW_MS } from './queue-error-log.js';

interface Line {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const REFUSED = 'connect ECONNREFUSED 127.0.0.1:6379';

/** Une file telle que l'application en détient, sans connexion à Redis. */
function queueNamed(name: string): Queue {
  return Object.assign(Object.create(Queue.prototype) as Queue, { name });
}

describe('QueueErrorLog', () => {
  let now: number;

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Le journal des files, un journal qui retient ce qu'on lui confie, et l'application. */
  function setup(instances: unknown[] = []): { log: QueueErrorLog; lines: Line[] } {
    const lines: Line[] = [];
    const logger = {
      setContext: (): void => undefined,
      error: (fields: Record<string, unknown>, message: string): void => {
        lines.push({ fields, message });
      },
    } as unknown as PinoLogger;
    const discovery = {
      getProviders: () => instances.map((instance) => ({ instance })),
    } as unknown as DiscoveryService;
    return { log: new QueueErrorLog(discovery, logger), lines };
  }

  it('écrit ce que signale une file ou son exécutant, avec son nom et sa provenance', () => {
    const { log, lines } = setup();
    const lost = new Error(REFUSED);
    const lockLost = new Error('Missing lock for job 42. moveToFinished');
    const unavailable = new Error('Database is not reachable');

    log.queueError('domain-events', lost);
    log.workerError('outbox-relay', lockLost);
    log.runFailed('account-maintenance', unavailable);

    expect(lines).toEqual([
      {
        fields: { err: lost, queue: 'domain-events', source: 'queue' },
        message: 'Background queue error',
      },
      {
        fields: { err: lockLost, queue: 'outbox-relay', source: 'worker' },
        message: 'Background queue error',
      },
      {
        fields: { err: unavailable, queue: 'account-maintenance' },
        message: 'Background job failed',
      },
    ]);
  });

  it('une même erreur répétée par le même objet n’est écrite qu’une fois par période, avec le nombre de répétitions', () => {
    const { log, lines } = setup();

    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).not.toHaveProperty('repeated');

    // Dix fois par seconde tant que Redis ne répond pas : rien de plus n'est écrit…
    for (let elapsed = 100; elapsed < REPEATED_ERROR_WINDOW_MS; elapsed += 100) {
      now = T0 + elapsed;
      log.workerError('outbox-relay', new Error(REFUSED));
    }
    expect(lines).toHaveLength(1);

    // … jusqu'à la fin de la période : une ligne, qui dit ce qui a été passé sous silence.
    now = T0 + REPEATED_ERROR_WINDOW_MS;
    const again = new Error(REFUSED);
    log.workerError('outbox-relay', again);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      fields: { err: again, queue: 'outbox-relay', source: 'worker', repeated: 299 },
      message: 'Background queue error',
    });

    // La période repart de cette ligne, et le décompte de zéro.
    now = T0 + 2 * REPEATED_ERROR_WINDOW_MS - 1;
    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(2);
    now = T0 + 2 * REPEATED_ERROR_WINDOW_MS;
    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(3);
    expect(lines[2]?.fields).toMatchObject({ repeated: 1 });
  });

  it('deux erreurs différentes, ou la même sur deux objets, ne se masquent jamais', () => {
    const { log, lines } = setup();

    log.workerError('outbox-relay', new Error(REFUSED));
    // Même erreur, autre file.
    log.workerError('domain-events', new Error(REFUSED));
    // Même file, même erreur : la file elle-même, et non son exécutant.
    log.queueError('outbox-relay', new Error(REFUSED));
    // Même file, même erreur : un passage en échec.
    log.runFailed('outbox-relay', new Error(REFUSED));
    // Même objet, autre message.
    log.workerError('outbox-relay', new Error('Missing lock for job 42. moveToFinished'));
    // Même objet, même message, autre nature d'erreur.
    log.workerError('outbox-relay', new TypeError(REFUSED));
    // Ce qui n'est pas une erreur est écrit aussi.
    log.workerError('outbox-relay', REFUSED);

    expect(
      lines.map(({ fields, message }) => [fields['queue'], fields['source'], message]),
    ).toEqual([
      ['outbox-relay', 'worker', 'Background queue error'],
      ['domain-events', 'worker', 'Background queue error'],
      ['outbox-relay', 'queue', 'Background queue error'],
      ['outbox-relay', undefined, 'Background job failed'],
      ['outbox-relay', 'worker', 'Background queue error'],
      ['outbox-relay', 'worker', 'Background queue error'],
      ['outbox-relay', 'worker', 'Background queue error'],
    ]);

    // Et chacune se répète sans rien écrire de plus.
    log.workerError('outbox-relay', new Error(REFUSED));
    log.queueError('outbox-relay', new Error(REFUSED));
    log.runFailed('outbox-relay', new Error(REFUSED));
    log.workerError('outbox-relay', new TypeError(REFUSED));
    log.workerError('outbox-relay', REFUSED);
    expect(lines).toHaveLength(7);
  });

  it('pendant une panne, chaque objet garde son décompte : écrire l’un n’efface pas celui des autres', () => {
    const { log, lines } = setup();
    const queues = ['domain-events', 'outbox-relay', 'account-maintenance'];
    const everyone = (): void => {
      for (const queue of queues) {
        log.queueError(queue, new Error(REFUSED));
        log.workerError(queue, new Error(REFUSED));
      }
    };

    everyone();
    expect(lines).toHaveLength(6);
    // Chaque connexion réessaie de son côté : huit fois en vingt secondes.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      now = T0 + attempt * 2_500;
      everyone();
    }
    expect(lines).toHaveLength(6);

    // La période passée, les six lignes suivantes portent chacune leur décompte.
    now = T0 + REPEATED_ERROR_WINDOW_MS + 7_000;
    everyone();
    expect(lines).toHaveLength(12);
    expect(lines.slice(6).map(({ fields }) => fields['repeated'])).toEqual([8, 8, 8, 8, 8, 8]);
  });

  it('une erreur qui n’est plus survenue depuis une période est oubliée, décompte compris', () => {
    const { log, lines } = setup();

    log.workerError('outbox-relay', new Error(REFUSED));
    now = T0 + 5_000;
    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(1);

    // Trente-cinq secondes sans elle ; une autre erreur est écrite entre-temps.
    now = T0 + 40_000;
    log.workerError('domain-events', new Error('Missing lock for job 7. moveToFinished'));
    expect(lines).toHaveLength(2);

    // Elle revient : c'est une nouvelle panne, écrite sans décompte.
    now = T0 + 41_000;
    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(3);
    expect(lines[2]?.fields).not.toHaveProperty('repeated');
  });

  it('une erreur plus rare que la période est écrite à chaque fois', () => {
    const { log, lines } = setup();
    for (let occurrence = 0; occurrence < 4; occurrence += 1) {
      now = T0 + occurrence * (REPEATED_ERROR_WINDOW_MS + 1);
      log.runFailed('account-maintenance', new Error('Account maintenance: 1 step(s) failed.'));
    }
    expect(lines).toHaveLength(4);
    expect(lines.every(({ fields }) => !('repeated' in fields))).toBe(true);
  });

  it('une horloge qui recule ne fait pas taire les erreurs', () => {
    const { log, lines } = setup();
    log.workerError('outbox-relay', new Error(REFUSED));
    // L'heure du système est corrigée d'une heure en arrière.
    now = T0 - 3_600_000;
    log.workerError('outbox-relay', new Error(REFUSED));
    expect(lines).toHaveLength(2);
  });

  it('écoute d’office chaque file de l’application, une seule fois', () => {
    const events = queueNamed('domain-events');
    const relay = queueNamed('outbox-relay');
    // Ce qui n'est pas une file n'est pas touché.
    const other = { on: jest.fn(), name: 'not-a-queue' };
    const { log, lines } = setup([null, undefined, other, events, relay, relay]);

    log.onModuleInit();
    // Un second passage, ou une file déclarée deux fois, n'ajoute pas d'écouteur.
    log.onModuleInit();

    expect(events.listenerCount('error')).toBe(1);
    expect(relay.listenerCount('error')).toBe(1);
    expect(other.on).not.toHaveBeenCalled();

    const lost = new Error(REFUSED);
    events.emit('error', lost);
    relay.emit('error', lost);
    expect(lines).toEqual([
      {
        fields: { err: lost, queue: 'domain-events', source: 'queue' },
        message: 'Background queue error',
      },
      {
        fields: { err: lost, queue: 'outbox-relay', source: 'queue' },
        message: 'Background queue error',
      },
    ]);
  });
});
