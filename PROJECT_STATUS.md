# État du projet MG-Exchange

_Dernière mise à jour : 2026-11-11 — fin de la phase 1, demande de fusion ouverte._

## Synthèse

| Phase | Périmètre                               | État                             |
| ----- | --------------------------------------- | -------------------------------- |
| 1     | Analyse et fondations                   | **Livrée** (réserves ci-dessous) |
| 2     | Identité et utilisateurs                | Non commencée                    |
| 3     | Infrastructure financière (grand livre) | Non commencée                    |
| 4     | Échange et paiements                    | Non commencée                    |
| 5     | Blockchain                              | Non commencée                    |
| 6     | P2P et séquestre                        | Non commencée                    |
| 7     | Web, mobile, back-office                | Non commencée                    |
| 8     | Risque et conformité                    | Non commencée                    |
| 9     | Tests et déploiement                    | Non commencée                    |

**Aucune opération financière n'existe ni n'est simulée.** Toutes les fonctionnalités
réglementées sont désactivées par défaut et le resteront jusqu'à décision explicite.

**Il n'y a pas encore de site web** : l'application web, les applications mobiles et le
back-office relèvent de la phase 7. Ce qui est visible aujourd'hui est l'API (documentation
interactive `/api/docs`, état de la plateforme, sondes de santé).

## Phase 1 — ce qui est réellement livré

| #   | Mission                   | Réalisation                                                                                 |
| --- | ------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Examiner l'environnement  | Fait — constats et contraintes ci-dessous                                                   |
| 2   | Structure du projet       | Monorepo `apps/` + `packages/` + `infrastructure/` + `docs/`                                |
| 3   | Décisions d'architecture  | 12 ADR dans `docs/adr/`                                                                     |
| 4   | Monorepo                  | pnpm 12, catalogue de versions épinglées, politique de chaîne d'approvisionnement           |
| 5   | NestJS                    | NestJS 12 (ESM), monolithe modulaire, Express 5                                             |
| 6   | TypeScript strict         | TS 6, options strictes renforcées, ESLint avec analyse de types — 0 erreur, 0 avertissement |
| 7   | PostgreSQL + Prisma       | Prisma 7, migration initiale, contraintes, déclencheurs, séparation des rôles               |
| 8   | Redis                     | Limitation de débit atomique, files BullMQ, sonde de disponibilité                          |
| 9   | Docker Compose            | Rédigé ; séquence rejouée hors Docker — **jamais exécuté par Docker** (voir réserves)       |
| 10  | Environnements            | `local`, `development`, `staging`, `production`, `test` — règles vérifiées au démarrage     |
| 11  | Tests                     | 275 tests, dont 55 sur PostgreSQL, Redis et BullMQ réels                                    |
| 12  | Premiers modules          | Santé, paramètres système, audit, boîte d'envoi                                             |
| 13  | Journalisation et erreurs | Pino structuré avec expurgation ; erreurs RFC 9457 centralisées                             |
| 14  | Documentation             | README, ARCHITECTURE, DATABASE, API, SECURITY, DEPLOYMENT, CHANGELOG, OpenAPI               |
| 15  | PROJECT_STATUS            | Ce document                                                                                 |

### Points d'accès de l'API

| Méthode | Chemin                        | Rôle                                                 |
| ------- | ----------------------------- | ---------------------------------------------------- |
| GET     | `/api/v1/system/status`       | version, heure serveur, maintenance, fonctionnalités |
| GET     | `/health/live`                | sonde de vivacité                                    |
| GET     | `/health/ready`               | sonde de disponibilité (PostgreSQL, Redis)           |
| GET     | `/api/docs`, `/api/docs-json` | documentation OpenAPI (selon l'environnement)        |

Aucun point d'accès d'écriture n'est exposé : il n'existe pas encore d'authentification.
La modification des paramètres système est implémentée et testée au niveau du service ;
son point d'accès d'administration arrivera avec les rôles et permissions (phase 2).

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
| `pnpm test`                      | **275 tests réussis, 0 échec** |

| Suite                     | Tests | Services réels            |
| ------------------------- | ----- | ------------------------- |
| `@mgx/shared` (montants)  | 103   | —                         |
| `@mgx/validation`         | 29    | —                         |
| `@mgx/contracts`          | 6     | —                         |
| API — unitaires           | 82    | —                         |
| API — intégration         | 30    | PostgreSQL, Redis, BullMQ |
| API — bout en bout (HTTP) | 25    | PostgreSQL, Redis, BullMQ |

Ce que ces tests établissent, notamment :

- **montants** : aucune perte de précision (tests de propriétés sur des valeurs jusqu'à 10⁴⁰),
  arrondis conformes à la table de référence, répartition qui conserve toujours le total,
  refus des nombres flottants ;
- **base de données** : le journal d'audit ne peut être ni modifié, ni supprimé, ni vidé —
  y compris par le propriétaire du schéma ; le rôle applicatif ne peut ni toucher au schéma,
  ni lire ou modifier l'historique des migrations ;
- **transactions** : valeur, audit et événement sont écrits ensemble ou pas du tout ;
  12 modifications concurrentes d'une même clé produisent 12 versions et une chaîne d'audit cohérente ;
- **traitements asynchrones** : 6 relais concurrents publient 40 événements exactement une
  fois chacun ; un échec est retenté puis abandonné explicitement ; rien n'est publié si la
  transaction est annulée ;
- **sécurité HTTP** : aucun détail interne dans une erreur 500, secrets absents des journaux,
  documentation fermée en production, limitation de débit non contournable par `X-Forwarded-For` ;
- **reverse proxy** : les erreurs que Nginx produit lui-même respectent le contrat d'erreur de l'API.

**Efficacité des tests vérifiée par mutation** : 20 défauts introduits volontairement
(8 dans les calculs monétaires, 4 dans la concurrence et l'expurgation, 1 dans les privilèges
de la base, 7 dans la configuration du proxy) ont tous été détectés.

L'artefact de production (`pnpm deploy --prod` : code compilé et dépendances de production
seules) a été démarré avec `NODE_ENV=production` et a répondu correctement.

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
ci-dessous ou révélera des défauts.

## Réserves — ce qui n'a pas pu être vérifié

L'environnement de développement utilisé ne dispose **ni de Docker, ni d'accès aux dépôts de
paquets système**. Faute de Docker, chaque fichier d'infrastructure a été exécuté **hors
Docker, avec le vrai logiciel** ; ce qui reste à confirmer est indiqué dans la dernière colonne.

| Élément                             | Vérifié ici                                                                                                                                                                                                                                                                                                               | Reste à confirmer                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `api.Dockerfile`                    | Étapes rejouées une à une dans une arborescence vierge appartenant à `root`, à partir du seul contexte de build : installation depuis les manifestes, compilation, `pnpm deploy`. L'artefact obtenu a été exécuté sous l'utilisateur `node`, sans droit d'écriture, et la commande de migration sous ce même utilisateur. | Construction par Docker (images de base, couches, cache)                                           |
| Script d'initialisation PostgreSQL  | Exécuté tel quel sur une instance PostgreSQL 18.6 vierge (client `psql` 16.2) : rôles, bases, privilèges, connexions par mot de passe.                                                                                                                                                                                    | Exécution par le point d'entrée de l'image officielle                                              |
| `docker-compose.yml`                | Séquence rejouée dans un espace réseau isolé, avec les mêmes noms d'hôtes, ports, commandes, variables et sondes : initialisation, migrations, API, Nginx. Fichier conforme au schéma officiel de la spécification Compose.                                                                                               | Orchestration par Docker Compose (ordre de démarrage, volumes, options de sécurité des conteneurs) |
| `nginx.conf`                        | Exécuté sans modification par Nginx 1.30.6 compilé depuis les sources : relais, sondes, limitation de débit, erreurs au format de l'API, journaux corrélés avec ceux de l'API.                                                                                                                                            | Exécution dans l'image `nginx:1.30-alpine`                                                         |
| Workflow de CI                      | Les commandes du job `verify` et le test de fumée du job `docker` ont été exécutés ici. Les actions sont épinglées sur des empreintes vérifiées.                                                                                                                                                                          | **Toute exécution par GitHub** (voir ci-dessus)                                                    |
| Moteur de migration natif de Prisma | Téléchargement bloqué ici : les migrations ont été créées et appliquées avec la **version WebAssembly officielle du même moteur** (même révision). Son comportement pour le contrôle de cohérence a été établi par lecture de son code source.                                                                            | Exécution par la CI                                                                                |
| Images Docker                       | Les étiquettes `postgres:18-bookworm`, `redis:8-alpine`, `nginx:1.30-alpine` et `node:24-bookworm-slim` existent dans le registre des images officielles.                                                                                                                                                                 | —                                                                                                  |
| Node.js 22 et 26                    | Non vérifiés. Seul Node.js 24.22.2 l'a été.                                                                                                                                                                                                                                                                               | —                                                                                                  |

## Problèmes identifiés en préparant la demande de fusion

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

- **Aucune authentification** : aucune route d'écriture, aucune notion d'utilisateur (phase 2).
- **Observabilité** : journaux structurés et identifiants de corrélation uniquement.
  OpenTelemetry, métriques et tableaux de bord Grafana ne sont pas commencés.
- **Sauvegardes, restauration, alertes** : non commencées (phase 9).
- **WebSockets** : non commencés (aucun cas d'usage avant les notifications).
- **Transactions** : pas encore de nouvelle tentative automatique sur conflit de
  sérialisation — à traiter avec le grand livre (phase 3), piloté par des tests de concurrence.
- **Boîte d'envoi** : remise « au moins une fois » (les consommateurs doivent être
  idempotents) ; nouvelle tentative par événement et non par consommateur ; pas encore
  d'outil pour rejouer un événement abandonné ni de purge des événements publiés.
- **Limitation de débit** : fenêtre fixe, par adresse IP ; les limites par compte et par
  action sensible viendront avec l'authentification.
- **Développement** : après modification d'un paquet `packages/*`, il faut le recompiler
  pour que l'API en mode rechargement le prenne en compte.
- **Versions** : TypeScript 6 et Prisma 7 plutôt que les toutes dernières (TypeScript 7,
  Prisma 8 en version candidate), pour rester dans les plages prises en charge par l'écosystème.
- **Nginx** : écoute en HTTP ; la terminaison TLS reste à configurer (phase 9). Les erreurs
  de protocole qu'il détecte avant tout traitement (requête mal formée, en-têtes trop
  volumineux) gardent sa page par défaut, hors du format d'erreur de l'API.

## Suite : phase 2 — identité et utilisateurs

Authentification (Argon2id, JWT, jetons de rafraîchissement), sessions et appareils,
vérification e-mail et téléphone, MFA, rôles et permissions, KYC/KYB, point d'accès
d'administration des paramètres système avec double validation.

Décisions métier à prendre avant ou pendant la phase 2 (elles ne bloquent pas son démarrage) :

1. Fournisseurs d'envoi d'e-mails et de SMS pour la RDC (les intégrations seront isolées
   derrière des interfaces ; un mode bac à sable sera fourni).
2. Niveaux de vérification KYC et plafonds associés ; vérification manuelle seule ou
   prestataire de vérification d'identité.
3. Hébergement cible (fournisseur, région) et exigences de localisation des données.
4. Statut réglementaire visé en RDC et calendrier des autorisations : il conditionne l'ordre
   d'ouverture des fonctionnalités.
