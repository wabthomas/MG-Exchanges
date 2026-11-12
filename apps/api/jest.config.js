import { createJestConfig, workspaceSourceAliases } from '@mgx/config/jest';

const { coverageProvider, coverageDirectory, coverageReporters, ...base } = createJestConfig({
  moduleNameMapper: workspaceSourceAliases('<rootDir>/../../packages'),
});

// Les tests d'intégration et de bout en bout utilisent un PostgreSQL et un Redis réels
// (voir test/support). Ils partagent l'instance Redis de test : les scripts les lancent
// en série (`--runInBand`). Leur délai par test (30 s) est fixé par le fichier de préparation :
// l'option `testTimeout` d'un projet est ignorée par Jest, seule la globale est appliquée.
const withRealServices = {
  ...base,
  setupFilesAfterEnv: ['<rootDir>/test/support/real-services.setup.ts'],
};

/** @type {import('jest').Config} */
export default {
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/generated/**', '!src/main.ts'],
  coverageProvider,
  coverageDirectory,
  coverageReporters,
  projects: [
    {
      ...base,
      displayName: 'unit',
      rootDir: '.',
      roots: ['<rootDir>/src'],
      testRegex: '.*\\.spec\\.ts$',
    },
    {
      ...withRealServices,
      displayName: 'integration',
      rootDir: '.',
      roots: ['<rootDir>/test/integration'],
      testRegex: '.*\\.spec\\.ts$',
    },
    {
      ...withRealServices,
      displayName: 'e2e',
      rootDir: '.',
      roots: ['<rootDir>/test/e2e'],
      testRegex: '.*\\.e2e-spec\\.ts$',
    },
  ],
};
