import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  type ClosableApplication,
  IDLE_CONNECTION_SWEEP_MS,
  installShutdown,
  shutdown,
  SHUTDOWN_SIGNALS,
  type ShutdownOptions,
  type SignalSource,
} from './shutdown.js';

interface Line {
  readonly level: 'info' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const TIMEOUT_MS = 8000;

/** Laisse s'exécuter ce que les promesses déjà résolues ont mis en attente. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

describe('arrêt borné', () => {
  let steps: string[];
  let lines: Line[];
  let exits: number[];
  let options: ShutdownOptions;

  beforeEach(() => {
    jest.useFakeTimers();
    steps = [];
    lines = [];
    exits = [];
    options = {
      timeoutMs: TIMEOUT_MS,
      log: {
        info: (fields, message) => lines.push({ level: 'info', fields, message }),
        error: (fields, message) => lines.push({ level: 'error', fields, message }),
      },
      exit: (code) => exits.push(code),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Une application dont la fermeture aboutit quand — et comme — le test le décide. */
  function application(): {
    app: ClosableApplication;
    closed: () => void;
    failed: (error: Error) => void;
  } {
    let closed!: () => void;
    let failed!: (error: Error) => void;
    const closing = new Promise<void>((resolve, reject) => {
      closed = resolve;
      failed = reject;
    });
    // Si l'arrêt n'attendait pas la fermeture, son échec n'aurait personne pour le recevoir :
    // Node mettrait fin aux tests au lieu de laisser leurs vérifications le dire.
    closing.catch(() => undefined);
    const app: ClosableApplication = {
      getHttpServer: () => ({
        close: () => {
          steps.push('server.close');
          return undefined as never;
        },
        closeIdleConnections: () => {
          steps.push('server.closeIdleConnections');
        },
      }),
      close: (signal) => {
        steps.push(`app.close(${String(signal)})`);
        return closing;
      },
    };
    return { app, closed, failed };
  }

  it('ferme le serveur HTTP d’abord, puis l’application, et se termine par le code 0', async () => {
    const { app, closed } = application();

    const done = shutdown(app, 'SIGTERM', options);
    expect(steps).toEqual(['server.close', 'app.close(SIGTERM)']);
    expect(exits).toEqual([]);

    closed();
    await done;

    expect(exits).toEqual([0]);
    expect(lines).toEqual([
      {
        level: 'info',
        fields: { signal: 'SIGTERM', timeoutMs: TIMEOUT_MS },
        message: 'Shutdown requested',
      },
      { level: 'info', fields: { signal: 'SIGTERM' }, message: 'Shutdown complete' },
    ]);
  });

  it('une fermeture aboutie ne laisse ni échéance ni balayage derrière elle', async () => {
    const { app, closed } = application();

    const done = shutdown(app, 'SIGTERM', options);
    closed();
    await done;
    const stepsAtExit = [...steps];
    jest.advanceTimersByTime(10 * TIMEOUT_MS);

    expect(exits).toEqual([0]);
    expect(steps).toEqual(stepsAtExit);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('se termine par le code 1 à l’échéance, pas avant, si la fermeture n’aboutit pas', async () => {
    const { app } = application();

    void shutdown(app, 'SIGTERM', options);
    jest.advanceTimersByTime(TIMEOUT_MS - 1);
    await settle();
    expect(exits).toEqual([]);

    jest.advanceTimersByTime(1);

    expect(exits).toEqual([1]);
    expect(lines.at(-1)).toEqual({
      level: 'error',
      fields: { signal: 'SIGTERM', timeoutMs: TIMEOUT_MS },
      message: 'Shutdown did not complete in time: exiting',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('une fermeture qui aboutit après l’échéance ne change plus l’issue', async () => {
    const { app, closed } = application();

    const done = shutdown(app, 'SIGTERM', options);
    jest.advanceTimersByTime(TIMEOUT_MS);
    closed();
    await done;

    expect(exits).toEqual([1]);
    expect(lines.map((line) => line.message)).toEqual([
      'Shutdown requested',
      'Shutdown did not complete in time: exiting',
    ]);
  });

  it('se termine par le code 1 si la fermeture échoue, en écrivant pourquoi', async () => {
    const { app, failed } = application();
    const cause = new Error('Connection is closed.');

    const done = shutdown(app, 'SIGINT', options);
    failed(cause);
    await done;

    expect(exits).toEqual([1]);
    expect(lines.at(-1)).toEqual({
      level: 'error',
      fields: { err: cause, signal: 'SIGINT' },
      message: 'Shutdown failed: exiting',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('une fermeture qui échoue après l’échéance n’écrit plus rien', async () => {
    const { app, failed } = application();

    const done = shutdown(app, 'SIGTERM', options);
    jest.advanceTimersByTime(TIMEOUT_MS);
    failed(new Error('Connection is closed.'));
    await done;

    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(2);
  });

  it('ferme, tant que dure l’arrêt, les connexions redevenues inactives', async () => {
    const { app, closed } = application();
    const sweeps = (): number =>
      steps.filter((step) => step === 'server.closeIdleConnections').length;

    const done = shutdown(app, 'SIGTERM', options);
    expect(sweeps()).toBe(0);
    jest.advanceTimersByTime(IDLE_CONNECTION_SWEEP_MS);
    expect(sweeps()).toBe(1);
    jest.advanceTimersByTime(3 * IDLE_CONNECTION_SWEEP_MS);
    expect(sweeps()).toBe(4);

    closed();
    await done;
    jest.advanceTimersByTime(10 * IDLE_CONNECTION_SWEEP_MS);

    expect(sweeps()).toBe(4);
    expect(IDLE_CONNECTION_SWEEP_MS).toBeLessThanOrEqual(1000);
  });

  describe('signaux', () => {
    /** Un processus qui retient ses écouteurs, et permet d'émettre un signal. */
    function target(): {
      process: SignalSource;
      emit: (signal: string) => void;
      listened: () => (string | symbol)[];
    } {
      const emitter = new EventEmitter();
      return {
        process: emitter,
        emit: (signal) => {
          emitter.emit(signal);
        },
        listened: () => emitter.eventNames(),
      };
    }

    it('écoute SIGTERM et SIGINT, et rien d’autre', () => {
      const { app } = application();
      const { process, listened } = target();

      installShutdown(app, options, process);

      expect(listened()).toEqual(['SIGTERM', 'SIGINT']);
      expect(SHUTDOWN_SIGNALS).toEqual(['SIGTERM', 'SIGINT']);
      expect(steps).toEqual([]);
    });

    it.each(SHUTDOWN_SIGNALS)('%s lance l’arrêt, en le nommant', async (signal) => {
      const { app, closed } = application();
      const { process, emit } = target();
      installShutdown(app, options, process);

      emit(signal);
      closed();
      await settle();

      expect(steps).toEqual(['server.close', `app.close(${signal})`]);
      expect(exits).toEqual([0]);
      expect(lines[0]?.fields).toEqual({ signal, timeoutMs: TIMEOUT_MS });
    });

    it('un second signal, pendant l’arrêt, met fin au processus sur-le-champ', () => {
      const { app } = application();
      const { process, emit } = target();
      installShutdown(app, options, process);

      emit('SIGTERM');
      expect(exits).toEqual([]);
      emit('SIGINT');

      expect(exits).toEqual([1]);
      expect(lines.at(-1)).toEqual({
        level: 'error',
        fields: { signal: 'SIGINT' },
        message: 'Second shutdown signal: exiting now',
      });
      // L'arrêt n'a été lancé qu'une fois.
      expect(steps).toEqual(['server.close', 'app.close(SIGTERM)']);
    });
  });
});
