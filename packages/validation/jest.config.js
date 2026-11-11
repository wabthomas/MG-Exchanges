import { createJestConfig, workspaceSourceAliases } from '@mgx/config/jest';

/** @type {import('jest').Config} */
export default {
  ...createJestConfig({ moduleNameMapper: workspaceSourceAliases('<rootDir>/..') }),
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
};
