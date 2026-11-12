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

Les droits d'administration (`permissions`, `roles`, `role_permissions`, `user_roles`) sont
en **lecture seule** pour le rôle applicatif. Le catalogue ne change que par migration. Une
attribution (`user_roles`) ne change que de deux façons : l'outil d'amorçage en ligne de
commande, exécuté avec le rôle propriétaire ; ou l'**approbation d'une demande de changement
de rôle**, que la base applique elle-même (voir `role_change_requests`). L'API n'écrit donc
jamais directement une attribution : chacune résulte d'une demande approuvée, qui en reste la
trace ineffaçable. La base vérifie la qualité des deux intervenants que l'API lui désigne ;
elle ne peut pas vérifier que ce sont bien eux qui agissent (limite décrite dans l'ADR 0018).

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

## Tables (phase 2 — identité)

### `users` — comptes

| Colonne                      | Type           | Notes                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------ |
| `id`                         | `uuid`         | UUID v7                                                            |
| `account_type`               | `account_type` | `INDIVIDUAL`, `BUSINESS`                                           |
| `status`                     | `user_status`  | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `CLOSED`            |
| `email`, `email_verified_at` |                | adresse normalisée (minuscules), unique : identifiant de connexion |
| `phone`, `phone_verified_at` |                | format E.164 ; unique **une fois vérifié** seulement               |
| `country_code`               | `char(2)`      | pays de résidence déclaré (ISO 3166-1)                             |
| `locale`                     | `varchar(10)`  | langue des messages                                                |
| `terms_accepted_at`          | `timestamptz`  | acceptation des conditions d'utilisation                           |

Contraintes : adresse normalisée et bien formée, téléphone E.164, code pays en majuscules,
**un compte `ACTIVE` a toujours une adresse vérifiée**. Un compte n'est jamais supprimé :
il est clôturé (toutes les clés étrangères vers `users` sont `ON DELETE RESTRICT`). Seule
exception : une **inscription jamais vérifiée** (`PENDING_VERIFICATION`), qui n'est pas encore
un compte, est supprimée après 7 jours avec son secret et ses codes.

### `user_credentials` — secret d'authentification

Table séparée de `users` : aucune lecture d'un compte ne renvoie son secret.
`password_hash` est une empreinte Argon2id au format PHC ; une contrainte refuse toute autre
valeur — un mot de passe en clair ne peut pas y être écrit, même par erreur.

### `permissions`, `roles`, `role_permissions`, `user_roles` — droits du back-office

`permissions` est la copie du catalogue du code (`@mgx/contracts`) ; un test vérifie que les
deux sont identiques, rôle par rôle. `roles` contient les rôles système : `super_admin`
(toutes les permissions) et `support` (`users.read`, `users.suspend`,
`users.revoke_sessions`). `user_roles` attribue un rôle à un compte (`granted_by` : auteur de
la demande approuvée, `NULL` pour l'amorçage). Tables en lecture seule pour le rôle
applicatif (voir « Rôles et privilèges »).

### `role_change_requests` — changements de rôle sous double validation

| Colonne                                      | Notes                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `user_id`, `role_id`, `action`               | compte concerné, rôle, `GRANT` ou `REVOKE`                       |
| `reason`                                     | justification de la demande                                      |
| `status`                                     | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`        |
| `requested_by`, `requested_at`, `expires_at` | auteur, date, échéance (72 heures)                               |
| `decided_by`, `decided_at`, `decision_note`  | auteur et date de la décision ; `decided_by` est `NULL` si échue |

**La règle des quatre yeux est portée par la base**, pas seulement par l'API :

- contraintes : nul ne demande un changement de ses propres rôles ; une approbation ou un
  refus vient d'un compte qui n'est ni l'auteur de la demande ni l'intéressé ; seul l'auteur
  retire sa demande ; une décision est complète (datée, attribuée) ; une seule demande en
  attente par compte et par rôle ;
- déclencheur `role_change_requests_enforce` (fonction `mgx_enforce_role_change()`,
  `SECURITY DEFINER`, chemin de recherche figé) : une demande naît en attente ; ses termes ne
  changent jamais ; une demande décidée ne se redécide pas ; **à l'approbation**, la fonction
  vérifie que la demande n'est pas échue, que son auteur et l'approbateur sont actifs et
  détiennent `roles.manage`, qu'un rôle ne va qu'à un compte actif — puis écrit elle-même
  dans `user_roles`. Elle prend d'abord un verrou consultatif
  (`pg_advisory_xact_lock`, clé `role_change:approval`) : les approbations sont appliquées
  une à une, chacune vérifiée sur un état que la précédente a déjà validé. Toute règle
  enfreinte lève l'erreur `MGX02` ;
- une demande ne s'efface pas (`MGX01`) : elle est la trace de la décision.

### `user_profiles` — profil déclaré

Prénom, nom, postnom (`additional_name`), date de naissance, adresse, fuseau horaire : une
ligne par compte, créée à la première modification. Ces informations sont **déclarées** par
le titulaire ; rien ne les a vérifiées. Contraintes : noms non vides, naissance ≥ 1900 (la
majorité est vérifiée par l'API, qui connaît la date du jour).

### `user_totp_credentials`, `user_recovery_codes` — validation en deux étapes

`user_totp_credentials` : une ligne par compte. `secret_ciphertext` est le secret TOTP
**chiffré** (AES-256-GCM, clé hors base) : version (1 octet) ‖ nonce (12) ‖ secret chiffré
(20) ‖ sceau (16) — une contrainte refuse toute autre forme, donc un secret en clair.
`confirmed_at` est `NULL` tant que l'enrôlement n'est pas confirmé ; `last_used_step` retient
le dernier pas de temps accepté (un code ne sert qu'une fois).
`user_recovery_codes` : une ligne par code de secours, **empreinte HMAC-SHA-256 uniquement**
(contrainte de longueur), `used_at` marque l'usage.

### `verification_challenges` — codes à usage unique

| Colonne                                       | Notes                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `purpose`                                     | `EMAIL_VERIFICATION`, `PASSWORD_RESET`, `PHONE_VERIFICATION`           |
| `target`                                      | adresse à laquelle le code est envoyé — la seule qu'il vérifie         |
| `code_hash`                                   | HMAC-SHA-256 du code, clé hors base ; `NULL` tant qu'il n'est pas émis |
| `attempts`, `max_attempts`                    | essais comptés ; la base refuse tout dépassement                       |
| `expires_at`, `consumed_at`, `invalidated_at` | cycle de vie                                                           |

Le code n'est jamais stocké. Un index unique partiel garantit **un seul code en cours** par
compte et par usage.

### `user_sessions`, `session_tokens` — sessions

`user_sessions` : une ligne par connexion (appareil, adresse IP, agent utilisateur, échéances
d'inactivité et absolue, révocation et son motif). `device_fingerprint` est l'empreinte
SHA-256 de l'identifiant d'appareil (jamais l'identifiant lui-même) : elle sert à reconnaître
un appareil déjà utilisé par le compte. `session_tokens` : une ligne par paire de
jetons émise ; seules les **empreintes SHA-256** des jetons sont stockées (contrainte de
longueur : 32 octets), `consumed_at` marque le renouvellement. Les paires renouvelées depuis
plus de 24 heures sont supprimées au renouvellement suivant.

## Éléments écrits à la main dans les migrations

Prisma ne modélise ni les contraintes `CHECK`, ni les index partiels, ni les déclencheurs.
Ils sont ajoutés à la fin du fichier SQL de la migration et **recensés ici** :

| Objet                                                                                                                                                                             | Table                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `system_settings_key_format_check`, `system_settings_version_check`                                                                                                               | `system_settings`                                        |
| `audit_logs_actor_id_check`, `audit_logs_action_format_check`, `audit_logs_metadata_is_object_check`                                                                              | `audit_logs`                                             |
| fonction `mgx_forbid_mutation()` ; déclencheurs `audit_logs_append_only_row`, `audit_logs_append_only_truncate`                                                                   | `audit_logs`                                             |
| retrait des privilèges `UPDATE`, `DELETE`, `TRUNCATE` aux rôles non propriétaires                                                                                                 | `audit_logs`                                             |
| `outbox_events_attempts_check`, `outbox_events_published_at_check`, `outbox_events_event_type_format_check`                                                                       | `outbox_events`                                          |
| index partiel `outbox_events_pending_idx`                                                                                                                                         | `outbox_events`                                          |
| retrait de tout privilège aux rôles non propriétaires                                                                                                                             | `_prisma_migrations`                                     |
| `users_email_normalized_check`, `users_phone_format_check`, `users_country_code_check`, `users_active_requires_verified_email_check`, `users_phone_verified_requires_phone_check` | `users`                                                  |
| index unique partiel `users_verified_phone_key`                                                                                                                                   | `users`                                                  |
| `user_credentials_password_hash_format_check`                                                                                                                                     | `user_credentials`                                       |
| `permissions_key_format_check`, `roles_key_format_check`                                                                                                                          | `permissions`, `roles`                                   |
| `verification_challenges_attempts_check`, `…_code_hash_length_check`, `…_single_outcome_check`, `…_expiry_check`                                                                  | `verification_challenges`                                |
| index unique partiel `verification_challenges_active_key`                                                                                                                         | `verification_challenges`                                |
| `user_sessions_revocation_check`, `user_sessions_expiry_check`                                                                                                                    | `user_sessions`                                          |
| `session_tokens_hash_length_check`                                                                                                                                                | `session_tokens`                                         |
| données initiales : catalogue des permissions, rôle `super_admin`                                                                                                                 | `permissions`, `roles`, `role_permissions`               |
| retrait des privilèges d'écriture aux rôles non propriétaires                                                                                                                     | `permissions`, `roles`, `role_permissions`, `user_roles` |
| `user_totp_credentials_ciphertext_format_check`, `user_totp_credentials_last_used_step_check`                                                                                     | `user_totp_credentials`                                  |
| `user_recovery_codes_hash_length_check`                                                                                                                                           | `user_recovery_codes`                                    |
| `user_profiles_names_not_blank_check`, `user_profiles_date_of_birth_check`                                                                                                        | `user_profiles`                                          |
| `user_sessions_device_fingerprint_length_check`                                                                                                                                   | `user_sessions`                                          |
| `role_change_requests_reason_not_blank_check`, `…_expiry_check`, `…_not_self_requested_check`, `…_decision_check`, `…_four_eyes_check`, `…_cancelled_by_requester_check`          | `role_change_requests`                                   |
| index unique partiel `role_change_requests_pending_key`                                                                                                                           | `role_change_requests`                                   |
| fonction `mgx_enforce_role_change()` (`SECURITY DEFINER`, `search_path` figé, `EXECUTE` retiré à `PUBLIC`) ; déclencheur `role_change_requests_enforce`                           | `role_change_requests`, `user_roles`                     |
| déclencheurs `role_change_requests_no_delete`, `role_change_requests_no_truncate` ; retrait de `DELETE` et `TRUNCATE` aux rôles non propriétaires                                 | `role_change_requests`                                   |
| index partiel `users_pending_registration_idx` (purge des inscriptions jamais vérifiées)                                                                                          | `users`                                                  |
| données initiales : permissions du back-office, rôle `support`                                                                                                                    | `permissions`, `roles`, `role_permissions`               |

Leur présence et leur effet sont vérifiés par les tests d'intégration
`database-constraints.spec.ts`, `identity-schema.spec.ts`, `account-security-schema.spec.ts`
et `back-office-schema.spec.ts` (dans `apps/api/test/integration/`).

**Erreurs levées par les déclencheurs** — codes SQLSTATE propres à l'application :

| Code    | Signification                                                   |
| ------- | --------------------------------------------------------------- |
| `MGX01` | modification ou suppression interdite d'une table en ajout seul |
| `MGX02` | règle de la double validation d'un changement de rôle enfreinte |

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

| Table                       | Règle actuelle                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `audit_logs`                | conservation illimitée ; la durée légale sera fixée avec la conformité (phase 8)                            |
| `outbox_events`             | les événements publiés pourront être purgés après un délai — purge non implémentée                          |
| `system_settings`           | historique complet des changements dans `audit_logs`                                                        |
| `users`, `user_credentials` | conservés ; un compte clôturé n'est pas supprimé. **Inscription jamais vérifiée : supprimée après 7 jours** |
| `user_sessions`             | supprimées **90 jours** après leur échéance d'inactivité — sauf la plus récente de chaque compte            |
| `session_tokens`            | paires renouvelées supprimées après 24 heures ; les autres avec leur session                                |
| `verification_challenges`   | supprimés **7 jours** après leur expiration                                                                 |
| `user_totp_credentials`     | enrôlement jamais confirmé : supprimé après **24 heures** ; second facteur en place : conservé              |
| `role_change_requests`      | conservées indéfiniment (trace des décisions) ; les demandes échues passent à `EXPIRED`                     |
| `user_profiles`             | conservés avec le compte                                                                                    |

La purge est une tâche planifiée toutes les heures (`AccountMaintenanceService`, file
`account-maintenance`), bornée à 500 lignes par catégorie et par exécution. Chaque
suppression d'inscription est écrite au journal d'audit (`user.registration_purged`). La
dernière session de chaque compte est conservée : elle atteste qu'il s'est déjà connecté, ce
dont dépend l'avertissement de connexion depuis un nouvel appareil. Ces durées sont des
valeurs de départ, à confirmer avec la conformité (phase 8).

## Tables à venir

Le modèle cible (KYC, portefeuilles, grand livre en partie double, échanges,
paiements, blockchain, P2P, séquestre, risque, support…) sera introduit phase par phase,
chaque table arrivant avec le module qui l'utilise, ses contraintes et ses tests.
