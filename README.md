# MG-Exchange

Plateforme fintech permettant d'acheter, vendre, échanger, envoyer, recevoir et gérer des
actifs numériques et des devises depuis une interface unique. Marché de lancement : la
République démocratique du Congo ; l'architecture est prévue pour s'étendre à d'autres marchés.

> **État : phase 2 en cours — comptes, authentification, validation en deux étapes, profil,
> vérification du téléphone, routes d'administration des comptes, vérification d'identité des
> particuliers (KYC, examen manuel), clôture de compte, copie et effacement des données,
> conditions d'utilisation versionnées (publication, acceptation) sont livrés ; la
> vérification des entreprises reste à faire.**
> Aucune fonctionnalité financière n'existe : ni paiement, ni transfert, ni retrait.
> L'inscription et la vérification d'identité sont fermées par défaut, et personne ne
> s'inscrit tant qu'aucune version des conditions d'utilisation n'est publiée — **leur texte
> n'est pas fourni par ce dépôt**. Les e-mails partent par
> le serveur SMTP du prestataire configuré au déploiement ; aucun SMS ne part (aucun
> prestataire SMS n'est branché).
> Ce dépôt contient une **API** : l'application web, les applications mobiles et l'interface
> du back-office n'existent pas encore (phase 7). L'avancement détaillé, les résultats de
> tests et les limites connues sont dans [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Ce que contient le dépôt

```
apps/
  api/                 API NestJS — monolithe modulaire (TypeScript strict, ESM)
packages/
  shared/              primitives métier : montants exacts (bigint), sans virgule flottante
  validation/          schémas de validation primitifs (Zod), partagés avec les futurs clients
  contracts/           contrats de l'API : erreurs, identité, vérification d'identité,
                       back-office, catalogue des permissions
  config/              préréglages d'outillage : TypeScript, ESLint, Jest
infrastructure/
  docker/              image de l'API, initialisation de PostgreSQL (rôles et privilèges)
  nginx/               reverse proxy
  ci/                  scripts de l'intégration continue : parcours de bout en bout rejoué
                       sur la pile conteneurisée, contrôle du volume des pièces
.github/workflows/     intégration continue (GitHub Actions)
docs/                  architecture, base de données, API, sécurité, déploiement, décisions (ADR)
docker-compose.yml     environnement local
```

Les dossiers `apps/web`, `apps/mobile` et `apps/admin` seront créés lorsque leur phase
commencera : le dépôt ne contient aucun dossier vide ni code factice.

## Prérequis

| Outil          | Version                                        |
| -------------- | ---------------------------------------------- |
| Node.js        | 24 LTS (≥ 24.15) — voir `.nvmrc`               |
| pnpm           | 12.18 (épinglé par `packageManager`)           |
| Docker Compose | v2 — fournit PostgreSQL 18 et Redis 8 en local |

## Démarrage rapide

```bash
# 1. Infrastructure locale (PostgreSQL 18 + Redis 8)
cp .env.example .env                 # renseigner chaque mot de passe : openssl rand -hex 24
docker compose up -d

# 2. Dépendances et configuration de l'API
pnpm install
cp apps/api/.env.example apps/api/.env   # reporter les mots de passe du fichier .env racine, puis générer :
                                         #   AUTH_CODE_HMAC_SECRET        openssl rand -hex 32
                                         #   AUTH_SECRETS_ENCRYPTION_KEY  openssl rand -base64 32
                                         # et, pour la vérification d'identité (facultatif) :
                                         #   KYC_ENCRYPTION_KEY           openssl rand -base64 32
                                         #   KYC_STORAGE_DIR              chemin absolu d'un répertoire

# 3. Schéma de base de données, compilation, lancement
pnpm db:migrate:deploy
pnpm build
pnpm dev:api

# 4. Comptes d'administration (hors de l'API, voir docs/DEPLOYMENT.md) — il en faut deux
#    pour que les rôles puissent ensuite évoluer par l'API (double validation)
read -rs MGX_ADMIN_PASSWORD && export MGX_ADMIN_PASSWORD
pnpm admin:create --email admin@example.com

# 5. Conditions d'utilisation : sans version publiée, personne ne peut s'inscrire.
#    DÉFINITIF — une version publiée ne se modifie ni ne se retire (voir docs/DEPLOYMENT.md)
pnpm terms:publish --number 1 --requires-acceptance yes \
  --reason "Texte de travail pour le développement" \
  --fr ./conditions-fr.md --fr-summary "Première version."
```

Un administrateur doit **activer la validation en deux étapes** avant toute action du
back-office (`POST /api/v1/me/mfa/totp/enroll`, puis `…/confirm` avec un code de son
application d'authentification) : sans elle, les routes `/api/v1/admin/…` répondent
`403 MFA_ENROLLMENT_REQUIRED`.

L'API écoute sur `http://localhost:3000` :

| URL                         | Rôle                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/api/docs`                 | documentation interactive (Swagger UI) — développement seul                                                          |
| `/api/v1/system/status`     | état de la plateforme et fonctionnalités ouvertes                                                                    |
| `/api/v1/auth/…`            | inscription, connexion en une ou deux étapes, mot de passe                                                           |
| `/api/v1/me/…`              | compte, sessions, second facteur, profil, téléphone, historique                                                      |
| `/api/v1/me/verification/…` | vérification d'identité : dossiers par niveau, envoi des pièces                                                      |
| `/api/v1/admin/…`           | back-office : paramètres, comptes, rôles, examen des dossiers de vérification (permissions et second facteur requis) |
| `/api/v1/dev/mailbox`       | e-mails et SMS « envoyés » — développement seul                                                                      |
| `/health/live`              | sonde de vivacité                                                                                                    |
| `/health/ready`             | sonde de disponibilité (PostgreSQL, Redis)                                                                           |

Toute route exige une authentification, sauf celles explicitement publiques. L'inscription
est fermée par défaut : un administrateur l'ouvre avec
`PUT /api/v1/admin/system-settings/features.registration` ; la vérification d'identité, de
même, avec `…/features.kyc`. En développement, les codes envoyés par e-mail ou par SMS se
lisent sur `/api/v1/dev/mailbox?recipient=<adresse ou numéro>`.

Pile entièrement conteneurisée (migrations, API, Nginx sur le port 8080) :

```bash
docker compose --profile app up -d --build
curl http://localhost:8080/api/v1/system/status
```

## Commandes

| Commande                       | Effet                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `pnpm build`                   | compile les paquets puis l'API                                                          |
| `pnpm dev:api`                 | lance l'API en mode rechargement                                                        |
| `pnpm lint`                    | ESLint strict, règles d'architecture, garde-fous financiers                             |
| `pnpm typecheck`               | vérification des types (TypeScript strict)                                              |
| `pnpm format` / `format:check` | mise en forme Prettier                                                                  |
| `pnpm test`                    | tous les tests (unitaires, intégration, bout en bout)                                   |
| `pnpm test:unit`               | tests unitaires seuls (aucun service requis)                                            |
| `pnpm db:migrate:dev`          | crée et applique une migration en développement                                         |
| `pnpm db:migrate:deploy`       | applique les migrations en attente                                                      |
| `pnpm admin:create --email …`  | crée un compte d'administration (rôle propriétaire de la base)                          |
| `pnpm terms:publish …`         | publie une version des conditions d'utilisation à partir de fichiers — définitif        |
| `pnpm db:check-drift`          | vérifie que les migrations correspondent au schéma Prisma (exige `SHADOW_DATABASE_URL`) |
| `pnpm audit:deps`              | vulnérabilités connues des dépendances de production                                    |
| `pnpm verify`                  | mise en forme, lint, build, types et tests                                              |

### Tests d'intégration et de bout en bout

Ils s'exécutent sur un **PostgreSQL et un Redis réels**. Le harnais crée lui-même ses rôles
et ses bases (une base isolée par fichier de test, issue des vraies migrations) : il lui
faut seulement un accès superutilisateur à une instance **jetable**.

```bash
export TEST_DATABASE_ADMIN_URL="postgresql://postgres:<POSTGRES_SUPERUSER_PASSWORD>@localhost:5432/postgres"
export TEST_REDIS_URL="redis://:<REDIS_PASSWORD>@localhost:6379/15"
pnpm test
```

## Documentation

- [PROJECT_STATUS.md](PROJECT_STATUS.md) — avancement réel, résultats de tests, limites, suite
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — structure, couches, conventions
- [docs/DATABASE.md](docs/DATABASE.md) — modèle de données, contraintes, rôles, migrations
- [docs/API.md](docs/API.md) — conventions, erreurs, points d'accès · [OpenAPI](docs/api/openapi.json)
- [docs/SECURITY.md](docs/SECURITY.md) — mesures en place et mesures prévues
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — environnements, configuration, images
- [docs/adr/](docs/adr/README.md) — décisions d'architecture
- [CHANGELOG.md](CHANGELOG.md)
