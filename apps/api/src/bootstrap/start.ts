import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../config/app-config.js';
import { createApp } from './create-app.js';
import {
  installShutdown,
  SHUTDOWN_SIGNALS,
  type ShutdownSignal,
  type SignalSource,
} from './shutdown.js';

export interface StartOptions {
  /** Source des signaux d'arrêt : le processus, sauf dans les tests. */
  readonly signals?: SignalSource;
  /** Fin du processus : `process.exit`, sauf dans les tests. */
  readonly exit?: (code: number) => void;
  /** Avis écrit avant que le journal existe : sur la sortie d'erreur, sauf dans les tests. */
  readonly notice?: (message: string) => void;
}

/**
 * Lance l'API : crée l'application, installe l'arrêt borné, puis écoute.
 *
 * Une demande d'arrêt est entendue dès l'appel :
 *  - tant que l'application s'initialise, elle n'a ni requête ni tâche à mener à son terme —
 *    le processus se termine sur-le-champ, par le code 0, après un avis sur la sortie
 *    d'erreur (le journal n'écrit encore rien) ;
 *  - ensuite, l'arrêt borné prend le relais ({@link installShutdown}), installé avant que
 *    l'API n'accepte sa première connexion.
 *
 * Sans la première règle, un signal reçu pendant l'initialisation resterait sans effet là où
 * l'API est le premier processus de son conteneur : le système n'y arrête pas un processus
 * qui n'écoute pas ses signaux. C'est encore le cas avant cet appel, pendant le chargement du
 * programme.
 */
export async function startApp({
  signals = process,
  exit = (code) => process.exit(code),
  notice = (message) => process.stderr.write(`${message}\n`),
}: StartOptions = {}): Promise<NestExpressApplication> {
  const beforeReady = new Map<ShutdownSignal, () => void>();
  for (const signal of SHUTDOWN_SIGNALS) {
    const stop = (): void => {
      notice(`Shutdown requested (${signal}) before the application was ready: exiting.`);
      exit(0);
    };
    beforeReady.set(signal, stop);
    signals.on(signal, stop);
  }

  const app = await createApp();
  const config = app.get(AppConfig);

  for (const [signal, stop] of beforeReady) {
    signals.off(signal, stop);
  }

  const shutdownLog = await app.resolve(PinoLogger);
  shutdownLog.setContext('Shutdown');
  installShutdown(
    app,
    { timeoutMs: config.app.shutdownTimeoutMs, log: shutdownLog, exit },
    signals,
  );

  await app.listen(config.app.port, config.app.host);

  app
    .get(Logger)
    .log(
      `${config.app.name} ${config.app.version} listening on ${config.app.host}:${config.app.port} (${config.app.environment})`,
      'Bootstrap',
    );
  return app;
}
