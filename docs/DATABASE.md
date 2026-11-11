# Base de données

PostgreSQL **18 ou supérieur** (fonction native `uuidv7()`), schéma géré exclusivement par
les migrations Prisma (`apps/api/prisma/`).

## Conventions

| Sujet          | Règle                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| Nommage        | tables au pluriel et colonnes en `snake_case` ; modèles Prisma en `PascalCase`               |
| Clés primaires | UUID v7 générés par la base (`uuidv7()`), ordonnés dans le temps                             |
| Horodatages    | `timestamptz(6)`, toujours en UTC                                                            |
| Montants       | `NUMERIC(38,0)` en unités minimales de l'actif — jamais `float`, `real` ni `money` (phase 3) |
| Énumérations   | types `ENUM` PostgreSQL pour les ensembles fermés et stables                                 |
| JSON           | `jsonb`, réservé aux contenus sans schéma relationnel (métadonnées, charges utiles)          |
| Intégrité      | portée par la base : `NOT NULL`, `CHECK`, clés étrangères, unicité, déclencheurs             |
| Suppression    | pas de suppression physique des données financières ou d'audit                               |

## Rôles et privilèges

Deux rôles distincts, pour que la compromission de l'API ne donne aucun pouvoir sur le schéma :

| Rôle         | Utilisé par                           | Droits                                                                                                                      |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| propriétaire | migrations (`DATABASE_MIGRATION_URL`) | possède les objets ; DDL                                                                                                    |
| applicatif   | l'API (`DATABASE_URL`)                | `SELECT`, `INSERT`, `UPDATE`, `DELETE` sur les données — aucun DDL, aucun `TRUNCATE`, ne peut pas désactiver un déclencheur |

Les privilèges sont attribués par
[`grant-app-privileges.sql`](../infrastructure/docker/postgres/sql/grant-app-privileges.sql),
exécuté une fois par base (initialisation Docker en local ; à intégrer à l'outillage
d'infrastructure ailleurs). Les tests d'intégration exécutent ce même fichier et se
connectent avec le rôle applicatif : la séparation est donc vérifiée à chaque exécution.

L'historique des migrations (`_prisma_migrations`) n'est pas une donnée applicative : qui
peut l'écrire peut faire rejouer ou ignorer une migration au déploiement suivant. Le rôle
applicatif n'y a **aucun accès**, pas même en lecture.

En développement, `DATABASE_MIGRATION_URL` peut être omise : `DATABASE_URL` est alors
utilisée pour les migrations.

## Tables (phase 1)

### `system_settings` — paramètres de la plateforme

| Colonne                    | Type           | Notes                                           |
| -------------------------- | -------------- | ----------------------------------------------- |
| `key`                      | `varchar(128)` | clé primaire ; `maintenance.mode`, `features.*` |
| `value`                    | `jsonb`        | validée par le schéma défini dans le code       |
| `version`                  | `integer`      | incrémentée à chaque modification               |
| `created_at`, `updated_at` | `timestamptz`  |                                                 |

Contraintes : format de clé (`system_settings_key_format_check`), `version >= 1`.
Les clés autorisées et le schéma de leurs valeurs sont définis dans le code ; une valeur
stockée invalide est ignorée au profit de la valeur par défaut (fonctionnalité fermée).

### `audit_logs` — journal d'audit, en ajout seul

| Colonne                                  | Type               | Notes                                           |
| ---------------------------------------- | ------------------ | ----------------------------------------------- |
| `id`                                     | `uuid`             | clé primaire, UUID v7                           |
| `occurred_at`                            | `timestamptz`      |                                                 |
| `actor_type`                             | `audit_actor_type` | `USER`, `SYSTEM`, `SERVICE`                     |
| `actor_id`                               | `varchar(64)`      | `NULL` si et seulement si l'acteur est `SYSTEM` |
| `action`                                 | `varchar(128)`     | `ressource.verbe`, ex. `system_setting.updated` |
| `resource_type`, `resource_id`           | `varchar`          | ressource concernée                             |
| `outcome`                                | `audit_outcome`    | `SUCCESS`, `FAILURE`, `DENIED`                  |
| `request_id`, `ip_address`, `user_agent` |                    | contexte de la requête                          |
| `metadata`                               | `jsonb`            | objet JSON, expurgé des secrets avant écriture  |

Index : `(occurred_at)`, `(actor_type, actor_id, occurred_at)`, `(resource_type, resource_id, occurred_at)`.

**Immuabilité, à trois niveaux :**

1. déclencheurs `audit_logs_append_only_row` et `audit_logs_append_only_truncate` : tout
   `UPDATE`, `DELETE` ou `TRUNCATE` est refusé (SQLSTATE `MGX01`), **y compris pour le
   propriétaire du schéma** ;
2. privilèges : le rôle applicatif ne possède que `INSERT` et `SELECT` sur cette table ;
3. le rôle applicatif ne peut ni désactiver un déclencheur ni modifier la table.

Une correction se fait par une nouvelle entrée, jamais par modification.

### `outbox_events` — boîte d'envoi transactionnelle

| Colonne                                       | Type            | Notes                                                  |
| --------------------------------------------- | --------------- | ------------------------------------------------------ |
| `id`                                          | `uuid`          | UUID v7 ; sert aussi d'identifiant de traitement       |
| `aggregate_type`, `aggregate_id`              | `varchar`       | entité à l'origine de l'événement                      |
| `event_type`                                  | `varchar(128)`  | `agrégat.fait`, ex. `system_setting.changed`           |
| `payload`, `metadata`                         | `jsonb`         |                                                        |
| `status`                                      | `outbox_status` | `PENDING`, `PUBLISHED`, `DEAD`                         |
| `attempts`, `last_error`                      |                 | suivi des tentatives de publication                    |
| `occurred_at`, `available_at`, `published_at` | `timestamptz`   | `available_at` porte le délai avant nouvelle tentative |

Contraintes : `attempts >= 0` ; un événement est `PUBLISHED` si et seulement si
`published_at` est renseignée ; format de `event_type`.
Index : `(aggregate_type, aggregate_id)` et l'index partiel
`outbox_events_pending_idx (available_at, id) WHERE status = 'PENDING'`, qui sert la file du relais.

## Éléments écrits à la main dans les migrations

Prisma ne modélise ni les contraintes `CHECK`, ni les index partiels, ni les déclencheurs.
Ils sont ajoutés à la fin du fichier SQL de la migration et **recensés ici** :

| Objet                                                                                                           | Table                |
| --------------------------------------------------------------------------------------------------------------- | -------------------- |
| `system_settings_key_format_check`, `system_settings_version_check`                                             | `system_settings`    |
| `audit_logs_actor_id_check`, `audit_logs_action_format_check`, `audit_logs_metadata_is_object_check`            | `audit_logs`         |
| fonction `mgx_forbid_mutation()` ; déclencheurs `audit_logs_append_only_row`, `audit_logs_append_only_truncate` | `audit_logs`         |
| retrait des privilèges `UPDATE`, `DELETE`, `TRUNCATE` aux rôles non propriétaires                               | `audit_logs`         |
| `outbox_events_attempts_check`, `outbox_events_published_at_check`, `outbox_events_event_type_format_check`     | `outbox_events`      |
| index partiel `outbox_events_pending_idx`                                                                       | `outbox_events`      |
| retrait de tout privilège aux rôles non propriétaires                                                           | `_prisma_migrations` |

Leur présence et leur effet sont vérifiés par
`apps/api/test/integration/database-constraints.spec.ts`.

## Migrations

```bash
pnpm db:migrate:dev --create-only --name <description>   # génère le SQL sans l'appliquer
# relire le SQL, y ajouter contraintes / déclencheurs, puis :
pnpm db:migrate:dev          # applique en développement
pnpm db:check-drift          # les migrations correspondent-elles au schéma Prisma ?
pnpm db:migrate:deploy       # applique les migrations en attente (CI, staging, production)
```

### Base fantôme

Pour comparer les migrations au schéma, Prisma les rejoue dans une base **distincte et
jetable**, qu'il vide au préalable : la base fantôme (`SHADOW_DATABASE_URL`).

| Commande                 | Base fantôme                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- |
| `pnpm db:check-drift`    | **obligatoire** : sans `SHADOW_DATABASE_URL`, la commande échoue                |
| `pnpm db:migrate:dev`    | utilisée si elle est définie ; sinon Prisma en crée une temporaire (`CREATEDB`) |
| `pnpm db:migrate:deploy` | jamais utilisée                                                                 |

En local, Docker Compose crée cette base au premier démarrage (`<MGX_DB_NAME>_shadow`,
`mgx_shadow` par défaut) : elle appartient au rôle propriétaire et le rôle applicatif ne peut
pas s'y connecter. Elle ne doit **jamais** désigner une base contenant des données — Prisma
refuse d'ailleurs qu'elle soit la base principale. Elle n'existe ni en staging ni en
production, où seule `pnpm db:migrate:deploy` s'exécute.

### Règles

- une migration appliquée n'est **jamais modifiée** : toute correction est une nouvelle migration ;
- aucune modification manuelle d'une base ; `prisma db push` est proscrit ;
- en production, les migrations s'exécutent comme une étape distincte, avec le rôle
  propriétaire, avant le démarrage de la nouvelle version ;
- les changements destructifs suivent le schéma « étendre, migrer, contracter » sur
  plusieurs versions.

## Conservation des données

| Table             | Règle actuelle                                                                     |
| ----------------- | ---------------------------------------------------------------------------------- |
| `audit_logs`      | conservation illimitée ; la durée légale sera fixée avec la conformité (phase 8)   |
| `outbox_events`   | les événements publiés pourront être purgés après un délai — purge non implémentée |
| `system_settings` | historique complet des changements dans `audit_logs`                               |

## Tables à venir

Le modèle cible (utilisateurs, KYC, portefeuilles, grand livre en partie double, échanges,
paiements, blockchain, P2P, séquestre, risque, support…) sera introduit phase par phase,
chaque table arrivant avec le module qui l'utilise, ses contraintes et ses tests.
