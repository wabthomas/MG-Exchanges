import { jest } from '@jest/globals';

/**
 * Délai accordé à chaque test et à chaque étape de préparation des suites qui s'exécutent sur
 * un PostgreSQL et un Redis réels (5 secondes par défaut).
 *
 * Il se règle ici, et non par l'option `testTimeout` de chaque projet de `jest.config.js` :
 * Jest n'applique cette option que lorsqu'elle est globale — celle d'un projet est acceptée,
 * affichée par `--showConfig`, puis ignorée.
 */
jest.setTimeout(30_000);
