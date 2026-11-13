# État du projet MG-Exchange

_Dernière mise à jour : 2026-11-12 — phase 2 en cours, lots 1 à 4 livrés._

## Synthèse

| Phase | Périmètre                               | État                             |
| ----- | --------------------------------------- | -------------------------------- |
| 1     | Analyse et fondations                   | **Livrée** (réserves ci-dessous) |
| 2     | Identité et utilisateurs                | **En cours** — lots 1 à 4 livrés |
| 3     | Infrastructure financière (grand livre) | Non commencée                    |
| 4     | Échange et paiements                    | Non commencée                    |
| 5     | Blockchain                              | Non commencée                    |
| 6     | P2P et séquestre                        | Non commencée                    |
| 7     | Web, mobile, back-office                | Non commencée                    |
| 8     | Risque et conformité                    | Non commencée                    |
| 9     | Tests et déploiement                    | Non commencée                    |

**Aucune opération financière n'existe ni n'est simulée.** Toutes les fonctionnalités
réglementées sont désactivées par défaut — l'inscription et la vérification d'identité
comprises — et le resteront jusqu'à décision explicite d'un administrateur.

**Il n'y a pas encore de site web** : l'application web, les applications mobiles et le
back-office relèvent de la phase 7. Ce qui est visible aujourd'hui est l'API (documentation
interactive `/api/docs`).

**Envoi des messages.** Les e-mails partent par le serveur SMTP du prestataire de votre choix
— à configurer au déploiement : sans lui, hors développement, l'API refuse l'inscription et
la réinitialisation du mot de passe plutôt que de promettre un code qui n'arriverait jamais,
et les messages de sécurité ne partent pas. Cet envoi a été vérifié contre un serveur SMTP
réel exécuté par les tests, **jamais contre le service d'un prestataire**. Aucun SMS ne
part : la vérification du numéro de téléphone reste indisponible hors développement.

**Vérification d'identité.** L'API reçoit les dossiers et les pièces, et les soumet à
l'examen de votre équipe de conformité : **rien n'est vérifié automatiquement**, et il
n'existe pas encore d'écran pour les examinateurs (phase 7) — l'examen se fait aujourd'hui
par les routes de l'API. Le niveau obtenu **n'ouvre encore aucun droit** : aucun plafond
n'existe, puisque aucune opération n'existe.

**Clôture et données personnelles.** Un titulaire peut clore son compte et obtenir une copie
de ses données ; ce que la loi impose de garder est conservé dix ans, le reste est effacé.
**Les durées et l'étendue de ces droits reposent sur notre lecture des textes, qui n'est pas
un avis juridique** — et, pour la protection des données, sur un résumé non officiel du Code
du numérique : à faire confirmer par votre conseil avant toute ouverture au public.

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

### Lot 3 — livré : vérification d'identité des particuliers (KYC)

Selon vos décisions du 2026-11-12 : examen **manuel**, par votre équipe ; **trois niveaux**.

| Sujet                 | Réalisation                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Niveaux               | 1 identité (pièce et autoportrait), 2 adresse (justificatif de moins de trois mois), 3 origine des fonds — obtenus dans l'ordre                         |
| Dossier               | le titulaire déclare, joint ses pièces, dépose ; un dossier déposé ne se modifie plus ; un refus est motivé et permet un nouveau dossier                |
| Pièces acceptées      | passeport, carte d'électeur (RDC), carte d'identité, permis de conduire ; fichiers JPEG, PNG ou PDF de 5 Mio au plus, contrôlés sur leur contenu        |
| Protection des pièces | chaque fichier est chiffré avec sa propre clé, hors de la base ; le numéro de la pièce est chiffré ; le titulaire ne revoit ni l'un ni l'autre en clair |
| Examen                | file des dossiers déposés, fiche, pièces, acceptation, refus motivé, retrait d'une vérification ; nouveau rôle `compliance`                             |
| Aides à l'examen      | la fiche signale un fichier déjà déposé par un autre compte, et une même pièce d'identité présentée par un autre compte                                 |
| Garanties de la base  | parcours du dossier, qualité de l'examinateur, ordre des niveaux, une pièce d'identité pour un seul compte : imposés par PostgreSQL lui-même            |
| Traçabilité           | chaque consultation d'un dossier ou d'une pièce est inscrite au journal d'audit, avant d'être servie ; nul n'examine son propre dossier                 |
| Profil                | une fois le dossier accepté, le profil reprend l'identité et l'adresse vérifiées, que le titulaire ne peut plus modifier librement                      |
| Information           | le titulaire est prévenu par e-mail de chaque décision et la retrouve dans son historique ; il n'apprend ni la note interne ni le nom de l'examinateur  |
| Minimisation          | un dossier jamais déposé est effacé, avec ses pièces, après trente jours                                                                                |

Détail : [`docs/API.md`](docs/API.md), [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Décision : ADR 0022.

**Ce qui change pour un client écrit contre le lot 2** : le compte et le profil portent le
niveau et l'état de vérification ; **un champ vérifié du profil ne se modifie plus**
(`409`) ; les actions du personnel sur le compte d'un client ne figurent plus dans
l'historique du membre du personnel. Liste complète : [`CHANGELOG.md`](CHANGELOG.md).

**Pour ouvrir la vérification d'identité**, il faut : un volume persistant et une clé de
chiffrement (`KYC_STORAGE_DIR`, `KYC_ENCRYPTION_KEY` — voir `DEPLOYMENT.md`) ; au moins un
examinateur portant le rôle `compliance`, attribué à quatre yeux ; puis l'ouverture de la
fonctionnalité `kyc` par un administrateur. **Avant cela, lire les limites ci-dessous** —
en particulier l'absence d'analyse antivirus des fichiers et la sauvegarde de la clé.

### Lot 4 — livré : clôture de compte, conservation légale, effacement, copie des données

| Sujet                    | Réalisation                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clôture par le titulaire | immédiate et définitive ; le mot de passe est redemandé, et le second facteur s'il est activé : une session ouverte ne suffit pas                      |
| Clôture par le personnel | à la demande du titulaire ou par décision de la plateforme ; permission nouvelle, détenue par les administrateurs et la conformité ; justification     |
| Ce que devient le compte | plus de mot de passe, de second facteur, de session ni de profil ; il n'en reste qu'une ligne sans identifiant ; l'adresse et le numéro sont libres    |
| Trace de la clôture      | date, origine, auteur ; elle garde l'adresse et le numéro jusqu'à l'échéance d'effacement, pour que le support retrouve un compte clôturé              |
| Conservation légale      | un dossier de vérification sur lequel une décision a été prise est conservé dix ans après la clôture, avec ses pièces ; un dossier jamais examiné, non |
| Effacement               | trente jours après la clôture, ou au terme des dix ans : dossiers, fichiers, puis adresse et numéro de la trace — par la purge horaire                 |
| Copie des données        | un document JSON : compte, profil, sécurité, sessions, historique, dossiers ; ni secret, ni fichier, numéro de pièce masqué ; trois par jour           |
| Garanties de la base     | rien ne s'écrit sur un compte clôturé ; rien ne s'efface avant le terme légal, lu à l'horloge de la base ; une clôture est entière ou n'est pas        |
| Information              | le titulaire est prévenu par e-mail de la clôture — à son ancienne adresse — et de chaque copie de ses données ; il n'apprend jamais la justification  |
| Minimisation             | les événements techniques déjà traités, qui peuvent désigner un compte, sont supprimés après trente jours                                              |

Détail : [`docs/API.md`](docs/API.md), [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/DATABASE.md`](docs/DATABASE.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Décision : ADR 0023.

**Ce qui change pour un client écrit contre le lot 3** : l'ancienne adresse d'un compte
clôturé reçoit `401`, comme une adresse inconnue — `403 ACCOUNT_DISABLED` ne désigne plus
qu'un compte suspendu ; une requête qui écrit sur un compte clôturé entre-temps reçoit `409` ;
l'historique et les dossiers connaissent de nouvelles valeurs. Liste complète :
[`CHANGELOG.md`](CHANGELOG.md).

**L'acceptation versionnée des conditions d'utilisation, annoncée pour ce lot, n'y figure
pas** : elle dépend d'un texte et d'une règle de version qui restent à décider (décision 9
ci-dessous). Elle fera l'objet du lot suivant.

### Reste à faire en phase 2

- **Acceptation versionnée des conditions d'utilisation** : enregistrer la version du texte
  acceptée, et la redemander quand il change.
- **Vérification des entreprises (KYB)** et comptes professionnels : à concevoir — pièces de
  la société, représentants, bénéficiaires effectifs.
- **Plafonds par niveau de vérification** : à fixer et à appliquer avec les premières
  opérations (phase 3).

## Résultats de tests

Exécution du 2026-11-12 — Node.js 24.22.2, pnpm 12.18.0, PostgreSQL 18.6, Redis 8.10.3.

| Vérification                     | Résultat                         |
| -------------------------------- | -------------------------------- |
| `pnpm format:check`              | conforme                         |
| `pnpm lint` (`--max-warnings 0`) | 0 erreur, 0 avertissement        |
| `pnpm build`                     | réussi                           |
| `pnpm typecheck`                 | 0 erreur                         |
| `pnpm db:check-drift`            | aucune différence                |
| `pnpm audit --prod`              | aucune vulnérabilité connue      |
| `pnpm test`                      | **1 236 tests réussis, 0 échec** |

| Suite                     | Tests | Services réels                                  |
| ------------------------- | ----- | ----------------------------------------------- |
| `@mgx/shared` (montants)  | 103   | —                                               |
| `@mgx/validation`         | 95    | —                                               |
| `@mgx/contracts`          | 34    | —                                               |
| API — unitaires           | 440   | —                                               |
| API — intégration         | 229   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |
| API — bout en bout (HTTP) | 335   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |

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
- **reverse proxy** : les erreurs que Nginx produit lui-même respectent le contrat d'erreur de
  l'API ; sa configuration ne lui fait copier sur son disque ni un fichier envoyé, ni une
  réponse de l'API ;
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
  l'échec d'une étape n'empêche pas les suivantes ; les événements publiés depuis trente
  jours sont supprimés, jamais ceux qui sont en attente ou abandonnés ;
- **pièces de vérification** : le stockage ne contient rien de lisible — ni le fichier, ni sa
  signature, ni le numéro de la pièce ; un fichier ou une clé recopiés à la place d'un autre
  ne se déchiffrent pas ; une pièce altérée, échangée ou disparue n'est jamais rendue, et
  l'incident est tracé ; l'examinateur retrouve le fichier envoyé à l'octet près ; un fichier
  remplacé, retiré ou abandonné est effacé du stockage ;
- **envoi d'un fichier** : un fichier déguisé, vide, trop petit ou d'un type non admis est
  refusé sans rien conserver ; la taille maximale exacte passe, un octet de plus non ; un
  envoi annoncé démesuré est refusé sans être lu ; au-delà de huit réceptions simultanées,
  l'envoi est refusé aussitôt ;
- **parcours d'un dossier** : des tests s'adressent **directement à PostgreSQL** avec le rôle
  de l'API. La base refuse alors de déposer un dossier incomplet ou hors de l'ordre des
  niveaux, de modifier ou d'effacer un dossier déposé, de modifier une pièce, de faire
  décider un compte suspendu, non habilité, ou le titulaire lui-même, d'accepter la même
  pièce d'identité pour deux comptes, de rouvrir un dossier clos ;
- **examen** : chaque route exige sa permission et la validation en deux étapes — consulter
  n'autorise pas à décider, ni décider à retirer ; le support ne voit aucun dossier ; nul
  n'examine le sien ; chaque page, fiche et téléchargement laisse sa trace ; le titulaire
  reçoit les motifs d'un refus, jamais la note interne ;
- **vérification et profil** : accepter un dossier vérifie le niveau, et le profil reprend
  l'identité de la pièce ; retirer le niveau 1 fait retomber tout le compte ; renouveler une
  pièce n'interrompt pas la vérification ;
- **accès simultanés à un dossier** : deux enregistrements créent un seul dossier ; trois
  dépôts, un seul aboutit ; de deux décisions contraires, une seule est prise et un seul avis
  part ; la même pièce acceptée au même instant sur deux comptes n'en vérifie qu'un ; aucun
  fichier orphelin ne reste après des envois concurrents ;
- **clôture** : une session ouverte ne suffit pas — sans le mot de passe, ou sans le second
  facteur s'il est activé, rien ne change ; clôturé, le compte n'a plus ni session, ni
  secret, ni profil, et son ancienne adresse répond comme une adresse inconnue ; l'adresse,
  le numéro et la pièce d'identité resservent aussitôt à un nouveau compte, qui n'hérite de
  rien ; un membre du personnel ne clôt ni son propre compte, ni sans la permission, ni un
  compte qui détient un rôle ; le titulaire est prévenu à son ancienne adresse, jamais de la
  justification ; une clôture acquise répond par un succès même si le nettoyage qui la suit
  échoue ;
- **clôture, règles de la base** : des tests s'adressent **directement à PostgreSQL** avec le
  rôle de l'API. La base refuse alors un compte clôturé sans sa trace, ou qui garde un
  secret, une session, un profil ou un rôle ; toute écriture sur un compte clôturé ; une
  clôture antidatée, ou prononcée par un compte non habilité ; l'effacement d'un dossier
  conservé avant son terme, lu à sa propre horloge. Une session ouverte pendant une clôture
  attend son issue, puis est refusée ; deux écritures ordinaires qui se croisent sur un même
  compte ne s'interbloquent pas ;
- **clôture au milieu d'autres requêtes du même compte** : chaque croisement est provoqué par
  le test, à l'instant voulu. Un changement de mot de passe, ou une connexion, qui arrive
  après la clôture reçoit `409`, jamais une erreur serveur ; une demande de réinitialisation
  répond comme pour une adresse inconnue ; face à une écriture qui prend ses verrous dans
  l'ordre inverse — une seconde connexion à PostgreSQL la joue —, la clôture cède le passage
  puis aboutit ; si le compte reste occupé, elle renonce sans rien changer ;
- **chaque route ouverte au titulaire, croisée par la clôture de son compte** : 28 requêtes —
  session, mot de passe, second facteur, téléphone, profil, dossiers et pièces, copie des
  données —, chacune à deux moments : une fois authentifiée et avant tout traitement, puis à
  l'ouverture de sa première transaction, quand toutes ses lectures ont vu un compte ouvert
  et que toutes ses écritures trouvent un compte clôturé. Aucune ne répond par une erreur
  serveur ; le compte reste clôturé et ne porte plus rien ; aucun fichier ne reste sur le
  volume des pièces ;
- **conservation et effacement** : un dossier examiné — accepté ou refusé — est conservé dix
  ans avec ses fichiers ; un dossier jamais examiné est effacé à la clôture. À l'échéance,
  **la base entière est relue, table par table : plus aucune ne contient l'adresse, le
  numéro, le nom, le lieu de naissance ni l'adresse postale du compte** ; il reste la ligne
  sans identifiant, la trace de la clôture et le journal d'audit. Avancer l'horloge de
  l'application seule n'efface rien de ce que la loi impose de garder ; un compte qui ne peut
  pas être effacé est signalé, sans bloquer les autres ;
- **copie des données** : elle contient le compte, le profil, les sessions, l'historique et
  les dossiers — ni secret, ni fichier, ni numéro complet de pièce ; trois par jour, et un
  essai refusé n'en consomme pas ; sans stockage chiffré, elle est refusée plutôt que
  tronquée.

**Efficacité des tests vérifiée par mutation.** 634 défauts ont été introduits volontairement,
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
- Lot 3 et envoi des e-mails : 226 défauts (règles SQL des dossiers, chiffrement et stockage
  des pièces, réception d'un fichier, parcours et examen des dossiers, purge, envoi SMTP).
  **À la première passe, 9 des 214 défauts n'étaient pas détectés** :
  - cinq révélaient un manque dans les tests, comblé depuis : un dossier accepté dont seuls le
    statut ou la date de modification étaient réécrits ; la table des dossiers vidée d'un
    bloc ; un dossier encore en préparation sur un autre compte compté parmi les doublons
    signalés à l'examinateur ; le niveau annoncé dans l'avis de retrait ; un envoi
    irrecevable attendu en entier avant d'être refusé ;
  - un portait sur la mémoire occupée pendant la réception d'un fichier trop grand, qu'aucun
    test ne pouvait observer : le code a été réorganisé pour que cette borne se vérifie ;
  - deux retiraient une condition d'écriture que la base rattrape par ses propres règles —
    l'API répondait donc la même chose. Ces écritures sont maintenant vérifiées directement,
    sans les contrôles qui les précèdent ;
  - un est sans effet dans une base installée comme prévu (il retire un privilège qui n'y
    est jamais accordé) : **il a été écarté**, et n'est pas compté.

  Treize défauts ont été ajoutés avec ces corrections. Les 226 sont détectés : 182 lors de la
  passe complète, et les 44 qui touchent du code ou des tests modifiés depuis, relancés un à
  un. Cette relance a elle-même trouvé un défaut qu'une de ces corrections avait rendu
  indétectable ; un test le couvre désormais.

- Lots 1 et 2 rejoués après le lot 3, qui modifie le code d'identité : les 31 défauts du
  lot 1 rejouables par script sont détectés. Au lot 2, **un défaut sur 105 ne l'a pas été à
  cette passe**, alors qu'il l'avait été jusque-là : un code d'application
  d'authentification accepté deux fois lorsque deux connexions le présentent au même
  instant. Le code livré n'a pas ce défaut ; c'est le test qui ne le voyait que si les
  requêtes se croisaient réellement — rejoué trois fois, il l'a détecté trois fois.
  L'écriture en cause est maintenant vérifiée directement, sans dépendre de l'instant où les
  requêtes arrivent, et deux défauts voisins ont été ajoutés : 107 au lot 2, tous détectés.
- Lot 4 : 249 défauts — 91 dans les règles SQL de la clôture, de la conservation et de
  l'effacement, 158 dans le code (clôture par le titulaire et par le personnel, preuve
  redemandée au titulaire, effacement à l'échéance, purge des événements publiés, copie des
  données, requêtes qui croisent la clôture). **À la première passe, 3 des 221 défauts
  n'étaient pas détectés**, chacun révélant un manque dans les tests, comblé depuis :
  l'origine d'une clôture réécrite au moment où son effacement est constaté ; une connexion
  commencée — mot de passe accepté, second facteur attendu — qui n'était pas annulée par la
  clôture ; un effacement compté une seconde fois lorsqu'une autre instance l'avait déjà
  constaté. Vingt-huit défauts ont été ajoutés avec les tests écrits ensuite : neuf avant la
  première publication du lot (mode maintenance, copie et clôture sans stockage chiffré,
  nettoyage en échec après une clôture acquise, ancien numéro dans la recherche et la fiche
  du back-office, événements publiés jamais purgés, adresse citée dans le journal d'audit),
  dix-neuf avec la correction des requêtes simultanées (voir « Problèmes identifiés »). Tous
  sont détectés. Un résultat a été écarté puis rejoué seul : une commande lancée par erreur
  exécutait d'autres tests au même moment.
- Lots 1 à 3 après le lot 4, qui modifie leur code et plusieurs de leurs tests. Vingt-huit
  défauts du lot 3 visaient des règles SQL que la migration du lot 4 redéfinit : ils ont été
  déplacés vers la nouvelle définition. **Tous les défauts rejouables par script — 31 au
  lot 1, 107 au lot 2, 226 au lot 3 — ont été rejoués sur le code du lot 4 : tous sont
  détectés.** L'un d'eux — la purge au travail non borné, déjà citée au lot 2 — bloquait de
  nouveau un test au lieu de le faire échouer : cette fois un test écrit pour le lot 4,
  corrigé depuis.
- Après la correction des requêtes simultanées, ont été rejoués les défauts qui portent sur
  un fichier qu'elle modifie, code ou test : les 249 du lot 4, les 31 du lot 1 et 5 du
  lot 2. Tous sont détectés.

## Infrastructure : vérifications hors Docker

L'environnement de développement utilisé ne dispose **ni de Docker, ni d'accès aux dépôts de
paquets système**. Chaque fichier d'infrastructure a donc été exécuté hors Docker, avec le
vrai logiciel, y compris après les ajouts de la phase 2 :

| Élément                             | Vérifié ici                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Reste à confirmer                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.Dockerfile`                    | Étapes rejouées une à une dans une arborescence vierge appartenant à `root`, à partir du seul contexte de build. L'artefact obtenu et l'outil d'administration ont été exécutés sous l'utilisateur `node`, sans droit d'écriture. Le répertoire des pièces y est créé comme le prescrit le fichier, réservé à l'utilisateur `node`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Construction par Docker (images de base, couches, cache) ; instruction `VOLUME`                                                                                                                                                                                                                                                                                |
| Script d'initialisation PostgreSQL  | Exécuté tel quel sur une instance PostgreSQL 18.6 vierge (client `psql` 16.2) : rôles, bases, privilèges, connexions par mot de passe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Exécution par le point d'entrée de l'image officielle                                                                                                                                                                                                                                                                                                          |
| `docker-compose.yml`                | Séquence rejouée dans un espace réseau isolé, avec les mêmes noms d'hôtes, ports, commandes, variables et sondes : initialisation, migrations, API, Nginx. Fichier conforme au schéma officiel de la spécification Compose. Les deux variables de la vérification d'identité sont fournies à l'API comme le fichier les déduit, et les pièces écrites dans un répertoire vide monté à l'emplacement du volume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Orchestration par Docker Compose (ordre de démarrage, volumes, options de sécurité des conteneurs) ; le volume `kyc-documents` et l'expression `${KYC_ENCRYPTION_KEY:+…}`, que seul Compose interprète (cette forme ne figure pas dans le texte de la spécification ; sa prise en charge a été vérifiée dans le code source de Compose, pas par une exécution) |
| `nginx.conf`                        | Exécuté sans modification par Nginx 1.30.6 compilé depuis les sources : relais, sondes, limitation de débit, erreurs au format de l'API, journaux corrélés avec ceux de l'API. Route d'envoi des pièces : fichiers de 600 Ko, de 5 Mio exactement, de 5 Mio + 1 octet (refusé par l'API) et de 7 Mo (refusé par Nginx) ; quatre envois lents simultanés, le cinquième refusé. Depuis le lot 4 : aucune réponse de l'API n'est copiée sur le disque du proxy — le téléchargement d'une pièce de 5 Mio n'y laisse ni fichier ni avertissement, et la même exécution **sans** la directive ajoutée échoue.                                                                                                                                                                                                                                                                                                                                                                                        | Exécution dans l'image `nginx:1.30-alpine`                                                                                                                                                                                                                                                                                                                     |
| Parcours d'identité de la CI        | Le script `infrastructure/ci/smoke-identity.sh` a été exécuté à travers ce Nginx : administrateur créé en ligne de commande, back-office refusé sans second facteur, activation du second facteur, ouverture de l'inscription, inscription, vérification, connexion, profil, historique, connexion en deux temps, recherche d'un compte et fermeture de ses sessions depuis le back-office. Depuis le lot 3 : vérification d'identité complète (déclaration, pièces, dépôt, examen, téléchargement d'une pièce de 5 Mio identique à l'octet près, acceptation, profil vérifié), puis contrôle du stockage par `check-kyc-storage.sh` sous l'utilisateur `node` — deux fichiers chiffrés, illisibles par un autre utilisateur. Depuis le lot 4 : copie des données (mot de passe redemandé, numéro de la pièce absent), clôture (confirmation exigée), connexion refusée ensuite, avis reçu à l'ancienne adresse, compte retrouvé par le back-office, dossier conservé. 105 contrôles au total. | Exécution dans la pile Docker                                                                                                                                                                                                                                                                                                                                  |
| Workflow de CI                      | Les commandes du job `verify` et les étapes de test du job `docker` ont été exécutées ici. L'étape ajoutée au lot 4 lit les journaux du conteneur Nginx : seul son équivalent, sur le journal d'erreurs de Nginx, a été exécuté. Les actions sont épinglées sur des empreintes vérifiées.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Toute exécution par GitHub** (voir ci-dessous)                                                                                                                                                                                                                                                                                                               |
| Moteur de migration natif de Prisma | Téléchargement bloqué ici : les migrations ont été créées et appliquées avec la **version WebAssembly officielle du même moteur** (même révision). Son comportement pour le contrôle de cohérence a été établi par lecture de son code source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exécution par la CI                                                                                                                                                                                                                                                                                                                                            |
| Images Docker                       | Les étiquettes `postgres:18-bookworm`, `redis:8-alpine`, `nginx:1.30-alpine` et `node:24-bookworm-slim` existent dans le registre des images officielles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                              |
| Node.js 22 et 26                    | Non vérifiés. Seul Node.js 24.22.2 l'a été.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                              |

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

### Pendant le lot 4 de la phase 2

Tous corrigés. Les deux premiers et les trois derniers touchent le produit ; les autres, ses
tests. **Les trois derniers ont été trouvés après la première publication du lot sur la
branche**, en envoyant des requêtes simultanées à l'API de l'aperçu.

1. **Une pièce d'identité téléchargée par un examinateur passait, en clair, par un fichier
   temporaire du proxy** — défaut du lot 3. Une réponse plus grande que les tampons de Nginx
   était copiée sur son disque le temps d'être relayée, puis supprimée. La documentation
   affirmait qu'une pièce n'y était « jamais écrite en clair » : c'était vrai à l'envoi, pas
   au téléchargement. Nginx le signalait dans ses journaux depuis le lot 3 ; la vérification
   ne comptait que les fichiers restés après coup. Plus aucune réponse de l'API n'est écrite
   sur ce disque ; un test lit la configuration, et le parcours de la pile complète échoue
   désormais si Nginx signale un tel fichier — ce qui a été constaté en retirant la
   correction.
2. **Une clôture acquise pouvait répondre par une erreur.** Si Redis faisait défaut juste
   après la transaction, le titulaire recevait une erreur pour une clôture déjà définitive.
   Ce qui suit la transaction est maintenant du nettoyage : un échec y est journalisé, et la
   clôture répond par un succès.
3. **Trois défauts volontaires sur 221 n'étaient pas détectés par les tests** (voir
   « mutation » ci-dessus) : une colonne de la trace réécrite seule, une connexion à
   mi-chemin non annulée, un effacement compté deux fois entre deux instances.
4. **Un test écrit pour ce lot bloquait au lieu d'échouer.** Il construisait ses données
   d'après la borne qu'il vérifiait : une borne relevée par erreur lui faisait créer cinq
   cent mille lignes. Trouvé en rejouant les défauts volontaires du lot 2 — le même travers
   y avait déjà été corrigé dans un autre test.
5. **Les tests sur services réels s'exécutaient avec un délai de 5 secondes au lieu de 30** :
   le réglage par projet de Jest n'était pas pris en compte. Les résultats publiés jusqu'ici
   n'en sont pas affectés — tous les tests passaient sous cette limite — mais un test
   légitime plus long aurait échoué sans raison.
6. **Un test d'envoi d'e-mail échouait par intermittence** (lot « envoi des e-mails ») : il
   démarrait une seconde application avant d'avoir arrêté la première, et les deux se
   disputaient les mêmes files. Le support de test refuse désormais ce cas.
7. **Quatre tests des lots 1 et 2 attendaient que les événements soient remis à la file, non
   qu'ils soient traités.** L'un a échoué une fois pendant la vérification finale ; rejoué
   sous charge, le travers se reproduit 9 fois sur 80. Trois autres pouvaient conclure
   « aucun message n'est parti » trop tôt. Ils attendent maintenant la fin du traitement.
8. **Un changement de mot de passe qui croisait la clôture répondait par une erreur
   serveur.** Mot de passe actuel confirmé, compte clôturé par une autre requête, puis
   écriture du nouveau mot de passe sur une ligne disparue : `500`. Rien n'était écrit, mais
   la documentation promettait `409` à toute écriture arrivée après la clôture — ce n'était
   vrai que pour les écritures que la base refuse, pas pour celles qui ne trouvent plus leur
   ligne. Reproduit 7 fois sur 14 essais contre l'aperçu ; il répond maintenant `409`. Le
   même défaut existait à la connexion, à l'instant où l'empreinte du mot de passe est
   recalculée.
9. **Une demande de réinitialisation du mot de passe qui croisait la clôture répondait
   « compte clôturé » (`409`)** au lieu de sa réponse unique : pendant un instant, une route
   ouverte à tous disait qu'un compte portait cette adresse. Reproduit 4 fois sur 14. Elle
   répond maintenant comme pour une adresse inconnue.
10. **La clôture pouvait s'interbloquer avec une autre écriture du même compte.** Elle
    verrouille le compte puis efface ce qu'il porte ; confirmer une application
    d'authentification, régénérer des codes de secours, redemander un code ou vérifier un
    numéro prennent ces verrous dans l'ordre inverse. PostgreSQL interrompait alors l'une
    des deux requêtes après une seconde (`500`) — sans rien écrire à moitié. Le défaut n'a
    pas été observé contre l'aperçu (la fenêtre est de quelques millisecondes) ; il a été
    établi par l'examen des verrous, puis reproduit avec deux connexions à PostgreSQL. La
    clôture cède maintenant le passage et recommence ; si le compte reste occupé, elle
    répond `409`. Après correction, 112 requêtes simultanées en huit salves, puis quarante
    croisements deux à deux : aucune erreur serveur.

Ces trois défauts étaient de la même famille : une requête partie avant la clôture, traitée
après. Plutôt que de chercher les suivants au hasard, un test rejoue désormais **chaque route
ouverte au titulaire** avec une clôture qui la croise, à deux moments de son traitement (voir
« Ce que ces tests établissent »). Il n'a trouvé aucune autre erreur serveur. Il a montré
trois inscriptions au journal d'audit postérieures à la clôture, laissées en l'état : la
copie des données, rassemblée avant la clôture et remise ; et deux actions devenues sans
effet que leur service inscrit comme réussies — fermer les autres sessions (aucune),
désactiver un second facteur que la clôture venait de retirer. Rien n'est écrit sur le
compte, aucun message ne part.

### Pendant le lot 3 de la phase 2

Tous corrigés avant la livraison du lot.

1. **Neuf défauts volontaires sur 214 n'étaient pas détectés par les tests** (voir
   « mutation » ci-dessus). Le plus instructif : une fois un dossier accepté, les tests ne
   vérifiaient pas que son statut seul, ou sa date de modification, ne pouvaient plus être
   réécrits — la base le refusait, mais rien ne l'aurait signalé si elle avait cessé de le
   faire.
2. **Une correction a rendu un autre défaut indétectable.** En rendant l'effacement d'un
   dossier insensible à l'état des autres contrôles, un défaut de la purge — chercher aussi
   des dossiers déposés — ne faisait plus échouer aucun test. Trouvé en rejouant les défauts
   concernés après la correction ; un test vérifie maintenant ce que la purge se voit proposer.
3. **L'effacement d'un dossier commençait par retirer ses pièces, quel que soit son état.**
   Pour un dossier déjà déposé, la base refusait et l'opération échouait au lieu de répondre
   « rien à effacer ». Inatteignable par l'API, qui verrouille et relit le dossier avant ;
   trouvé en vérifiant directement les écritures. Chaque écriture porte désormais sa condition.
4. **Les interventions du personnel apparaissaient dans l'historique du membre du personnel**
   autant que dans celui du client (comportement du lot 2). Avec l'examen des dossiers,
   l'historique d'un examinateur se serait rempli des dossiers d'autrui. Une action faite sur
   le compte d'un client appartient désormais à l'historique de ce seul client ; le journal
   d'audit, lui, garde tout.
5. **Une lecture faite dans une transaction lançait plusieurs requêtes à la fois sur la même
   connexion**, ce que le pilote PostgreSQL signale comme obsolète et cessera d'accepter. La
   lecture se fait désormais en une requête.
6. **Un test du lot 2 ne détectait un défaut que selon le hasard** — celui du code
   d'authentification accepté deux fois au même instant (voir « mutation » ci-dessus). Trouvé
   en rejouant les défauts des lots précédents ; remplacé par une vérification qui ne dépend
   pas de l'instant où les requêtes arrivent.

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
  encore ouvert au support ; à réserver au rôle de conformité.
- **Le back-office ne lit pas encore le journal d'audit** ni l'historique d'un compte.
- **Recherche d'un compte par identifiant complet uniquement** (adresse, numéro, identifiant) :
  pas de recherche par nom. C'est voulu à ce stade.
- **Le profil est déclaré tant que l'identité n'est pas vérifiée** ; une fois le dossier
  accepté, il reprend ce que la pièce établit.
- **L'identifiant de connexion est l'adresse e-mail.** Le numéro de téléphone se vérifie mais
  ne permet pas de se connecter (décision attendue).
- **Durées de conservation** (7 jours, 30 jours, 90 jours, dix ans…) : valeurs de départ, à
  confirmer avec votre conseil. Le journal d'audit n'est jamais purgé.
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

Vérification d'identité :

- **L'examen est entièrement humain.** Rien ne lit la pièce, ne compare l'autoportrait à la
  photographie, ni ne consulte une liste de sanctions ou de personnes politiquement exposées.
  Une seule personne décide d'un dossier.
- **Il n'existe pas d'écran pour les examinateurs** (phase 7) : l'examen passe par les routes
  de l'API. En pratique, la vérification ne peut s'ouvrir au public qu'avec cet écran, ou un
  outil interne qui appelle ces routes.
- **Aucune analyse antivirus des fichiers.** Seule leur signature est contrôlée : un PDF ou
  une image piégés seraient acceptés, puis ouverts par un examinateur. À traiter avant
  l'ouverture — analyse à la réception, ou poste d'examen isolé.
- **Clé de chiffrement des pièces** (`KYC_ENCRYPTION_KEY`) : à sauvegarder à part de la base
  et du volume. La perdre rend toutes les pièces illisibles, définitivement ; sa rotation
  n'est pas outillée.
- **Les pièces sont sur un volume**, que plusieurs instances de l'API doivent partager ; le
  stockage objet reste à faire (phase 9). Base et volume se sauvegardent ensemble.
- **Le niveau vérifié n'ouvre aucun droit** : aucun plafond n'est défini ni appliqué.
- **Une pièce qui expire après l'acceptation ne fait rien retomber** : pas de relance ni de
  suspension automatique ; la conformité retire la vérification à la main.
- **Conservation** : tant que le compte est ouvert, un dossier déposé n'est jamais effacé ;
  après la clôture, il l'est au terme de dix ans s'il a été examiné, aussitôt sinon. Notre
  lecture de la loi n° 22/068 (dix ans après la fin de la relation) **n'est pas un avis
  juridique** : à faire confirmer par votre conseil.
- **Un examinateur habilité peut télécharger toutes les pièces déposées.** Chaque accès est
  tracé ; rien ne signale un volume anormal de consultations.
- **Doublons** : une même pièce d'identité ne vérifie qu'un compte, et un même fichier déposé
  ailleurs est signalé à l'examinateur ; une personne qui présente deux pièces différentes
  sur deux comptes n'est pas détectée.
- **Entreprises** : un compte professionnel ne peut pas être vérifié (KYB à concevoir).
- **Mémoire** : une pièce est tenue en mémoire le temps d'être reçue et chiffrée — 160 Mio au
  plus par instance, à prévoir dans son dimensionnement.

Clôture, effacement, copie des données :

- **Lecture juridique à confirmer.** Le Code du numérique (ordonnance-loi n° 23/010) n'a pas
  été lu directement, seulement un résumé non officiel. Restent à établir avec votre
  conseil : les délais de réponse aux demandes, les exceptions, les formalités auprès de
  l'autorité de contrôle, et si dix ans de conservation s'appliquent bien à un dossier
  **refusé**.
- **La clôture est sans retour** : ni délai de rétractation, ni réouverture. La même personne
  peut se réinscrire aussitôt, avec la même adresse ; le nouveau compte n'hérite de rien, et
  doit refaire vérifier son identité.
- **Requêtes simultanées sur un même compte** : seuls les croisements avec la clôture ont été
  examinés verrou par verrou. Entre les autres écritures d'un compte, l'ordre des verrous
  n'a pas fait l'objet d'une revue systématique ; un interblocage y serait résolu par
  PostgreSQL — une requête interrompue, rien d'écrit à moitié — et répondrait `500`. Une
  clôture demandée pendant qu'une autre requête tarde peut répondre `409` : elle est à
  refaire. Les routes du back-office et les routes sans authentification ne sont pas
  couvertes par le balayage des croisements ; pour elles, un compte clôturé pendant la
  requête se présente comme un compte déjà clôturé, cas testé par ailleurs.
- **Le journal d'audit n'est pas effacé**, y compris après l'échéance. Il ne contient ni
  adresse e-mail ni numéro complet, mais garde l'identifiant technique du compte, des
  adresses IP et des appareils, et les justifications saisies par le personnel — qui ne
  doivent donc contenir aucune donnée personnelle. Sa durée de conservation reste à fixer.
- **Les sauvegardes ne sont pas concernées par l'effacement** : une donnée effacée subsiste
  dans les sauvegardes antérieures, dont la durée de conservation borne le délai réel
  d'effacement. À fixer avec la politique de sauvegarde (phase 9).
- **Les messages déjà envoyés** (chez le prestataire d'e-mail, dans la boîte du titulaire)
  échappent à l'effacement.
- **Aucun écran ni procédure pour une demande reçue hors de l'application** (courrier,
  e-mail) : la clôture par le personnel existe, mais la copie des données n'est remise qu'au
  titulaire connecté. Une demande d'un titulaire qui ne peut plus se connecter se traite à
  la main.
- **La copie ne contient pas les fichiers des pièces** (elle les décrit), ni le numéro complet
  de la pièce d'identité ; son historique est borné aux 2 000 événements les plus récents, et
  le dit lorsqu'il en manque.
- **Pas de rectification outillée** d'une identité vérifiée : elle passe par un nouveau
  dossier de vérification.
- **Effacement : 200 comptes par heure au plus**, du terme le plus ancien au plus récent. Un
  compte qui ne peut pas être effacé est signalé à chaque passage ; si 200 comptes restaient
  durablement bloqués, les suivants attendraient. L'alerte correspondante n'est pas encore
  branchée (phase 9).
- **Horloges** : le terme légal se lit à l'horloge de PostgreSQL ; serveur de base et
  instances de l'API doivent être synchronisés.
- **Comptes sans activité** : rien ne clôt ni n'efface un compte que son titulaire a cessé
  d'utiliser.

Socle :

- **Observabilité** : journaux structurés et identifiants de corrélation uniquement.
  OpenTelemetry, métriques et tableaux de bord Grafana ne sont pas commencés.
- **Sauvegardes, restauration, alertes** : non commencées (phase 9).
- **WebSockets** : non commencés (aucun cas d'usage avant les notifications en temps réel).
- **Transactions** : pas encore de nouvelle tentative automatique sur conflit de
  sérialisation — à traiter avec le grand livre (phase 3), piloté par des tests de concurrence.
- **Boîte d'envoi** : remise « au moins une fois » (les consommateurs doivent être
  idempotents) ; nouvelle tentative par événement et non par consommateur ; pas encore
  d'outil pour rejouer un événement abandonné. Les événements publiés sont supprimés après
  trente jours ; les événements abandonnés, jamais.
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
**trois niveaux** ; envoi des **e-mails par SMTP**, les SMS plus tard. Les trois sont
réalisées.

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
6. **Durées de conservation et droits des personnes** — à faire confirmer par votre conseil :
   la conservation de dix ans après la clôture (et son application aux dossiers refusés), le
   délai de trente jours avant effacement, la durée de conservation du journal d'audit, les
   formalités auprès de l'autorité de contrôle, et la liste des pièces acceptées.
7. **Examen des dossiers** : qui examine, avec quelle consigne écrite (quand accepter, quand
   refuser), et comment les fichiers reçus sont ouverts sans risque (analyse antivirus ou
   poste isolé).
8. **Vérification des entreprises** : en avez-vous besoin au lancement, et pour quelles
   formes de société ?
9. **Conditions d'utilisation** : le texte, et la règle de version — un changement doit-il
   être accepté de nouveau avant de continuer à utiliser le compte, ou seulement signalé ?
   C'est ce qui manque pour écrire l'acceptation versionnée.
10. **Hébergement cible** (fournisseur, région) et exigences de localisation des données —
    les pièces d'identité y sont désormais soumises.
11. **Statut réglementaire visé en RDC** et calendrier des autorisations : il conditionne
    l'ordre d'ouverture des fonctionnalités.
