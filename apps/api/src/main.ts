import { existsSync } from 'node:fs';

import { Logger } from 'nestjs-pino';

import { createApp } from './bootstrap/create-app.js';
import { AppConfig, ConfigValidationError, loadAppConfig } from './config/app-config.js';

// Développement local uniquement : charge `.env` s'il existe. En production, la
// configuration provient exclusivement de l'environnement du processus (gestionnaire de secrets).
if (process.env['NODE_ENV'] !== 'production' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Validation de la configuration avant tout démarrage : message clair, sans aucune valeur.
try {
  loadAppConfig();
} catch (error) {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const app = await createApp();
const config = app.get(AppConfig);

await app.listen(config.app.port, config.app.host);

app
  .get(Logger)
  .log(
    `${config.app.name} ${config.app.version} listening on ${config.app.host}:${config.app.port} (${config.app.environment})`,
    'Bootstrap',
  );
