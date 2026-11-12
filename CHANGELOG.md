# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions selon
[SemVer](https://semver.org/lang/fr/).

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
