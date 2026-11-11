# Déploiement

> **Avertissement.** L'environnement de développement ne disposait pas de Docker : l'image,
> la pile Compose et Nginx **n'ont jamais été exécutés par Docker**. Leur contenu a été
> exécuté hors Docker avec les vrais logiciels (détail dans `PROJECT_STATUS.md`), et la CI
> les construit et les teste — mais **elle n'est pas encore activée** (voir « Intégration
> continue »). Considérer ce document comme à confirmer tant qu'elle n'est pas passée au
> vert. Le déploiement en production est l'objet de la phase 9.

## Environnements

`APP_ENV` détermine les règles appliquées ; `NODE_ENV` reste le réglage technique de Node.js.

| `APP_ENV`     | Usage                          | `NODE_ENV`   | Documentation API              | Journaux                              |
| ------------- | ------------------------------ | ------------ | ------------------------------ | ------------------------------------- |
| `local`       | poste de développement         | libre        | servie                         | lisibles ou JSON                      |
| `development` | environnement partagé d'équipe | libre        | servie                         | lisibles ou JSON                      |
| `test`        | tests automatisés              | `test`       | servie                         | au choix (silencieux dans le harnais) |
| `staging`     | pré-production                 | `production` | sur authentification seulement | JSON                                  |
| `production`  | production                     | `production` | jamais                         | JSON                                  |

Une configuration contraire à ces règles empêche le démarrage. Les clés Redis sont préfixées
par environnement (`mgx:<APP_ENV>:`).

## Configuration

Référence complète et commentée : [`apps/api/.env.example`](../apps/api/.env.example).

| Variable                 | Obligatoire           | Rôle                                                                                             |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| `APP_ENV`, `NODE_ENV`    | recommandé            | environnement                                                                                    |
| `DATABASE_URL`           | oui                   | PostgreSQL, **rôle applicatif**                                                                  |
| `DATABASE_MIGRATION_URL` | migrations            | PostgreSQL, **rôle propriétaire** — jamais fournie à l'API                                       |
| `SHADOW_DATABASE_URL`    | développement et CI   | base fantôme jetable de Prisma Migrate (voir `DATABASE.md`) — jamais en staging ni en production |
| `REDIS_URL`              | oui                   | Redis (`rediss://` pour TLS)                                                                     |
| `QUEUE_REDIS_URL`        | non                   | Redis dédié aux files (politique `noeviction`)                                                   |
| `TRUST_PROXY_HOPS`       | oui derrière un proxy | nombre de proxys de confiance (1 derrière Nginx)                                                 |
| `CORS_ALLOWED_ORIGINS`   | selon clients         | origines autorisées                                                                              |
| `LOG_LEVEL`              | non                   | `info` par défaut                                                                                |

Les secrets sont injectés par le gestionnaire de secrets de l'hébergeur, jamais par un
fichier présent dans l'image ou le dépôt.

**Redis et BullMQ.** Les files exigent la politique `maxmemory-policy noeviction` et une
persistance (AOF). Si le même Redis sert plus tard de cache avec éviction, fournir une
instance distincte via `QUEUE_REDIS_URL`.

## Images

Un seul fichier, trois cibles (`infrastructure/docker/api.Dockerfile`) :

| Cible      | Contenu                                                      | Usage                         |
| ---------- | ------------------------------------------------------------ | ----------------------------- |
| `build`    | dépendances complètes, compilation                           | étape intermédiaire           |
| `migrator` | CLI Prisma, schéma, migrations, utilisateur `node`           | tâche ponctuelle de migration |
| `runtime`  | code compilé + dépendances de production, utilisateur `node` | exécution de l'API            |

```bash
docker build -f infrastructure/docker/api.Dockerfile --target runtime  -t mgx-api:<version> .
docker build -f infrastructure/docker/api.Dockerfile --target migrator -t mgx-api-migrator:<version> .
```

## Ordre de mise en service d'une version

1. Sauvegarder la base (procédure à définir en phase 9).
2. Exécuter les migrations avec l'image `migrator` et `DATABASE_MIGRATION_URL` (rôle propriétaire).
3. Démarrer la nouvelle version de l'API (`DATABASE_URL`, rôle applicatif).
4. Attendre `GET /health/ready` = 200 avant d'y diriger du trafic.
5. Retirer l'ancienne version : à la réception de `SIGTERM`, l'API ferme proprement son
   serveur HTTP, ses files et ses connexions PostgreSQL et Redis (vérifié sur l'artefact de production).

Les migrations doivent donc rester compatibles avec la version précédente du code le temps
de la bascule (schéma « étendre, migrer, contracter »).

**Retour arrière.** Redéployer l'image précédente. Une migration n'est pas annulée : elle
est corrigée par une nouvelle migration. Procédure détaillée et testée : phase 9.

**Première mise en service d'une base.** Créer les deux rôles et exécuter
`infrastructure/docker/postgres/sql/grant-app-privileges.sql` (voir `DATABASE.md`) avant
la première migration.

## Environnement local avec Docker Compose

```bash
cp .env.example .env                       # mots de passe : openssl rand -hex 24
docker compose up -d                       # PostgreSQL + Redis
docker compose --profile app up -d --build # + migrations, API, Nginx (port 8080)
docker compose --profile app down          # arrêt (ajouter --volumes pour effacer les données)
```

Le script d'initialisation de PostgreSQL crée les deux rôles, la base (`mgx`) et la base
fantôme de Prisma Migrate (`mgx_shadow`). Il ne s'exécute qu'à la création du volume : après
un changement de mot de passe dans `.env`, recréer le volume (`down --volumes`).

Les services ne sont déclarés « sains » qu'une fois réellement utilisables : PostgreSQL
lorsque son initialisation est terminée et qu'il accepte les connexions réseau, Redis
lorsqu'il répond à une commande authentifiée. Les migrations puis l'API ne démarrent qu'ensuite.

## Reverse proxy

`infrastructure/nginx/nginx.conf` : point d'entrée unique, limitation de débit amont
(20 requêtes/s par adresse, rafales de 40), bornage des requêtes, journaux d'accès JSON,
attribution de `X-Request-Id` et transmission de l'adresse réelle du client (un
`X-Forwarded-For` fourni par le client est écrasé). Seuls `/api/` et `/health/live` sont
relayés ; `/health/ready` est réservée au réseau interne.

Les erreurs que Nginx produit lui-même (route non relayée, corps trop volumineux, limitation
de débit, API injoignable) sont renvoyées au format d'erreur de l'API (voir `API.md`). Leur
horodatage suppose que Nginx tourne en UTC, ce que fixe le fichier Compose (`TZ=UTC`).

Il écoute en HTTP : il doit être placé derrière un terminateur TLS, ou complété par la
configuration TLS en phase 9.

## Sondes

| Sonde               | Usage orchestrateur                | Dépend de         |
| ------------------- | ---------------------------------- | ----------------- |
| `GET /health/live`  | redémarrer l'instance si KO        | rien              |
| `GET /health/ready` | retirer l'instance du trafic si KO | PostgreSQL, Redis |

## Intégration continue

Le workflow GitHub Actions est fourni dans `infrastructure/ci/ci.yml`. **Il n'est pas
encore actif** : GitHub n'exécute que les fichiers de `.github/workflows/`, dossier dans lequel
l'outil qui a préparé le dépôt n'était pas autorisé à écrire. Pour l'activer :

```bash
git mv infrastructure/ci/ci.yml .github/workflows/ci.yml
git commit -m "ci: activer l'intégration continue" && git push
```

Il s'exécute ensuite à chaque demande de fusion et sur `main` :

1. **verify** — installation figée, mise en forme, build, lint, types, cohérence
   migrations/schéma, tous les tests sur PostgreSQL 18 et Redis 8 réels, audit des dépendances ;
2. **docker** — validation de la configuration Compose, construction des images, démarrage
   de la pile complète (initialisation de PostgreSQL, migrations, API, Nginx), test de fumée
   à travers Nginx, puis contrôle de cohérence migrations/schéma avec le rôle propriétaire
   et la base fantôme créée par le script d'initialisation.

Aucun déploiement automatique n'est configuré : une modification financière critique ne
sera jamais déployée sans validation explicite.

## Reste à faire (phase 9)

TLS, gestion des secrets par environnement, sauvegardes automatiques chiffrées et
restauration testée, supervision (OpenTelemetry, Grafana), alertes, journaux centralisés,
analyse des images, procédure de gestion d'incident, déploiement progressif.
