# État du projet MG-Exchange

_Dernière mise à jour : 2026-11-12 — phase 2 en cours, lots 1 et 2 livrés._

## Synthèse

| Phase | Périmètre                               | État                             |
| ----- | --------------------------------------- | -------------------------------- |
| 1     | Analyse et fondations                   | **Livrée** (réserves ci-dessous) |
| 2     | Identité et utilisateurs                | **En cours** — lots 1 et 2 sur 3 |
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

**Envoi des messages.** Les e-mails partent par le serveur SMTP du prestataire de votre choix
— à configurer au déploiement : sans lui, hors développement, l'API refuse l'inscription et
la réinitialisation du mot de passe plutôt que de promettre un code qui n'arriverait jamais,
et les messages de sécurité ne partent pas. Cet envoi a été vérifié contre un serveur SMTP
réel exécuté par les tests, **jamais contre le service d'un prestataire**. Aucun SMS ne
part : la vérification du numéro de téléphone reste indisponible hors développement.

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

### Lot 2 — livré : sécurité du compte, profil, back-office des comptes

| Sujet                     | Réalisation                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation en deux étapes | application d'authentification (TOTP) et dix codes de secours ; connexion en deux temps ; essais bornés par compte ; secret chiffré           |
| Back-office protégé       | toute route d'administration exige la validation en deux étapes, quelles que soient les permissions                                           |
| Profil                    | nom, date de naissance, adresse, langue, fuseau horaire — **déclarés**, non vérifiés (la vérification d'identité est l'objet du lot 3)        |
| Téléphone                 | vérification du numéro par code SMS ; un numéro vérifié n'appartient qu'à un compte                                                           |
| Historique                | le titulaire voit les événements de sécurité de son compte, interventions du support comprises                                                |
| Connexion inhabituelle    | une connexion depuis un appareil inconnu du compte est signalée par e-mail                                                                    |
| Back-office : comptes     | liste, recherche par identifiant complet, fiche, suspension et réactivation, fermeture des sessions, retrait du second facteur                |
| Traçabilité               | chaque action du back-office porte une justification ; chaque recherche, page et consultation est inscrite au journal d'audit                 |
| Back-office : rôles       | demande, puis approbation par un **second** administrateur ; la règle est appliquée par la base de données elle-même ; nouveau rôle `support` |
| Purge                     | toutes les heures : inscriptions jamais vérifiées (7 j), sessions closes (90 j), codes échus (7 j), activations abandonnées, demandes échues  |

Détail : [`docs/API.md`](docs/API.md), [`docs/SECURITY.md`](docs/SECURITY.md). Décisions : ADR 0017 à 0020.

**Ce qui change pour un client écrit contre le lot 1** (aucune version n'a été mise en
service entre les deux lots) : la connexion répond par un `status` (`AUTHENTICATED` ou
`MFA_REQUIRED`) ; la vérification de l'adresse exige aussi le mot de passe ; un administrateur
doit activer la validation en deux étapes avant toute action. Liste complète :
[`CHANGELOG.md`](CHANGELOG.md).

### Reste à faire en phase 2

- **Lot 3** — KYC et KYB : dossiers, pièces, niveaux de vérification, validation manuelle,
  historique des décisions ; comptes professionnels. Il dépend de décisions attendues
  (niveaux, plafonds, vérification manuelle ou prestataire).

## Résultats de tests

Exécution du 2026-11-12 — Node.js 24.22.2, pnpm 12.18.0, PostgreSQL 18.6, Redis 8.10.3.

| Vérification                     | Résultat                       |
| -------------------------------- | ------------------------------ |
| `pnpm format:check`              | conforme                       |
| `pnpm lint` (`--max-warnings 0`) | 0 erreur, 0 avertissement      |
| `pnpm build`                     | réussi                         |
| `pnpm typecheck`                 | 0 erreur                       |
| `pnpm db:check-drift`            | aucune différence              |
| `pnpm audit --prod`              | aucune vulnérabilité connue    |
| `pnpm test`                      | **805 tests réussis, 0 échec** |

| Suite                     | Tests | Services réels                                  |
| ------------------------- | ----- | ----------------------------------------------- |
| `@mgx/shared` (montants)  | 103   | —                                               |
| `@mgx/validation`         | 93    | —                                               |
| `@mgx/contracts`          | 21    | —                                               |
| API — unitaires           | 271   | —                                               |
| API — intégration         | 126   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |
| API — bout en bout (HTTP) | 191   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |

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
  la session d'un autre compte est introuvable ;
- **validation en deux étapes** : l'implémentation TOTP reproduit les vecteurs des RFC 4226
  et 6238 ; le secret n'est conservé que chiffré, et ne se déchiffre ni avec une autre clé ni
  recopié sur un autre compte ; après le mot de passe, aucune session n'existe tant que le
  code n'est pas donné ; un code ne sert qu'une fois — présenté au même instant sur quatre
  connexions, il n'en ouvre qu'une, et il en va de même d'un code de secours ; les essais sont
  bornés par compte, d'où qu'ils viennent ;
- **back-office** : sans validation en deux étapes, aucune route d'administration ne répond ;
  chaque route exige sa permission ; nul n'agit sur son propre compte ; le support n'agit pas
  sur le personnel ; chaque action laisse sa justification au journal, chaque recherche sa
  trace — sans l'adresse ni le numéro recherchés ; la liste des comptes refuse tout
  identifiant dans l'URL ;
- **rôles** : des tests s'adressent **directement à PostgreSQL** avec le rôle de l'API. La
  base refuse alors toute écriture directe d'une attribution, l'approbation d'une demande par
  son auteur ou par l'intéressé, l'approbation d'une demande échue ou dont l'auteur a perdu
  sa qualité, la modification de ses termes, la réécriture ou la suppression d'une demande
  décidée. Huit approbations simultanées d'une même demande en appliquent une seule ; deux
  approbations simultanées qui se retirent mutuellement un intervenant sont appliquées l'une
  après l'autre, et la seconde est refusée ;
- **téléphone** : deux comptes qui confirment le même numéro au même instant — un seul l'obtient ;
- **e-mails** : face à un vrai serveur SMTP, une inscription se termine avec le code reçu, y
  compris en configuration de production (connexion chiffrée, compte d'envoi authentifié) ;
  ni identifiants ni message ne partent vers un serveur qui ne chiffre pas ou dont le
  certificat n'est pas reconnu ; une adresse piégée ne peut ni ajouter ni substituer un
  destinataire ; une boîte inexistante n'est pas relancée ; le journal ne contient ni adresse
  ni code ;
- **purge** : ne supprime ni un compte vérifié, ni une inscription récente, ni la dernière
  session d'un compte, ni un second facteur actif ; chaque inscription supprimée est tracée ;
  l'échec d'une étape n'empêche pas les suivantes.

**Efficacité des tests vérifiée par mutation.** 157 défauts ont été introduits volontairement,
un par un, puis retirés ; chacun doit faire échouer au moins un test.

- Phase 1 : 20 défauts (calculs monétaires, concurrence, expurgation, privilèges,
  configuration du proxy), tous détectés.
- Lot 1 : 32 défauts dans le code d'identité. Sur les 28 premiers, 2 n'étaient pas détectés
  (jeton stocké en clair plutôt que son empreinte ; règle de mot de passe contournée à la
  réinitialisation) ; les tests ont été renforcés, 4 défauts ajoutés, et les 32 sont détectés.
- Lot 2 : 105 défauts (second facteur, téléphone, profil, back-office, règles SQL de la double
  validation, purge, accès simultanés), tous détectés. L'un d'eux — une purge au travail non
  borné — ne faisait pas échouer les tests : il les bloquait ; le test concerné échoue
  maintenant immédiatement. Quatre défauts ne se manifestent que lorsque deux requêtes
  arrivent en même temps : ils sont détectés par les tests d'accès simultanés.

## Infrastructure : vérifications hors Docker

L'environnement de développement utilisé ne dispose **ni de Docker, ni d'accès aux dépôts de
paquets système**. Chaque fichier d'infrastructure a donc été exécuté hors Docker, avec le
vrai logiciel, y compris après les ajouts de la phase 2 :

| Élément                             | Vérifié ici                                                                                                                                                                                                                                                                                                                                                                                 | Reste à confirmer                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `api.Dockerfile`                    | Étapes rejouées une à une dans une arborescence vierge appartenant à `root`, à partir du seul contexte de build. L'artefact obtenu et l'outil d'administration ont été exécutés sous l'utilisateur `node`, sans droit d'écriture.                                                                                                                                                           | Construction par Docker (images de base, couches, cache)                                           |
| Script d'initialisation PostgreSQL  | Exécuté tel quel sur une instance PostgreSQL 18.6 vierge (client `psql` 16.2) : rôles, bases, privilèges, connexions par mot de passe.                                                                                                                                                                                                                                                      | Exécution par le point d'entrée de l'image officielle                                              |
| `docker-compose.yml`                | Séquence rejouée dans un espace réseau isolé, avec les mêmes noms d'hôtes, ports, commandes, variables et sondes : initialisation, migrations, API, Nginx. Fichier conforme au schéma officiel de la spécification Compose.                                                                                                                                                                 | Orchestration par Docker Compose (ordre de démarrage, volumes, options de sécurité des conteneurs) |
| `nginx.conf`                        | Exécuté sans modification par Nginx 1.30.6 compilé depuis les sources : relais, sondes, limitation de débit, erreurs au format de l'API, journaux corrélés avec ceux de l'API.                                                                                                                                                                                                              | Exécution dans l'image `nginx:1.30-alpine`                                                         |
| Parcours d'identité de la CI        | Le script `infrastructure/ci/smoke-identity.sh` a été exécuté à travers ce Nginx : administrateur créé en ligne de commande, back-office refusé sans second facteur, activation du second facteur, ouverture de l'inscription, inscription, vérification, connexion, profil, historique, connexion en deux temps, recherche d'un compte et fermeture de ses sessions depuis le back-office. | Exécution dans la pile Docker                                                                      |
| Workflow de CI                      | Les commandes du job `verify` et les étapes de test du job `docker` ont été exécutées ici. Les actions sont épinglées sur des empreintes vérifiées.                                                                                                                                                                                                                                         | **Toute exécution par GitHub** (voir ci-dessous)                                                   |
| Moteur de migration natif de Prisma | Téléchargement bloqué ici : les migrations ont été créées et appliquées avec la **version WebAssembly officielle du même moteur** (même révision). Son comportement pour le contrôle de cohérence a été établi par lecture de son code source.                                                                                                                                              | Exécution par la CI                                                                                |
| Images Docker                       | Les étiquettes `postgres:18-bookworm`, `redis:8-alpine`, `nginx:1.30-alpine` et `node:24-bookworm-slim` existent dans le registre des images officielles.                                                                                                                                                                                                                                   | —                                                                                                  |
| Node.js 22 et 26                    | Non vérifiés. Seul Node.js 24.22.2 l'a été.                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                  |

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

### Pendant le lot 2 de la phase 2

Tous corrigés avant la livraison du lot.

1. **Un tiers pouvait préparer un compte à l'adresse d'une autre personne** (défaut du lot 1,
   trouvé à la relecture). Il s'inscrivait avec l'adresse de sa victime et son propre mot de
   passe, puis attendait qu'elle active elle-même le compte en saisissant le code reçu — il
   en connaissait alors le mot de passe. Désormais, vérifier l'adresse exige aussi le mot de
   passe de l'inscription ; une nouvelle inscription remplace entièrement la précédente tant
   que l'adresse n'est pas vérifiée ; une inscription jamais vérifiée ne se réinitialise pas.
2. **Deux approbations simultanées de changements de rôle pouvaient se priver l'une l'autre
   de leurs intervenants**, et passer toutes les deux alors qu'aucun ordre ne les admet
   ensemble — au pire, ne laisser aucun administrateur. Trouvé en écrivant les tests d'accès
   simultanés, reproduit par un test qui échoue sur la version précédente. Les approbations
   sont désormais appliquées une à une par la base.
3. **Qui connaissait le mot de passe pouvait essayer des codes à six chiffres sans limite**,
   en rouvrant une connexion après chaque série de cinq essais (première version du lot). Les
   essais sont maintenant comptés par compte : 5 en 15 minutes, 20 en 24 heures, et le
   titulaire est prévenu du blocage.
4. **Une session ouverte à l'instant même d'une suspension pouvait revivre à la
   réactivation.** Réactiver un compte ferme désormais toutes ses sessions.
5. **L'adresse ou le numéro recherché par le support figurait dans l'URL** (`?email=`). Les
   journaux de l'API et du Nginx fourni n'enregistrent pas les paramètres d'URL, mais ceux
   d'un hébergeur ou d'un proxy le font. La recherche passe désormais par le corps d'une
   requête, et la liste des comptes refuse tout identifiant en paramètre.
6. **Un index de recherche par préfixe rendait le contrôle de cohérence des migrations
   définitivement faux** (Prisma ne sait pas le décrire). Il a été remplacé par un index
   ordinaire, suffisant puisque la recherche se fait par identifiant complet.
7. **Un défaut volontaire bloquait les tests au lieu de les faire échouer** (voir
   « mutation » ci-dessus).

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

- **E-mails : le compte d'envoi reste à ouvrir.** L'API envoie par SMTP, mais aucun
  prestataire n'est choisi ni configuré : tant que ce n'est pas fait, hors développement,
  inscription et réinitialisation du mot de passe répondent `503` et les messages de sécurité
  ne partent pas. L'envoi n'a été vérifié que contre un serveur SMTP de test ; la
  délivrabilité réelle (SPF, DKIM, réputation, messageries utilisées en RDC) reste à
  constater avec le prestataire retenu.
- **E-mails : non-remises et plaintes non exploitées.** L'API ne sait pas qu'un message
  accepté a ensuite été retourné ; il n'y a pas de plafond global d'envoi. Les messages sont
  en texte seul.
- **SMS : aucun prestataire.** La vérification du numéro de téléphone répond `503` hors
  développement.
- **Retrait d'un second facteur par le support : la procédure n'est pas écrite.** L'API borne
  le risque (permission réservée, justification, sessions fermées, titulaire prévenu) mais ne
  vérifie pas l'identité de la personne qui dit avoir perdu son téléphone. À écrire avant
  toute mise en service.
- **Clé de chiffrement des seconds facteurs** (`AUTH_SECRETS_ENCRYPTION_KEY`) : à sauvegarder
  hors de la base. La perdre ou la changer rend tous les seconds facteurs invérifiables ; sa
  rotation n'est pas outillée. Changer `AUTH_CODE_HMAC_SECRET` invalide les codes de secours.
- **Double validation des rôles** : il faut au moins deux administrateurs pour faire évoluer
  les rôles par l'API. La base vérifie la qualité des deux intervenants que l'API lui désigne,
  pas leur présence : elle protège d'un administrateur seul et d'un défaut du code, **pas d'un
  attaquant qui exécuterait du SQL sous le rôle de l'API** — celui-ci laisserait toutefois une
  trace ineffaçable (ADR 0018). Suspendre un administrateur et modifier les paramètres de la
  plateforme restent des actions d'une seule personne.
- **Le TOTP ne résiste pas à l'hameçonnage en temps réel.** Les clés d'accès (WebAuthn) sont
  la suite prévue.
- **Connexion inhabituelle** : seule la connexion depuis un appareil inconnu est signalée,
  d'après un identifiant que l'application fournit (à défaut, l'agent utilisateur). Pas de
  géolocalisation, pas de réputation d'adresse IP.
- **Suspension sans prévenir le titulaire** (`notifyUser: false`) : pouvoir sensible, tracé,
  à réserver à un rôle de conformité quand il existera.
- **Le back-office ne lit pas encore le journal d'audit** ni l'historique d'un compte.
- **Recherche d'un compte par identifiant complet uniquement** (adresse, numéro, identifiant) :
  pas de recherche par nom. C'est voulu à ce stade.
- **Le profil est déclaré, pas vérifié** : la vérification d'identité est l'objet du lot 3.
- **L'identifiant de connexion est l'adresse e-mail.** Le numéro de téléphone se vérifie mais
  ne permet pas de se connecter (décision attendue).
- **Durées de conservation** (7 jours, 90 jours…) : valeurs de départ, à confirmer avec la
  conformité. Le journal d'audit n'est jamais purgé.
- **Conditions d'utilisation** : seule la date d'acceptation est enregistrée, pas la version du texte.
- **Mots de passe** : la liste des mots de passe courants refusés est courte ; pas encore de
  vérification contre les fuites connues.
- **Blocage par un tiers** : en multipliant les échecs, un tiers peut bloquer temporairement
  la connexion à un compte ; qui connaît le mot de passe peut bloquer la seconde étape
  (24 heures au plus). Le titulaire en est prévenu.
- **Horloge** : sessions et codes à usage unique lisent encore directement l'heure du
  système ; le reste du lot 2 passe par une horloge injectable, ce qui en facilite le test.
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

Prises le 2026-11-12 : vérification d'identité **manuelle**, par votre équipe ; grille à
**trois niveaux** ; envoi des **e-mails par SMTP**, les SMS plus tard.

1. **Compte d'envoi d'e-mails** : ouvrir un compte chez le prestataire de votre choix, y
   autoriser le domaine expéditeur, puis fournir ses paramètres SMTP. C'est ce qui reste
   pour ouvrir l'inscription hors développement.
2. **Prestataire SMS pour la RDC** — nécessaire pour la vérification du téléphone. Chacun a
   son API : l'intégration se fera une fois le prestataire retenu.
3. **Identifiant de connexion** : l'adresse e-mail suffit-elle, ou le numéro de téléphone
   doit-il aussi permettre de se connecter (usage courant sur le marché visé) ? Sans réponse,
   l'adresse e-mail est conservée ; le numéro est seulement vérifié.
4. **Procédure du support pour le retrait d'un second facteur** : quelles preuves d'identité,
   quel délai de carence.
5. **Plafonds par niveau de vérification** — à fixer avant les premiers mouvements de
   fonds : rien ne les applique aujourd'hui.
6. **Durées de conservation** des données d'identité : confirmer ou corriger les valeurs de départ.
7. **Conditions d'utilisation** : texte et gestion des versions.
8. **Hébergement cible** (fournisseur, région) et exigences de localisation des données.
9. **Statut réglementaire visé en RDC** et calendrier des autorisations : il conditionne
   l'ordre d'ouverture des fonctionnalités.
