import { existsSync } from 'node:fs';

import { startApp } from './bootstrap/start.js';
import { ConfigValidationError, loadAppConfig } from './config/app-config.js';

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

await startApp();
