# Architecture

## Vue d'ensemble

MG-Exchange démarre en **monolithe modulaire** : une seule application NestJS, déployée
comme une unité, mais découpée en modules aux frontières strictes afin qu'un domaine puisse
être extrait plus tard sans réécriture. Les décisions structurantes sont consignées dans
[`docs/adr/`](adr/README.md).

```
            clients (web, mobile, back-office — phase 7)
                              │ HTTPS
                        ┌─────▼─────┐
                        │   Nginx   │  point d'entrée, limitation de débit amont
                        └─────┬─────┘
                        ┌─────▼─────┐
                        │ API NestJS│  monolithe modulaire
                        └──┬─────┬──┘
              ┌────────────▼┐   ┌▼───────────────┐
              │ PostgreSQL  │   │     Redis      │
              │ source de   │   │ limitation de  │
              │ vérité      │   │ débit, files   │
              └─────────────┘   └────────────────┘
```

PostgreSQL est l'unique source de vérité. Redis ne contient que des données reconstructibles
ou transitoires (compteurs, files de traitement).

## Organisation du dépôt

| Emplacement           | Contenu                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/api`            | l'API                                                                      |
| `packages/shared`     | primitives métier pures (`Money`) — aucune dépendance, portable web/mobile |
| `packages/validation` | schémas Zod primitifs (montant, actif, horodatage, identifiant de requête) |
| `packages/contracts`  | contrats de l'API : formes des réponses, catalogue des codes d'erreur      |
| `packages/config`     | préréglages TypeScript, ESLint, Jest                                       |
| `infrastructure/`     | Docker, PostgreSQL (rôles), Nginx                                          |

Dépendances entre paquets : `contracts → validation → shared`. Les paquets `shared`,
`validation` et `contracts` sont destinés à être consommés tels quels par les applications
web et mobile : ils n'utilisent ni API Node.js ni framework serveur (règle ESLint).

## Structure de l'API

```
apps/api/src/
  main.ts                 point d'entrée : charge et valide la configuration, démarre
  app.module.ts           racine : assemble socle technique et modules
  bootstrap/              configuration HTTP partagée par l'exécution réelle et les tests
  config/                 schéma des variables d'environnement, configuration typée
  common/                 transverse : erreurs, filtre global, validation, expurgation
  infrastructure/         PostgreSQL (Prisma), Redis, files (BullMQ), journalisation, débit
  modules/
    health/               sondes de vivacité et de disponibilité
    system-settings/      mode maintenance, activation des fonctionnalités
    audit/                journal d'audit en ajout seul
    outbox/               boîte d'envoi transactionnelle et distribution des événements
```

### Couches d'un module métier

`system-settings` sert de modèle aux modules métier à venir :

| Couche            | Rôle                                           | Peut dépendre de                     |
| ----------------- | ---------------------------------------------- | ------------------------------------ |
| `domain/`         | règles et types métier purs                    | `@mgx/shared`, `@mgx/contracts`, Zod |
| `application/`    | cas d'usage, ports (interfaces de persistance) | `domain`, services d'autres modules  |
| `infrastructure/` | adaptateurs : implémentation Prisma des ports  | `application`, `domain`              |
| `presentation/`   | contrôleurs HTTP, gardes, décorateurs          | `application`, `domain`              |

Ces frontières sont **vérifiées par ESLint** : le domaine ne peut importer ni NestJS, ni
Prisma, ni aucune bibliothèque d'entrées/sorties ; la couche application ignore HTTP.

Les modules de plateforme (`audit`, `outbox`) sont volontairement plus minces : ils _sont_
le mécanisme de persistance et s'appuient directement sur le client de base de données.

## Principes transverses

**Transactions explicites.** `UnitOfWork.run(tx => …)` délimite une transaction ; le client
`tx` est passé explicitement à chaque service qui y participe. Les frontières de transaction
sont donc toujours visibles dans le code — essentiel pour les opérations financières.

**Rien d'important sans trace.** `AuditService.record(tx, …)` écrit dans la transaction de
l'opération auditée : une action sensible ne peut pas aboutir sans son entrée d'audit.

**Événements fiables.** `OutboxService.append(tx, …)` enregistre l'événement avec les
données ; un relais le publie ensuite sur une file BullMQ, au moins une fois, sans doublon
entre instances (`FOR UPDATE SKIP LOCKED`). Les consommateurs sont idempotents.

**Fonctionnalités fermées par défaut.** Chaque fonctionnalité réglementée est un paramètre
système, désactivé tant qu'aucune décision tracée ne l'ouvre. `@RequiresFeature('exchange')`
suffit à y soumettre une route ; `@AllowDuringMaintenance()` exempte une route du mode maintenance.

**Aucun flottant pour l'argent.** Montants en `bigint` d'unités minimales dans le code,
chaînes décimales sur le fil, `NUMERIC` en base (ADR 0007). ESLint interdit `parseFloat` et `toFixed`.

**Configuration validée.** Toute variable d'environnement est validée au démarrage ; aucune
partie du code ne lit `process.env` en dehors de `config/`.

## Conventions

- **Langue** : identifiants et messages émis à l'exécution (API, journaux) en anglais ;
  commentaires et documentation en français. Les clients traduisent à partir des codes d'erreur.
- **Nommage** : fichiers `kebab-case` suffixés par leur rôle (`.service.ts`, `.controller.ts`,
  `.guard.ts`, `.repository.ts`, `.spec.ts`) ; classes `PascalCase` ; tables `snake_case` au pluriel.
- **Modules ES** : imports relatifs avec extension `.js` ; `import type` pour les imports
  purement typés (vérifié par ESLint).
- **Tests** : unitaires à côté du code (`*.spec.ts`) ; intégration et bout en bout dans
  `apps/api/test/`, toujours sur des services réels.
- **Dépendances** : versions exactes dans le catalogue de `pnpm-workspace.yaml`.

## Ajouter un module métier

1. Créer `modules/<nom>/` avec les quatre couches et un `<nom>.module.ts`.
2. Modéliser les tables dans `schema.prisma`, créer la migration (`pnpm db:migrate:dev --create-only`),
   y ajouter contraintes et déclencheurs à la main, la documenter dans `DATABASE.md`.
3. Définir les contrats (schémas Zod) dans `@mgx/contracts`.
4. Écrire les cas d'usage en passant `tx` à l'audit et à la boîte d'envoi.
5. Protéger les routes : `@RequiresFeature(...)`, limites de débit dédiées, permissions.
6. Tester : unitaires, intégration sur PostgreSQL réel (concurrence comprise), bout en bout.
7. Importer le module dans `app.module.ts`.
