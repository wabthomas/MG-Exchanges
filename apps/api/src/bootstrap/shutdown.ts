import type { Server } from 'node:http';

/** Signaux d'arrêt écoutés : celui de l'orchestrateur, et celui du clavier. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Pendant l'arrêt, intervalle auquel sont fermées les connexions redevenues inactives : une
 * connexion que le client garde ouverte ne retient plus rien une fois sa réponse partie.
 */
export const IDLE_CONNECTION_SWEEP_MS = 250;

/** Ce que l'arrêt écrit ; `PinoLogger` s'y conforme. */
export interface ShutdownLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Ce que l'arrêt demande à l'application : son serveur HTTP, et sa fermeture ordonnée. */
export interface ClosableApplication {
  getHttpServer(): Pick<Server, 'close' | 'closeIdleConnections'>;
  close(signal?: string): Promise<void>;
}

/** Ce que l'arrêt demande au processus : pouvoir écouter ses signaux, et cesser de le faire. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownOptions {
  /** Durée au-delà de laquelle le processus se termine sans attendre la fin de la fermeture. */
  readonly timeoutMs: number;
  readonly log: ShutdownLog;
  /** Met fin au processus. Injecté : les tests ne s'arrêtent pas avec ce qu'ils éprouvent. */
  readonly exit: (code: number) => void;
}

/**
 * Arrête l'application à la demande, dans un temps borné.
 *
 *  1. Le serveur HTTP cesse aussitôt d'accepter des connexions ; les requêtes en cours vont à
 *     leur terme.
 *  2. L'application se ferme dans l'ordre de NestJS : les tâches de fond en cours s'achèvent
 *     (`onModuleDestroy`), le serveur HTTP attend ses dernières réponses, puis les files,
 *     Redis et la base sont fermés (`onApplicationShutdown`) : rien de ce dont se sert une
 *     requête ou une tâche en cours n'est fermé sous elle.
 *  3. Si cette fermeture n'a pas abouti à l'échéance, le processus se termine quand même, avec
 *     le code 1 et une ligne d'erreur.
 *
 * La troisième règle est la raison d'être de ce module : la fermeture d'un exécutant de file
 * attend sa connexion à Redis, et ne revient pas tant que Redis est injoignable. Sans borne,
 * le processus restait là — et, la première règle manquant, continuait de répondre — jusqu'à
 * ce que l'orchestrateur le tue. Rien n'est perdu à l'échéance : une transaction interrompue
 * est annulée par PostgreSQL, un événement non relayé reste dans la boîte d'envoi, une tâche
 * interrompue est reprise.
 *
 * Se termine par `exit(0)` quand tout s'est fermé, par `exit(1)` sinon — une seule fois.
 */
export async function shutdown(
  app: ClosableApplication,
  signal: string,
  { timeoutMs, log, exit }: ShutdownOptions,
): Promise<void> {
  log.info({ signal, timeoutMs }, 'Shutdown requested');

  const server = app.getHttpServer();
  // L'échéance peut tomber pendant l'attente de la fermeture : l'issue se décide une fois.
  const state: { finished: boolean; deadline?: NodeJS.Timeout; sweep?: NodeJS.Timeout } = {
    finished: false,
  };
  const finish = (code: number): void => {
    if (state.finished) {
      return;
    }
    state.finished = true;
    clearTimeout(state.deadline);
    clearInterval(state.sweep);
    exit(code);
  };

  state.deadline = setTimeout(() => {
    log.error({ signal, timeoutMs }, 'Shutdown did not complete in time: exiting');
    finish(1);
  }, timeoutMs);
  state.sweep = setInterval(() => {
    server.closeIdleConnections();
  }, IDLE_CONNECTION_SWEEP_MS);

  try {
    // Avant tout le reste : la suite peut attendre longtemps, le trafic ne doit pas la suivre.
    server.close();
    await app.close(signal);
  } catch (error) {
    if (!state.finished) {
      log.error({ err: error, signal }, 'Shutdown failed: exiting');
    }
    finish(1);
    return;
  }
  if (!state.finished) {
    log.info({ signal }, 'Shutdown complete');
  }
  finish(0);
}

/**
 * Écoute les signaux d'arrêt. Le premier lance l'arrêt borné ; un second, reçu pendant
 * l'arrêt, y met fin sur-le-champ — qui insiste n'a pas à attendre l'échéance.
 */
export function installShutdown(
  app: ClosableApplication,
  options: ShutdownOptions,
  target: SignalSource = process,
): void {
  let requested = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, () => {
      if (requested) {
        options.log.error({ signal }, 'Second shutdown signal: exiting now');
        options.exit(1);
        return;
      }
      requested = true;
      void shutdown(app, signal, options);
    });
  }
}
