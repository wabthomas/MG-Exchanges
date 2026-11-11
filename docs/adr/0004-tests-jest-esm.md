# 0004 — Jest 30 en mode ESM ; services réels pour l'intégration

**Statut :** acceptée (2026-11-11)

## Contexte

Jest est l'outil de test demandé. NestJS 12 étant en modules ES, le générateur officiel
propose désormais Vitest pour les projets ESM. La prise en charge ESM de Jest reste
qualifiée d'expérimentale par ses auteurs.

## Décision

- **Jest 30** avec `--experimental-vm-modules` et `ts-jest` en mode ESM (transpilation
  seule ; les types sont vérifiés par `tsc`).
- Tests de propriétés (`fast-check`) pour les calculs monétaires.
- Les tests d'intégration et de bout en bout s'exécutent sur **PostgreSQL, Redis et BullMQ
  réels** : une base par fichier de test, clonée d'une base modèle créée par les vraies
  migrations, avec les mêmes rôles restreints qu'en production. Aucune base simulée.

## Conséquences

- Vérifié sur Node.js 24.22 (résultats détaillés dans `PROJECT_STATUS.md`).
- Limite constatée : sous Jest, un paquet CommonJS qui fait `require()` d'un paquet ESM de
  NestJS échoue. `@nestjs/throttler` (CommonJS) a été écarté pour cette raison (ADR 0010).
  Toute dépendance CommonJS liée à NestJS doit être validée sous Jest avant adoption.
- Si cette limite devenait bloquante, Vitest est l'alternative documentée par NestJS ;
  la migration serait mécanique (API très proche).
