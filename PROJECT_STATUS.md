# État du projet MG-Exchange

_Dernière mise à jour : 2026-11-11 — phase 2 en cours, lot 1 livré._

## Synthèse

| Phase | Périmètre                               | État                             |
| ----- | --------------------------------------- | -------------------------------- |
| 1     | Analyse et fondations                   | **Livrée** (réserves ci-dessous) |
| 2     | Identité et utilisateurs                | **En cours** — lot 1 sur 3 livré |
| 3     | Infrastructure financière (grand livre) | Non commencée                    |
| 4     | Échange et paiements                    | Non commencée                    |
| 5     | Blockchain                              | Non commencée                    |
| 6     | P2P et séquestre                        | Non commencée                    |
| 7     | Web, mobile, back-office                | Non commencée                    |
| 8     | Risque et conformité                    | Non commencée                    |
| 9     | Tests et déploiement                    | Non commencée                    |

**Aucune opération financière n'existe ni n'est simulée.** Toutes les fonctionnalités
réglementées sont désactivées par défaut — l'inscription comprise — et le resteront jusqu'à
décision explicite d'un administrateur.

**Il n'y a pas encore de site web** : l'application web, les applications mobiles et le
back-office relèvent de la phase 7. Ce qui est visible aujourd'hui est l'API (documentation
interactive `/api/docs`).

**L'inscription ne peut pas être ouverte au public en l'état** : aucun prestataire d'envoi
d'e-mails n'est branché (décision attendue, voir plus bas). Hors développement, l'API refuse
alors l'inscription plutôt que de créer des comptes qui ne recevraient jamais leur code.

## Phase 2 — identité et utilisateurs

### Lot 1 — livré : comptes, authentification, sessions, autorisations

| Sujet                    | Réalisation                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Inscription              | comptes individuels ; e-mail, mot de passe, pays, téléphone facultatif ; conditions acceptées        |
| Vérification de l'e-mail | code à six chiffres, 15 minutes, 5 essais, renvoi limité                                             |
| Connexion                | blocage temporaire après échecs répétés ; aucune divulgation de l'existence d'un compte              |
| Sessions                 | jetons opaques, renouvellement avec détection de vol, expiration par inactivité et absolue           |
| Appareils                | liste de ses sessions, fermeture d'une session ou de toutes les autres, déconnexion                  |
| Mot de passe             | oubli et réinitialisation par code, changement ; Argon2id ; règles de choix                          |
| Autorisations            | authentification exigée par défaut ; rôles et permissions ; refus tracés                             |
| Administration           | lecture et modification des paramètres de la plateforme (maintenance, ouverture des fonctionnalités) |
| Premier administrateur   | outil en ligne de commande, hors de l'API                                                            |
| Notifications            | port d'envoi, modèles en français et en anglais, boîte de réception de développement                 |
| Audit                    | chaque événement de sécurité est inscrit au journal, avec le contexte de la requête                  |

Détail des routes : [`docs/API.md`](docs/API.md). Décisions : ADR 0013 à 0016.

### Reste à faire en phase 2

- **Lot 2** — second facteur (TOTP, codes de secours) ; vérification du téléphone par SMS ;
  profil (informations personnelles, coordonnées, préférences) et historique d'activité ;
  gestion des comptes depuis le back-office (recherche, suspension, attribution des rôles avec
  double validation) ; détection de connexion inhabituelle ; purge des données expirées.
- **Lot 3** — KYC et KYB : dossiers, pièces, niveaux de vérification, validation manuelle,
  historique des décisions ; comptes professionnels.

## Résultats de tests

Exécution du 2026-11-11 — Node.js 24.22.2, pnpm 12.18.0, PostgreSQL 18.6, Redis 8.10.3.

| Vérification                     | Résultat                       |
| -------------------------------- | ------------------------------ |
| `pnpm format:check`              | conforme                       |
| `pnpm lint` (`--max-warnings 0`) | 0 erreur, 0 avertissement      |
| `pnpm build`                     | réussi                         |
| `pnpm typecheck`                 | 0 erreur                       |
| `pnpm db:check-drift`            | aucune différence              |
| `pnpm audit --prod`              | aucune vulnérabilité connue    |
| `pnpm test`                      | **492 tests réussis, 0 échec** |

| Suite                     | Tests | Services réels            |
| ------------------------- | ----- | ------------------------- |
| `@mgx/shared` (montants)  | 103   | —                         |
| `@mgx/validation`         | 54    | —                         |
| `@mgx/contracts`          | 10    | —                         |
| API — unitaires           | 160   | —                         |
| API — intégration         | 56    | PostgreSQL, Redis, BullMQ |
| API — bout en bout (HTTP) | 109   | PostgreSQL, Redis, BullMQ |

Ce que ces tests établissent, notamment :

- **montants** : aucune perte de précision (tests de propriétés sur des valeurs jusqu'à 10⁴⁰),
  arrondis conformes à la table de référence, répartition qui conserve toujours le total,
  refus des nombres flottants ;
- **base de données** : le journal d'audit ne peut être ni modifié, ni supprimé, ni vidé —
  y compris par le propriétaire du schéma ; le rôle applicatif ne peut ni toucher au schéma,
  ni lire ou modifier l'historique des migrations, ni s'attribuer un rôle d'administration ;
- **transactions** : valeur, audit et événement sont écrits ensemble ou pas du tout ;
  12 modifications concurrentes d'une même clé produisent 12 versions et une chaîne d'audit cohérente ;
- **traitements asynchrones** : 6 relais concurrents publient 40 événements exactement une
  fois chacun ; un échec est retenté puis abandonné explicitement ; rien n'est publié si la
  transaction est annulée ;
- **sécurité HTTP** : aucun détail interne dans une erreur 500, secrets absents des journaux,
  documentation fermée en production, limitation de débit non contournable par `X-Forwarded-For` ;
- **reverse proxy** : les erreurs que Nginx produit lui-même respectent le contrat d'erreur de l'API ;
- **accès** : les seules routes accessibles sans authentification sont celles d'une liste
  fermée ; toutes les autres répondent `401` sans jeton ; un utilisateur final n'atteint aucune
  route d'administration ; le retrait d'un rôle est immédiat ;
- **comptes** : inscription, renvoi de code, mot de passe oublié et échec de connexion
  répondent de la même façon que le compte existe ou non ; six inscriptions simultanées avec
  la même adresse créent un seul compte ;
- **codes** : jamais stockés en clair, cinq essais au plus, un seul valable à la fois, refusés
  une fois expirés ou utilisés ;
- **sessions** : aucun jeton en base (empreintes seulement) ; déconnexion, changement de mot
  de passe et suspension coupent l'accès immédiatement ; la réutilisation d'un jeton de
  renouvellement révoque la session ; dix renouvellements simultanés restent cohérents ;
  la session d'un autre compte est introuvable.

**Efficacité des tests vérifiée par mutation.** 52 défauts ont été introduits volontairement,
puis retirés : 20 en phase 1 (calculs monétaires, concurrence, expurgation, privilèges,
configuration du proxy) et 32 dans le code d'identité. Sur les 28 premiers défauts d'identité,
26 ont été détectés d'emblée ; 2 ne l'étaient pas (jeton stocké en clair plutôt que son
empreinte ; règle de mot de passe contournée à la réinitialisation). Les tests concernés ont
été renforcés, 4 défauts supplémentaires ont été ajoutés, et les 32 sont désormais détectés.

## Infrastructure : vérifications hors Docker

L'environnement de développement utilisé ne dispose **ni de Docker, ni d'accès aux dépôts de
paquets système**. Chaque fichier d'infrastructure a donc été exécuté hors Docker, avec le
vrai logiciel, y compris après les ajouts de la phase 2 :

| Élément                             | Vérifié ici                                                                                                                                                                                                                                                             | Reste à confirmer                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `api.Dockerfile`                    | Étapes rejouées une à une dans une arborescence vierge appartenant à `root`, à partir du seul contexte de build. L'artefact obtenu et l'outil d'administration ont été exécutés sous l'utilisateur `node`, sans droit d'écriture.                                       | Construction par Docker (images de base, couches, cache)                                           |
| Script d'initialisation PostgreSQL  | Exécuté tel quel sur une instance PostgreSQL 18.6 vierge (client `psql` 16.2) : rôles, bases, privilèges, connexions par mot de passe.                                                                                                                                  | Exécution par le point d'entrée de l'image officielle                                              |
| `docker-compose.yml`                | Séquence rejouée dans un espace réseau isolé, avec les mêmes noms d'hôtes, ports, commandes, variables et sondes : initialisation, migrations, API, Nginx. Fichier conforme au schéma officiel de la spécification Compose.                                             | Orchestration par Docker Compose (ordre de démarrage, volumes, options de sécurité des conteneurs) |
| `nginx.conf`                        | Exécuté sans modification par Nginx 1.30.6 compilé depuis les sources : relais, sondes, limitation de débit, erreurs au format de l'API, journaux corrélés avec ceux de l'API.                                                                                          | Exécution dans l'image `nginx:1.30-alpine`                                                         |
| Parcours d'identité de la CI        | Le script `infrastructure/ci/smoke-identity.sh` a été exécuté à travers ce Nginx : administrateur créé par l'outil en ligne de commande, ouverture de l'inscription, inscription, code reçu, vérification, connexion, contrôle des droits, renouvellement, déconnexion. | Exécution dans la pile Docker                                                                      |
| Workflow de CI                      | Les commandes du job `verify` et les étapes de test du job `docker` ont été exécutées ici. Les actions sont épinglées sur des empreintes vérifiées.                                                                                                                     | **Toute exécution par GitHub** (voir ci-dessous)                                                   |
| Moteur de migration natif de Prisma | Téléchargement bloqué ici : les migrations ont été créées et appliquées avec la **version WebAssembly officielle du même moteur** (même révision). Son comportement pour le contrôle de cohérence a été établi par lecture de son code source.                          | Exécution par la CI                                                                                |
| Images Docker                       | Les étiquettes `postgres:18-bookworm`, `redis:8-alpine`, `nginx:1.30-alpine` et `node:24-bookworm-slim` existent dans le registre des images officielles.                                                                                                               | —                                                                                                  |
| Node.js 22 et 26                    | Non vérifiés. Seul Node.js 24.22.2 l'a été.                                                                                                                                                                                                                             | —                                                                                                  |

## Intégration continue : à activer

Le workflow est prêt (`infrastructure/ci/ci.yml`) mais **n'a jamais été exécuté** : GitHub
n'exécute que les fichiers du dossier `.github/workflows/`, dans lequel l'outil qui a préparé
ce dépôt n'était pas autorisé à écrire. Il faut le déplacer, une fois :

```bash
git mv infrastructure/ci/ci.yml .github/workflows/ci.yml
git commit -m "ci: activer l'intégration continue" && git push
```

Sa première exécution construira les images, démarrera la pile Compose et la testera à
travers Nginx, avec le moteur de migration natif de Prisma : elle lèvera les réserves
ci-dessus ou révélera des défauts.

## Problèmes identifiés

### Pendant le lot 1 de la phase 2

1. **Des inscriptions simultanées avec la même adresse pouvaient produire une erreur 500.**
   Deux demandes de code concurrentes pour un même compte se heurtaient à l'unicité du code
   en cours. Elles sont désormais traitées l'une après l'autre ; un test en lance six de front.
2. **Deux renouvellements simultanés d'un même jeton pouvaient échapper à la détection de
   réutilisation.** La seconde requête lisait l'état du jeton tel qu'il était avant d'attendre
   le verrou de la session, donc avant que la première ne le consomme ; et la comparaison des
   dates excusait deux requêtes traitées au même instant. L'état est désormais relu une fois
   le verrou obtenu. Trouvé à la relecture, reproduit par un test (cinq renouvellements de
   front, tolérance nulle) qui échoue systématiquement sur l'ancienne version.
3. **Une adresse de client invalide ou un agent utilisateur trop long faisaient échouer la
   connexion** (erreur 500 à l'enregistrement de la session) lorsque l'API fait confiance à un
   proxy qui ne nettoie pas `X-Forwarded-For`. Ces valeurs sont désormais validées et bornées.
4. **Deux défauts volontaires n'étaient pas détectés par les tests** (voir « mutation »
   ci-dessus). Les vérifications portaient sur la forme de ce qui est stocké, pas sur sa
   valeur ; elles comparent maintenant l'empreinte attendue à l'empreinte enregistrée.

### En préparant la demande de fusion de la phase 1

Tous corrigés. Ils ont été trouvés en exécutant réellement chaque fichier d'infrastructure,
ce que les validations statiques faites jusque-là ne permettaient pas de voir.

1. **`pnpm db:check-drift` ne fonctionnait que dans l'environnement de développement.** Le
   moteur natif de Prisma exige une base fantôme explicite pour comparer les migrations au
   schéma : la commande aurait échoué en CI et sur tout poste de développement. La
   configuration lit désormais `SHADOW_DATABASE_URL` ; la base est créée par Docker Compose.
2. **Les migrations pouvaient démarrer avant la fin de l'initialisation de PostgreSQL** : la
   sonde du service le déclarait prêt pendant que son script d'initialisation s'exécutait encore.
3. **La sonde de Redis réussissait même sans authentification.**
4. **La création des bases aurait échoué sur un serveur PostgreSQL non initialisé en UTF-8**
   (l'image officielle l'est, mais rien ne le garantissait).
5. **Le rôle applicatif pouvait lire et modifier l'historique des migrations**, donc faire
   rejouer ou ignorer une migration au déploiement suivant. Il n'y a plus aucun accès.
6. **Les erreurs produites par Nginx étaient des pages HTML** (limitation de débit, corps trop
   volumineux, route inconnue, API arrêtée), alors que l'API promet un format unique. Elles
   suivent désormais le contrat d'erreur, ce qu'un test vérifie.

## Limites connues

Identité :

- **Aucun prestataire d'envoi** : en pré-production et en production, inscription et
  réinitialisation du mot de passe répondent `503`. Seuls des administrateurs créés en ligne
  de commande peuvent se connecter.
- **Pas de second facteur, pas de vérification du téléphone** (lot 2). Le numéro déclaré à
  l'inscription est enregistré mais ne sert à rien d'autre.
- **Un seul rôle d'administration** (`super_admin`), attribué uniquement en ligne de commande ;
  aucune route ne permet encore de suspendre un compte ni de gérer les rôles (lot 2). La
  modification des paramètres de la plateforme n'est pas encore soumise à une double validation.
- **L'identifiant de connexion est l'adresse e-mail**, pas le numéro de téléphone.
- **Conditions d'utilisation** : seule la date d'acceptation est enregistrée, pas la version du texte.
- **Mots de passe** : la liste des mots de passe courants refusés est courte ; pas encore de
  vérification contre les fuites connues.
- **Blocage par un tiers** : en multipliant les échecs, un tiers peut bloquer temporairement
  la connexion à un compte ; la réinitialisation du mot de passe lève le blocage.
- **Purges non implémentées** : inscriptions jamais vérifiées, sessions et codes expirés.
- **Chaque requête authentifiée lit la session en base** : simple et immédiat ; un cache
  s'ajoutera si la charge le demande.

Socle :

- **Observabilité** : journaux structurés et identifiants de corrélation uniquement.
  OpenTelemetry, métriques et tableaux de bord Grafana ne sont pas commencés.
- **Sauvegardes, restauration, alertes** : non commencées (phase 9).
- **WebSockets** : non commencés (aucun cas d'usage avant les notifications en temps réel).
- **Transactions** : pas encore de nouvelle tentative automatique sur conflit de
  sérialisation — à traiter avec le grand livre (phase 3), piloté par des tests de concurrence.
- **Boîte d'envoi** : remise « au moins une fois » (les consommateurs doivent être
  idempotents) ; nouvelle tentative par événement et non par consommateur ; pas encore
  d'outil pour rejouer un événement abandonné ni de purge des événements publiés.
- **Limitation de débit** : fenêtre fixe, par adresse IP, complétée par des limites par compte
  sur la connexion et les codes.
- **Développement** : après modification d'un paquet `packages/*`, il faut le recompiler
  pour que l'API en mode rechargement le prenne en compte.
- **Versions** : TypeScript 6 et Prisma 7 plutôt que les toutes dernières (TypeScript 7,
  Prisma 8 en version candidate), pour rester dans les plages prises en charge par l'écosystème.
- **Nginx** : écoute en HTTP ; la terminaison TLS reste à configurer (phase 9). Les erreurs
  de protocole qu'il détecte avant tout traitement (requête mal formée, en-têtes trop
  volumineux) gardent sa page par défaut, hors du format d'erreur de l'API.

## Décisions attendues

1. **Prestataire d'envoi d'e-mails (puis de SMS) pour la RDC** — c'est désormais la seule
   chose qui empêche d'ouvrir l'inscription hors développement. L'intégration se fera derrière
   l'interface existante.
2. **Identifiant de connexion** : l'adresse e-mail suffit-elle, ou le numéro de téléphone
   doit-il aussi permettre de se connecter (usage courant sur le marché visé) ? À trancher
   avant le lot 2.
3. **Niveaux de vérification KYC et plafonds associés** ; vérification manuelle seule ou
   prestataire de vérification d'identité — nécessaire pour le lot 3.
4. **Conditions d'utilisation** : texte et gestion des versions.
5. **Hébergement cible** (fournisseur, région) et exigences de localisation des données.
6. **Statut réglementaire visé en RDC** et calendrier des autorisations : il conditionne
   l'ordre d'ouverture des fonctionnalités.
