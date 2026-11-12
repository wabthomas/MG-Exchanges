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

| Variable                      | Obligatoire           | Rôle                                                                                                             |
| ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`, `NODE_ENV`         | recommandé            | environnement                                                                                                    |
| `DATABASE_URL`                | oui                   | PostgreSQL, **rôle applicatif**                                                                                  |
| `DATABASE_MIGRATION_URL`      | migrations            | PostgreSQL, **rôle propriétaire** — jamais fournie à l'API                                                       |
| `SHADOW_DATABASE_URL`         | développement et CI   | base fantôme jetable de Prisma Migrate (voir `DATABASE.md`) — jamais en staging ni en production                 |
| `REDIS_URL`                   | oui                   | Redis (`rediss://` pour TLS)                                                                                     |
| `QUEUE_REDIS_URL`             | non                   | Redis dédié aux files (politique `noeviction`)                                                                   |
| `TRUST_PROXY_HOPS`            | oui derrière un proxy | nombre de proxys de confiance (1 derrière Nginx)                                                                 |
| `CORS_ALLOWED_ORIGINS`        | selon clients         | origines autorisées                                                                                              |
| `LOG_LEVEL`                   | non                   | `info` par défaut                                                                                                |
| `AUTH_CODE_HMAC_SECRET`       | oui                   | clé du HMAC des codes à usage unique et des codes de secours (32 caractères au moins) — secret                   |
| `AUTH_SECRETS_ENCRYPTION_KEY` | oui                   | clé de chiffrement des secrets de la validation en deux étapes (32 octets en base64) — secret, **à sauvegarder** |
| `AUTH_*_TTL_SECONDS`          | non                   | durées des codes, des jetons d'accès et des sessions                                                             |
| `AUTH_PASSWORD_HASH_*`        | non                   | coût d'Argon2id ; jamais inférieur à 19 456 Kio / 2 passes en staging et en production                           |
| `NOTIFICATION_DELIVERY`       | non                   | `memory` (développement, tests), `smtp` ou `none` ; `memory` interdit en staging et en production                |
| `SMTP_HOST`, `EMAIL_FROM`     | pour envoyer          | serveur SMTP du prestataire d'e-mail et expéditeur ; les définir active l'envoi réel                             |
| `SMTP_USER`, `SMTP_PASSWORD`  | selon prestataire     | identifiants du compte d'envoi — secret                                                                          |
| `SMTP_SECURITY`, `SMTP_PORT`  | non                   | `starttls` (587, défaut) ou `tls` (465) ; `none` refusé en staging et en production                              |
| `KYC_STORAGE_DIR`             | pour le KYC           | répertoire (chemin absolu) des pièces de vérification chiffrées — un **volume persistant**                       |
| `KYC_ENCRYPTION_KEY`          | pour le KYC           | clé maîtresse des pièces (32 octets en base64), distincte de la précédente — secret, **à sauvegarder à part**    |

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

**Rotation de `AUTH_CODE_HMAC_SECRET`.** Les codes à usage unique en cours deviennent
invalides (il suffit d'en redemander un) ; les sessions ne sont pas affectées. **Les codes de
secours de la validation en deux étapes deviennent eux aussi invalides** : chaque titulaire
doit les régénérer (ce qui exige un code de son application d'authentification). À ne faire
qu'en cas de compromission de la clé, en prévenant les utilisateurs.

**`AUTH_SECRETS_ENCRYPTION_KEY` : sauvegarde obligatoire, rotation non encore outillée.**
Cette clé chiffre le secret du second facteur de chaque compte. Générer :
`openssl rand -base64 32`.

- **La perdre désactive tous les seconds facteurs** : plus aucun code ne peut être vérifié, et
  chaque compte protégé — administrateurs compris — reste bloqué à la seconde étape jusqu'à ce
  que le support retire son second facteur. Elle doit être sauvegardée séparément de la base.
- **La changer a le même effet** : il n'existe pas encore de procédure de rotation (le format
  de stockage réserve un octet de version pour l'introduire sans migration des données).
- Une sauvegarde de la base sans cette clé ne contient aucun secret TOTP exploitable ; une
  sauvegarde de la base **avec** cette clé les contient tous : ne pas les stocker ensemble.

**Tâches planifiées.** L'API exécute elle-même, par BullMQ (un planificateur partagé par
toutes les instances) : le relais de la boîte d'envoi (chaque seconde) et la **purge des
données d'identité** (chaque heure : inscriptions jamais vérifiées, sessions terminées, codes
expirés, enrôlements abandonnés, demandes de rôle échues, dossiers de vérification jamais
déposés — durées dans `DATABASE.md`). Un échec est journalisé
(`Account maintenance step failed`) et visible dans la file `account-maintenance` ;
l'exécution suivante réessaie.

## Vérification d'identité : stockage des pièces

La vérification d'identité (ADR 0022) n'est utilisable que si **deux** variables sont
définies ; sans elles l'API démarre, mais tout ce qui touche à un dossier répond `503`.

```bash
KYC_STORAGE_DIR=/var/lib/mgx/kyc          # chemin absolu, sur un volume persistant
KYC_ENCRYPTION_KEY=…                      # openssl rand -base64 32 — gestionnaire de secrets
```

- **Le volume.** Les pièces y sont écrites chiffrées, une par fichier, réparties dans 256
  sous-répertoires. Au démarrage, l'API crée le répertoire s'il manque et vérifie qu'elle
  peut y écrire (utilisateur `node` dans l'image, qui prévoit `/var/lib/mgx/kyc` avec les bons
  droits) : **elle refuse de démarrer** si ce n'est pas le cas. Compter jusqu'à 5 Mio par
  pièce, et de quatre à onze pièces pour un compte vérifié aux trois niveaux.
- **Journal de démarrage.** La ligne `Verification document storage is ready` confirme que
  le stockage est utilisable ; `Identity verification is unavailable…` signale que les deux
  variables manquent.
- **Plusieurs instances** de l'API doivent partager ce volume (système de fichiers réseau) :
  une pièce reçue par l'une est relue par une autre. Un stockage objet demandera une autre
  implémentation du port `DocumentStorage`.
- **Sauvegardes : trois éléments, dont un à part.** La base et le volume se sauvegardent
  ensemble (une ligne sans fichier, ou l'inverse, donne une pièce illisible). **La clé se
  conserve ailleurs** : une sauvegarde de la base et du volume sans elle ne contient aucune
  pièce lisible ; avec elle, elle les contient toutes.
- **Perdre la clé rend toutes les pièces illisibles, définitivement** — et avec elles les
  numéros de pièce d'identité. Les vérifications acceptées restent acquises, mais plus aucune
  pièce ne peut être produite à une autorité.
- **Changer la clé a le même effet** : la rotation n'est pas outillée (le format réserve un
  octet de version pour l'introduire).
- **Rôle `compliance`.** Les examinateurs le reçoivent comme tout rôle, par une demande
  approuvée par un second administrateur (`POST /api/v1/admin/role-changes`), et doivent
  activer la validation en deux étapes. La fonctionnalité s'ouvre ensuite aux titulaires :
  `PUT /api/v1/admin/system-settings/features.kyc`.
- **Poste des examinateurs.** Les fichiers ne sont pas analysés par un antivirus : ils
  doivent être ouverts sur un poste à jour, dans une visionneuse isolée (voir `SECURITY.md`).

Avec Docker Compose, définir `KYC_ENCRYPTION_KEY` dans `.env` suffit : le volume
`kyc-documents` est monté sur `/var/lib/mgx/kyc` et `KYC_STORAGE_DIR` en découle.

## Premiers comptes d'administration

Aucune route de l'API ne permet d'obtenir un rôle sans l'accord de deux administrateurs. Les
premiers se créent donc en ligne de commande, avec le **rôle propriétaire** de la base (celui
des migrations), seul autorisé à écrire une attribution. L'opération est inscrite au journal
d'audit.

**Il en faut au moins deux**, détenus par deux personnes : tout changement de rôle par l'API
exige qu'un administrateur le demande et qu'un _autre_ l'approuve. Avec un seul
administrateur, les rôles ne peuvent plus évoluer que par cet outil — qui reste aussi le
recours si tous les administrateurs perdent leur accès.

```bash
read -rs MGX_ADMIN_PASSWORD && export MGX_ADMIN_PASSWORD   # saisie masquée, 10 caractères au moins

# poste de développement (DATABASE_MIGRATION_URL lue dans apps/api/.env)
pnpm build && pnpm admin:create --email admin@example.com

# pile conteneurisée : l'image de migration détient l'URL du rôle propriétaire
docker compose --profile app run --rm --env MGX_ADMIN_PASSWORD \
  migrate node dist/cli/main.js admin:create --email admin@example.com
```

Le compte reçoit le rôle `super_admin`. Le mot de passe est haché avec le coût exigé en
production, quel que soit l'environnement.

**Avant toute action d'administration, le compte doit activer la validation en deux étapes** :
se connecter, puis `POST /api/v1/me/mfa/totp/enroll` et `POST /api/v1/me/mfa/totp/confirm`
(voir `API.md`). Tant que ce n'est pas fait, toute route du back-office répond
`403 MFA_ENROLLMENT_REQUIRED`. Conserver les codes de secours en lieu sûr. Le compte peut
ensuite ouvrir les fonctionnalités
(`PUT /api/v1/admin/system-settings/features.registration`…) et demander l'attribution du
rôle `support` aux agents (`POST /api/v1/admin/role-changes`).

## Notifications

**E-mails : par le serveur SMTP du prestataire de votre choix** (ADR 0021). Tous en proposent
un ; l'API n'en connaît aucun en particulier.

```bash
SMTP_HOST=smtp.prestataire.example
SMTP_USER=…            # identifiants du compte d'envoi (gestionnaire de secrets)
SMTP_PASSWORD=…
EMAIL_FROM="MG-Exchange <no-reply@votre-domaine.example>"
# SMTP_SECURITY=starttls (port 587, défaut) ou tls (port 465)
```

Définir `SMTP_HOST` suffit à activer l'envoi. La connexion est toujours chiffrée en
pré-production et en production, et le certificat du serveur toujours vérifié (un relais
interne signé par une autorité privée se déclare à Node.js par `NODE_EXTRA_CA_CERTS`).

Avant d'ouvrir l'inscription :

1. **Autoriser le domaine expéditeur** chez le prestataire (enregistrements SPF et DKIM, puis
   DMARC). Sans cela, les messages partent mais finissent en indésirables.
2. Démarrer l'API et lire son journal : la ligne `SMTP server is reachable…` confirme que le
   serveur répond et accepte les identifiants ; `SMTP server verification failed` donne la
   réponse du serveur. L'API démarre dans les deux cas.
3. Créer un compte de test avec une vraie adresse et vérifier la réception du code.

Chaque message accepté par le serveur laisse une ligne `Email accepted by the SMTP server`
(modèle et identifiant du message, jamais l'adresse). Un échec est retenté cinq fois, puis
abandonné et journalisé (`Domain event handling failed`). Les retours de non-remise signalés
après coup se consultent chez le prestataire : l'API ne les reçoit pas.

**SMS : aucun prestataire n'est branché.** La vérification du numéro de téléphone répond
`503` ; rien d'autre n'en dépend. Les deux canaux sont indépendants.

**Sans `SMTP_HOST`** :

- en local, en développement et en test, les messages — e-mails et SMS — restent en mémoire
  et se lisent sur `GET /api/v1/dev/mailbox?recipient=<adresse ou numéro>` ;
- en pré-production et en production, rien ne part : l'inscription, la réinitialisation du
  mot de passe et la vérification du téléphone répondent `503`, et les messages de sécurité
  (nouvelle connexion, second facteur modifié, compte suspendu…) ne sont pas envoyés. Un
  administrateur créé en ligne de commande peut, lui, se connecter et activer sa validation
  en deux étapes, qui ne dépend d'aucun envoi.

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

Les corps sont bornés à 128 Ko, sauf sur **une** route : l'envoi d'une pièce de vérification
(6 Mio). Le fichier y est transmis à l'API au fil de l'eau, **sans copie sur le disque du
proxy** — une pièce d'identité n'y est jamais écrite en clair —, avec au plus quatre envois
simultanés par adresse. Un proxy ou un répartiteur placé devant Nginx doit admettre des
corps de 6 Mio sur cette route, et ne pas les mettre en tampon sur disque.

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
   à travers Nginx, parcours d'identité complet (administrateur créé en ligne de commande,
   activation de sa validation en deux étapes, ouverture de l'inscription, inscription,
   vérification, connexion, contrôle des droits, connexion en deux étapes, back-office,
   **vérification d'identité** : envoi de pièces à travers le proxy — jusqu'à la taille
   maximale, et à quatre de front —, dépôt, examen, téléchargement d'une pièce à l'identique,
   acceptation), contrôle que le volume ne contient que des pièces chiffrées, puis contrôle
   de cohérence migrations/schéma avec le rôle propriétaire et la base fantôme créée par le
   script d'initialisation.

Aucun déploiement automatique n'est configuré : une modification financière critique ne
sera jamais déployée sans validation explicite.

## Reste à faire (phase 9)

TLS, gestion des secrets par environnement, sauvegardes automatiques chiffrées et
restauration testée (base, volume des pièces, clés), stockage objet des pièces, supervision
(OpenTelemetry, Grafana), alertes, journaux centralisés, analyse des images, procédure de
gestion d'incident, déploiement progressif.
