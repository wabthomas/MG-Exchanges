// Configuration ESLint partagée (format « flat config », ESLint 10).
//
// Trois familles de règles :
//  1. qualité TypeScript stricte, avec analyse de types (typescript-eslint) ;
//  2. garde-fous financiers : aucun calcul monétaire en virgule flottante ;
//  3. frontières d'architecture : le domaine ne dépend ni du framework ni de l'infrastructure.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FLOAT_MONEY_MESSAGE =
  'Interdit : les montants ne passent jamais par un nombre flottant. Utiliser Money / parseDecimalToUnits de @mgx/shared (bigint).';

/** Motifs d'import interdits au code de domaine (pur, sans framework ni E/S). */
const DOMAIN_FORBIDDEN_IMPORTS = [
  { group: ['@nestjs/*'], message: 'Le domaine ne dépend pas de NestJS.' },
  {
    group: ['@prisma/*', '**/generated/prisma/**'],
    message: 'Le domaine ne dépend pas de Prisma.',
  },
  {
    group: ['ioredis', 'bullmq', 'express', 'pino', 'nestjs-pino'],
    message: 'Le domaine ne fait pas d’E/S.',
  },
  {
    group: ['**/infrastructure/**', '**/presentation/**', '**/application/**'],
    message: 'Le domaine ne dépend que de lui-même et de @mgx/shared.',
  },
];

/**
 * @param {object} options
 * @param {string} options.tsconfigRootDir Racine du monorepo (résolution des tsconfig).
 */
export function createEslintConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores([
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      '**/prisma/migrations/**',
    ]),

    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,

    {
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
      rules: {
        eqeqeq: ['error', 'always'],
        curly: ['error', 'all'],
        'no-console': 'error',
        'no-var': 'error',
        'prefer-const': 'error',
        'no-restricted-globals': ['error', { name: 'parseFloat', message: FLOAT_MONEY_MESSAGE }],
        'no-restricted-properties': [
          'error',
          { object: 'Number', property: 'parseFloat', message: FLOAT_MONEY_MESSAGE },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "CallExpression[callee.property.name='toFixed']",
            message: FLOAT_MONEY_MESSAGE,
          },
        ],

        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        // Avec `verbatimModuleSyntax`, `import { type X } from 'm'` laisse un `import 'm'` à
        // l'exécution : un import purement typé s'écrit `import type { X } from 'm'`.
        '@typescript-eslint/no-import-type-side-effects': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/restrict-template-expressions': [
          'error',
          { allowNumber: true, allowBoolean: true },
        ],
        // Les modules NestJS sont des classes décorées sans membres.
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
        '@typescript-eslint/switch-exhaustiveness-check': [
          'error',
          { considerDefaultExhaustiveForUnions: true },
        ],
        '@typescript-eslint/no-confusing-void-expression': [
          'error',
          { ignoreArrowShorthand: true },
        ],
      },
    },

    // --- Frontières d'architecture -------------------------------------------------------
    {
      name: 'mgx/architecture/domain-is-pure',
      files: ['apps/*/src/modules/*/domain/**/*.ts'],
      rules: { 'no-restricted-imports': ['error', { patterns: DOMAIN_FORBIDDEN_IMPORTS }] },
    },
    {
      name: 'mgx/architecture/application-ignores-presentation',
      files: ['apps/*/src/modules/*/application/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/presentation/**', 'express'],
                message: 'La couche application ignore HTTP et la couche présentation.',
              },
            ],
          },
        ],
      },
    },
    {
      name: 'mgx/architecture/shared-packages-are-portable',
      files: ['packages/{shared,validation,contracts}/src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['node:*', '@nestjs/*', '@prisma/*'],
                message:
                  'Ces paquets sont partagés avec le web et le mobile : ni API Node.js, ni framework serveur.',
              },
            ],
          },
        ],
      },
    },

    // --- Tests : lisibilité privilégiée, sans relâcher les garde-fous financiers ----------
    {
      name: 'mgx/tests',
      files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },

    // --- Fichiers de configuration JavaScript : pas d'analyse de types ---------------------
    {
      name: 'mgx/javascript-config-files',
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },

    // Prettier a le dernier mot sur la mise en forme.
    prettier,
  );
}
