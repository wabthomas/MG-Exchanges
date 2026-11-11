# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions selon
[SemVer](https://semver.org/lang/fr/).

## [Non publié] — Phase 1 : analyse et fondations

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
