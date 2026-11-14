# Base de données

PostgreSQL **18 ou supérieur** (fonction native `uuidv7()`), schéma géré exclusivement par
les migrations Prisma (`apps/api/prisma/`).

## Conventions

| Sujet          | Règle                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Nommage        | tables au pluriel et colonnes en `snake_case` ; modèles Prisma en `PascalCase`      |
| Clés primaires | UUID v7 générés par la base (`uuidv7()`), ordonnés dans le temps                    |
| Horodatages    | `timestamptz(6)`, toujours en UTC                                                   |
| Montants       | `NUMERIC(38,0)` en unités minimales de l'actif — jamais `float`, `real` ni `money`  |
| Énumérations   | types `ENUM` PostgreSQL pour les ensembles fermés et stables                        |
| JSON           | `jsonb`, réservé aux contenus sans schéma relationnel (métadonnées, charges utiles) |
| Intégrité      | portée par la base : `NOT NULL`, `CHECK`, clés étrangères, unicité, déclencheurs    |
| Suppression    | pas de suppression physique des données financières ou d'audit                      |

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
trace ineffaçable. De même, une version des conditions d'utilisation **sans auteur** ne
s'écrit qu'avec le rôle propriétaire (outil `terms:publish`) : l'API, elle, doit désigner un
membre du personnel habilité, que la base vérifie. La base vérifie la qualité des deux intervenants que l'API lui désigne ;
elle ne peut pas vérifier que ce sont bien eux qui agissent (limite décrite dans l'ADR 0018).

Sur le **grand livre**, le rôle applicatif ne peut qu'**ajouter** : il lit le plan de comptes
(`ledger_account_types`) sans pouvoir l'écrire ; il ajoute des actifs, des écritures et des
lignes sans pouvoir les modifier ni les supprimer. Il garde `UPDATE` sur `ledger_accounts`
— c'est ce privilège qui permet de verrouiller un compte (`FOR UPDATE`), et c'est sous son
nom que la base met le solde à jour lorsqu'il passe une ligne —, mais un solde écrit
directement n'est jamais validé (voir « Tables (phase 3 — grand livre) »). Un actif **sans
auteur** ne s'enregistre qu'avec le rôle propriétaire.

Sur les **transferts**, de même : le rôle applicatif **ajoute** des transferts sans pouvoir
les modifier ni les supprimer ; il fixe et remplace des plafonds (`INSERT`, `UPDATE` sur
`transfer_limits`) sans pouvoir en supprimer. Des plafonds **sans auteur** ne se fixent
qu'avec le rôle propriétaire.

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
Index : `(aggregate_type, aggregate_id)`, `(published_at)` — purge des événements publiés — et
l'index partiel `outbox_events_pending_idx (available_at, id) WHERE status = 'PENDING'`, qui
sert la file du relais.

## Tables (phase 2 — identité)

### `users` — comptes

| Colonne                      | Type           | Notes                                                                                                                                                                                                    |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `uuid`         | UUID v7                                                                                                                                                                                                  |
| `account_type`               | `account_type` | `INDIVIDUAL`, `BUSINESS`                                                                                                                                                                                 |
| `status`                     | `user_status`  | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `CLOSED`                                                                                                                                                  |
| `email`, `email_verified_at` |                | adresse normalisée (minuscules), unique : identifiant de connexion                                                                                                                                       |
| `phone`, `phone_verified_at` |                | format E.164 ; unique **une fois vérifié** seulement                                                                                                                                                     |
| `country_code`               | `char(2)`      | pays de résidence déclaré (ISO 3166-1)                                                                                                                                                                   |
| `locale`                     | `varchar(10)`  | langue des messages                                                                                                                                                                                      |
| `registered_at`              | `timestamptz`  | date de la demande d'inscription — c'est elle que lit la purge des inscriptions jamais vérifiées. (Avant la migration `terms_of_use` : `terms_accepted_at` ; les acceptations ont désormais leur table.) |

Contraintes : adresse normalisée et bien formée, téléphone E.164, code pays en majuscules,
**un compte `ACTIVE` a toujours une adresse vérifiée**. Un compte n'est jamais supprimé :
il est clôturé (toutes les clés étrangères vers `users` sont `ON DELETE RESTRICT`). Seule
exception : une **inscription jamais vérifiée** (`PENDING_VERIFICATION`), qui n'est pas encore
un compte, est supprimée après 7 jours avec son secret et ses codes.

**Compte clôturé** (ADR 0023) — la ligne reste, sans identifiant, et ne change plus jamais :

- contraintes : un compte `CLOSED` porte l'adresse factice `closed-<id>@closed.invalid`, non
  vérifiée, et aucun numéro (`users_closed_is_anonymous_check`) ; le domaine `closed.invalid`
  est réservé aux comptes clôturés (`users_reserved_email_domain_check`) — nul ne peut donc
  prendre d'avance l'adresse factice d'un compte ;
- déclencheur `users_enforce_closure` (fonction `mgx_enforce_user_closure()`) : un compte ne
  naît pas clôturé ; seul un compte actif ou suspendu se clôt, et seulement **avec sa trace**
  (`account_closures`), **sans rôle**, et une fois supprimés son secret, son second facteur,
  ses codes, ses sessions et son profil (`MGX04`) ; **clôturé, il ne se modifie plus**
  (`MGX05`) ;
- déclencheur `users_closure_leaves_no_terms_acceptance` (fonction
  `mgx_forbid_closure_with_terms_acceptance()`) : il ne se clôt pas davantage en gardant une
  acceptation des conditions d'utilisation (`MGX04`) ;
- déclencheur `users_closure_leaves_no_funds` (fonction `mgx_forbid_closure_with_funds()`) :
  il ne se clôt pas tant qu'un de ses comptes du grand livre **détient des fonds**, dans
  quelque actif que ce soit (`MGX04`) ;
- déclencheurs `<table>_account_open` (fonction `mgx_forbid_closed_account_rows()`) sur
  `user_credentials`, `user_totp_credentials`, `user_recovery_codes`, `user_sessions`,
  `verification_challenges`, `user_profiles`, `user_roles`, `kyc_cases`,
  `terms_acceptances` et `ledger_accounts` : **rien ne s'ajoute à un compte clôturé** (`MGX05`). La fonction verrouille la ligne du compte en
  `FOR KEY SHARE` ; la clôture la verrouille en `FOR UPDATE`. Les deux s'excluent : une ligne
  est écrite avant la clôture — qui l'efface, ou échoue — ou attend la clôture et est
  refusée. Le verrou est le plus faible qui convienne : il ne gêne aucune autre écriture du
  compte.

### `user_credentials` — secret d'authentification

Table séparée de `users` : aucune lecture d'un compte ne renvoie son secret.
`password_hash` est une empreinte Argon2id au format PHC ; une contrainte refuse toute autre
valeur — un mot de passe en clair ne peut pas y être écrit, même par erreur.

### `permissions`, `roles`, `role_permissions`, `user_roles` — droits du back-office

`permissions` est la copie du catalogue du code (`@mgx/contracts`) ; un test vérifie que les
deux sont identiques, rôle par rôle. `roles` contient les rôles système : `super_admin`
(toutes les permissions), `support` (`users.read`, `users.suspend`,
`users.revoke_sessions`) et `compliance` (`users.read`, `users.close`, `kyc.read`,
`kyc.review`, `kyc.revoke`). `user_roles` attribue un rôle à un compte (`granted_by` : auteur
de la demande approuvée, `NULL` pour l'amorçage). Tables en lecture seule pour le rôle
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

Lorsqu'un dossier de vérification est accepté, ce qu'il établit **prime** sur cette table,
sans y être recopié : l'API lit l'identité et l'adresse vérifiées dans `kyc_cases`. Si la
vérification est retirée, le profil déclaré réapparaît tel qu'il était.

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

### `account_closures` — trace de la clôture d'un compte

Une ligne par compte clôturé, écrite dans la transaction de la clôture.

| Colonne                 | Notes                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `user_id`               | clé primaire : le compte clôturé                                                              |
| `closed_at`             | date de la clôture                                                                            |
| `origin`, `closed_by`   | `HOLDER` (le titulaire, `closed_by = user_id`) ou `STAFF` (un membre du personnel)            |
| `email`, `phone`        | adresse et numéro que portait le compte — **effacés à l'échéance**                            |
| `legal_retention_until` | terme de la conservation imposée par la loi ; `NULL` si rien n'est conservé à ce titre        |
| `erasure_due_at`        | échéance d'effacement : jamais avant le terme légal                                           |
| `erased_at`             | date à laquelle l'adresse, le numéro et les dossiers conservés ont été effacés ; sinon `NULL` |

- contraintes : l'origine s'accorde avec l'auteur (`account_closures_author_check`) ; forme de
  l'adresse et du numéro ; l'échéance suit la clôture et n'est jamais antérieure au terme
  légal (`account_closures_schedule_check`) ; **avant l'effacement, la trace garde
  l'adresse ; après, plus aucun identifiant** (`account_closures_erasure_check`) ;
- index : `(email)`, `(phone)` — recherche d'un compte clôturé par son ancienne adresse —,
  `(erasure_due_at)` — file de l'effacement ;
- déclencheur `account_closures_enforce` (fonction `mgx_enforce_account_closure()`), erreur
  `MGX04` :
  - **à l'écriture** : le compte est actif ou suspendu (sa ligne est verrouillée) ; la trace
    porte exactement son adresse et son numéro ; elle n'est pas déjà effacée ; la clôture
    n'est **pas antidatée** de plus de vingt-quatre heures ; une clôture `STAFF` vient d'un
    compte **actif détenant `users.close`** ; si une décision a été prise sur un dossier de
    vérification du compte, `legal_retention_until` vaut **au moins dix ans** après la
    clôture (dix années civiles, comptées en UTC) ;
  - **ensuite**, la trace ne change qu'une fois, pour constater l'effacement — rien d'autre
    ne se réécrit —, et seulement **une fois le terme légal atteint à l'horloge de la base**
    et les dossiers de vérification du compte effacés ;
  - elle ne se supprime pas ; la table ne se vide pas (`account_closures_no_truncate`) ; le
    rôle applicatif n'a ni `DELETE` ni `TRUNCATE` ;
- déclencheur `account_closures_ledger_retention` (fonction
  `mgx_enforce_closure_ledger_retention()`), erreur `MGX04` : dès lors qu'**une écriture a
  été passée** sur un compte du grand livre du titulaire, `legal_retention_until` vaut **au
  moins dix ans** après la clôture, comptés de la même façon ; il s'exécute après
  `account_closures_enforce` (ordre alphabétique des noms), qui a verrouillé le compte ;
- déclencheur de contrainte **différé** `account_closures_applied` (fonction
  `mgx_check_closure_applied()`), vérifié à la validation de la transaction : **une clôture est
  entière ou n'est pas** — une trace n'existe que pour un compte clôturé, et un compte
  clôturé n'a plus de dossier de vérification en préparation, en attente ou en vigueur.

### `terms_versions`, `terms_acceptances` — conditions d'utilisation

Les versions publiées des conditions d'utilisation, et qui a accepté laquelle (ADR 0024).

| `terms_versions`                          | Notes                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `number`                                  | clé primaire : 1, 2, 3…, **sans trou** ; la version en vigueur est la plus grande                |
| `requires_acceptance`                     | la règle de la version : `true`, chaque compte doit l'accepter ; `false`, elle est signalée      |
| `summary_fr`, `body_fr`, `body_fr_sha256` | résumé, texte et empreinte SHA-256 (hexadécimal) du texte encodé en UTF-8 — le français fait foi |
| `summary_en`, `body_en`, `body_en_sha256` | traduction anglaise : entière, ou absente (`NULL`)                                               |
| `published_by`                            | le membre du personnel qui a publié ; `NULL` : publiée par l'outil d'exploitation                |
| `published_at`                            | **heure de la base**, lue après le verrou de publication : elle croît avec le numéro             |

| `terms_acceptances`         | Notes                                                    |
| --------------------------- | -------------------------------------------------------- |
| `user_id`, `version_number` | clé primaire : une acceptation par compte et par version |
| `accepted_at`               | **heure de la base** au moment de l'écriture             |

- contraintes de `terms_versions` : `number >= 1` ; **la version 1 exige d'être acceptée**
  (`terms_versions_first_requires_acceptance_check` — nul n'a pu accepter un texte qui
  n'existait pas) ; textes bornés (résumé 1 000 caractères, texte 200 000), non blancs, sans
  caractère de contrôle autre que saut de ligne, retour chariot et tabulation, sans marque
  d'ordre des octets en tête (`terms_versions_fr_text_check`, `…_en_text_check`, fonction
  `mgx_is_terms_text()`) ; **l'empreinte conservée est celle du texte conservé**
  (`…_fr_digest_check`, `…_en_digest_check`) : un texte altéré entre l'API et la base ne se
  publie pas ;
- déclencheur `terms_versions_enforce` (fonction `mgx_enforce_terms_version()`) :
  - une publication à la fois (verrou consultatif de transaction) ; **seul le numéro suivant
    se publie** — ni doublon, ni trou, ni retour en arrière (`MGX07`) ;
  - **qui publie** : un compte **actif détenant `terms.publish`**, relu au moment de publier
    (`MGX06`) ; sans auteur (`published_by` `NULL`), seulement le **rôle propriétaire** de la
    table — celui de l'outil `terms:publish`, jamais celui de l'API (`MGX06`) ;
  - l'heure de publication est celle de la base, quelle que soit celle qu'on lui donne ;
- **une version publiée ne change plus** : ni `UPDATE`, ni `DELETE`, ni `TRUNCATE`
  (déclencheurs `terms_versions_immutable_row`, `…_immutable_truncate`, erreur `MGX01`) — même
  pour le propriétaire du schéma ; le rôle applicatif n'en a d'ailleurs pas le privilège ;
- déclencheur `terms_acceptances_enforce` (fonction `mgx_enforce_terms_acceptance()`) :
  - **on n'accepte que la version en vigueur** (`MGX07`) ; n'accepte qu'un compte en cours
    d'inscription ou actif (`MGX06`) ; l'heure est celle de la base ;
  - **une acceptation est une preuve** : elle ne s'efface qu'avec le compte — inscription
    jamais vérifiée (purgée, ou remplacée par une nouvelle inscription), ou clôture **dont la
    trace est déjà écrite** (`account_closures`) ; dans tout autre cas : `MGX06` ;
- elle ne se modifie pas et la table ne se vide pas (`terms_acceptances_no_update`,
  `…_no_truncate`, `MGX01`) ; le rôle applicatif n'a ni `UPDATE` ni `TRUNCATE` ;
- `terms_acceptances_account_open` : rien ne s'ajoute à un compte clôturé (`MGX05`), comme
  pour ses autres lignes ; ce déclencheur s'exécute avant `terms_acceptances_enforce` (ordre
  alphabétique des noms) ;
- les quatre fonctions ont un **chemin de recherche figé** sur le schéma de l'application,
  `pg_temp` en dernier : une table temporaire homonyme (`users`, `terms_versions`…) placée par
  une session ne peut pas répondre à la place des vraies ;
- index : `terms_acceptances (version_number)` — décompte des acceptations d'une version ;
- clés étrangères `ON DELETE RESTRICT` : supprimer une inscription jamais vérifiée exige
  d'effacer d'abord son acceptation.

La règle « ce compte doit-il accepter ? » n'est pas stockée : elle se calcule à chaque requête
(une lecture, `PrismaTermsRepository.standingOf`) — le compte est ouvert, une version exigeant
l'acceptation existe, et la dernière version qu'il a acceptée lui est antérieure.

## Tables (phase 2 — vérification d'identité)

### `kyc_cases` — dossiers de vérification

Un dossier par compte, par niveau et par tentative. Le **niveau vérifié d'un compte n'est
stocké nulle part** : il se lit sur ses dossiers acceptés (`status = 'APPROVED'`).

| Colonne                                                                                                        | Notes                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `user_id`, `level`                                                                                             | titulaire ; niveau `1` identité, `2` adresse, `3` origine des fonds                     |
| `status`                                                                                                       | `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `SUPERSEDED`, `REVOKED`, `ACCOUNT_CLOSED` |
| `submitted_at`                                                                                                 | date du dépôt — ordre de la file d'examen                                               |
| `decided_by`, `decided_at`, `rejection_reasons`, `decision_note`                                               | décision ; motifs communiqués au titulaire, note interne                                |
| `ended_at`, `revoked_by`, `revocation_reason`                                                                  | fin de validité d'un dossier accepté : remplacement ou retrait                          |
| `given_name` … `nationality`                                                                                   | niveau 1 : identité déclarée                                                            |
| `document_type`, `document_issuing_country`, `document_issued_on`, `document_issued_at`, `document_expires_on` | niveau 1 : pièce présentée                                                              |
| `document_number_encrypted`                                                                                    | numéro de la pièce, **chiffré** (AES-256-GCM, lié au compte)                            |
| `document_number_digest`                                                                                       | empreinte à clé (HMAC-SHA-256) de nature + pays + numéro : doublons                     |
| `address_line1` … `address_country`, `address_proof_type`, `address_proof_issued_on`                           | niveau 2 : adresse et justificatif                                                      |
| `funds_sources`, `occupation`, `employer_name`, `funds_explanation`                                            | niveau 3 : origine des fonds                                                            |

**Le parcours est porté par la base**, quel que soit le code qui écrit :

- contraintes : à chaque statut ses dates et ses acteurs ; un refus porte un à cinq motifs et
  une note, aucun autre statut n'en porte ; un retrait est motivé ; **nul ne décide de son
  propre dossier ni ne retire sa propre vérification** ; un dossier porte la déclaration de
  son niveau, complète, et **elle seule** ;
- index uniques partiels : un seul dossier ouvert (`kyc_cases_open_key`) et un seul dossier
  accepté (`kyc_cases_approved_key`) par compte et par niveau ; **une même pièce d'identité
  ne vérifie qu'un seul compte** (`kyc_cases_verified_document_key`) ;
- déclencheur `kyc_cases_enforce` (fonction `mgx_enforce_kyc_case()`, chemin de recherche
  figé) : un dossier naît en préparation ; son titulaire et son niveau ne changent jamais ;
  il n'est **déposé** qu'avec ses pièces obligatoires et, au-delà du niveau 1, si le niveau
  précédent est vérifié ; déposé, **rien de ce qui a été déclaré ne change plus** ; la
  **décision** vient d'un compte actif détenant `kyc.review` ; un niveau ne s'accepte pas si
  le précédent n'est plus vérifié ; l'acceptation fait passer à `SUPERSEDED` le dossier
  accepté précédent du même niveau — transition que rien d'autre ne peut écrire ; un
  **retrait** vient d'un compte actif détenant `kyc.revoke` ; un dossier accepté **prend fin
  avec son compte** (`ACCOUNT_CLOSED`), et seulement si le compte est clôturé ; un dossier
  refusé, remplacé, retiré ou clos avec son compte ne change plus. Toute règle enfreinte lève
  l'erreur `MGX03`.
- **effacement** (fonction `mgx_kyc_case_erasable()`) : un dossier en préparation s'efface
  toujours ; un dossier déposé mais jamais examiné, seulement si le compte est clôturé ; un
  dossier sur lequel une décision a été prise, seulement si le compte est clôturé **et** que
  la conservation légale inscrite à sa clôture est écoulée — **à l'horloge de la base**.
  Tant que le compte est ouvert, un dossier déposé ne s'efface pas.

À la différence des rôles (ADR 0018), ces fonctions ne sont pas `SECURITY DEFINER` : elles
n'écrivent dans aucune table interdite au rôle applicatif.

### `kyc_documents` — pièces d'un dossier

| Colonne                     | Notes                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                        | attribué par l'API avant le chiffrement : il est lié au contenu chiffré                        |
| `case_id`, `kind`           | dossier ; `IDENTITY_FRONT`, `IDENTITY_BACK`, `SELFIE`, `PROOF_OF_ADDRESS`, `SOURCE_OF_FUNDS`   |
| `content_type`, `byte_size` | type constaté sur le contenu (JPEG, PNG, PDF) ; taille du fichier reçu                         |
| `sha256`                    | empreinte du fichier **reçu** : intégrité à la relecture, mêmes fichiers sur plusieurs comptes |
| `storage_key`               | emplacement du fichier chiffré dans le stockage des pièces                                     |
| `wrapped_key`               | clé du fichier, chiffrée par la clé maîtresse                                                  |

**Le fichier n'est pas en base** : seul ce qui le décrit et la clé (chiffrée) qui l'ouvre.
Supprimer la ligne rend le fichier définitivement illisible.

- contraintes : types de contenu acceptés ; un autoportrait n'est pas un PDF ; taille bornée ;
  longueurs de l'empreinte et de la clé ; forme de l'emplacement ;
- index unique partiel `kyc_documents_single_kind_key` : un recto, un verso et un autoportrait
  au plus par dossier ;
- déclencheur `kyc_documents_enforce` (fonction `mgx_enforce_kyc_document()`) : une pièce ne
  s'ajoute qu'à un dossier **en préparation**, de son niveau, **ne se modifie jamais**, et ne
  se retire que d'un dossier qui peut lui-même être effacé (voir `mgx_kyc_case_erasable()`
  ci-dessus). La fonction verrouille la ligne du dossier (`FOR SHARE`) : un dépôt
  simultané attend, de sorte qu'une pièce n'entre jamais dans un dossier déjà déposé, et
  qu'un dossier n'est jamais déposé sans une pièce en cours de retrait ;
- le rôle applicatif n'a pas le privilège `UPDATE` sur cette table.

## Tables (phase 3 — grand livre)

Grand livre **en partie double** (ADR 0025). Toute variation d'un solde est une **écriture** :
un en-tête (`ledger_entries`) et au moins deux **lignes** (`ledger_postings`), dont les débits
égalent les crédits, actif par actif. Une écriture ne se modifie ni ne s'efface : une erreur
se corrige par une écriture inverse. Le solde d'un compte (`ledger_accounts.balance`) n'est
que le reflet de sa dernière ligne.

**Une seule opération passe des écritures à ce jour** : le transfert entre titulaires (voir
« Tables (phase 3 — transferts) »). Aucune ne dépose ni ne retire de fonds.

### `assets` — actifs tenus par la plateforme

| Colonne         | Type          | Notes                                                                               |
| --------------- | ------------- | ----------------------------------------------------------------------------------- |
| `code`          | `varchar(12)` | clé primaire : `USD`, `CDF`, `BTC`… — une majuscule, puis majuscules ou chiffres    |
| `name`          | `varchar(64)` | libellé, sur une ligne                                                              |
| `kind`          | `asset_kind`  | `FIAT`, `CRYPTO`                                                                    |
| `scale`         | `smallint`    | nombre de décimales de l'unité minimale : 0 à 18                                    |
| `registered_by` | `uuid`        | le membre du personnel qui a enregistré l'actif ; `NULL` : enregistré hors de l'API |
| `registered_at` | `timestamptz` | **heure de la base**, quelle que soit celle qu'on lui fournit                       |

- Le catalogue est **une donnée, pas du code** : aucun actif n'est créé par migration. Il
  s'enregistre par le back-office (`POST /admin/ledger/assets`).
- contraintes : `assets_code_format_check` (`^[A-Z][A-Z0-9]{1,11}$`), `assets_scale_check`
  (0 à 18 : un montant est un entier d'au plus 38 chiffres ; au-delà de 18 décimales il ne
  resterait plus de place pour sa partie entière), `assets_name_check` (non vide, sans espace
  en tête ni en fin, sans caractère de contrôle) ;
- déclencheur `assets_enforce` (fonction `mgx_enforce_asset()`), erreur `MGX08` : **seul
  l'enregistre un compte actif détenant `ledger.manage_assets`**, relu au moment d'écrire ;
  sans auteur, seulement le **rôle propriétaire** de la table — jamais celui de l'API ;
- **un actif enregistré ne change plus** : ni `UPDATE`, ni `DELETE`, ni `TRUNCATE`
  (déclencheurs `assets_immutable_row`, `assets_immutable_truncate`, erreur `MGX01`), même
  pour le propriétaire du schéma — tous les montants s'expriment dans son unité minimale, et
  changer son nombre de décimales changerait leur valeur. Le rôle applicatif n'a que
  `SELECT` et `INSERT`.

### `ledger_account_types` — plan de comptes

| `key`              | `owner`    | `normal_side` | Rôle                                                                                                                     |
| ------------------ | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `user_available`   | `USER`     | `CREDIT`      | fonds dont un titulaire dispose                                                                                          |
| `platform_custody` | `PLATFORM` | `DEBIT`       | fonds conservés hors du grand livre pour le compte des titulaires (banque, monnaie mobile, conservation de cryptoactifs) |
| `platform_fees`    | `PLATFORM` | `CREDIT`      | frais gagnés par la plateforme                                                                                           |

- `normal_side` est le sens qui **augmente** le solde. Les avoirs des titulaires sont une
  dette de la plateforme envers eux : un crédit les augmente. Ce qu'elle conserve pour eux
  est un actif : un débit l'augmente.
- Le plan **ne change que par migration**, et s'étendra avec les opérations ; il est recopié
  de `@mgx/contracts` (`LEDGER_ACCOUNT_TYPES`), et un test vérifie que les deux sont
  identiques. Le rôle applicatif n'a que `SELECT`.
- contrainte `ledger_account_types_key_format_check` ; un type **ne se modifie ni ne se
  retire** (déclencheurs `ledger_account_types_immutable_row`, `…_immutable_truncate`,
  `MGX01`) : son sens est recopié sur chaque compte à son ouverture.

### `ledger_accounts` — comptes

| Colonne         | Type            | Notes                                                                                 |
| --------------- | --------------- | ------------------------------------------------------------------------------------- |
| `id`            | `uuid`          | UUID v7 : croît avec l'heure d'ouverture                                              |
| `type_key`      | `varchar(64)`   | type du plan de comptes                                                               |
| `asset_code`    | `varchar(12)`   | actif dans lequel le compte est tenu                                                  |
| `user_id`       | `uuid`          | titulaire ; `NULL` pour un compte de la plateforme                                    |
| `normal_side`   | `ledger_side`   | recopié du type par la base                                                           |
| `balance`       | `numeric(38,0)` | solde en unités minimales, exprimé dans le sens normal du compte : **jamais négatif** |
| `posting_count` | `bigint`        | nombre de lignes passées sur le compte                                                |
| `created_at`    | `timestamptz`   | **heure de la base**                                                                  |

- Un compte est ouvert par la première écriture qui le touche : un titulaire sans compte
  dans un actif n'y détient rien.
- index uniques partiels : `ledger_accounts_user_key` — `(user_id, asset_code, type_key)`
  pour les comptes de titulaires — et `ledger_accounts_platform_key` —
  `(asset_code, type_key)` pour ceux de la plateforme : **un seul compte par type et par
  actif**, pour chaque titulaire comme pour la plateforme ;
- contraintes : `ledger_accounts_balance_check` (`balance >= 0` : **aucun compte ne devient
  négatif**, celui d'un titulaire comme celui de la plateforme),
  `ledger_accounts_posting_count_check`, `ledger_accounts_empty_check` (sans ligne, pas de
  solde) ;
- déclencheur `ledger_accounts_enforce` (fonction `mgx_enforce_ledger_account()`), erreur
  `MGX08` :
  - **à l'ouverture** : un compte de titulaire appartient à un titulaire, un compte de la
    plateforme à personne ; le titulaire est **actif ou suspendu** — une inscription jamais
    vérifiée peut être purgée, elle ne détient donc pas de fonds ; le compte **s'ouvre vide** ;
    son sens et sa date sont fixés par la base ;
  - **ensuite** : il ne change ni de type, ni d'actif, ni de titulaire, ni de sens ;
- déclencheur `ledger_accounts_account_open` : aucun compte ne s'ouvre pour un titulaire
  clôturé (`MGX05`) ; il retient le titulaire (`FOR KEY SHARE`) jusqu'à la fin de la
  transaction, et s'exécute avant `ledger_accounts_enforce` ;
- un compte **ne se supprime pas** et la table ne se vide pas (`ledger_accounts_no_delete`,
  `ledger_accounts_no_truncate`, `MGX01`) ; le rôle applicatif n'a ni `DELETE` ni `TRUNCATE` ;
- déclencheur de contrainte **différé** `ledger_accounts_balance_proven` (fonction
  `mgx_check_ledger_account_balance()`), vérifié à la validation de toute transaction qui a
  modifié un compte : **son solde et son nombre de lignes sont ceux de sa dernière ligne**,
  et aucune ligne ne porte un rang plus élevé. Un solde écrit directement, sans la ligne qui
  le justifie, n'est donc jamais validé — quel que soit le rôle (`MGX08`).

### `ledger_entries` — écritures (en-tête)

| Colonne                  | Type               | Notes                                                                    |
| ------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `id`                     | `uuid`             | UUID v7                                                                  |
| `idempotency_key`        | `varchar(160)`     | **unique** : la même opération ne s'écrit qu'une fois                    |
| `kind`                   | `varchar(64)`      | type de l'écriture — l'opération qui l'a produite (`transfer.internal`…) |
| `posting_count`          | `smallint`         | nombre de lignes que l'écriture **déclare** : 2 à 100                    |
| `actor_type`, `actor_id` | `audit_actor_type` | qui l'a passée : `USER`, `SERVICE` (avec identifiant) ou `SYSTEM` (sans) |
| `request_id`             | `varchar(128)`     | requête à l'origine de l'écriture, si elle en a une                      |
| `metadata`               | `jsonb`            | références de l'opération : un objet, 4 096 octets au plus               |
| `posted_at`              | `timestamptz`      | **heure de la base** (déclencheur `ledger_entries_stamp`)                |

- contraintes : `ledger_entries_idempotency_key_format_check` (8 à 160 caractères : lettres,
  chiffres, `.`, `_`, `:`, `-`, le premier étant une lettre ou un chiffre),
  `ledger_entries_kind_format_check` (minuscules, segments séparés par des points),
  `ledger_entries_posting_count_check`, `ledger_entries_actor_id_check`,
  `ledger_entries_metadata_check` ;
- **une écriture ne se modifie ni ne s'efface** (déclencheurs `ledger_entries_immutable_row`,
  `ledger_entries_immutable_truncate`, `MGX01`), même pour le propriétaire du schéma ; le
  rôle applicatif n'a que `SELECT` et `INSERT`.

### `ledger_postings` — lignes d'écriture

| Colonne            | Type            | Notes                                                                          |
| ------------------ | --------------- | ------------------------------------------------------------------------------ |
| `id`               | `uuid`          | UUID v7                                                                        |
| `entry_id`         | `uuid`          | l'écriture                                                                     |
| `line_number`      | `smallint`      | rang dans l'écriture : 1, 2, 3… — unique par écriture                          |
| `account_id`       | `uuid`          | le compte                                                                      |
| `asset_code`       | `varchar(12)`   | l'actif — **celui du compte**                                                  |
| `side`             | `ledger_side`   | `DEBIT`, `CREDIT`                                                              |
| `amount`           | `numeric(38,0)` | unités minimales, **strictement positif**                                      |
| `account_sequence` | `bigint`        | rang de la ligne sur son compte : 1, 2, 3… sans trou — **calculé par la base** |
| `balance_after`    | `numeric(38,0)` | solde du compte juste après la ligne — **calculé par la base**                 |

- index uniques : `(entry_id, line_number)`, `(account_id, account_sequence)` — ce dernier
  sert aussi les relevés d'un compte, du plus récent au plus ancien ;
- contraintes : `ledger_postings_amount_check`, `ledger_postings_line_number_check`,
  `ledger_postings_account_sequence_check`, `ledger_postings_balance_after_check` ;
- déclencheur `ledger_postings_apply` (fonction `mgx_apply_ledger_posting()`) — **c'est lui
  qui passe la ligne sur son compte** :
  - il **verrouille le compte** (`FOR UPDATE`) jusqu'à la fin de la transaction : une ligne à
    la fois par compte, la suivante part du solde que celle-ci a laissé ;
  - la ligne est dans l'actif de son compte (`MGX08`) ;
  - le titulaire du compte n'est pas clôturé (`MGX05`) — il est retenu (`FOR KEY SHARE`)
    jusqu'à la fin de la transaction : une clôture attend la ligne, ou la ligne attend la
    clôture et est refusée ;
  - le solde du compte est bien celui de sa dernière ligne ; sinon le compte a été altéré,
    et **plus rien ne s'y écrit** tant qu'il n'a pas été examiné (`MGX08`) ;
  - le solde qui résulte de la ligne **n'est pas négatif** (`MGX09`, « fonds
    insuffisants ») — contrôle fait ligne après ligne : un découvert, même passager au sein
    d'une écriture, est refusé ;
  - il calcule `account_sequence` et `balance_after` — ce que l'appelant fournit est
    ignoré — et met à jour le compte ;
- **une ligne ne se modifie ni ne s'efface** (déclencheurs `ledger_postings_immutable_row`,
  `ledger_postings_immutable_truncate`, `MGX01`) ; le rôle applicatif n'a que `SELECT` et
  `INSERT` ;
- déclencheurs de contrainte **différés** `ledger_entries_sound` et
  `ledger_postings_entry_sound` (fonction `mgx_check_ledger_entry()`), vérifiés à la
  validation de la transaction, pour l'en-tête comme pour chaque ligne — **une écriture est
  entière et équilibrée, ou n'est pas** (`MGX08`) :
  - elle a exactement le nombre de lignes qu'elle déclare, numérotées 1, 2, 3… ;
  - ses lignes portent sur **deux comptes au moins** ;
  - **pour chaque actif, le total de ses débits égale celui de ses crédits** ;
  - plus rien ne s'y ajoute ensuite : une ligne ajoutée à une écriture déjà validée la
    rendrait incomplète, et est donc refusée.

**Chemin de recherche figé.** Les huit fonctions de la migration `ledger` ne résolvent les
noms que dans le schéma de l'application (`search_path = <schéma>, pg_temp`) : une table
temporaire homonyme placée par une session ne peut ni habiliter un intrus, ni créer de fonds.

**Écritures simultanées.** Deux écritures qui touchent un même compte passent l'une après
l'autre, la seconde à partir du solde laissé par la première. L'application verrouille
d'abord les titulaires, puis les comptes, toujours dans le même ordre (voir
`ARCHITECTURE.md`) ; la base, elle, garantit le résultat quel que soit l'ordre choisi par le
code qui écrit — au pire, PostgreSQL annule l'une de deux transactions qui s'interbloquent.

**Vérification périodique.** L'étape `verify-ledger` de la tâche horaire relit tout le grand
livre et recalcule ce que ces règles garantissent : solde de chaque compte, enchaînement des
lignes, actif des lignes, écritures entières et équilibrées, équilibre de chaque actif. Une
anomalie ne peut venir que d'une altération faite hors de ces règles (déclencheurs
désactivés par le propriétaire du schéma, restauration partielle) : elle est journalisée,
inscrite au journal d'audit (`ledger.verification_failed`), et **rien n'est corrigé
automatiquement**.

## Tables (phase 3 — transferts)

Transferts de fonds entre deux titulaires (ADR 0026). Un transfert est **une ligne et une
écriture** : la ligne (`transfers`) dit qui a envoyé quoi à qui, sous quelle clé et à quel
niveau de vérification ; l'écriture du grand livre déplace les fonds. L'une ne va pas sans
l'autre, et la base le vérifie. Les plafonds (`transfer_limits`) sont **des données** : aucun
n'est créé par migration.

### `transfer_limits` — plafonds par actif et par niveau de vérification

| Colonne            | Type            | Notes                                                                 |
| ------------------ | --------------- | --------------------------------------------------------------------- |
| `asset_code`       | `varchar(12)`   | l'actif — clé primaire avec `kyc_level`                               |
| `kyc_level`        | `smallint`      | niveau de vérification : 0 (aucun dossier accepté) à 3                |
| `per_transfer_max` | `numeric(38,0)` | plafond d'un transfert, en unités minimales ; **zéro : niveau fermé** |
| `daily_max`        | `numeric(38,0)` | plafond des envois sur 24 heures glissantes                           |
| `monthly_max`      | `numeric(38,0)` | plafond des envois sur 31 jours glissants                             |
| `set_by`           | `uuid`          | le membre du personnel qui les a fixés ; `NULL` : fixés hors de l'API |
| `set_at`           | `timestamptz`   | **heure de la base**, à chaque modification                           |

- **Pas de ligne, pas de transfert** : un niveau sans plafonds dans un actif n'y envoie ni
  n'y reçoit rien. Un niveau est **ouvert** si sa ligne existe et que `per_transfer_max > 0`.
- contraintes : `transfer_limits_kyc_level_check` (0 à 3), `transfer_limits_amounts_check`
  (`0 ≤ per_transfer_max ≤ daily_max ≤ monthly_max`) ;
- déclencheur `transfer_limits_enforce` (fonction `mgx_enforce_transfer_limit()`), erreur
  `MGX10` : **seul les fixe un compte actif détenant `transfer_limits.write`**, relu au
  moment d'écrire ; sans auteur, seulement le **rôle propriétaire** de la table — jamais
  celui de l'API. Une ligne ne change ni d'actif, ni de niveau ;
- **des plafonds ne se suppriment pas** (déclencheurs `transfer_limits_no_delete`,
  `transfer_limits_no_truncate`, erreur `MGX01`) : refermer un niveau, c'est ramener ses trois
  montants à zéro — la ligne reste, et dit qui l'a décidé. Le rôle applicatif n'a que
  `SELECT`, `INSERT` et `UPDATE` ;
- la ligne ne garde que les plafonds **en vigueur** : leur historique — valeurs remplacées,
  auteur, justification — est dans `audit_logs` (`transfer_limit.set`).

### `transfers` — transferts entre titulaires

| Colonne           | Type            | Notes                                                                       |
| ----------------- | --------------- | --------------------------------------------------------------------------- |
| `id`              | `uuid`          | UUID v7                                                                     |
| `sender_id`       | `uuid`          | le compte qui envoie                                                        |
| `recipient_id`    | `uuid`          | le compte qui reçoit — **un autre**                                         |
| `asset_code`      | `varchar(12)`   | l'actif                                                                     |
| `amount`          | `numeric(38,0)` | unités minimales, **strictement positif**                                   |
| `entry_id`        | `uuid`          | l'écriture du grand livre qui le réalise — **unique**                       |
| `idempotency_key` | `varchar(128)`  | la clé fournie par le client — **unique par émetteur**                      |
| `request_digest`  | `bytea`         | empreinte SHA-256 de la requête (destinataire, actif, montant)              |
| `sender_level`    | `smallint`      | niveau de vérification de l'émetteur **à cet instant** : celui des plafonds |
| `created_at`      | `timestamptz`   | **heure de la base** — c'est elle que comptent les fenêtres de 24 h et 31 j |

- index : `(sender_id, idempotency_key)` unique — **la même requête ne s'exécute qu'une
  fois** ; `entry_id` unique ; `(sender_id, asset_code, created_at)` pour les cumuls ;
  `(sender_id, id)` et `(recipient_id, id)` pour les listes ;
- contraintes : `transfers_amount_check`, `transfers_parties_check` (émetteur ≠ destinataire),
  `transfers_sender_level_check` (0 à 3), `transfers_idempotency_key_format_check` (16 à 128
  caractères : lettres, chiffres, `.`, `_`, `:`, `-`, le premier étant une lettre ou un
  chiffre — le format du contrat), `transfers_request_digest_check` (32 octets) ;
- déclencheur `transfers_enforce` (fonction `mgx_enforce_transfer()`), erreur `MGX10` —
  **les plafonds sont imposés ici, quel que soit le code qui écrit** :
  - il **verrouille l'émetteur** (`FOR NO KEY UPDATE`) jusqu'à la fin de la transaction : un
    transfert à la fois par émetteur, le suivant compte celui-ci dans ses cumuls. Ce verrou
    exclut aussi la suspension et la clôture du compte, mais pas celui qu'une écriture prend
    sur ses titulaires (`FOR KEY SHARE`) : deux transferts croisés ne s'interbloquent pas ;
  - l'émetteur et le destinataire sont **actifs** — le destinataire est retenu
    (`FOR KEY SHARE`) jusqu'à la fin de la transaction ;
  - `sender_level` est bien le niveau de vérification de l'émetteur, **recalculé par la
    base** ;
  - ce niveau est **ouvert** dans l'actif ;
  - le montant ne dépasse pas le plafond par transfert ; ajouté aux envois des 24 dernières
    heures, il ne dépasse pas `daily_max` ; ajouté à ceux des 744 dernières heures (31
    jours), il ne dépasse pas `monthly_max` — bornes incluses ;
  - le niveau de vérification du **destinataire** est ouvert dans l'actif, lui aussi ;
  - il fixe `created_at` — ce que l'appelant fournit est ignoré ;
- **un transfert ne se modifie ni ne s'efface** (déclencheurs `transfers_immutable_row`,
  `transfers_immutable_truncate`, `MGX01`), même pour le propriétaire du schéma : c'est sur
  lui que se comptent les plafonds. Le rôle applicatif n'a que `SELECT` et `INSERT` ;
- déclencheur de contrainte **différé** `transfers_entry_matches` (fonction
  `mgx_check_transfer_entry()`), vérifié à la validation de la transaction — **l'écriture
  désignée est bien celle du transfert** (`MGX10`) : de type `transfer.internal`, **deux
  lignes exactement**, l'une au débit du compte `user_available` de l'émetteur, l'autre au
  crédit de celui du destinataire, chacune du montant du transfert, dans son actif. Chaque
  ligne est vérifiée pour elle-même ; leur ordre est indifférent ;
- déclencheur de contrainte **différé** `ledger_entries_transfer_recorded` (fonction
  `mgx_check_transfer_recorded()`), posé sur `ledger_entries` — réciproquement, **une
  écriture de type `transfer.internal` n'existe pas sans son transfert** (`MGX10`) : aucun
  mouvement de ce type n'échappe aux plafonds.

**Niveau de vérification.** `mgx_verified_level(uuid)` rend le plus haut niveau dont tous les
précédents sont acceptés : un niveau 2 accepté ne compte pas tant que le niveau 1 ne l'est
pas — ou ne l'est plus. C'est la règle de l'application (`verifiedLevelOf`) ; un test vérifie
que les deux s'accordent sur toutes les combinaisons.

**Cumuls.** `mgx_transfer_usage(uuid, varchar)` rend, pour un émetteur et un actif, la somme
de ses envois des 24 dernières heures et des 744 dernières heures, **à l'horloge de la
base**. Les durées sont comptées en heures : elles ne dépendent d'aucun fuseau horaire, ni
de la longueur des mois. L'application lit ses cumuls par la même fonction : ce qu'elle
annonce au titulaire est ce que la base comptera.

**Ce que la base ne vérifie pas** : le solde — c'est l'affaire du grand livre, qui refuse
tout découvert (`MGX09`) ; et l'idempotence au-delà de l'unicité de la clé — comparer
l'empreinte d'une requête renvoyée à celle d'origine est fait par l'application.

**Chemin de recherche figé.** Les six fonctions de la migration `internal_transfers` ne
résolvent les noms que dans le schéma de l'application (`search_path = <schéma>, pg_temp`).

## Éléments écrits à la main dans les migrations

Prisma ne modélise ni les contraintes `CHECK`, ni les index partiels, ni les déclencheurs.
Ils sont ajoutés à la fin du fichier SQL de la migration et **recensés ici** :

| Objet                                                                                                                                                                                                                                                                                                                                                   | Table                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `system_settings_key_format_check`, `system_settings_version_check`                                                                                                                                                                                                                                                                                     | `system_settings`                                        |
| `audit_logs_actor_id_check`, `audit_logs_action_format_check`, `audit_logs_metadata_is_object_check`                                                                                                                                                                                                                                                    | `audit_logs`                                             |
| fonction `mgx_forbid_mutation()` ; déclencheurs `audit_logs_append_only_row`, `audit_logs_append_only_truncate`                                                                                                                                                                                                                                         | `audit_logs`                                             |
| retrait des privilèges `UPDATE`, `DELETE`, `TRUNCATE` aux rôles non propriétaires                                                                                                                                                                                                                                                                       | `audit_logs`                                             |
| `outbox_events_attempts_check`, `outbox_events_published_at_check`, `outbox_events_event_type_format_check`                                                                                                                                                                                                                                             | `outbox_events`                                          |
| index partiel `outbox_events_pending_idx`                                                                                                                                                                                                                                                                                                               | `outbox_events`                                          |
| retrait de tout privilège aux rôles non propriétaires                                                                                                                                                                                                                                                                                                   | `_prisma_migrations`                                     |
| `users_email_normalized_check`, `users_phone_format_check`, `users_country_code_check`, `users_active_requires_verified_email_check`, `users_phone_verified_requires_phone_check`                                                                                                                                                                       | `users`                                                  |
| index unique partiel `users_verified_phone_key`                                                                                                                                                                                                                                                                                                         | `users`                                                  |
| `user_credentials_password_hash_format_check`                                                                                                                                                                                                                                                                                                           | `user_credentials`                                       |
| `permissions_key_format_check`, `roles_key_format_check`                                                                                                                                                                                                                                                                                                | `permissions`, `roles`                                   |
| `verification_challenges_attempts_check`, `…_code_hash_length_check`, `…_single_outcome_check`, `…_expiry_check`                                                                                                                                                                                                                                        | `verification_challenges`                                |
| index unique partiel `verification_challenges_active_key`                                                                                                                                                                                                                                                                                               | `verification_challenges`                                |
| `user_sessions_revocation_check`, `user_sessions_expiry_check`                                                                                                                                                                                                                                                                                          | `user_sessions`                                          |
| `session_tokens_hash_length_check`                                                                                                                                                                                                                                                                                                                      | `session_tokens`                                         |
| données initiales : catalogue des permissions, rôle `super_admin`                                                                                                                                                                                                                                                                                       | `permissions`, `roles`, `role_permissions`               |
| retrait des privilèges d'écriture aux rôles non propriétaires                                                                                                                                                                                                                                                                                           | `permissions`, `roles`, `role_permissions`, `user_roles` |
| `user_totp_credentials_ciphertext_format_check`, `user_totp_credentials_last_used_step_check`                                                                                                                                                                                                                                                           | `user_totp_credentials`                                  |
| `user_recovery_codes_hash_length_check`                                                                                                                                                                                                                                                                                                                 | `user_recovery_codes`                                    |
| `user_profiles_names_not_blank_check`, `user_profiles_date_of_birth_check`                                                                                                                                                                                                                                                                              | `user_profiles`                                          |
| `user_sessions_device_fingerprint_length_check`                                                                                                                                                                                                                                                                                                         | `user_sessions`                                          |
| `role_change_requests_reason_not_blank_check`, `…_expiry_check`, `…_not_self_requested_check`, `…_decision_check`, `…_four_eyes_check`, `…_cancelled_by_requester_check`                                                                                                                                                                                | `role_change_requests`                                   |
| index unique partiel `role_change_requests_pending_key`                                                                                                                                                                                                                                                                                                 | `role_change_requests`                                   |
| fonction `mgx_enforce_role_change()` (`SECURITY DEFINER`, `search_path` figé, `EXECUTE` retiré à `PUBLIC`) ; déclencheur `role_change_requests_enforce`                                                                                                                                                                                                 | `role_change_requests`, `user_roles`                     |
| déclencheurs `role_change_requests_no_delete`, `role_change_requests_no_truncate` ; retrait de `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                                                                                                                                                       | `role_change_requests`                                   |
| index partiel `users_pending_registration_idx` (purge des inscriptions jamais vérifiées)                                                                                                                                                                                                                                                                | `users`                                                  |
| données initiales : permissions du back-office, rôle `support`                                                                                                                                                                                                                                                                                          | `permissions`, `roles`, `role_permissions`               |
| `kyc_cases_level_check`, `…_lists_not_null_check`, `…_lifecycle_check`, `…_rejection_check`, `…_decision_note_check`, `…_revocation_reason_check`, `…_not_self_decided_check`, `…_not_self_revoked_check`, `…_identity_fields_check`, `…_address_fields_check`, `…_funds_fields_check`                                                                  | `kyc_cases`                                              |
| index uniques partiels `kyc_cases_open_key`, `kyc_cases_approved_key`, `kyc_cases_verified_document_key`                                                                                                                                                                                                                                                | `kyc_cases`                                              |
| fonction `mgx_enforce_kyc_case()` (`search_path` figé) ; déclencheurs `kyc_cases_enforce`, `kyc_cases_no_truncate`                                                                                                                                                                                                                                      | `kyc_cases`                                              |
| `kyc_documents_content_type_check`, `…_selfie_is_image_check`, `…_byte_size_check`, `…_sha256_check`, `…_wrapped_key_check`, `…_storage_key_check`                                                                                                                                                                                                      | `kyc_documents`                                          |
| index unique partiel `kyc_documents_single_kind_key`                                                                                                                                                                                                                                                                                                    | `kyc_documents`                                          |
| fonction `mgx_enforce_kyc_document()` (`search_path` figé) ; déclencheurs `kyc_documents_enforce`, `kyc_documents_no_truncate`                                                                                                                                                                                                                          | `kyc_documents`                                          |
| retrait de `TRUNCATE` (et de `UPDATE` sur `kyc_documents`) aux rôles non propriétaires                                                                                                                                                                                                                                                                  | `kyc_cases`, `kyc_documents`                             |
| données initiales : permissions `kyc.read`, `kyc.review`, `kyc.revoke`, rôle `compliance`                                                                                                                                                                                                                                                               | `permissions`, `roles`, `role_permissions`               |
| valeur `ACCOUNT_CLOSED` du type `kyc_case_status` (migration séparée : PostgreSQL interdit d'utiliser une valeur dans la transaction qui l'ajoute)                                                                                                                                                                                                      | `kyc_cases`                                              |
| `users_closed_is_anonymous_check`, `users_reserved_email_domain_check` ; fonction `mgx_enforce_user_closure()`, déclencheur `users_enforce_closure`                                                                                                                                                                                                     | `users`                                                  |
| fonction `mgx_forbid_closed_account_rows()` ; déclencheurs `<table>_account_open`                                                                                                                                                                                                                                                                       | dix tables rattachées à un compte (voir `users`)         |
| `account_closures_author_check`, `…_email_check`, `…_phone_check`, `…_schedule_check`, `…_erasure_check`                                                                                                                                                                                                                                                | `account_closures`                                       |
| fonctions `mgx_enforce_account_closure()`, `mgx_check_closure_applied()` ; déclencheurs `account_closures_enforce`, `account_closures_no_truncate`, déclencheur de contrainte différé `account_closures_applied` ; retrait de `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                        | `account_closures`                                       |
| fonction `mgx_kyc_case_erasable()` ; `kyc_cases_lifecycle_check`, `mgx_enforce_kyc_case()` et `mgx_enforce_kyc_document()` **remplacées** (fin d'une vérification à la clôture, effacement)                                                                                                                                                             | `kyc_cases`, `kyc_documents`                             |
| données initiales : permission `users.close`, attribuée à `super_admin` et `compliance`                                                                                                                                                                                                                                                                 | `permissions`, `role_permissions`, `roles`               |
| colonne `terms_accepted_at` **renommée** `registered_at` (`RENAME COLUMN`, sans perte : Prisma proposerait de la supprimer puis de la recréer)                                                                                                                                                                                                          | `users`                                                  |
| fonction `mgx_is_terms_text()` ; `terms_versions_number_check`, `…_first_requires_acceptance_check`, `…_fr_text_check`, `…_en_text_check`, `…_fr_digest_check`, `…_en_digest_check`                                                                                                                                                                     | `terms_versions`                                         |
| fonction `mgx_enforce_terms_version()` ; déclencheurs `terms_versions_enforce`, `terms_versions_immutable_row`, `terms_versions_immutable_truncate` ; retrait de `UPDATE`, `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                                                                           | `terms_versions`                                         |
| fonction `mgx_enforce_terms_acceptance()` ; déclencheurs `terms_acceptances_account_open`, `terms_acceptances_enforce`, `terms_acceptances_no_update`, `terms_acceptances_no_truncate` ; retrait de `UPDATE` et `TRUNCATE` aux rôles non propriétaires                                                                                                  | `terms_acceptances`                                      |
| fonction `mgx_forbid_closure_with_terms_acceptance()` ; déclencheur `users_closure_leaves_no_terms_acceptance`                                                                                                                                                                                                                                          | `users`                                                  |
| chemin de recherche figé (`search_path = <schéma>, pg_temp`) des quatre fonctions de la migration `terms_of_use`                                                                                                                                                                                                                                        | —                                                        |
| données initiales : permission `terms.publish`, attribuée à `super_admin`                                                                                                                                                                                                                                                                               | `permissions`, `role_permissions`                        |
| types `asset_kind`, `ledger_side`, `ledger_account_owner` (modélisés par Prisma) ; `assets_code_format_check`, `assets_scale_check`, `assets_name_check`                                                                                                                                                                                                | `assets`                                                 |
| fonction `mgx_enforce_asset()` ; déclencheurs `assets_enforce`, `assets_immutable_row`, `assets_immutable_truncate` ; retrait de `UPDATE`, `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                                                                                                           | `assets`                                                 |
| `ledger_account_types_key_format_check` ; déclencheurs `ledger_account_types_immutable_row`, `ledger_account_types_immutable_truncate` ; retrait de tout privilège d'écriture aux rôles non propriétaires ; données initiales : plan de comptes                                                                                                         | `ledger_account_types`                                   |
| index uniques partiels `ledger_accounts_user_key`, `ledger_accounts_platform_key` ; `ledger_accounts_balance_check`, `…_posting_count_check`, `…_empty_check`                                                                                                                                                                                           | `ledger_accounts`                                        |
| fonctions `mgx_enforce_ledger_account()`, `mgx_check_ledger_account_balance()` ; déclencheurs `ledger_accounts_account_open`, `ledger_accounts_enforce`, `ledger_accounts_no_delete`, `ledger_accounts_no_truncate`, déclencheur de contrainte différé `ledger_accounts_balance_proven` ; retrait de `DELETE` et `TRUNCATE` aux rôles non propriétaires | `ledger_accounts`                                        |
| `ledger_entries_idempotency_key_format_check`, `…_kind_format_check`, `…_posting_count_check`, `…_actor_id_check`, `…_metadata_check`                                                                                                                                                                                                                   | `ledger_entries`                                         |
| fonction `mgx_stamp_ledger_entry()` ; déclencheurs `ledger_entries_stamp`, `ledger_entries_immutable_row`, `ledger_entries_immutable_truncate`, déclencheur de contrainte différé `ledger_entries_sound` ; retrait de `UPDATE`, `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                      | `ledger_entries`                                         |
| `ledger_postings_amount_check`, `…_line_number_check`, `…_account_sequence_check`, `…_balance_after_check`                                                                                                                                                                                                                                              | `ledger_postings`                                        |
| fonctions `mgx_apply_ledger_posting()`, `mgx_check_ledger_entry()` ; déclencheurs `ledger_postings_apply`, `ledger_postings_immutable_row`, `ledger_postings_immutable_truncate`, déclencheur de contrainte différé `ledger_postings_entry_sound` ; retrait de `UPDATE`, `DELETE` et `TRUNCATE` aux rôles non propriétaires                             | `ledger_postings`                                        |
| fonction `mgx_forbid_closure_with_funds()` ; déclencheur `users_closure_leaves_no_funds`                                                                                                                                                                                                                                                                | `users`                                                  |
| fonction `mgx_enforce_closure_ledger_retention()` ; déclencheur `account_closures_ledger_retention`                                                                                                                                                                                                                                                     | `account_closures`                                       |
| chemin de recherche figé (`search_path = <schéma>, pg_temp`) des huit fonctions de la migration `ledger`                                                                                                                                                                                                                                                | —                                                        |
| données initiales : permissions `ledger.read` et `ledger.manage_assets`, attribuées à `super_admin`                                                                                                                                                                                                                                                     | `permissions`, `role_permissions`                        |
| fonction `mgx_verified_level()` (niveau de vérification d'un compte, tel que la base le calcule)                                                                                                                                                                                                                                                        | `kyc_cases`                                              |
| `transfer_limits_kyc_level_check`, `transfer_limits_amounts_check`                                                                                                                                                                                                                                                                                      | `transfer_limits`                                        |
| fonction `mgx_enforce_transfer_limit()` ; déclencheurs `transfer_limits_enforce`, `transfer_limits_no_delete`, `transfer_limits_no_truncate` ; retrait de `DELETE` et `TRUNCATE` aux rôles non propriétaires                                                                                                                                            | `transfer_limits`                                        |
| `transfers_amount_check`, `…_parties_check`, `…_sender_level_check`, `…_idempotency_key_format_check`, `…_request_digest_check`                                                                                                                                                                                                                         | `transfers`                                              |
| fonctions `mgx_transfer_usage()`, `mgx_enforce_transfer()`, `mgx_check_transfer_entry()` ; déclencheurs `transfers_enforce`, `transfers_immutable_row`, `transfers_immutable_truncate`, déclencheur de contrainte différé `transfers_entry_matches` ; retrait de `UPDATE`, `DELETE` et `TRUNCATE` aux rôles non propriétaires                           | `transfers`                                              |
| fonction `mgx_check_transfer_recorded()` ; déclencheur de contrainte différé `ledger_entries_transfer_recorded`                                                                                                                                                                                                                                         | `ledger_entries`                                         |
| chemin de recherche figé (`search_path = <schéma>, pg_temp`) des six fonctions de la migration `internal_transfers`                                                                                                                                                                                                                                     | —                                                        |
| données initiales : permissions `transfer_limits.read` et `transfer_limits.write`, attribuées à `super_admin`                                                                                                                                                                                                                                           | `permissions`, `role_permissions`                        |

Leur présence et leur effet sont vérifiés par les tests d'intégration
`database-constraints.spec.ts`, `identity-schema.spec.ts`, `account-security-schema.spec.ts`,
`back-office-schema.spec.ts`, `kyc-schema.spec.ts`, `account-closure-schema.spec.ts`,
`terms-schema.spec.ts`, `ledger-schema.spec.ts` et `transfers-schema.spec.ts` (dans
`apps/api/test/integration/`).

**Erreurs levées par les déclencheurs** — codes SQLSTATE propres à l'application :

| Code    | Signification                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MGX01` | modification ou suppression interdite d'une table en ajout seul                                                                                                                                                                                          |
| `MGX02` | règle de la double validation d'un changement de rôle enfreinte                                                                                                                                                                                          |
| `MGX03` | règle du parcours d'un dossier de vérification enfreinte                                                                                                                                                                                                 |
| `MGX04` | règle de la clôture d'un compte ou de sa trace enfreinte                                                                                                                                                                                                 |
| `MGX05` | écriture sur un compte clôturé — l'API répond `409 CONFLICT`                                                                                                                                                                                             |
| `MGX06` | règle des conditions d'utilisation enfreinte : auteur non habilité à publier, compte qui ne peut pas accepter, acceptation effacée hors des cas permis                                                                                                   |
| `MGX07` | numéro de version qui n'est pas — ou plus — celui attendu : à la publication, le suivant ; à l'acceptation, celui en vigueur                                                                                                                             |
| `MGX08` | règle du grand livre enfreinte : écriture incomplète ou déséquilibrée, ligne dans un autre actif que son compte, solde qui n'est pas celui de la dernière ligne, compte ouvert à qui ne peut pas détenir de fonds, actif enregistré sans y être habilité |
| `MGX09` | fonds insuffisants : la ligne rendrait négatif le solde d'un compte                                                                                                                                                                                      |
| `MGX10` | règle des transferts enfreinte : plafonds fixés sans y être habilité, partie qui n'est pas active, niveau de vérification erroné ou non ouvert dans l'actif, plafond dépassé, transfert sans son écriture — ou écriture de transfert sans son transfert  |

`MGX05` est traduit **partout**, par le filtre d'erreurs de l'API : il signale le plus souvent
une requête partie avant la clôture du compte et arrivée après, et aucun service n'a à s'en
soucier. Les autres sont interceptés par le dépôt (_repository_) du module concerné : les
contrôles du service auraient dû écarter le cas, de sorte que la réponse est un `409 CONFLICT`
et l'incident est journalisé. `MGX07`, lui, est un cas **attendu** — une version publiée
entre la lecture et l'écriture : l'API répond `409 TERMS_VERSION_NOT_CURRENT` (acceptation,
inscription) ou `409 CONFLICT` (publication), et le client recommence avec la version en
vigueur. `MGX06` à la publication signifie que l'auteur a perdu son droit entre le contrôle de
l'API et l'écriture : `403 FORBIDDEN`.

Pour le grand livre, le dépôt traduit le refus d'une instruction en erreur du domaine, que
l'opération appelante traduira à son tour pour son utilisateur : `MGX09` devient
`InsufficientFundsError` et `MGX05` `HolderClosedError` — deux cas **attendus** —, `MGX08`
`LedgerIntegrityError`, un défaut. `LedgerService` fait les mêmes contrôles avant d'écrire :
la base n'est atteinte que si deux requêtes se croisent, ou si le code est fautif. Un refus
prononcé **à la validation de la transaction** (écriture incomplète, solde non justifié)
n'est pas traduit : c'est toujours un défaut du code, et l'erreur de la base remonte telle
quelle. À l'enregistrement d'un actif, `MGX08` signifie que l'auteur a perdu son droit entre
le contrôle de l'API et l'écriture : `403 FORBIDDEN`.

Pour les transferts, `TransferService` fait les mêmes contrôles que `mgx_enforce_transfer()`,
dans le même ordre, sous le même verrou de l'émetteur : la base n'est atteinte que si l'état
d'un compte change entre ces contrôles et l'écriture — un dossier de vérification retiré, des
plafonds abaissés, un destinataire suspendu. `MGX10` à l'écriture d'un transfert devient
`TransferRefusedByDatabaseError`, et l'API répond `409 CONFLICT` : rien n'est écrit, et la
requête, renvoyée, est examinée dans l'état nouveau. `MGX10` à l'écriture de plafonds
(`LimitChangeDeniedError`) signifie que l'auteur a perdu son droit entre le contrôle de l'API
et l'écriture : `403 FORBIDDEN`. Un refus prononcé à la validation de la transaction — un
transfert et son écriture qui ne s'accordent pas — est un défaut du code, et n'est pas
traduit.

**Transactions qui se croisent.** `40001` (conflit de sérialisation) et `40P01`
(interblocage) ne sont pas des défauts : PostgreSQL a annulé une transaction pour laisser
passer l'autre, et rien n'a été écrit. `UnitOfWork.run(work, { retry })` relance alors la
transaction entière ; sans cette option, ou une fois les tentatives épuisées, l'API répond
`409 CONFLICT`. Une erreur levée à la validation (`COMMIT`) n'a pas la même forme, côté
Prisma, qu'une erreur levée par une instruction : `sqlStateOf` lit les deux.

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

| Table                                                  | Règle actuelle                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs`                                           | conservation illimitée ; la durée légale sera fixée avec la conformité (phase 8)                                                                                                                                                                                                                                                                                                          |
| `outbox_events`                                        | événements **publiés** : supprimés **30 jours** après leur publication. Événements en attente ou abandonnés (`DEAD`) : conservés jusqu'à leur traitement                                                                                                                                                                                                                                  |
| `system_settings`                                      | historique complet des changements dans `audit_logs`                                                                                                                                                                                                                                                                                                                                      |
| `users`, `user_credentials`                            | conservés tant que le compte est ouvert. **Inscription jamais vérifiée : supprimée après 7 jours.** **Compte clôturé** : secret supprimé à la clôture ; la ligne `users` reste, sans adresse ni numéro                                                                                                                                                                                    |
| `account_closures`                                     | trace conservée indéfiniment ; son adresse et son numéro sont **effacés à l'échéance** : 30 jours après la clôture, ou au terme de la conservation légale (dix ans) si des dossiers de vérification sont conservés **ou si une écriture a été passée sur un compte du titulaire**                                                                                                         |
| `user_sessions`                                        | supprimées **90 jours** après leur échéance d'inactivité — sauf la plus récente de chaque compte                                                                                                                                                                                                                                                                                          |
| `session_tokens`                                       | paires renouvelées supprimées après 24 heures ; les autres avec leur session                                                                                                                                                                                                                                                                                                              |
| `verification_challenges`                              | supprimés **7 jours** après leur expiration                                                                                                                                                                                                                                                                                                                                               |
| `user_totp_credentials`                                | enrôlement jamais confirmé : supprimé après **24 heures** ; second facteur en place : conservé                                                                                                                                                                                                                                                                                            |
| `role_change_requests`                                 | conservées indéfiniment (trace des décisions) ; les demandes échues passent à `EXPIRED`                                                                                                                                                                                                                                                                                                   |
| `user_profiles`                                        | conservés tant que le compte est ouvert ; **supprimés à la clôture**, comme les sessions, les codes et le second facteur                                                                                                                                                                                                                                                                  |
| `terms_versions`                                       | conservées **indéfiniment** : une version publiée ne se modifie ni ne se retire                                                                                                                                                                                                                                                                                                           |
| `terms_acceptances`                                    | conservées tant que le compte est ouvert ; **supprimées à la clôture** et avec une inscription jamais vérifiée. La trace de chaque acceptation (version, empreinte du texte, date, adresse IP) reste dans `audit_logs`                                                                                                                                                                    |
| `kyc_cases`, `kyc_documents`                           | dossier **jamais déposé** : effacé avec ses pièces après **30 jours** sans changement. Dossier déposé : conservé tant que le compte est ouvert. **À la clôture** : effacé s'il n'a jamais été examiné ; sinon conservé **dix ans**, puis effacé avec ses pièces                                                                                                                           |
| `assets`, `ledger_account_types`                       | conservés **indéfiniment** : un actif enregistré et un type de compte ne se modifient ni ne se retirent                                                                                                                                                                                                                                                                                   |
| `ledger_accounts`, `ledger_entries`, `ledger_postings` | conservés **indéfiniment** : une écriture a toujours deux côtés, l'effacer déséquilibrerait le grand livre. **Après la clôture d'un compte**, ses comptes et leurs lignes restent, rattachés à une ligne `users` qui ne porte plus aucun identifiant ; l'adresse et le numéro gardés par `account_closures` permettent de les rattacher à une personne pendant dix ans, puis sont effacés |
| `transfers`                                            | conservés **indéfiniment**, comme les écritures qu'ils désignent : un transfert ne se modifie ni ne s'efface. **Après la clôture d'un compte**, ses transferts restent, rattachés à une ligne `users` qui ne porte plus aucun identifiant : l'autre partie n'en voit plus l'adresse                                                                                                       |
| `transfer_limits`                                      | conservés **indéfiniment** : des plafonds se remplacent, ils ne se suppriment pas. L'historique des valeurs est dans `audit_logs`                                                                                                                                                                                                                                                         |

La purge est une tâche planifiée toutes les heures (`AccountMaintenanceService`, file
`account-maintenance`), bornée à 500 lignes par catégorie et par exécution — 200 comptes pour
l'effacement des comptes clôturés, de l'échéance la plus ancienne à la plus récente. Chaque
suppression d'inscription est écrite au journal d'audit (`user.registration_purged`), chaque
suppression d'un dossier de vérification abandonné (`kyc_case.draft_purged`) et chaque
effacement d'un compte clôturé (`user.data_erased`) aussi. Les fichiers des pièces sont
effacés après la validation de la transaction ; un fichier resté sans ligne est de toute
façon indéchiffrable. La dernière session de chaque compte ouvert est conservée : elle atteste
qu'il s'est déjà connecté, ce dont dépend l'avertissement de connexion depuis un nouvel
appareil.

L'échéance d'effacement est lue à l'horloge de l'application ; la conservation légale, elle,
est **relue par la base à sa propre horloge**, qui refuse tout effacement prématuré : l'étape
échoue alors, le signale, et recommence au passage suivant. Un compte qui ne peut pas être
effacé n'empêche pas les autres de l'être, mais il reste en tête de file : au-delà de 200
comptes durablement bloqués, les suivants attendraient (voir `DEPLOYMENT.md`).

Ces durées sont des valeurs de départ. Celles qui touchent aux données personnelles
s'appuient sur une lecture non confirmée de la loi (ADR 0022 et 0023) : elles sont à valider
par un conseil juridique avant l'ouverture au public.

## Tables à venir

Le modèle cible (vérification des entreprises, réservations de fonds, dépôts et retraits,
échanges, paiements, blockchain, P2P, séquestre, risque, support…) sera introduit
phase par phase, chaque table arrivant avec le module qui l'utilise, ses contraintes et ses
tests. Le plan de comptes s'étendra avec elles.
