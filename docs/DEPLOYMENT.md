# Déploiement

> **Avertissement.** L'environnement de développement ne disposait pas de Docker : le contenu
> de l'image, de la pile Compose et de Nginx y est exécuté hors Docker, avec les vrais
> logiciels (détail dans `PROJECT_STATUS.md`). **L'intégration continue, elle, les construit
> et les teste avec Docker à chaque modification** — au vert depuis sa première exécution, le
> 2026-11-13 (voir « Intégration continue »). Rien de tout cela n'a encore servi en
> production : le déploiement est l'objet de la phase 9.

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

> **Exception : la migration `terms_of_use` (conditions d'utilisation).** Elle **renomme**
> une colonne de `users` (`terms_accepted_at` devient `registered_at`) : une fois appliquée,
> la version précédente de l'API ne lit plus aucun compte. **Arrêter l'API avant de migrer**,
> puis démarrer la nouvelle version — une courte interruption, admise parce qu'aucun
> environnement n'est encore en service. Pour la même raison, **revenir à l'image
> précédente n'est plus possible une fois cette migration appliquée**, sauf à restaurer la
> base. Sans objet pour une base neuve. La règle ci-dessus vaut de nouveau pour les
> migrations suivantes.

La migration `ledger` (grand livre), elle, **n'ajoute que** des tables, des règles et deux
permissions : elle suit la règle, et la version précédente de l'API continue de fonctionner
sur la base migrée. Constaté sur une base qui contenait déjà des comptes : la migration
appliquée pendant que la version précédente tournait, celle-ci a ensuite passé son parcours
complet — inscription, vérification d'identité, back-office, copie des données, clôture —
sans une erreur.

La migration `internal_transfers` (transferts entre titulaires) fait de même : deux tables,
leurs règles, deux permissions. Elle ne fixe aucun plafond et n'ouvre aucune fonctionnalité.
Constaté de la même façon, sur une base qui contenait déjà des comptes : la migration
appliquée pendant que la version précédente tournait, celle-ci a ensuite passé son parcours
complet sans une erreur ; puis la nouvelle version a passé le sien, transferts compris.

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
déposés, événements publiés de la boîte d'envoi, **effacement des comptes clôturés arrivés à
échéance** — durées dans `DATABASE.md` ; puis **vérification du grand livre**, voir « Grand
livre »). Un échec est journalisé
(`Account maintenance step failed`) et visible dans la file `account-maintenance` ;
l'exécution suivante réessaie.

## Clôture des comptes et effacement

Décisions : ADR 0023. Ce que l'exploitation doit savoir :

- **Avant la migration `20261112182356_account_closure`.** Elle réserve le domaine
  `closed.invalid` aux comptes clôturés, et échoue si une inscription porte déjà une adresse
  de ce domaine (`check constraint "users_reserved_email_domain_check" … is violated by some
row`) — de même si un compte avait été mis au statut `CLOSED` à la main, ce qu'aucune
  version précédente ne faisait. Le vérifier avant de déployer :

  ```sql
  SELECT id, email, status FROM users WHERE email LIKE '%@closed.invalid' OR status = 'CLOSED';
  ```

  Si la migration a échoué pour cette raison, elle n'a rien modifié (constaté ici : ni table,
  ni fonction, ni contrainte), mais Prisma la retient comme échouée et refuse les suivantes
  (`P3009`). Supprimer l'inscription en cause — aucun message n'arrive à une adresse de ce
  domaine : hors développement, il ne peut s'agir que d'une inscription jamais vérifiée —,
  puis :

  ```bash
  pnpm --filter @mgx/api exec prisma migrate resolve --rolled-back 20261112182356_account_closure
  pnpm db:migrate:deploy
  ```

- **Horloges.** La conservation légale se compte **à l'horloge de PostgreSQL** : c'est elle
  qui autorise l'effacement d'un dossier conservé, et qui refuse une clôture antidatée de
  plus de vingt-quatre heures. Serveur de base et instances de l'API doivent être
  synchronisés (NTP). Une instance de l'API en retard de plus de vingt-quatre heures verrait
  ses clôtures refusées (`409`, et `Account closure refused by the database` dans ses
  journaux) ; très en avance, elle tenterait des effacements que la base refuse.
- **Journaux d'une clôture.** `Account closure refused by the database` (erreur) : la base a
  refusé une clôture que l'API croyait permise — une horloge déréglée, ou un défaut à
  signaler. `Cleanup after account closure failed` (avertissement) : la clôture est acquise,
  mais un nettoyage qui la suit a échoué (Redis injoignable, fichier non supprimé) ; rien
  n'est à refaire côté compte.
  `Account closure abandoned: the account is busy` (avertissement) : une autre requête a tenu
  le compte pendant quatre essais ; la clôture a répondu `409`, rien n'a changé, et le
  demandeur peut la refaire. Répété pour un même compte, le message désigne une transaction
  qui ne se termine pas.
- **Attente des verrous.** Une clôture qui croise une autre écriture du même compte lui cède
  le passage : elle n'attend aucun verrou plus de 300 ms, puis recommence. Ce délai doit
  rester inférieur à `deadlock_timeout` de PostgreSQL (une seconde par défaut) : **ne pas
  abaisser ce réglage sous une seconde**, faute de quoi la base interromprait elle-même l'une
  des deux requêtes, au hasard (`409` : rien n'est écrit, mais la requête est à refaire).
- **Surveiller l'effacement.** L'étape `erase-closed-accounts` traite au plus 200 comptes par
  heure, de l'échéance la plus ancienne à la plus récente. Un compte qui ne peut pas être
  effacé est journalisé (`Closed account not erased`, avec son identifiant) et retenté à
  chaque passage ; l'étape est alors signalée en échec (`Account maintenance step failed`).
  **Cette alerte doit être traitée** : au-delà de 200 comptes durablement bloqués, les
  suivants ne seraient plus effacés.
- **Stockage des pièces.** Clore un compte ou l'effacer supprime des fichiers du volume des
  pièces (`KYC_STORAGE_DIR`).
  - La ligne en base est supprimée d'abord, dans la transaction ; le fichier ensuite. Un
    fichier qui ne peut pas être supprimé reste sur le volume — **indéchiffrable**, sa clé
    ayant disparu avec la ligne — et il est journalisé avec son emplacement
    (`Verification document file not removed`) : le supprimer à la main suffit.
  - **Sans stockage configuré**, la clôture reste possible (les fichiers restants sont
    signalés : `Verification document files not removed: storage is not configured`), mais un
    compte dont des pièces sont conservées **n'est pas effacé à l'échéance** : il est signalé
    à chaque passage, jusqu'à ce que le stockage soit rétabli.
  - Sans stockage configuré, la copie des données d'un compte qui a déclaré une pièce
    d'identité répond `503` : le numéro de la pièce, chiffré, ne peut pas être relu.
- **Sauvegardes.** Une donnée effacée de la base subsiste dans les sauvegardes antérieures :
  **leur durée de conservation borne le délai réel d'effacement**. Elle est à fixer avec la
  politique de sauvegarde (phase 9), en gardant à l'esprit qu'une restauration ranime les
  données effacées depuis : après une restauration, laisser passer la purge horaire avant de
  rouvrir le service.
- **Journal d'audit.** Il n'est jamais purgé (identifiant technique du compte, adresse IP,
  appareil). Sa durée de conservation reste à fixer avec le conseil juridique.

## Grand livre

Décisions : ADR 0025. Une seule opération passe des écritures à ce jour — le transfert
entre titulaires, décrit à la section suivante — et **aucune route ne crédite un
portefeuille**. Ce que l'exploitation doit savoir :

- **Actifs.** Le grand livre ne tient de comptes que dans les actifs **enregistrés**, et
  aucun ne l'est par les migrations. Un administrateur (`super_admin`, validation en deux
  étapes) les enregistre par l'API :

  ```bash
  curl -X POST https://<hôte>/api/v1/admin/ledger/assets \
    -H "Authorization: Bearer <jeton d'accès>" -H "Content-Type: application/json" \
    -d '{"code":"USD","name":"US dollar","kind":"FIAT","scale":2,"reason":"Comptes en dollars : décision du 12/03"}'
  ```

  **C'est définitif** : ni le code, ni le libellé, ni la nature, ni le nombre de décimales
  (`scale` : 2 pour le dollar et le franc congolais, 8 pour le bitcoin, 18 au plus) ne se
  modifient ensuite, et un actif ne se retire pas. Un nombre de décimales erroné oblige à
  enregistrer l'actif sous un autre code. Enregistrer un actif ne déplace aucun fonds et
  n'ouvre aucune opération : chaque titulaire voit apparaître un portefeuille à zéro.

- **Vérification horaire.** L'étape `verify-ledger` de la tâche de maintenance relit **tout**
  le grand livre. Une anomalie produit :
  - une erreur dans les journaux, `Ledger verification failed`, avec la liste des anomalies
    (nature et identifiant — jamais de montant ; cinquante au plus) ;
  - une entrée `ledger.verification_failed` au journal d'audit ;
  - l'échec de l'étape (`Account maintenance step failed`), à chaque passage tant que
    l'anomalie demeure.

  **Cette alerte doit être traitée sans délai** — et aucune alerte automatique n'est encore
  branchée (phase 9) : c'est à la supervision des journaux de la relever. Une anomalie ne
  peut venir que d'une écriture faite hors des règles de la base (déclencheurs désactivés
  avec le rôle propriétaire, restauration partielle) ou d'un défaut de ces règles. **Ne rien
  corriger à la main** : passer en mode maintenance, conserver les journaux, examiner. Rien
  n'est corrigé automatiquement.

- **Rôle propriétaire.** Il peut désactiver les règles du grand livre ; le rôle de l'API ne
  le peut pas. Ses identifiants (`DATABASE_MIGRATION_URL`) ne servent qu'aux migrations et
  aux outils d'exploitation, et ne sont jamais donnés à l'API.
- **Requêtes qui se croisent.** Avertissement
  `Request abandoned: its transaction conflicted with another one` : PostgreSQL a annulé une
  transaction qui en croisait une autre, y compris après ses nouvelles tentatives ; la
  requête a répondu `409`, rien n'a été écrit. Isolé, le message est sans gravité ; répété,
  il désigne des requêtes qui se disputent les mêmes lignes — à signaler.
- **Sauvegarde et restauration.** Le grand livre se restaure **en entier, avec le reste de la
  base** : restaurer une partie de ses tables le rendrait incohérent, ce que la vérification
  relèverait. Après une restauration, laisser passer la vérification horaire avant de
  rouvrir le service.
- **Clôture d'un compte.** Un compte dont un portefeuille détient des fonds ne se clôt pas,
  pas même par le personnel (`409`). Le titulaire peut les transférer à un autre compte, si
  les transferts lui sont ouverts ; le personnel, lui, n'a aucun moyen de les sortir : la
  procédure de sortie des fonds d'un compte à fermer devra exister avant l'ouverture des
  dépôts.
- **Volume.** La vérification relit toutes les lignes à chaque passage, en une instruction
  bornée par le délai d'exécution des requêtes. Sans conséquence aujourd'hui ; à mesurer,
  puis à borner, avant que le grand livre ne compte des millions de lignes.

## Transferts entre titulaires

Décisions : ADR 0026. Ce que l'exploitation doit savoir :

- **La mise à jour n'ouvre rien.** Après la migration, aucun plafond n'existe et la
  fonctionnalité est fermée : `POST /api/v1/me/transfers` répond `403 FEATURE_DISABLED`.
- **Ouvrir les transferts : trois décisions, dans cet ordre**, chacune par un administrateur
  (`super_admin`, validation en deux étapes) et chacune justifiée :
  1. **l'actif est enregistré** (voir « Grand livre ») ;
  2. **des plafonds sont fixés**, dans cet actif, pour chaque niveau de vérification qui doit
     y prendre part — un appel par niveau :

     ```bash
     curl -X PUT https://<hôte>/api/v1/admin/transfer-limits/USD/1 \
       -H "Authorization: Bearer <jeton d'accès>" -H "Content-Type: application/json" \
       -d '{"perTransfer":"<montant>","daily":"<montant>","monthly":"<montant>","reason":"Plafonds du niveau 1 : décision du 12/03"}'
     ```

     Les montants sont des chaînes décimales dans l'unité de l'actif (`"100.00"`), par
     transfert, sur 24 heures glissantes et sur 31 jours glissants, et croissants.
     **Aucune valeur n'est proposée ici : elles sont à arrêter par le propriétaire, avec la
     conformité.** `GET /api/v1/admin/transfer-limits` relit ce qui est fixé ;

  3. **la fonctionnalité est ouverte** :

     ```bash
     curl -X PUT https://<hôte>/api/v1/admin/system-settings/features.internal_transfers \
       -H "Authorization: Bearer <jeton d'accès>" -H "Content-Type: application/json" \
       -d '{"value":true,"reason":"Ouverture des transferts : décision du 12/03"}'
     ```

- **Un niveau sans plafonds n'envoie ni ne reçoit.** Niveau 0 : adresse e-mail vérifiée,
  aucun dossier accepté ; niveaux 1 à 3 : ceux de la vérification d'identité. Pour qu'un
  compte **reçoive**, son niveau doit avoir des plafonds non nuls dans l'actif — ce qui lui
  permet aussi d'envoyer, dans cette limite : il n'existe pas de réglage « réception seule ».
- **Un changement de plafonds prend effet aussitôt**, y compris pour ce qui a déjà été
  envoyé : un compte dont les envois dépassent déjà un plafond abaissé n'envoie plus rien
  tant qu'ils ne sont pas sortis de la fenêtre. Une valeur erronée prend effet aussitôt elle
  aussi : relire la réponse, qui rend les plafonds tels qu'ils sont enregistrés.
- **Refermer.** Toute la fonctionnalité : le même appel avec `"value":false` — effectif en
  moins de cinq secondes sur chaque instance. Un niveau dans un actif : ses trois montants à
  `"0"` — effectif aussitôt. Des plafonds ne se suppriment pas.
- **À ne pas ouvrir en production en l'état.** Aucune route ne crédite un portefeuille : il
  n'y a rien à transférer tant que les dépôts n'existent pas. Les valeurs des plafonds ne
  sont pas arrêtées, et l'autorisation d'opérer reste à établir pays par pays (voir
  `SECURITY.md`).
- **E-mail.** Chaque transfert prévient ses deux parties. Sans serveur d'envoi configuré
  (voir « Notifications »), ces messages ne partent pas — et le transfert a lieu quand même.
- **Horloge de la base.** Les fenêtres de 24 heures et de 31 jours sont comptées à l'horloge
  de PostgreSQL : elle doit être synchronisée (NTP), y compris sur un serveur de secours.
- **Journal d'audit.** `transfer.created` (un transfert), `transfer.refused` (un refus, avec
  son motif), `transfer.proof_failed` (mot de passe ou second facteur erroné),
  `transfer_limit.set` (plafonds remplacés et nouveaux, justification),
  `transfer_limit.listed_by_admin` (consultation).
- **Journaux.** Avertissement
  `Transfer refused by the database after the application admitted it` : l'état d'un compte a
  changé pendant la requête — vérification retirée, plafonds abaissés, destinataire
  suspendu ; la requête a répondu `409`, rien n'a été écrit. Isolé, le message est sans
  gravité ; **répété, il signale que l'application et la base ne s'accordent plus sur une
  règle** — un défaut, à signaler.
- **Sauvegarde et restauration.** Les transferts se restaurent avec le grand livre, **en
  entier** : un transfert sans son écriture, ou l'inverse, serait incohérent. La
  vérification horaire du grand livre ne relit pas cette correspondance ; la base, elle, la
  vérifie à chaque écriture.
- **Parcours de vérification.** `infrastructure/ci/smoke-identity.sh` ouvre désormais les
  transferts, fixe des plafonds sur son actif de test, et **les laisse ouverts** : il est
  fait pour une pile de test, jamais pour une plateforme en service.

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
ensuite publier les conditions d'utilisation (section suivante), ouvrir les fonctionnalités
(`PUT /api/v1/admin/system-settings/features.registration`…) et demander l'attribution du
rôle `support` aux agents (`POST /api/v1/admin/role-changes`).

## Conditions d'utilisation

**Avant d'ouvrir l'inscription, publier la version 1.** Tant qu'aucune version n'est publiée,
`POST /auth/register` répond `503` ; dès qu'elle l'est, **tout compte existant doit
l'accepter** avant de continuer — personnel compris, pour ses routes de client (le back-office,
lui, reste ouvert). Le texte n'est pas fourni par le dépôt : il revient au propriétaire et à
son conseil.

**Publier est définitif.** Une version ne se modifie pas et ne se retire pas ; une erreur se
corrige en publiant la version suivante. Relire le fichier avant de lancer la commande.

Deux moyens, mêmes règles (`API.md`, « Conditions d'utilisation : publication ») :

- le **back-office**, `POST /api/v1/admin/terms/versions`, par un administrateur ;
- l'**outil en ligne de commande**, sur le serveur, avec le **rôle propriétaire** de la base —
  le rôle même qui a exécuté les migrations. Il sert à installer la première version avant
  l'ouverture, ou à publier sans back-office. Avec le rôle de l'API, la base refuse.

```bash
sha256sum conditions-fr.md        # à comparer avec l'empreinte que l'outil affichera

# poste de développement (DATABASE_MIGRATION_URL lue dans apps/api/.env)
pnpm build && pnpm terms:publish --number 1 --requires-acceptance yes \
  --reason "Première version, validée par le conseil le 12/03" \
  --fr ./conditions-fr.md --fr-summary "Première version des conditions d'utilisation."

# pile conteneurisée : le dossier des textes est monté en lecture seule dans l'image de migration
docker compose --profile app run --rm --volume "$PWD/conditions:/terms:ro" \
  migrate node dist/cli/main.js terms:publish --number 1 --requires-acceptance yes \
  --reason "Première version, validée par le conseil le 12/03" \
  --fr /terms/conditions-fr.md --fr-summary "Première version des conditions d'utilisation."
```

- `--number` : le numéro de la version en vigueur plus un (`1` pour la première). Tout autre
  numéro est refusé, et l'outil rappelle celui qui est attendu : une commande relancée par
  mégarde ne publie pas deux fois.
- `--requires-acceptance yes|no` : la règle de cette version — `yes`, chaque compte doit
  l'accepter ; `no`, elle est seulement signalée. La version 1 exige `yes`.
- `--fr <fichier>` et `--fr-summary <texte>` sont obligatoires ; `--en <fichier>` et
  `--en-summary <texte>` vont ensemble ou pas du tout. Texte brut ou Markdown, **en UTF-8** :
  un fichier dans un autre encodage est refusé. 200 000 caractères au plus par texte.
- Un chemin relatif s'entend depuis le dossier où la commande est lancée (avec
  `pnpm --dir <dossier>`, depuis ce dossier-là). Si un fichier est introuvable, l'outil nomme
  le chemin complet qu'il a cherché, et ne publie rien.
- `--reason` : la justification, écrite au journal d'audit (10 à 500 caractères).
- L'outil affiche le numéro publié, l'heure et **l'empreinte SHA-256 de chaque texte
  conservé** : elle doit être celle de `sha256sum`. Si le fichier commençait par une marque
  d'ordre des octets (certains éditeurs Windows en placent une), l'outil la retire et le dit :
  l'empreinte affichée est alors celle du texte sans ces trois octets.
- Codes de sortie : `0` publié ; `1` rien n'a été publié, la commande est à corriger (option,
  fichier, numéro, rôle de base) ; `2` échec technique (base injoignable…) — vérifier avec
  `GET /api/v1/terms/current` avant de relancer.
- Dans la pile conteneurisée, le dossier monté et ses fichiers doivent être lisibles par
  l'utilisateur de l'image (`node`, uid 1000) : `chmod -R a+rX conditions`.
- Vérifier ensuite : `curl -s https://…/api/v1/terms/current | jq '{number, sha256}'`.

> La commande `pnpm terms:publish` et l'outil dans l'image de migration ont été exécutés hors
> Docker (voir l'avertissement en tête). **La commande `docker compose run --volume …`
> ci-dessus n'a pas encore été exécutée par Docker** : le script
> `infrastructure/ci/publish-terms-cli.sh` la lance et vérifie son résultat, mais le workflow
> ne l'appelle pas encore (voir « Intégration continue »).

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

Avant d'ouvrir l'inscription (et après avoir publié la version 1 des conditions
d'utilisation, voir plus haut) :

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

Les corps sont bornés à 128 Ko, sauf sur **deux** routes, où ils sont transmis à l'API au fil
de l'eau, **sans copie sur le disque du proxy** — une requête sans droit est ainsi refusée
par l'API avant que son contenu n'ait été reçu :

- l'envoi d'une pièce de vérification (6 Mio), avec au plus quatre envois simultanés par
  adresse ;
- la publication des conditions d'utilisation (1 100 Ko ; l'API, elle, s'arrête à 1 Mio).

**Aucune réponse de l'API n'est copiée sur le disque du proxy non plus**
(`proxy_max_temp_file_size 0`) : une réponse plus grande que ses tampons — une pièce
téléchargée par un examinateur, la copie des données d'un compte — est relayée au rythme du
client, depuis la mémoire. Une pièce d'identité ne passe donc en clair par aucun fichier
temporaire, dans un sens comme dans l'autre. Un proxy ou un répartiteur placé devant Nginx
doit admettre des corps de 6 Mio sur la route d'envoi et de 1 100 Ko sur la route de
publication, et ne rien mettre en tampon sur disque — ni les envois, ni les réponses.

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

Le workflow GitHub Actions (`.github/workflows/ci.yml`) s'exécute à chaque demande de fusion
et sur `main`. Les scripts qu'il appelle sont dans `infrastructure/ci/`.

1. **verify** — installation figée, mise en forme, build, lint, types, cohérence
   migrations/schéma, tous les tests sur PostgreSQL 18 et Redis 8 réels, audit des dépendances ;
2. **docker** — validation de la configuration Compose, construction des images, démarrage
   de la pile complète (initialisation de PostgreSQL, migrations, API, Nginx), test de fumée
   à travers Nginx, parcours d'identité complet (administrateur créé en ligne de commande,
   activation de sa validation en deux étapes, ouverture de l'inscription, **publication
   des conditions d'utilisation** — un texte de 185 Ko relu à l'octet près à travers le
   proxy, refus au-delà des limites —, inscription, vérification, connexion, contrôle des
   droits, connexion en deux étapes, back-office, **nouvelle version à accepter** — le
   compte est arrêté, accepte, reprend —,
   **vérification d'identité** : envoi de pièces à travers le proxy — jusqu'à la taille
   maximale, et à quatre de front —, dépôt, examen, téléchargement d'une pièce à l'identique,
   acceptation, **grand livre** : enregistrement d'un actif, portefeuille à zéro, balance,
   **transferts** : ouverture, rien ne part sans plafonds, plafonds fixés puis lus par le
   titulaire, demandes refusées — sans clé d'idempotence, sans le bon mot de passe, au-delà
   du plafond, au-delà du solde — sans que rien ne bouge,
   puis copie des données et clôture du compte), contrôle que le volume
   ne contient que des pièces chiffrées, contrôle qu'aucune réponse de l'API n'a été copiée
   sur le disque du proxy, puis contrôle de cohérence migrations/schéma avec le rôle
   propriétaire et la base fantôme créée par le script d'initialisation.

**Une étape reste à ajouter au workflow.** `infrastructure/ci/publish-terms-cli.sh` publie
une version des conditions d'utilisation avec l'outil en ligne de commande, dans la pile
Compose, comme la section « Conditions d'utilisation » le décrit : dossier des textes monté
en lecture seule dans l'image de migration, numéro inexact refusé, texte relu à l'octet près
à travers Nginx. Ce script a été exécuté hors Docker. Pour que la CI l'exécute, ajouter au
job `docker` de `.github/workflows/ci.yml`, juste après l'étape « Parcours d'identité et de
vérification d'identité à travers Nginx » :

```yaml
- name: Conditions d'utilisation publiées en ligne de commande
  run: infrastructure/ci/publish-terms-cli.sh
```

(avec le même retrait que les étapes voisines : six espaces devant le tiret.)

L'outil qui prépare ce dépôt n'est pas autorisé à modifier les fichiers de
`.github/workflows/` : cet ajout revient au propriétaire du dépôt.

Aucun déploiement automatique n'est configuré : une modification financière critique ne
sera jamais déployée sans validation explicite.

## Reste à faire (phase 9)

TLS, gestion des secrets par environnement, sauvegardes automatiques chiffrées et
restauration testée (base, volume des pièces, clés), stockage objet des pièces, supervision
(OpenTelemetry, Grafana), alertes, journaux centralisés, analyse des images, procédure de
gestion d'incident, déploiement progressif.
