// Configuration Jest commune à tous les projets du monorepo.
//
// Le code est en ESM natif : Jest s'exécute avec `node --experimental-vm-modules`
// (voir docs/adr/0004-tests-jest-esm.md). ts-jest transpile fichier par fichier
// (`isolatedModules`), la vérification des types étant assurée par `pnpm typecheck`.

/**
 * @param {object} [options]
 * @param {string} [options.tsconfig] Chemin du tsconfig utilisé pour la transpilation.
 * @param {Record<string, string>} [options.moduleNameMapper] Alias supplémentaires.
 * @returns {import('jest').Config}
 */
export function createJestConfig(options = {}) {
  const { tsconfig = '<rootDir>/tsconfig.json', moduleNameMapper = {} } = options;

  return {
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
      ...moduleNameMapper,
      // Les imports relatifs ESM portent l'extension `.js` ; les sources sont en `.ts`.
      '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {
      '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig }],
    },
    // Aucun état partagé entre tests : les mocks sont remis à zéro automatiquement.
    clearMocks: true,
    restoreMocks: true,
    // Un test qui laisse fuir une promesse rejetée ou un handle ouvert doit échouer.
    errorOnDeprecated: true,
    coverageProvider: 'v8',
    coverageDirectory: '<rootDir>/coverage',
    coverageReporters: ['text-summary', 'lcov'],
  };
}

/**
 * Alias Jest pointant les paquets internes vers leurs sources TypeScript,
 * afin que les tests n'exigent aucune compilation préalable.
 *
 * @param {string} packagesDirectory Chemin (relatif à <rootDir>) du dossier `packages`.
 * @returns {Record<string, string>}
 */
export function workspaceSourceAliases(packagesDirectory) {
  return {
    '^@mgx/(shared|validation|contracts)$': `${packagesDirectory}/$1/src/index.ts`,
  };
}
