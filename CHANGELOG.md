# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions selon
[SemVer](https://semver.org/lang/fr/).

## [Non publié] — Intégration continue activée

### Modifié

- Le workflow de CI a quitté `infrastructure/ci/ci.yml` pour `.github/workflows/ci.yml` : il
  s'exécute désormais sur chaque demande de fusion et sur `main`. Sa première exécution
  (2026-11-13) est passée au vert sans correction — premières exécutions réelles de la
  construction des images, de la pile Docker Compose, du parcours à travers le conteneur
  Nginx et du moteur de migration natif de Prisma. Les scripts qu'il appelle restent dans
  `infrastructure/ci/`.

## [Non publié] — Phase 2, lot 4 : clôture de compte, conservation légale, effacement, copie des données

### Ajouté

- **Clôture par le titulaire** : `POST /me/close`. Immédiate et définitive ; elle exige de
  nouveau le mot de passe et, s'il est activé, le second facteur, plus `confirm: true`.
  Sessions, mot de passe, second facteur, codes et profil sont supprimés dans la même
  transaction ; l'adresse, le numéro et la pièce d'identité sont libres aussitôt.
- **Clôture par le personnel** : `POST /admin/users/{userId}/close`, permission nouvelle
  `users.close` (rôles `super_admin` et `compliance`) ; motif (`HOLDER_REQUEST` ou
  `PLATFORM_DECISION`), justification et `confirm: true` obligatoires ; titulaire toujours
  prévenu, jamais de la raison.
- **Copie des données** : `POST /me/data-export` remet, en un document JSON versionné, ce que
  la plateforme détient sur le compte — sans secret, sans fichier, numéro de pièce masqué.
  Même preuve que la clôture ; trois copies au plus par vingt-quatre heures ; chaque copie est
  inscrite à l'historique et signalée par e-mail.
- **Conservation légale** : les dossiers de vérification sur lesquels une décision a été prise
  sont conservés dix ans après la clôture ; un dossier jamais examiné est effacé à la clôture,
  avec ses fichiers.
- **Effacement à l'échéance** : la purge horaire efface les dossiers conservés et leurs
  fichiers, puis l'adresse et le numéro que gardait la trace de la clôture — trente jours
  après la clôture, ou au terme des dix ans. Elle supprime aussi désormais les événements
  publiés de la boîte d'envoi après trente jours.
- **Règles portées par la base** (erreurs `MGX04` et `MGX05`) : un compte ne se clôt qu'avec
  sa trace et vidé de ses secrets ; rien ne s'écrit plus sur un compte clôturé, y compris par
  une requête partie avant la clôture ; une clôture par le personnel vient d'un compte actif
  détenant `users.close` ; rien de ce que la loi impose de conserver ne s'efface avant le
  terme, lu à l'horloge de la base.
- Back-office : la fiche d'un compte clôturé porte `closure` ; une recherche par adresse ou
  par numéro retrouve aussi les comptes clôturés qui les portaient, jusqu'à leur effacement.
- E-mails : avis de clôture (envoyé à l'ancienne adresse) et avis de copie des données.
- CI : le parcours à travers Nginx (`infrastructure/ci/smoke-identity.sh`) va jusqu'à la
  copie des données et à la clôture — connexion refusée ensuite, avis reçu à l'ancienne
  adresse, dossier conservé, compte retrouvé par le back-office ; une étape vérifie que le
  proxy n'a copié aucune réponse sur son disque.
- ADR 0023. Migrations `20261112182333_kyc_case_account_closed_status` et
  `20261112182356_account_closure`. Aucune dépendance nouvelle.

### Modifié — à prendre en compte par un client du lot 3

- Un compte clôturé **n'existe plus pour la connexion** : son ancienne adresse reçoit
  `401 INVALID_CREDENTIALS`, comme une adresse inconnue. `403 ACCOUNT_DISABLED` ne désigne
  plus qu'un compte suspendu.
- Toute requête qui écrit sur un compte clôturé entre-temps répond `409 CONFLICT`
  (« This account is closed. »).
- L'inscription refuse le domaine réservé `closed.invalid` (`400 VALIDATION_FAILED`).
- Historique : trois types nouveaux — `DATA_EXPORTED`, `DATA_EXPORT_FAILED`,
  `ACCOUNT_CLOSURE_FAILED`.
- Dossiers de vérification : statut nouveau `ACCOUNT_CLOSED` (accepté jusqu'à la clôture du
  compte), visible du back-office (`GET /admin/kyc/cases?status=ACCOUNT_CLOSED`).
- `GET /admin/roles` : le catalogue compte douze permissions ; `compliance` détient
  `users.close`.
- La fiche d'un compte au back-office porte `closure` (`null` tant qu'il est ouvert) ; les
  actions du back-office sur un compte clôturé répondent `409 CONFLICT`.

### Corrigé

- **Reverse proxy : une pièce téléchargée par un examinateur passait, en clair, par un
  fichier temporaire de Nginx** (défaut du lot 3). Une réponse plus grande que les tampons du
  proxy était copiée sur son disque le temps d'être relayée, puis supprimée. Plus aucune
  réponse de l'API n'y est écrite (`proxy_max_temp_file_size 0`) ; un test lit la
  configuration, et le parcours de la pile complète échoue si Nginx signale un tel fichier.
- **Requêtes simultanées à la clôture** — trois défauts de ce lot, trouvés en envoyant des
  requêtes concurrentes à l'API après sa première publication sur la branche :
  - un changement de mot de passe qui croisait la clôture répondait `500` ; il répond `409`,
    comme toute écriture arrivée après la clôture (de même une connexion, à l'instant où
    l'empreinte de son mot de passe est recalculée) ;
  - une demande de réinitialisation du mot de passe qui croisait la clôture répondait `409`
    « compte clôturé » au lieu de sa réponse unique `202` : pendant un instant, elle disait
    qu'un compte portait cette adresse ;
  - la clôture pouvait s'interbloquer avec une autre écriture du même compte ; PostgreSQL
    interrompait alors l'une des deux requêtes (`500`). La clôture cède maintenant le passage
    et recommence ; si le compte reste occupé, elle répond `409` et rien n'a changé.

### Corrigé — outillage de test

- Les tests d'intégration et de bout en bout s'exécutaient avec le délai par défaut de Jest
  (5 secondes) et non celui prévu (30) : le réglage par projet n'était pas pris en compte.
- Un test de bout en bout pouvait démarrer une seconde application avant d'avoir arrêté la
  première : les deux se disputaient les files Redis, d'où un échec intermittent d'un test
  d'envoi d'e-mail. Le support de test le refuse désormais.
- Quatre tests des lots 1 et 2 attendaient que les événements soient remis à la file, non
  qu'ils soient traités : l'un échouait par intermittence sous charge, et trois autres
  pouvaient conclure « aucun message n'est parti » avant que le traitement soit terminé. Ils
  attendent désormais la fin du traitement.

## [Non publié] — Phase 2, lot 3 : vérification d'identité (KYC) des particuliers

### Ajouté

- **Vérification d'identité en trois niveaux**, obtenus dans l'ordre : identité (pièce et
  autoportrait), adresse (justificatif de domicile), origine des fonds. Pour chaque niveau, le
  titulaire prépare un dossier, y joint ses pièces et le dépose : `GET /me/verification`,
  `PUT /me/verification/{identity,address,source-of-funds}`, `…/cases/{id}`,
  `…/cases/{id}/documents`, `…/cases/{id}/submit`. Fonctionnalité `kyc`, fermée par défaut.
- **Envoi des pièces** : le fichier est le corps de la requête (JPEG, PNG ou PDF, de 1 Ko à
  5 Mio), contrôlé sur son contenu. Réception bornée en taille, en durée et en nombre, après
  tous les contrôles qui peuvent refuser l'envoi.
- **Pièces chiffrées au repos** (AES-256-GCM, une clé par fichier, clé maîtresse
  `KYC_ENCRYPTION_KEY`), écrites hors de la base dans `KYC_STORAGE_DIR` ; numéro de la pièce
  d'identité chiffré en base, rendu masqué au titulaire. Sans ces deux variables, la
  vérification répond `503`.
- **Examen par la conformité** : file des dossiers déposés, fiche, téléchargement d'une pièce,
  acceptation, refus motivé, retrait d'une vérification (`/admin/kyc/cases/…`). Permissions
  `kyc.read`, `kyc.review`, `kyc.revoke` ; rôle système `compliance`. Chaque consultation est
  journalisée ; nul n'examine son propre dossier. La fiche signale un même fichier ou une même
  pièce d'identité présentés par d'autres comptes.
- **Règles portées par la base** (erreur `MGX03`) : un dossier déposé ne se modifie plus ; une
  décision ne vient que d'un compte actif habilité, jamais du titulaire ; les niveaux se
  suivent ; une même pièce d'identité ne vérifie qu'un seul compte.
- Le titulaire est prévenu par e-mail de chaque décision, et la retrouve dans son historique
  (`IDENTITY_VERIFICATION_SUBMITTED`, `…_APPROVED`, `…_REJECTED`, `…_REVOKED`).
- Purge horaire des dossiers restés en préparation trente jours, avec leurs pièces.
- Nginx : route d'envoi dédiée (6 Mio, transmission au fil de l'eau sans copie sur disque,
  quatre envois simultanés par adresse). Compose et image : volume `kyc-documents`.
- ADR 0022. Migration `20261112102342_kyc`. Aucune dépendance nouvelle.

### Modifié — à prendre en compte par un client du lot 2

- `GET /me` porte `verificationLevel` (0 à 3).
- Le profil porte `placeOfBirth`, `nationality`, `identityVerified`, `addressVerified`. Une
  fois l'identité ou l'adresse vérifiées, les champs correspondants sont ceux du dossier
  accepté, et **`PATCH /me/profile` répond `409 CONFLICT`** si l'on tente de les modifier.
- La fiche d'un compte au back-office porte `verification` ; son profil est le profil vérifié
  lorsqu'il existe.
- Historique : les actions d'un membre du personnel sur le compte d'un client figurent dans
  l'historique de ce client, **plus dans celui du membre du personnel**.
- `GET /admin/roles` liste un troisième rôle système, `compliance` ; le catalogue compte onze
  permissions.
- Les journaux expurgent aussi les clés nommées `encryptionKey`, `masterKey` et
  `documentNumber`.

## [Non publié] — Phase 2 : envoi réel des e-mails

### Ajouté

- **Envoi des e-mails par SMTP** : le prestataire se choisit au déploiement (`SMTP_HOST`,
  `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, et au besoin `SMTP_SECURITY`, `SMTP_PORT`).
  Définir `SMTP_HOST` active l'envoi ; `NOTIFICATION_DELIVERY` accepte désormais `smtp`.
- Connexion chiffrée et certificat vérifié, obligatoires en pré-production et en production ;
  vérification du serveur et des identifiants au démarrage, sans bloquer celui-ci.
- Une boîte inexistante (refus définitif du destinataire) n'est pas relancée.
- ADR 0021. Dépendance : `nodemailer`.

### Modifié

- Avec un serveur SMTP configuré, l'inscription, le renvoi du code et le mot de passe oublié
  ne répondent plus `503` en pré-production et en production ; la boîte de réception de
  développement n'existe plus dès que les e-mails partent réellement.
- Les SMS restent indisponibles : la vérification du numéro de téléphone répond toujours
  `503` hors développement.

## [Non publié] — Phase 2, lot 2 : sécurité du compte, profil, back-office des comptes

### Ajouté

- **Validation en deux étapes** (TOTP, RFC 6238) : activation, confirmation, désactivation ;
  dix codes de secours à usage unique ; secret chiffré au repos (AES-256-GCM) ; un code n'est
  accepté qu'une fois. La connexion se fait alors en deux temps (`POST /auth/mfa/verify`) ;
  aucune session n'existe entre les deux.
- **Essais bornés par compte** sur la seconde étape (5 en 15 minutes, 20 en 24 heures), et
  message au titulaire en cas de blocage.
- **Profil** (`/me/profile`) : identité déclarée, adresse, langue ; les champs laissés vides
  le restent, rien n'est vérifié à ce stade.
- **Vérification du numéro de téléphone** par code SMS (`/me/phone/verification`,
  `/me/phone/verify`) ; un numéro vérifié n'appartient qu'à un compte.
- **Historique d'activité** (`/me/activity`) : événements de sécurité du compte, interventions
  du support comprises.
- **Connexion depuis un appareil inconnu** signalée au titulaire par e-mail (`deviceId`
  facultatif à la connexion).
- **Back-office des comptes** : liste, recherche par identifiant complet
  (`POST /admin/users/search`), fiche, suspension et réactivation, fermeture des sessions,
  retrait du second facteur. Chaque action porte une justification ; chaque accès est inscrit
  au journal d'audit.
- **Rôles sous double validation** (`/admin/role-changes`) : demande, puis approbation par un
  second administrateur. La règle est appliquée par un déclencheur PostgreSQL ; le rôle
  applicatif de la base n'écrit toujours pas lui-même dans la table des rôles attribués.
  Rôle système `support`.
- **Purge horaire** des données expirées (inscriptions jamais vérifiées, sessions closes,
  codes échus, activations de second facteur abandonnées, demandes de rôle échues).
- Migrations `account_security` et `back_office_accounts`.
- Permissions : `users.read`, `users.suspend`, `users.revoke_sessions`, `users.reset_mfa`,
  `roles.read`, `roles.manage`. Code d'erreur : `MFA_ENROLLMENT_REQUIRED`.
- Variable **obligatoire** `AUTH_SECRETS_ENCRYPTION_KEY` (32 octets en base64) — à
  sauvegarder hors de la base : la perdre rend tous les seconds facteurs invérifiables.
- Tests : 762 au total, dont 292 sur PostgreSQL, Redis et BullMQ réels.
- ADR 0017 à 0020.

### Modifié — ruptures pour un client du lot 1

- `POST /auth/login` répond par un objet à `status` : `AUTHENTICATED` (avec les jetons) ou
  `MFA_REQUIRED` (avec un jeton de connexion en attente).
- `POST /auth/email/verify` exige le mot de passe choisi à l'inscription, en plus du code.
- Une nouvelle inscription sur une adresse jamais vérifiée **remplace** la précédente.
- Le mot de passe oublié ne s'applique qu'à un compte actif : une inscription jamais vérifiée
  ne se réinitialise pas.
- **Toute route `/admin` exige la validation en deux étapes** (`403 MFA_ENROLLMENT_REQUIRED`
  sinon), y compris pour un administrateur créé en ligne de commande.

### Corrigé

- Un tiers pouvait créer un compte à l'adresse d'une personne, avec son propre mot de passe,
  et attendre qu'elle l'active elle-même (défaut du lot 1, trouvé à la relecture) : voir les
  ruptures ci-dessus sur la vérification de l'adresse, la réinscription et le mot de passe oublié.

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
