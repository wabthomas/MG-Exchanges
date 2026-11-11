# 0002 — Node.js 24 LTS, modules ES, TypeScript 6 strict

**Statut :** acceptée (2026-11-11)

## Contexte

NestJS 12 est publié exclusivement en modules ES. TypeScript 7 est sorti, mais plusieurs
outils retenus (`typescript-eslint`, `ts-jest`, `@nestjs/swagger`, CLI Nest) déclarent ne
prendre en charge que TypeScript < 7.

## Décision

- **Node.js 24 LTS** (`engines: >=24.15`), image `node:24-bookworm-slim`.
- **Modules ES** partout (`"type": "module"`, `module: nodenext`).
- **TypeScript 6.0.3**, mode strict renforcé : `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `verbatimModuleSyntax`, `isolatedModules`.
- ESLint 10 avec analyse de types (`strictTypeChecked`), zéro avertissement toléré.

## Conséquences

- Imports relatifs avec extension `.js` ; `import type` obligatoire pour les imports
  purement typés (sinon un import parasite subsiste à l'exécution — règle ESLint dédiée).
- Passage à TypeScript 7 et à Node.js 26 dès que l'outillage les prend en charge
  officiellement ; Node.js 22 et 26 ne sont pas vérifiés à ce jour.
