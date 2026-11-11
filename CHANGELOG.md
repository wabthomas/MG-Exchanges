# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions selon
[SemVer](https://semver.org/lang/fr/).

## [Non publié] — Phase 2, lot 1 : comptes, authentification, sessions, autorisations

### Ajouté

- Inscription de comptes individuels avec vérification de l'adresse e-mail par code à usage
  unique ; aucune réponse ne révèle l'existence d'un compte.
- Connexion avec blocage temporaire après échecs répétés ; sessions par jetons opaques,
  renouvellement avec détection de réutilisation, expiration par inactivité et absolue.
- Gestion de ses sessions (liste, fermeture, déconnexion) ; mot de passe oublié,
  réinitialisation et changement ; hachage Argon2id natif, règles de choix NIST.
- Authentification exigée par défaut sur toutes les routes ; rôles et permissions du
  back-office ; administration des paramètres de la plateforme (`/api/v1/admin/system-settings`).
- Outil en ligne de commande `admin:create` : premier compte d'administration, créé hors de l'API.
- Module de notifications : port d'envoi, modèles en français et en anglais, boîte de
  réception de développement (`/api/v1/dev/mailbox`).
- Migration `identity_foundations` : comptes, secrets, rôles, permissions, codes, sessions,
  avec leurs contraintes ; tables de droits en lecture seule pour le rôle applicatif.
- Codes d'erreur : `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED`,
  `INVALID_OR_EXPIRED_CODE`, `COUNTRY_NOT_SUPPORTED`.
- Variables : `AUTH_CODE_HMAC_SECRET` (obligatoire), `AUTH_*`, `NOTIFICATION_DELIVERY`.
- CI : parcours d'identité de bout en bout à travers Nginx (`infrastructure/ci/smoke-identity.sh`).
- Tests : 492 au total, dont 165 sur PostgreSQL, Redis et BullMQ réels.
- ADR 0013 à 0016.

### Modifié

- Document OpenAPI : schéma d'erreur partagé (`ProblemDetails`), authentification par jeton.
- Les réponses `401` portent l'en-tête `WWW-Authenticate: Bearer`.

## Phase 1 : analyse et fondations

### Ajouté

- Monorepo pnpm (`apps/api`, `packages/{shared,validation,contracts,config}`), versions
  épinglées par catalogue, délai minimal de 3 jours avant adoption d'une publication,
  scripts d'installation refusés par défaut.
- Outillage : TypeScript 6 strict (ESM), ESLint 10 avec analyse de types, règles
  d'architecture et interdiction des calculs monétaires en virgule flottante, Prettier, Jest 30.
- `@mgx/shared` : montants exacts (`Money`, `bigint`), analyse et formatage décimaux, sept
  modes d'arrondi explicites, points de base, répartition sans perte.
- `@mgx/validation`, `@mgx/contracts` : schémas Zod partagés (montants sur le fil, erreurs
  RFC 9457, état de la plateforme, catalogue des codes d'erreur).
- API NestJS 12 : configuration validée au démarrage, journalisation structurée Pino avec
  expurgation des secrets, gestion centralisée des erreurs, identifiant de requête, REST
  versionné, validation par schéma, en-têtes de sécurité, CORS strict, limitation de débit
  Redis, documentation OpenAPI soumise aux règles d'environnement, sondes de santé, arrêt propre.
- PostgreSQL 18 + Prisma 7 : première migration (`system_settings`, `audit_logs`,
  `outbox_events`), contraintes CHECK, journal d'audit en ajout seul (déclencheurs),
  séparation des rôles propriétaire / applicatif, historique des migrations inaccessible
  au rôle applicatif.
- Modules de plateforme : paramètres système (mode maintenance, fonctionnalités désactivées
  par défaut), journal d'audit, boîte d'envoi transactionnelle relayée par BullMQ.
- Tests : 275 tests (unitaires, propriétés, intégration et bout en bout sur PostgreSQL,
  Redis et BullMQ réels).
- Infrastructure : image Docker de l'API, Docker Compose (PostgreSQL, Redis, migrations,
  API, Nginx), Nginx avec erreurs au format de l'API, workflow d'intégration continue
  (`infrastructure/ci/ci.yml`, à activer en le déplaçant dans `.github/workflows/`).
- Base fantôme de Prisma Migrate (`SHADOW_DATABASE_URL`) pour le contrôle de cohérence
  entre migrations et schéma.
- Documentation : architecture, base de données, API, sécurité, déploiement, 12 ADR.
