# État du projet MG-Exchange

_Dernière mise à jour : 2026-11-23 — phase 2 : lots 1 à 5 livrés ; phase 3 : lot 1 (grand livre), lot 2 (transferts entre titulaires) et lot 3 (opérations du personnel) livrés, puis deux retouches du socle (base saturée, erreurs des tâches de fond), deux corrections de robustesse (tâches planifiées surveillées, arrêt borné) et le lot 4 (types d'écriture en liste fermée), **construit sans votre confirmation**, puis le lot 5 (la vérification horaire relit le type des écritures et leur opération), fait sur votre « vas y » ; intégration continue active._

## Synthèse

| Phase | Périmètre                               | État                             |
| ----- | --------------------------------------- | -------------------------------- |
| 1     | Analyse et fondations                   | **Livrée**                       |
| 2     | Identité et utilisateurs                | **En cours** — lots 1 à 5 livrés |
| 3     | Infrastructure financière (grand livre) | **En cours** — lots 1 à 5 livrés |
| 4     | Échange et paiements                    | Non commencée                    |
| 5     | Blockchain                              | Non commencée                    |
| 6     | P2P et séquestre                        | Non commencée                    |
| 7     | Web, mobile, back-office                | Non commencée                    |
| 8     | Risque et conformité                    | Non commencée                    |
| 9     | Tests et déploiement                    | Non commencée                    |

**Ni dépôt, ni retrait, ni échange n'existent, et rien n'est simulé.** Le registre comptable
est en place (phase 3, lot 1), avec deux opérations : le **transfert entre deux titulaires**
(lot 2), qui ne déplace que des fonds déjà présents dans un portefeuille, et, depuis le
lot 3, l'**ajustement d'un portefeuille par votre équipe** — un crédit ou un débit demandé
par une personne, approuvé par une seconde. C'est aujourd'hui la seule route de l'API par
laquelle des fonds s'inscrivent dans un portefeuille : **elle constate ce que deux membres de
votre équipe déclarent, et rien ne rapproche ce constat de fonds réellement détenus**. Tant
qu'aucun ajustement n'est approuvé, tous les soldes valent zéro. Toutes les fonctionnalités
réglementées sont désactivées par défaut — l'inscription, la vérification d'identité, les
transferts et les ajustements compris — et le resteront jusqu'à décision explicite d'un
administrateur.

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
par les routes de l'API. Le niveau obtenu détermine désormais **ce qu'un compte peut
envoyer** : les plafonds de transfert se fixent niveau par niveau — et **aucun n'est fixé** :
leurs valeurs vous reviennent (décision 5).

**Clôture et données personnelles.** Un titulaire peut clore son compte et obtenir une copie
de ses données ; ce que la loi impose de garder est conservé dix ans, le reste est effacé.
**Les durées et l'étendue de ces droits reposent sur notre lecture des textes, qui n'est pas
un avis juridique** — et, pour la protection des données, sur un résumé non officiel du Code
du numérique : à faire confirmer par votre conseil avant toute ouverture au public.

**Conditions d'utilisation.** L'API publie les versions successives du texte, enregistre quel
compte a accepté laquelle, et arrête un compte tant qu'il n'a pas accepté une version qui
l'exige. **Le texte lui-même n'existe pas : il vous revient, avec votre conseil.** Tant
qu'aucune version n'est publiée, personne ne peut s'inscrire ; dès que la première l'est,
chaque compte existant doit l'accepter. La question « un changement doit-il être accepté de
nouveau ? » n'est pas tranchée par le code : elle se décide à chaque publication
(décision 9).

**Grand livre.** Tout mouvement de fonds s'écrira dans un registre en partie double que la
base de données vérifie elle-même : écritures équilibrées et définitives, soldes jamais
négatifs. **Ce registre est vide** : aucun actif n'y est enregistré — la liste des monnaies
à tenir, et le nombre de décimales de chacune, vous reviennent (décision 12) —, et aucune
des deux opérations qui y écrivent, le transfert et l'ajustement, n'est ouverte. Un
titulaire peut déjà lire ses portefeuilles : il n'en a aucun tant qu'aucun actif n'est
enregistré, puis ils sont à zéro. Depuis le lot 4, la base refuse aussi toute écriture qui
n'est pas celle d'une opération qu'elle connaît.

**Transferts entre titulaires.** Un titulaire peut envoyer des fonds à un autre, désigné par
son adresse e-mail : c'est immédiat et définitif. Chaque envoi redemande le mot de passe, ne
peut pas être exécuté deux fois par une requête renvoyée, et respecte des plafonds fixés par
niveau de vérification, que la base de données applique elle-même. **Trois décisions
manquent pour qu'un transfert ait lieu, et toutes trois vous reviennent** : les valeurs des
plafonds — le code n'en contient aucune (décision 5) —, les monnaies à tenir (décision 12),
et l'ouverture elle-même, qui dépend du statut réglementaire (décision 11). **Et il n'y a
rien à transférer** tant qu'aucun portefeuille n'a été crédité — par un ajustement de votre
équipe aujourd'hui, par un dépôt plus tard. Cinq choix de produit ont été faits sans vous
pour que le lot soit complet : ils sont à confirmer (décision 14).

**Opérations du personnel.** Votre équipe peut créditer ou débiter le portefeuille d'un
titulaire — **à deux** : l'un demande, un autre approuve, en redonnant son mot de passe et
son second facteur ; la base de données refuse elle-même qu'une seule personne fasse l'un et
l'autre. Elle peut aussi **geler un portefeuille** : plus rien n'en part ni n'y arrive, hors
ces ajustements — c'est par eux que l'on sort les fonds d'un compte suspendu, d'un
portefeuille gelé ou d'un compte à clôturer. Les ajustements sont livrés **fermés**. **Aucun
montant maximal ne les borne, et rien ne vérifie que les fonds crédités existent** : ce qui
fonde un ajustement — quelle pièce, quel rapprochement, quelles personnes — relève d'une
procédure qui vous revient. Il faut désormais **deux administrateurs** pour qu'un ajustement
aboutisse. Huit choix ont été faits sans vous pour que le lot soit complet : ils sont à
confirmer (décision 15).

**Surcharge et pannes.** Quatre retouches du socle ont suivi le lot 3. Une base saturée fait
répondre « réessayez dans cinq secondes », et non plus « erreur » ; ce que les tâches de fond
signalent s'écrit dans les journaux. Les deux défauts que ces essais de panne avaient révélés
sont corrigés à leur tour. Si Redis — le service qui tient les files de tâches — revient vide
d'une coupure, **l'API réinscrit d'elle-même ses tâches, et les messages repartent en moins
d'une minute**, sans redémarrage. Et **l'API s'arrête en huit secondes au plus**, que Redis
réponde ou non, là où elle ne s'arrêtait pas. Un troisième défaut, trouvé en chemin, est
corrigé aussi : une requête en cours à l'instant d'un arrêt recevait une erreur ; elle reçoit
sa réponse.

**Un point annoncé n'a pas été fait** : la sonde de disponibilité ne signale pas les tâches
manquantes. Elle aurait retiré du trafic toutes les instances à la fois, pour un retard que
l'API répare seule ; c'est une ligne du journal qui le dit. Ce choix, et six autres faits
sans vous, sont à confirmer (décision 16).

**Entrée des fonds : fermée aussi dans la base — un lot fait sans votre confirmation.** Le
lot 4 de la phase 3 n'était que proposé, « à confirmer par vous ». Votre message suivant a
été « continue » : il a été pris pour un accord, **ce qu'il vous revient de confirmer ou de
démentir** (décision 17). Ce lot corrige le défaut relevé au lot 3 : qui écrivait dans la
base à côté de l'API, avec ses identifiants, pouvait y passer une écriture comptable
« libre » — créditer un portefeuille sans double validation, ou déplacer des fonds d'un
portefeuille à un autre sans plafond. La base tient désormais la liste des opérations qui
écrivent au registre — le transfert, le crédit et le débit de votre équipe — et refuse toute
autre écriture. Rien ne change pour un client de l'API. **Ce n'est pas une protection
complète** : avec ces mêmes identifiants, on peut encore écrire une opération entière — un
ajustement et son approbation, au nom de deux membres habilités de votre équipe.

**Le registre relit désormais, toutes les heures, d'où vient chaque écriture.** C'est l'étape
que proposait l'état précédent ; votre réponse a été « vas y », **lue comme votre accord pour
cette étape — et comme le maintien du lot 4, sur lequel elle repose**. Ce lot 5 la livre. La
vérification horaire ne recalculait que l'arithmétique du registre : une écriture bien formée
que personne n'avait demandée — passée en suspendant les règles de la base, ce que peut le
propriétaire des tables, non l'API — lui paraissait saine. Elle relève maintenant une
écriture d'un type inconnu, un transfert ou un ajustement qui ne correspond plus à son
écriture, et une écriture de transfert ou d'ajustement sans son opération. **Elle relève
après coup : elle n'empêche rien, ne corrige rien, et ne prévient toujours personne** —
l'anomalie est dans les journaux. Rien ne change pour un client de l'API. **À connaître : sur
l'aperçu, cette vérification échoue désormais à chaque passage**, à cause de l'écriture
d'essai du 15 novembre, qui ne s'efface pas. Cinq choix ont été faits sans vous, dont
celui-là, et une question vous est posée sur l'aperçu (décision 18).

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

**L'acceptation versionnée des conditions d'utilisation, annoncée pour ce lot, n'y figurait
pas** : elle fait l'objet du lot 5.

### Lot 5 — livré : conditions d'utilisation versionnées

Ni le texte des conditions ni la règle de version n'ont été arrêtés (décision 9). Le lot est
construit pour ne dépendre ni de l'un ni de l'autre : **le texte se publie comme une donnée,
et la règle se choisit à chaque publication.**

| Sujet                      | Réalisation                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versions                   | numérotées 1, 2, 3… ; un texte français, qui fait foi, une traduction anglaise facultative, un résumé de ce qui change ; en vigueur dès publication |
| Règle de chaque version    | à accepter par chaque compte avant de continuer, ou seulement signalée — au choix de qui publie ; la première est toujours à accepter               |
| Lecture                    | publique, sans compte : version en vigueur et versions passées, dans la langue demandée ; texte rendu à l'octet près, avec son empreinte            |
| Inscription                | elle désigne la version lue ; refusée si ce n'est pas celle en vigueur ; impossible tant qu'aucune version n'est publiée                            |
| Acceptation                | une par compte et par version, datée par la base ; inscrite à l'historique du compte et au journal d'audit, avec l'empreinte du texte accepté       |
| Tant qu'il faut accepter   | restent ouverts : voir son compte, accepter, mot de passe, sessions, second facteur, historique, copie des données, clôture ; le reste est refusé   |
| Refus par défaut           | une route ajoutée plus tard est fermée aux comptes qui doivent accepter, sauf déclaration contraire ; un test tient la liste des routes ouvertes    |
| Publication                | par un administrateur (permission nouvelle, réservée) ou en ligne de commande sur le serveur ; justifiée, inscrite au journal d'audit, définitive   |
| Garanties de la base       | numéros sans trou ni doublon ; version immuable ; empreinte recalculée ; on n'accepte que la version en vigueur ; une acceptation ne se modifie pas |
| Copie des données, clôture | la copie liste les acceptations du compte ; la clôture les supprime — la preuve reste au journal d'audit                                            |

Détail : [`docs/API.md`](docs/API.md), [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/DATABASE.md`](docs/DATABASE.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Décision : ADR 0024.

**À savoir avant de publier la première version :**

- tant qu'aucune version n'est publiée, rien n'est exigé des comptes existants, mais
  **personne ne peut s'inscrire** (`503`) ;
- dès la version 1, **chaque compte existant doit l'accepter** avant de retrouver son profil,
  la vérification de son téléphone et celle de son identité. Les membres du personnel aussi,
  pour ces routes-là ; le back-office leur reste ouvert ;
- **publier est définitif** : une version ne se corrige pas et ne se retire pas — on publie la
  suivante ;
- **aucun e-mail n'annonce une nouvelle version** : le titulaire l'apprend à sa prochaine
  requête.

**Ce qui change pour un client écrit contre le lot 4** : l'inscription envoie
`acceptedTermsVersion` (le numéro de la version lue) au lieu de `acceptTerms: true` ; toute
route d'un titulaire peut répondre `403 TERMS_ACCEPTANCE_REQUIRED` ; la copie des données
passe au format 2 ; la fiche d'un compte au back-office change de forme. Liste complète :
[`CHANGELOG.md`](CHANGELOG.md).

**Mise à jour d'une base existante.** La migration de ce lot renomme une colonne : une fois
appliquée, la version précédente de l'API ne fonctionne plus. **Il faut arrêter l'API avant
de migrer**, puis démarrer la nouvelle version ([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).
Sans objet pour une installation neuve.

### Reste à faire en phase 2

- **Vérification des entreprises (KYB)** et comptes professionnels : à concevoir — pièces de
  la société, représentants, bénéficiaires effectifs.
- **Plafonds par niveau de vérification** : à fixer et à appliquer avec les premières
  opérations (phase 3).

## Phase 3 — infrastructure financière

### Lot 1 — livré : grand livre en partie double

Ce lot pose le registre où s'écrira tout mouvement de fonds, **sans en ouvrir aucun**. Il
vient en premier parce que tout le reste — dépôts, retraits, transferts, échange, P2P, frais
— passera par lui, et par lui seul : il n'existe qu'un chemin, dans le code, pour modifier un
solde.

| Sujet                      | Réalisation                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actifs                     | les monnaies que la plateforme tient, enregistrées une à une par un administrateur avec leur nombre de décimales (0 à 18) ; **définitif** : ni modification, ni retrait ; aucun n'est créé d'avance |
| Comptes                    | trois types : fonds dont dispose un titulaire, fonds que la plateforme conserve pour eux, frais qu'elle a perçus ; un compte par titulaire et par actif, ouvert à sa première écriture              |
| Écritures                  | en partie double : 2 à 100 lignes, sur deux comptes au moins, débits égaux aux crédits dans chaque actif ; **définitives** — une erreur se corrige par une écriture inverse                         |
| Montants                   | des entiers, comptés dans la plus petite unité de l'actif (38 chiffres au plus) : jamais de nombre à virgule flottante ; l'API les rend en chaînes décimales exactes                                |
| Soldes                     | jamais négatifs ; chaque ligne porte le solde qu'elle laisse, et le solde d'un compte est celui de sa dernière ligne                                                                                |
| Idempotence                | chaque écriture porte une clé : la présenter de nouveau ne l'écrit pas deux fois et rend le résultat d'origine ; une écriture différente sous la même clé est refusée                               |
| Écritures simultanées      | titulaires puis comptes sont verrouillés dans un ordre fixe : deux écritures sur un même compte passent l'une après l'autre ; une transaction annulée pour conflit est reprise, trois fois          |
| Garanties de la base       | chacune de ces règles est imposée par PostgreSQL, quel que soit le code qui écrit ; le rôle de l'API ne peut ni modifier ni supprimer une écriture, ni suspendre un contrôle                        |
| Vérification horaire       | tout le registre est relu : soldes, enchaînement des lignes, équilibre de chaque écriture et de chaque actif ; une anomalie est journalisée et inscrite au journal d'audit, à chaque passage        |
| Portefeuilles du titulaire | en lecture : un portefeuille par actif enregistré, et ses mouvements page par page, chacun avec le solde qu'il a laissé ; rien n'y montre l'autre partie ni les frais perçus                        |
| Back-office                | en lecture, hors l'enregistrement d'un actif : actifs, comptes, lignes d'un compte, écriture complète, balance ; deux permissions nouvelles, réservées à `super_admin` ; tout est journalisé        |
| Clôture, copie des données | un compte qui détient des fonds ne se clôt pas ; ses écritures ne s'effacent jamais ; s'il en a eu, ses identifiants sont gardés dix ans ; la copie contient portefeuilles et mouvements            |

Détail : [`docs/API.md`](docs/API.md), [`docs/DATABASE.md`](docs/DATABASE.md),
[`docs/SECURITY.md`](docs/SECURITY.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Décision : ADR 0025.

**À savoir :**

- **à la livraison de ce lot, aucune route de l'API ne passait d'écriture.** Deux le font
  depuis : le transfert entre titulaires (lot 2) et l'approbation d'un ajustement (lot 3).
  Les règles du registre ont été éprouvées par les tests, qui écrivent chacun dans une base
  qui leur est propre — pas par un usage ;
- **aucun actif n'est enregistré**, et en enregistrer un est **définitif** : un nombre de
  décimales erroné ne se corrige pas, il oblige à enregistrer l'actif sous un autre code.
  Enregistrer un actif n'ouvre aucune opération : chaque titulaire voit seulement apparaître
  un portefeuille à zéro (décision 12) ;
- **la balance du grand livre n'est pas un rapprochement.** Elle établit que le registre
  est cohérent avec lui-même — ce que la plateforme dit conserver égale ce qu'elle doit aux
  titulaires et ce qu'elle a gagné. Elle ne dit pas que ces fonds existent sur un compte
  bancaire ou une adresse : le rapprochement avec l'extérieur reste à construire, avec les
  dépôts et les retraits ;
- **dix ans** : c'est la durée pendant laquelle un compte clôturé qui a eu des écritures
  garde ses identifiants — la même que pour les dossiers de vérification, retenue faute
  d'indication contraire. Les écritures elles-mêmes ne s'effacent jamais. L'une et l'autre
  règle sont à faire confirmer (décision 6) ;
- **la vérification horaire relève une anomalie ; elle ne corrige rien et ne prévient
  personne.** L'anomalie est dans les journaux et au journal d'audit ; l'alerte reste à
  brancher (phase 9) ;
- **deux permissions nouvelles** — lire le grand livre, enregistrer un actif — ne sont
  données qu'au rôle `super_admin`. Le grand livre montre les soldes de tous les
  titulaires : dites-nous qui, chez vous, doit pouvoir le lire (décision 13).

**Ce qui change pour un client écrit contre le lot 5 de la phase 2** : la copie des données
passe au format 3 (elle contient les portefeuilles) ; une clôture peut être refusée (`409`)
parce que le compte détient des fonds ; une requête dont la transaction en a croisé une
autre répond `409` au lieu de `500`, et peut être renvoyée telle quelle. Liste complète :
[`CHANGELOG.md`](CHANGELOG.md).

**Mise à jour d'une base existante.** La migration n'ajoute que des tables, des règles et
deux permissions : elle s'applique sans arrêter l'API. Constaté sur la base de l'aperçu, qui
contenait des comptes des lots précédents : migration appliquée pendant que la version
précédente de l'API tournait ; celle-ci a ensuite passé son parcours complet (127 contrôles)
sans une erreur, puis la nouvelle version l'a remplacée.

### Lot 2 — livré : transferts entre titulaires

Première opération qui écrit dans le grand livre : un titulaire envoie des fonds à un autre,
**à l'intérieur de la plateforme**. Rien n'y entre, rien n'en sort. Elle est livrée
**fermée**, et rien ne part tant que vous n'avez pas fixé de plafonds. Elle vient en premier
parce qu'elle est la plus simple des opérations, et qu'elle oblige à trancher ce que toutes
les suivantes reprendront : la requête renvoyée qui ne doit pas payer deux fois, la preuve
demandée au titulaire, les plafonds.

**Deux écarts par rapport à ce que nous proposions à la fin du lot 1 :**

- **les fonds réservés ne sont pas dans ce lot.** Un transfert immédiat n'en a pas l'usage :
  les construire sans rien qui s'en serve n'aurait rien prouvé. Ils viendront avec la
  première opération qui retient des fonds entre deux instants — un retrait en attente, un
  séquestre ;
- **le lot n'a pas attendu vos plafonds.** Nous écrivions qu'il ne pourrait pas être terminé
  sans eux. Plutôt que d'attendre, ou d'inventer des montants, les plafonds sont devenus des
  données que votre équipe saisit : le code n'en contient aucun, et tant qu'aucun n'est
  saisi, rien ne part. La décision reste entièrement la vôtre — elle devient « quelles
  valeurs saisir » (décision 5).

| Sujet                        | Réalisation                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfert                    | d'un titulaire à un autre, dans un actif ; **immédiat et définitif**, sans frais ; une seule écriture du grand livre, validée avec le transfert, sa trace au journal d'audit et les avis aux deux parties — ou pas du tout                                                                                      |
| Requête renvoyée             | chaque demande porte une clé choisie par le client (`Idempotency-Key`) : renvoyée, elle ne transfère rien de plus et rend le transfert d'origine ; la même clé pour une autre demande est refusée ; une demande refusée ne retient pas sa clé                                                                   |
| Preuve du titulaire          | le mot de passe est redemandé à chaque transfert, avec le second facteur s'il est activé : une session ouverte ne suffit pas                                                                                                                                                                                    |
| Plafonds                     | par actif et par niveau de vérification (0 à 3) : par transfert, sur 24 heures, sur 31 jours — glissants ; seuls comptent les envois ; un niveau sans plafonds n'envoie ni ne reçoit ; **aucune valeur n'est livrée**                                                                                           |
| Réglage des plafonds         | au back-office, un niveau et un actif à la fois, avec une justification ; effet immédiat ; l'ancien et le nouveau réglage sont au journal d'audit ; des plafonds ne se suppriment pas, ils se ramènent à zéro ; deux permissions nouvelles, réservées à `super_admin`                                           |
| Destinataire                 | désigné par son adresse e-mail ; adresse inconnue, compte suspendu, clôturé, non vérifié, niveau fermé : **un seul et même refus**, prononcé en dernier, et compté — le dixième en 24 heures suspend les transferts du compte pendant 24 heures                                                                 |
| Ce que chaque partie voit    | l'adresse e-mail que porte aujourd'hui le compte de l'autre, et rien d'autre ; les deux sont prévenues par e-mail, chacune dans sa langue                                                                                                                                                                       |
| Ce que le titulaire consulte | ses transferts, envoyés et reçus, page par page ; ce qu'il peut encore envoyer, actif par actif ; chaque transfert, chaque refus et chaque mot de passe erroné dans l'historique de son compte                                                                                                                  |
| Garanties de la base         | PostgreSQL recalcule lui-même le niveau de l'émetteur et le cumul de ses envois, à sa propre horloge ; il refuse un transfert hors plafonds, depuis ou vers un compte qui n'est pas actif, un transfert sans son écriture, une écriture de transfert sans transfert ; un transfert ne se modifie ni ne s'efface |
| Transferts simultanés        | les transferts d'un même émetteur passent un à un : ni plafond dépassé, ni fonds dépensés deux fois ; des transferts croisés ne s'interbloquent pas ; un transfert et la clôture d'une de ses parties, ou la suspension de son émetteur, s'attendent                                                            |
| Bornes                       | 60 demandes par minute et par adresse ; 30 transferts tentés par heure et par compte, aboutis ou refusés                                                                                                                                                                                                        |
| Clôture, copie des données   | des fonds retiennent la clôture : il faut d'abord les envoyer ; les transferts demeurent, et l'autre partie les garde, sans l'adresse du compte clôturé ; la copie des données contient les transferts                                                                                                          |

Détail : [`docs/API.md`](docs/API.md), [`docs/DATABASE.md`](docs/DATABASE.md),
[`docs/SECURITY.md`](docs/SECURITY.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Décision : ADR 0026.

**À savoir :**

- **rien ne peut être transféré aujourd'hui.** La fonctionnalité est fermée, aucun plafond
  n'est fixé, aucun actif n'est enregistré. À la livraison de ce lot, aucune route ne
  créditait un portefeuille, et le parcours rejoué à travers le proxy ne menait aucun
  transfert à son terme : il vérifiait que chaque refus est le bon. Depuis le lot 3, un
  portefeuille se crédite par un ajustement de votre équipe, et ce parcours mène un transfert
  à son terme. La plupart des tests, eux, alimentent toujours les portefeuilles en écrivant
  directement dans le grand livre ;
- **un transfert est définitif** : ni annulation, ni délai de rétractation, ni liste de
  bénéficiaires. Des fonds envoyés à une mauvaise adresse — si elle a un compte — ne
  reviennent que si le destinataire les renvoie ou, depuis le lot 3, si votre équipe les lui
  débite et les recrédite à l'émetteur, par deux ajustements sous double validation ;
- **le mot de passe suffit lorsque le compte n'a pas activé la validation en deux étapes**,
  qui reste facultative pour un titulaire. Qui connaît le mot de passe d'un tel compte peut
  en envoyer les fonds, dans la limite des plafonds. Exiger le second facteur pour
  transférer est possible : c'est un choix de produit (décision 14) ;
- **un changement de plafonds prend effet aussitôt, et une seule personne suffit à le
  faire** — avec une justification, inscrite au journal d'audit. Une valeur saisie par
  erreur s'applique immédiatement ;
- **le destinataire apprend l'adresse e-mail de l'émetteur** : à dire dans vos conditions
  d'utilisation ou votre politique de confidentialité ;
- **aucune surveillance des transactions** : ni filtrage, ni détection de comportements
  (phase 8). Les plafonds sont le seul frein, et ils ne bornent ni ce qu'un compte reçoit,
  ni le total de ses envois tous actifs confondus ;
- **cinq choix de produit ont été faits sans vous** (décision 14) ; chacun se change sans
  reprendre le reste ;
- **le parcours de vérification de la CI ouvre les transferts et les laisse ouverts** :
  comme avant, il est réservé à une pile de test, jamais à une plateforme en service.

**Ce qui change pour un client écrit contre le lot 1** : rien n'est retiré. La copie des
données passe au format 4 (elle contient les transferts) ; l'historique du compte connaît
trois types d'événements de plus ; un mouvement de portefeuille peut être de type
`transfer.internal` ; le catalogue des permissions en compte dix-sept. Liste complète :
[`CHANGELOG.md`](CHANGELOG.md).

**Mise à jour d'une base existante.** La migration n'ajoute que deux tables, leurs règles et
deux permissions : elle s'applique sans arrêter l'API, n'ouvre rien et ne fixe aucun
plafond. Constaté sur la base de l'aperçu, qui contenait 215 comptes : la migration a été
appliquée pendant que la version du lot 1 tournait ; celle-ci a ensuite passé son parcours
complet (143 contrôles) sans une erreur, puis la version du lot 2 le sien (177 contrôles).

### Lot 3 — livré : opérations du personnel

Ce que votre équipe peut faire sur un portefeuille : le **créditer ou le débiter, à deux** ;
le **geler** ; et, par ces deux moyens, **sortir les fonds d'un compte à fermer**. C'est le
lot proposé à la fin du précédent, sans écart de périmètre. Il vient maintenant pour deux
raisons : rien ne permettait de vider un compte suspendu — or un compte qui détient des fonds
ne se clôt pas — ; et, faute de dépôts, rien ne permettait d'éprouver un transfert avec un
vrai solde ailleurs que dans les tests.

Créditer un portefeuille, c'est inscrire des fonds au registre : l'acte le plus sensible du
back-office. Il est donc livré **fermé**, il exige **deux personnes**, et cette exigence est
imposée par la base de données elle-même, pas seulement par le code de l'API.

| Sujet                     | Réalisation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ajustement                | crédit ou débit du portefeuille d'un titulaire, dans un actif, avec une justification ; **une demande, puis l'approbation d'une seconde personne** — rien ne bouge avant ; l'approbation passe une seule écriture du grand livre, le portefeuille contre le compte de conservation de la plateforme, validée avec la décision, sa trace au journal d'audit et l'avis au titulaire — ou pas du tout                                                                                                                       |
| Issue d'une demande       | approuvée ; refusée par un second, avec un motif ; retirée par son auteur ; échue après 72 heures sans décision ; une demande décidée ne se rouvre pas, et un ajustement approuvé ne s'annule pas : il se corrige par un ajustement inverse, lui aussi à deux                                                                                                                                                                                                                                                            |
| Quatre yeux               | nul ne prend part à l'ajustement de son propre portefeuille ; l'approbation et le refus viennent d'un autre que l'auteur de la demande ; une seule demande identique — même portefeuille, même sens, même montant — peut être en attente : une demande renvoyée par erreur ne s'approuve pas deux fois                                                                                                                                                                                                                   |
| Preuve de l'approbateur   | son mot de passe et son second facteur lui sont redemandés à l'approbation, et vérifiés avant tout examen de la demande : une session ouverte ne suffit pas à créditer                                                                                                                                                                                                                                                                                                                                                   |
| Montants                  | strictement positifs, à la précision de l'actif — rien n'est arrondi ; un débit ne dépasse jamais le solde, à la demande comme à l'approbation ; **aucun montant maximal**                                                                                                                                                                                                                                                                                                                                               |
| Gel d'un portefeuille     | celui d'un titulaire dans un actif, avec une justification : **plus aucune écriture n'y passe**, ni envoi ni réception, hors les ajustements ; le solde demeure, les autres portefeuilles ne sont pas touchés ; un gel se lève, avec une justification, et reste consultable une fois levé                                                                                                                                                                                                                               |
| Ce que voit le titulaire  | son portefeuille marqué gelé, et ses transferts refusés pour ce motif — jamais la raison ; un e-mail à chaque crédit et à chaque débit, dans sa langue ; les crédits, débits, gels et levées dans l'historique de son compte ; qui lui envoie des fonds reçoit le refus ordinaire du destinataire, sans apprendre le gel                                                                                                                                                                                                 |
| Sortie des fonds          | un débit sous double validation passe sur un compte suspendu et sur un portefeuille gelé ; des fonds retiennent la clôture, un portefeuille gelé aussi : on débite, on lève le gel, on clôt — la plateforme rend les fonds hors de l'API                                                                                                                                                                                                                                                                                 |
| Qui peut quoi             | six permissions nouvelles : consulter, demander, approuver un ajustement ; consulter, poser, lever un gel ; `super_admin` les détient toutes ; `compliance` consulte et pose les gels, sans pouvoir en lever un ni prendre part à un ajustement ; `support`, aucune                                                                                                                                                                                                                                                      |
| Garanties de la base      | PostgreSQL vérifie lui-même que le demandeur et l'approbateur sont actifs et habilités au moment d'écrire, qu'ils sont deux et qu'aucun n'est le titulaire, que la demande n'est pas échue — à sa propre horloge —, qu'un ajustement approuvé a son écriture, exactement la sienne, et qu'une écriture d'ajustement a son ajustement ; il refuse toute ligne sur un portefeuille gelé, quelle que soit l'opération, et la clôture d'un compte au portefeuille gelé ; ni demande ni gel ne se réécrivent ni ne s'effacent |
| Opérations simultanées    | un gel attend l'écriture en cours sur le portefeuille, et toute écriture qui le suit le voit : aucun mouvement n'est validé après lui ; de deux approbations simultanées d'une demande, une seule passe ; de deux gels d'un même portefeuille, un seul est posé                                                                                                                                                                                                                                                          |
| Ouverture                 | les ajustements sont une fonctionnalité **fermée par défaut** : demander et approuver l'exigent ; consulter, refuser et retirer restent possibles, pour clore ce qui attendait ; geler et lever ne dépendent d'aucune ouverture ; tout reste accessible pendant la maintenance                                                                                                                                                                                                                                           |
| Traces, copie des données | chaque demande, chaque décision, chaque tentative refusée et chaque consultation est au journal d'audit, qui garde les justifications ; la copie des données d'un titulaire, au format 5, dit quel portefeuille est gelé et contient les mouvements d'ajustement — sans aucune justification ; les demandes échues sont closes à chaque lecture, à chaque demande, à chaque décision et par la tâche horaire                                                                                                             |

Détail : [`docs/API.md`](docs/API.md), [`docs/DATABASE.md`](docs/DATABASE.md),
[`docs/SECURITY.md`](docs/SECURITY.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Décision : ADR 0027.

**À savoir :**

- **un crédit vaut ce que valent les deux personnes qui l'ont décidé.** Rien ne le rapproche
  de fonds réellement détenus, et aucun montant maximal ne le borne : deux personnes
  habilitées qui s'entendent — ou deux comptes d'administration compromis — créditent
  n'importe quel portefeuille du montant qu'elles veulent. Chaque ajustement est tracé,
  ineffaçable, et signalé au titulaire — après coup : rien ne l'empêche. La procédure qui
  fonde un ajustement est à écrire avant toute ouverture (décision 15) ;
- **à la livraison de ce lot, la base de données ne fermait pas la liste des types
  d'écriture** — corrigé depuis par le lot 4. Elle refusait une écriture d'ajustement sans
  son ajustement approuvé par deux personnes ; elle ne refusait pas une écriture équilibrée
  d'un **autre** type qui créditerait un portefeuille. La double validation était donc la
  seule route **de l'API** qui apporte des fonds ; elle ne protégeait pas de qui écrirait
  dans la base avec les identifiants de l'API. Ce qui en reste est dit au lot 4 ;
- **il faut deux administrateurs**, chacun avec la validation en deux étapes : seul
  `super_admin` prend part à un ajustement, et il n'existe pas de rôle « finance ». Avec un
  seul administrateur, aucun ajustement n'aboutit ;
- **lever un gel est l'acte d'une seule personne** — aujourd'hui un `super_admin`. La
  conformité gèle, elle ne lève pas. À revoir avant l'ouverture, si une levée doit elle aussi
  se décider à deux ;
- **un gel n'est pas discret.** Le titulaire voit son portefeuille gelé et ses transferts
  refusés pour ce motif ; il n'en lit pas la raison. Pour une mesure qui ne doit pas alerter
  la personne visée, ce n'est pas l'outil. Et le support ne consulte pas les gels : il ne
  peut pas dire à un titulaire pourquoi ses transferts sont refusés ;
- **un gel porte sur un portefeuille, pas sur un compte.** Le compte reste utilisable, et ses
  autres portefeuilles aussi. Pour tout arrêter, la suspension du compte existe déjà ;
- **les justifications sont des textes libres, conservés sans limite de durée** — celle d'une
  demande, d'un refus, d'un gel, d'une levée. Ce qu'on y écrit d'une personne y reste, même
  après la clôture de son compte. Elles ne sont jamais montrées au titulaire, ni dans la
  copie de ses données : à faire confirmer avec le reste (décision 6) ;
- **après un gel, ne pas revenir à la version précédente de l'API.** Elle ignore les gels :
  un transfert depuis ou vers un portefeuille gelé y est bien refusé — par la base —, mais
  par une erreur serveur (`500`) au lieu du refus prévu. Constaté sur la base de l'aperçu ;
  rien ne bouge. Lever les gels avant un retour en arrière, ou l'éviter ;
- **huit choix ont été faits sans vous** (décision 15) ; chacun se change sans reprendre le
  reste ;
- **le parcours de vérification de la CI crédite un portefeuille**, ouvre les ajustements et
  les laisse ouverts : il reste réservé à une pile de test, jamais à une plateforme en
  service. Il lui faut désormais un second administrateur.

**Ce qui change pour un client écrit contre le lot 2** : rien n'est retiré. Chaque
portefeuille porte `frozen` ; la copie des données passe au format 5 ; l'historique du compte
connaît quatre types d'événements de plus ; un transfert peut être refusé par `WALLET_FROZEN`
(403), et une clôture (409) parce qu'un portefeuille est gelé ; un mouvement de portefeuille
peut être de type `adjustment.credit` ou `adjustment.debit` ; l'état de la plateforme annonce
`manualAdjustments` ; le catalogue des permissions en compte vingt-trois, et `compliance` en
détient sept. Liste complète : [`CHANGELOG.md`](CHANGELOG.md).

**Mise à jour d'une base existante.** La migration n'ajoute que deux tables, leurs règles et
six permissions : elle s'applique sans arrêter l'API, n'ouvre rien, ne gèle rien et ne
crédite rien. Constaté sur la base de l'aperçu, qui contenait 219 comptes : la migration a
été appliquée, en moins de deux secondes, pendant que la version du lot 2 tournait ; celle-ci
a ensuite passé son parcours complet (177 contrôles) sans une erreur, puis la version du
lot 3 le sien (251 contrôles), avec deux administrateurs créés pour l'occasion. Une réserve,
décrite ci-dessus : une fois un portefeuille gelé, la version précédente ne sait plus
répondre proprement à un transfert qui le touche.

### Retouches du socle — livrées : base saturée, erreurs des tâches de fond

Les deux corrections proposées à la fin du lot 3, faites avant le lot suivant. Elles
n'ajoutent aucune fonctionnalité et ne touchent pas à la base de données — aucune route
nouvelle, aucune migration — ; une réponse de l'API change.

**Une base saturée répond « réessayez dans cinq secondes », et non plus « erreur ».** Quand
toutes les connexions de l'API à la base sont occupées, une requête de plus attend — deux
secondes pour une transaction, cinq pour le reste —, puis elle est abandonnée **sans avoir
commencé**. L'API répondait alors `500`, comme pour un défaut du programme ; elle répond
maintenant `503`, avec l'en-tête `Retry-After: 5`. L'opération refusée n'a rien écrit ; la
requête se renvoie telle quelle, et un transfert renvoyé sous la même clé n'est fait qu'une
fois. La supervision y lit une surcharge, non une panne. Rejouée, la rafale de 72 transferts
qui avait révélé le défaut — chaque validation retardée de 100 ms — voit 30 transferts
refusés faute de connexion : les 30 refus sont reconnus pour ce qu'ils sont.

**Ce que les tâches de fond signalent s'écrit dans les journaux, au bon format.** Une
connexion à Redis perdue, une tâche qui perd son verrou, un passage du relais ou de la purge
en échec : chacun laisse désormais une ligne structurée, avec le nom de sa file. Jusque-là,
la bibliothèque qui tient les files écrivait elle-même, hors format — ou rien n'était écrit
du tout. Une même erreur ne s'écrit qu'une fois par demi-minute, avec le nombre de ses
répétitions.

**Éprouvé en provoquant les pannes**, sur l'API compilée, lancée seule contre un PostgreSQL
et un Redis réels, avant puis après la correction :

| Panne provoquée              | Avant                                                  | Désormais                              |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Redis arrêté 12 secondes     | 120 erreurs brutes, hors des journaux structurés       | 6 lignes structurées                   |
| Redis arrêté 40 secondes     | 150 erreurs brutes                                     | 12 lignes, qui en annoncent 129 autres |
| Base supprimée huit secondes | **aucune ligne** pour huit passages du relais en échec | une ligne                              |

**Le défaut était plus large que le constat.** Celui-ci visait les erreurs des trois
exécutants de tâches ; l'essai a montré que les trois files en émettent autant, et qu'un
passage du relais en échec ne laissait de ligne nulle part. Les trois sont corrigés.

**Six choix techniques ont été faits sans vous** (ADR 0028, décision 16) : la saturation se
reconnaît au message de l'erreur, faute de code — un test la provoque pour de vrai, et
échouera si une mise à jour en change les termes — ; le délai annoncé est de cinq secondes ;
ces lignes sont de niveau « erreur » ; l'API ne relance pas elle-même une requête refusée ;
une ligne par demi-minute et par erreur ; les passages en échec du relais et de la purge sont
écrits eux aussi, ce que le constat ne demandait pas.

**Ce que ces essais ont trouvé d'autre** — deux comportements antérieurs à ces retouches : si
Redis revenait **vide**, plus aucun message ne partait jusqu'au redémarrage de l'API, sans
que rien le signale ; et l'API ne s'arrêtait pas d'elle-même tant que Redis était
injoignable. **Corrigés depuis** : section suivante.

**Ce qui change pour un client** : toute route peut répondre `503` avec `Retry-After` ; il
attend ce délai, puis renvoie sa requête. Rien d'autre. Détail :
[`CHANGELOG.md`](CHANGELOG.md) ; pour l'exploitation,
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), « Saturation et pannes ». Décision : ADR 0028.

### Robustesse du socle — livrée : tâches planifiées surveillées, arrêt borné

Les deux corrections proposées à la fin des retouches précédentes, et une troisième, trouvée
en reprenant l'arrêt. Elles n'ajoutent aucune fonctionnalité et ne touchent pas à la base de
données — aucune route nouvelle, aucune migration. **Rien ne change pour un client de
l'API** ; trois choses changent pour l'hébergement, dites plus bas.

**Un Redis revenu vide ne coupe plus les messages.** Les deux tâches planifiées de l'API — le
relais, par lequel partent les codes de vérification, et la purge — n'existent que dans
Redis, et l'API ne les y inscrivait qu'à son démarrage. Si Redis perdait ses données, elles
disparaissaient, et plus rien ne partait jusqu'au redémarrage de l'API, sans aucun signal.
Désormais, chaque instance vérifie toutes les trente secondes que ses tâches sont dans Redis
et à l'heure, réinscrit celle qui ne l'est pas, et l'écrit dans les journaux, au niveau
« erreur ». L'essai qui avait révélé le défaut, refait : Redis arrêté 12 secondes puis
relancé sans ses données, les deux tâches sont réinscrites 14 à 18 secondes après son retour,
et l'événement resté en attente part aussitôt — sans redémarrage.

**L'API s'arrête en un temps borné.** À la demande d'arrêt, elle fermait d'abord ses tâches
de fond, puis son serveur ; or, sans Redis, la première étape ne finissait jamais : elle
continuait de répondre, et il fallait la tuer. Désormais elle **cesse aussitôt d'accepter des
connexions**, mène à leur terme les requêtes et les tâches en cours, ferme le reste — et, si
cela n'a pas abouti après huit secondes, s'arrête quand même, en l'écrivant.

**Une requête en cours à l'instant de l'arrêt reçoit sa réponse.** C'est le troisième défaut,
antérieur lui aussi : la base était fermée avant que le serveur ait fini de répondre. Une
requête qui écrivait à cet instant recevait une erreur, et son écriture était annulée — rien
n'était perdu, mais le client devait recommencer. Un test écrit pour vérifier que les
requêtes en cours vont à leur terme l'a montré. La base se ferme désormais en dernier.

**Éprouvé en provoquant les pannes**, sur l'API compilée, lancée seule contre un PostgreSQL
et un Redis réels, avant puis après la correction :

| Essai                                                            | Avant                                                   | Désormais                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Redis revenu vide après 12 secondes                              | plus aucun message, jusqu'au redémarrage ; aucun signal | tâches réinscrites en 14 à 18 secondes ; deux lignes au journal |
| Redis revenu avec ses données                                    | reprise en 16 secondes                                  | de même ; aucune réinscription                                  |
| Arrêt en service normal                                          | un dixième de seconde                                   | de même                                                         |
| Arrêt cinq secondes après la perte de Redis                      | tourne et répond encore vingt secondes plus tard        | ne répond plus dans la seconde ; arrêtée en huit                |
| Arrêt huit secondes après le retour d'une coupure de 40 secondes | de même, jusqu'à plus de deux minutes                   | arrêtée en huit secondes                                        |
| Arrêt pendant qu'une requête écrit en base                       | la requête reçoit une erreur                            | la requête reçoit sa réponse                                    |

Les deux premiers arrêts ont été refaits dans la position qu'occupe l'API dans son image
Docker — premier processus de son conteneur —, sans Docker, que cet environnement n'a pas :
mêmes résultats.

**Ce qui n'a pas été fait, et pourquoi :**

- **La sonde de disponibilité ne signale pas les tâches manquantes**, contrairement à ce que
  la proposition annonçait. Cette sonde sert à retirer une instance du trafic. Or toutes les
  instances partagent les mêmes tâches : elles se seraient déclarées indisponibles toutes
  ensemble, et tout le service aurait été coupé pour un retard que l'API répare seule en
  moins d'une minute. Le signal est une ligne du journal. À confirmer (décision 16) ;
  l'ajouter à la sonde reste possible, et court.
- **Sous Docker, aucune étape ne vérifie l'arrêt.** La CI arrête la pile sans rien en exiger,
  et ne peut pas être modifiée d'ici. Son journal en donne seulement la durée, pour l'arrêt
  sans incident : le conteneur de l'API arrêté 85 millisecondes après la demande
  (« Intégration continue »). Ni le code de sortie, ni l'arrêt pendant une panne n'y
  figurent.
- **Aucun test automatique n'envoie un vrai signal à un vrai processus.** Les tests lancent
  l'API comme en service, mais lui fournissent ses signaux ; le signal réel a été éprouvé à
  la main, comme ci-dessus.
- **La première seconde du lancement en conteneur.** Pendant le chargement du programme,
  l'API n'écoute pas encore : une demande d'arrêt reçue à cet instant est ignorée, et
  l'hébergeur force l'arrêt à l'expiration de son délai. Antérieur à ces corrections, non
  corrigé (« Problèmes identifiés »).

**Ce qui change pour l'hébergement** : un arrêt propre se termine par le code 0 — il se
terminait par 143 hors conteneur — et un code 1 signifie un arrêt coupé à son échéance ; dès
la demande d'arrêt, l'API refuse les connexions nouvelles ; le délai que l'hébergeur accorde
avant de forcer l'arrêt doit dépasser huit secondes — dix sont désormais écrites dans la pile
Docker du dépôt. Détail : [`CHANGELOG.md`](CHANGELOG.md) ; pour l'exploitation,
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), « Au retour de Redis » et « Arrêt de l'API ».
Décision : ADR 0029.

**Sept choix techniques ont été faits sans vous** (ADR 0029, décision 16) : la sonde ne dit
rien des tâches ; vérification toutes les trente secondes, retard toléré d'une minute ; la
ligne de réinscription est de niveau « erreur » ; huit secondes pour s'arrêter ; code de
sortie 0 pour un arrêt propre ; refus des connexions dès le signal ; à l'échéance, ce qui est
en cours est coupé.

### Lot 4 — livré sans votre confirmation : la base n'accepte plus d'écriture hors d'une opération

**Ce lot n'avait pas été confirmé.** L'état précédent le présentait comme « à confirmer par
vous — rien n'en est commencé ». Votre message suivant a été « continue » : il a été pris
pour un accord. **Si ce n'était pas votre intention, dites-le** : le lot tient en une
migration, quelques lignes de code et des tests ; il se retire en annulant ses commits, sans
toucher au reste — aussi longtemps que sa migration n'a été appliquée à aucune base que vous
gardez. Il a aussi été fait **plus large que proposé**, pour une raison donnée plus bas.

**Ce qu'il corrige.** Le défaut relevé au lot 3 (« Problèmes identifiés », lot 3, point 1).
Le grand livre vérifiait d'une écriture l'arithmétique — entière, équilibrée, sans solde
négatif — et, pour les seules écritures de transfert et d'ajustement, l'opération qui les
fonde. Une écriture équilibrée d'un type quelconque, écrite dans la base avec les
identifiants de l'API, passait donc : elle pouvait **créditer un portefeuille depuis le
compte de conservation**, sans double validation, ou **déplacer des fonds d'un portefeuille à
un autre**, sans plafond ni niveau de vérification. Aucune route de l'API ne le permettait :
il fallait écrire dans la base, à côté d'elle.

| Sujet                    | Réalisation                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liste des types          | la base tient la liste des types d'écriture — trois à ce jour : le transfert entre titulaires, le crédit et le débit de votre équipe ; la même liste est dans le code, et un test échoue si elles diffèrent                                                     |
| Écriture d'un autre type | refusée d'emblée, avant qu'aucun montant soit écrit, sous tous les rôles — celui de l'API, le propriétaire des tables, le superutilisateur de la base — et quel que soit l'auteur qu'elle désigne ; aucun solde ne bouge                                        |
| Écriture d'un type connu | validée seulement avec son opération, comme avant : son transfert, avec ses plafonds, ou son ajustement approuvé par deux personnes                                                                                                                             |
| Étendre la liste         | par une migration seulement, avec le rôle propriétaire des tables ; le rôle de l'API ne fait que lire la liste, et n'y ajouterait rien même si le droit d'y écrire lui était rendu par erreur ; un type ne se modifie ni ne se retire, même par le propriétaire |
| Dans l'API               | aucune route, aucun contrat ne change ; si le code passait un jour une écriture d'un type inconnu, ce serait un défaut — erreur serveur, rien d'écrit, une ligne au journal                                                                                     |

Détail : [`docs/DATABASE.md`](docs/DATABASE.md), [`docs/SECURITY.md`](docs/SECURITY.md),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Décision : ADR 0030.

**Plus large que ce qui était proposé.** La proposition était de faire de toute ligne passée
sur le compte de conservation la ligne d'une opération que la base connaît. En relisant les
règles avant de les écrire, le même chemin existait d'un portefeuille à un autre, sans passer
par ce compte : une règle sur le seul compte de conservation l'aurait laissé ouvert. La règle
retenue est donc une liste fermée des types d'écriture, qui ferme les deux. C'est le premier
des cinq choix à confirmer.

**Éprouvé.** Sur une base telle que les migrations la laissent, sans aucun aménagement pour
les tests : un crédit depuis le compte de conservation, un déplacement d'un portefeuille à un
autre, une sortie vers le compte de conservation — chacun refusé, soldes inchangés ; treize
types voisins d'un type connu, refusés ; une table de même nom glissée par une session ne
trompe pas la règle ; et les opérations réelles — un crédit, un transfert, un débit —
passent. **L'essai du 15 novembre, qui avait révélé le défaut, a été refait à l'identique sur
la base de l'aperçu, la migration appliquée** — même commande, même portefeuille, mêmes
identifiants de l'API : refusé, et rien n'a bougé.

**Mise à jour d'une base existante.** La migration ajoute une table de trois lignes et une
règle sur les écritures. Elle ne relit, ne modifie ni ne retire aucune écriture existante ;
elle n'ouvre rien et ne déplace rien. Constaté sur la base de l'aperçu, qui contenait 230
comptes et sept écritures : appliquée en moins de deux secondes pendant que la version
précédente de l'API tournait ; celle-ci a ensuite passé son parcours complet — 249 contrôles,
double validation, transfert et débit compris — sans une erreur, puis la nouvelle version le
sien. **La version précédente fonctionne donc sur la base migrée** : aucun ordre de mise en
service n'est imposé, et un retour en arrière ne demande rien. Avant de migrer une base qui a
déjà servi, une requête recense les écritures d'un autre type
([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), « Grand livre ») : un résultat non vide
désignerait des écritures faites à côté de l'API.

**À savoir :**

- **ce n'est pas une protection complète contre qui détient les identifiants de l'API.** Il
  ne passe plus d'écriture libre ; il peut encore écrire **une opération entière** : un
  ajustement, avec sa demande et son approbation, au nom de deux membres habilités de votre
  équipe — la base vérifie leur qualité, pas leur présence —, ou un transfert dans les
  plafonds. Il laisserait à leur nom des traces ineffaçables. Ces identifiants restent à
  protéger comme ceux d'un compte qui peut créditer ;
- **les écritures déjà passées ne sont pas réexaminées.** Une écriture ne se modifie ni ne
  s'efface : celle de l'essai du 15 novembre reste dans la base de l'aperçu, sous son type
  inventé. Aucune base de production n'existe encore. _Depuis le lot 5, la vérification
  horaire la signale, à chaque passage ;_
- **la vérification horaire du grand livre n'était pas étendue par ce lot.** Elle recalculait
  les soldes et les équilibres ; elle ne relisait ni le type des écritures, ni leur lien à
  une opération. _Elle les relit depuis le lot 5, ci-dessous ;_
- **un type ajouté à la liste sans la règle qui le lie à son opération rouvrirait le
  chemin.** Chaque opération à venir — dépôt, retrait, échange — devra apporter les deux,
  dans la même migration. Un test le garde pour les types présents : il relit dans la base
  les règles posées sur les écritures, et exige que chaque type ait la sienne. Rien, dans la
  base, ne l'impose ;
- **les tests du grand livre gardent des écritures d'essai** — à cinq lignes, sur plusieurs
  actifs, sur le compte des frais —, qu'aucune opération ne produit encore. Chaque fichier de
  tests concerné déclare leurs types dans sa propre base jetable, avec le rôle propriétaire,
  comme le ferait une migration. Dix fichiers le font. Le fichier de tests de ce lot, lui,
  travaille sur la base telle que les migrations la laissent, et le parcours de la CI aussi ;
- **la pile Docker n'a pas été répétée ici pour ce lot.** Les lots précédents l'étaient hors
  Docker, à travers un Nginx compilé pour l'occasion, qui n'existe plus dans cet
  environnement. Ce lot ne change aucun fichier d'infrastructure ; le parcours complet a été
  exécuté sur l'aperçu, à travers son relais et non à travers Nginx. C'est l'intégration
  continue qui l'exécute dans la pile Docker (« Intégration continue ») ;
- **cinq choix ont été faits sans vous** (décision 17).

### Lot 5 — livré : la vérification horaire relit le type des écritures et leur opération

**Ce que vous avez approuvé, et ce qui a été décidé sans vous.** L'état précédent proposait
d'« étendre la vérification horaire du grand livre au type des écritures et à leur lien avec
une opération ». Votre réponse a été « vas y » : elle a été lue comme votre accord pour cette
étape, et comme le maintien du lot 4, sur lequel elle repose. **Si ce n'était pas votre
intention, dites-le** : ce lot ne contient aucune migration et se retire en annulant ses
commits. **Les choix faits en le construisant ne vous ont pas été soumis** (décision 18) ; et
vos réponses aux décisions 16 et 17 restent attendues.

**Ce qu'il corrige.** La base refuse, à l'instant où elle s'écrit, une écriture d'un type
inconnu ou sans son opération. Mais une règle à l'écriture ne dit rien de ce qui est déjà
écrit, ni de ce qui s'écrit pendant qu'elle est suspendue — ce que le rôle de l'API ne peut
pas faire, mais que peut le propriétaire des tables, et que produirait aussi une restauration
partielle. La vérification horaire, elle, recalculait les soldes et les équilibres : **une
écriture entière et équilibrée, que personne n'avait demandée, lui paraissait saine**. Un
test de ce lot l'établit : un portefeuille crédité depuis le compte de conservation, sans
demande ni approbation, la règle suspendue, n'est relevé par aucun des contrôles qui
existaient.

| Sujet                           | Réalisation                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Écriture d'un type inconnu      | relevée : une écriture dont le type n'est pas dans la liste que tient la base — c'est le cas de l'écriture d'essai du 15 novembre, sur l'aperçu                                                                                     |
| Transfert et son écriture       | relevé, un transfert dont l'écriture n'est plus la sienne : son type, ses deux lignes exactement, leur sens, leur montant, leur monnaie, le portefeuille de l'émetteur et celui du destinataire — ou dont l'écriture n'existe pas   |
| Écriture de transfert orpheline | relevée : des fonds passés d'un portefeuille à un autre sans qu'aucun transfert l'ait demandé — donc sans plafond ni niveau de vérification                                                                                         |
| Ajustement et son écriture      | relevé de même, pour un ajustement approuvé : type, deux lignes, sens, montant, monnaie, portefeuille du titulaire, compte de conservation                                                                                          |
| Écriture d'ajustement orpheline | relevée : un crédit ou un débit que ne désigne aucun ajustement **approuvé** — un ajustement refusé, retiré ou échu ne compte pas                                                                                                   |
| Comment                         | chaque contrôle reprend, condition pour condition, la règle que la base applique à l'écriture : ce qu'elle refuse alors est ce qui est relevé après coup                                                                            |
| Ce que vous en voyez            | comme pour les anomalies existantes : une erreur dans les journaux, une ligne au journal d'audit, l'étape en échec à chaque passage — avec le nom de l'anomalie et l'identifiant de l'opération ou de l'écriture, jamais un montant |
| Contrôle qui ne s'exécute pas   | si l'un des trois contrôles ne peut pas s'exécuter — la base ne répond pas à temps —, les deux autres s'exécutent quand même ; l'étape échoue dans tous les cas, et nomme celui qui a manqué                                        |
| Dans l'API                      | aucune route, aucun contrat, aucune migration ne change                                                                                                                                                                             |

Détail : [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (« Vérification horaire » : les dix
anomalies, ce que portent les journaux), [`docs/DATABASE.md`](docs/DATABASE.md),
[`docs/SECURITY.md`](docs/SECURITY.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Décision : ADR 0031.

**Éprouvé.** Sur une base telle que les migrations la laissent, où un crédit approuvé, un
transfert et un débit approuvé ont été écrits sous le rôle de l'API, toutes règles en
vigueur. Chaque condition de chaque règle y est altérée à son tour, avec le rôle
propriétaire, règles suspendues : chacune est relevée, sous son nom, et la vérification ne
relève plus rien une fois l'altération défaite. Trois écritures entières et équilibrées sont
passées sans leur opération — un crédit, un débit, un mouvement entre deux titulaires :
chacune est relevée, **et par ce lot seulement**. Un contrôle est arrêté pour de vrai par le
délai que la base accorde à une requête — une autre session tient la table des transferts,
rien n'est simulé : il échoue seul, et l'étape le nomme. Enfin, les quatre fichiers de tests
qui passent de vrais transferts et de vrais ajustements, par les services et par les routes
de l'API, se terminent désormais par la vérification : **elle n'y relève rien**.

**À savoir :**

- **sur l'aperçu, la vérification échoue désormais à chaque passage.** L'écriture d'essai
  du 15 novembre y est d'un type que la base ne connaît pas ; une écriture ne s'efface pas,
  et rien ne permet d'acquitter une anomalie. C'est le comportement décidé, non un défaut —
  et c'est la seule anomalie que les trois contrôles relèvent sur cette base. Chaque passage
  y laisse une erreur dans les journaux et une ligne au journal d'audit. Le faire cesser
  demande de recréer la base de l'aperçu, ce qui efface ses comptes : **rien n'a été fait
  sans vous** (décision 18) ;
- **avant de mettre en service cette version sur une base qui a déjà servi**, la requête de
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (« Grand livre ») recense les écritures d'un
  type inconnu : chacune ferait échouer la vérification toutes les heures. Aucune base de
  production n'existe encore ;
- **elle relève, elle n'empêche pas, et elle ne prévient personne.** L'alerte reste à
  brancher (phase 9) : d'ici là, une anomalie n'est vue que de qui lit les journaux ;
- **ce qui dépendait du moment n'est pas relu** : les plafonds et le niveau de vérification à
  l'heure d'un transfert, les permissions de ceux qui ont demandé et approuvé un ajustement,
  un gel alors en vigueur. Ces règles dépendent d'un état qui a pu changer depuis, et que
  rien ne conserve à la date de l'opération. Les demandes d'ajustement non approuvées ne sont
  pas relues non plus ;
- **ce n'est toujours pas une protection contre qui détient les identifiants de l'API.** Une
  opération entière écrite avec eux — un ajustement, sa demande et son approbation — est une
  opération en règle pour la base : la vérification ne la signale pas. Elle établit qu'une
  opération existe et correspond à son écriture, non qu'elle était justifiée ;
- **un type ajouté à la liste à la main, par le propriétaire des tables, n'est pas signalé.**
  La vérification compare le type d'une écriture à la liste que tient la base, non à celle du
  code : elle relève ce que la base aurait refusé. Un test le montre ;
- **sa durée n'a jamais été mesurée sur un registre volumineux.** Elle fait maintenant trois
  lectures complètes par passage au lieu d'une — le registre, tous les transferts, tous les
  ajustements approuvés —, chacune limitée par le délai que la base accorde à une requête
  (quinze secondes par défaut). Une lecture qui le dépasserait échouerait à chaque passage,
  sans avoir rien vérifié : l'étape échouerait, le journal le dirait, et ce serait le signal
  qu'il faut découper la relecture. Sans conséquence aujourd'hui ;
- **les règles existent désormais en deux exemplaires** : dans la base, qui les applique à
  l'écriture, et dans les contrôles, qui les relisent. Rien ne les compare mécaniquement ; ce
  sont les tests qui altèrent une à une les données sur lesquelles porte chaque condition.
  Une condition ajoutée plus tard à une règle devra l'être aussi à son contrôle ;
- **chaque opération à venir devra apporter son contrôle**, avec son type d'écriture et sa
  règle. Un test le garde : il donne chaque type du produit à une écriture qui n'en est pas,
  et exige qu'elle soit relevée. Rien ne l'impose au démarrage de l'API ;
- **la pile Docker n'a pas été répétée ici pour ce lot**, comme pour le lot 4 : il ne change
  aucun fichier d'infrastructure, et c'est l'intégration continue qui l'exécute dans la pile
  Docker. Son parcours ne peut pas déclencher la vérification horaire, ni en lire le
  résultat : dans la CI, ce lot n'est éprouvé que par les tests ;
- **cinq choix ont été faits sans vous** (décision 18).

### Suite proposée de la phase 3

À confirmer par vous — rien n'en est commencé :

- **Les fonds réservés**, avec la première opération qui en a l'usage (un retrait en attente
  de validation, par exemple), puis le **rapprochement** avec les fonds réellement détenus.
- **Mesurer la vérification horaire sur un registre volumineux**, puis la découper si
  nécessaire : elle fait trois lectures complètes par passage, et sa durée n'a jamais été
  mesurée. Court.
- **Selon vos réponses à la décision 15** : un montant maximal par ajustement, la double
  validation de la levée d'un gel, un rôle « finance » distinct de `super_admin`. Aucun n'est
  commencé ; chacun est court.
- **Deux restes du socle, courts et sans urgence** (« Problèmes identifiés ») : pendant une
  coupure de Redis, une requête met jusqu'à neuf secondes à échouer ; pendant la première
  seconde de son lancement en conteneur, l'API ignore une demande d'arrêt.

Dépôts et retraits réels relèvent des phases 4 (paiements) et 5 (blockchain) : ils supposent
un prestataire, et l'autorisation correspondante (décision 11).

## Résultats de tests

Exécution du 2026-11-23 — Node.js 24.22.2, pnpm 12.18.0, PostgreSQL 18.6, Redis 8.10.3.

| Vérification                     | Résultat                         |
| -------------------------------- | -------------------------------- |
| `pnpm format:check`              | conforme                         |
| `pnpm lint` (`--max-warnings 0`) | 0 erreur, 0 avertissement        |
| `pnpm build`                     | réussi                           |
| `pnpm typecheck`                 | 0 erreur                         |
| `pnpm db:check-drift`            | aucune différence                |
| `pnpm audit --prod`              | aucune vulnérabilité connue      |
| `pnpm test`                      | **2 246 tests réussis, 0 échec** |

| Suite                     | Tests | Services réels                                  |
| ------------------------- | ----- | ----------------------------------------------- |
| `@mgx/shared` (montants)  | 103   | —                                               |
| `@mgx/validation`         | 96    | —                                               |
| `@mgx/contracts`          | 71    | —                                               |
| API — unitaires           | 644   | —                                               |
| API — intégration         | 718   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |
| API — bout en bout (HTTP) | 614   | PostgreSQL, Redis, BullMQ, serveur SMTP de test |

Les 1 332 tests d'intégration et de bout en bout passent aussi lorsque chaque validation
d'une transaction est retardée de 25 ms — 1 328 d'une traite, puis, en entier, les quatre
fichiers auxquels un test a été ajouté ensuite. Cette répétition « disque lent » a été ajoutée après
le lot 3 de la phase 3 : le PostgreSQL de l'environnement de développement valide sans
attendre le disque, à la différence de celui de la CI et d'une installation réelle, et un
test qui dépendait de cette durée a échoué une fois dans la CI. À 100 ms, bien au-delà de ce
que demande un disque en bon état — mesure faite sur les 1 261 tests du lot 3, et non refaite
en entier depuis —, tous passaient sauf un, qui lance 72 transferts à la fois : la base ne
suit plus. L'API aurait alors répondu `500` ; elle répond désormais `503`, avec le délai
avant de réessayer (voir « Problèmes identifiés », lot 3, points 8 et 9, et « Retouches du
socle »).

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
- **base saturée** : provoquée avec un vrai pool de connexions, elle donne `503` et le délai
  avant de réessayer ; la transaction refusée n'a rien exécuté ; une écriture du grand livre
  refusée ne laisse rien, et passe une fois lorsqu'elle est renvoyée sous la même clé ; une
  requête authentifiée n'est pas prise pour une session invalide, ni une connexion pour un
  mot de passe erroné ; une transaction trop longue et une base injoignable restent des
  erreurs ;
- **tâches de fond** : chaque file et chaque exécutant de l'application est écouté ; ce
  qu'ils signalent est écrit avec le nom de la file ; un passage du relais qui échoue à
  chaque échéance n'écrit qu'une ligne ; l'échec du traitement d'un événement en écrit une à
  chaque fois ;
- **tâches planifiées** : Redis vidé sous l'application, elle réinscrit ses deux tâches et
  relaie de nouveau, sans être redémarrée ; une tâche dont seule l'exécution en attente a
  disparu est réinscrite aussi ; une vérification ne touche pas une tâche saine ; chaque
  tâche est inscrite à sa cadence ; un test parcourt Redis et échoue si une tâche planifiée
  n'est pas surveillée ;
- **arrêt** : sur l'application réelle à l'écoute d'un port, une connexion nouvelle est
  refusée dès la demande ; la requête en cours reçoit sa réponse, y compris au milieu d'une
  écriture en base ; la tâche de fond en cours s'achève ; l'arrêt achevé, plus aucune
  connexion à la base ne reste ; si la fermeture n'aboutit pas, le processus se termine à
  l'échéance, par le code 1 ; le lancement réel installe cet arrêt, et un signal reçu avant
  que l'API soit prête y met fin aussitôt ;
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
- **chaque route ouverte au titulaire, croisée par la clôture de son compte** : 30 requêtes —
  session, mot de passe, second facteur, téléphone, profil, dossiers et pièces, copie des
  données, conditions d'utilisation —, chacune à deux moments : une fois authentifiée et
  avant tout traitement, puis à
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
  tronquée ;
- **conditions d'utilisation** : sans version publiée, personne ne s'inscrit ; l'inscription
  et l'acceptation ne valent que pour la version en vigueur, désignée par son numéro ; le
  texte lu est le texte publié, à l'octet près — fins de ligne mêlées, tabulations, accents,
  émojis —, et son empreinte est celle du fichier, calculée hors de l'application ; une
  version « pour information » n'interrompt personne ; une version à accepter arrête le
  compte, et l'accepter le rétablit ; accepter deux fois ne change rien ; qui a accepté une
  version signalée doit encore accepter celle qui l'exige ;
- **accès conditionné** : chaque route d'un titulaire figure dans l'une de deux listes —
  fermée, ou explicitement laissée ouverte —, et le test échoue tant qu'une route nouvelle
  n'est dans aucune ; une route fermée répond `403` avant même de valider la requête ; qui
  refuse le texte obtient encore la copie de ses données et clôt son compte ; le
  back-office reste ouvert au personnel ;
- **publication** : elle exige le rôle, la permission et la validation en deux étapes ; sans
  jeton, la requête est refusée avant que son contenu ne soit lu ; un mébioctet exactement
  est lu, un octet de plus refusé ; un texte enregistré dans un autre encodage est refusé,
  non « réparé » ; une requête rejouée ne publie pas deux fois ; l'acte est au journal avec
  sa justification et les empreintes ; un auteur qui perd son rôle entre le contrôle de ses
  droits et l'écriture est refusé par la base. L'outil en ligne de commande publie le
  fichier à l'octet près, est refusé avec le rôle de l'API, et ne laisse paraître ni
  l'adresse ni le mot de passe de la base ;
- **conditions d'utilisation, règles de la base** : des tests s'adressent **directement à
  PostgreSQL** avec le rôle de l'API. La base refuse alors un numéro qui n'est pas le
  suivant ; une première version « pour information » ; une publication sans auteur, ou par
  un compte suspendu ou non habilité ; toute modification, suppression ou vidage d'une
  version — y compris par le propriétaire du schéma ; un texte hors bornes, blanc, ou dont
  l'empreinte n'est pas la sienne ; l'acceptation d'une autre version que celle en vigueur,
  ou par un compte suspendu ou clôturé ; la modification d'une acceptation, et son
  effacement tant que le compte est en service ; la clôture d'un compte qui en garderait
  une. De deux publications du même numéro, la seconde attend la première puis est
  refusée ; une acceptation lancée pendant la clôture du compte attend son issue, puis est
  refusée ; une acceptation n'est jamais datée d'avant la publication de sa version ;
- **inscription et publication qui se croisent** : le test publie une version entre le
  premier contrôle de l'inscription et son écriture. La demande est refusée de la même façon
  que l'adresse soit libre, en attente de vérification ou déjà prise ; rien n'est écrit,
  aucun avis ne part ;
- **grand livre, règles de la base** : des tests s'adressent **directement à PostgreSQL**,
  avec le rôle de l'API — et, pour ce que nul ne doit pouvoir faire, avec le rôle
  propriétaire. La base refuse alors, à la validation de la transaction : une écriture
  déséquilibrée, incomplète, sur un seul compte, ou dont les lignes ne se suivent pas ; cent
  dollars « compensés » par cent francs ; une ligne ajoutée à une écriture déjà validée.
  Elle refuse aussitôt : une ligne qui rendrait un solde négatif ; un montant nul ou
  négatif ; une ligne dans un autre actif que celui de son compte. Un solde ou un compteur
  écrit à la main n'est jamais validé, par quelque rôle que ce soit, et un compte ainsi
  altéré n'accepte plus aucune ligne. Aucune ligne, aucune écriture, aucun actif ni aucun
  type de compte ne se modifie, ne se supprime ni ne se vide d'un bloc — **y compris par le
  propriétaire du schéma**, et chaque table le refuse d'elle-même. Un actif n'est
  enregistré que par un membre du personnel actif qui en détient la permission, relue au
  moment d'écrire. Le rôle de l'API ne peut suspendre aucun de ces contrôles ;
- **grand livre, écritures simultanées** : des transferts croisés lancés ensemble ne
  s'interbloquent pas et ne perdent pas un centime ; un compte disputé ne cède jamais plus
  que son solde, quel que soit l'ordre d'arrivée ; la même écriture présentée plusieurs fois
  en même temps n'est passée qu'une fois, et toutes les réponses la rendent ; une
  transaction que PostgreSQL annule pour interblocage est relancée, et l'écriture passe une
  seule fois. Une écriture et la clôture de son titulaire qui se croisent : l'une attend
  l'autre — soit la clôture trouve les fonds et échoue, soit l'écriture est refusée sans
  avoir rien écrit ;
- **grand livre, service** : une écriture refusée — mal formée, actif inconnu, fonds
  insuffisants, titulaire clôturé — ne laisse rien, pas même un compte ouvert ; un découvert
  passager au fil des lignes est refusé, comme dans la base ; une écriture rejouée rend le
  résultat d'origine, même si les fonds ont été dépensés depuis ; une écriture différente
  sous la même clé est refusée, quelle que soit la différence — montant, compte, sens,
  type, actif, ordre ou nombre des lignes ; passée dans la transaction d'une opération,
  l'écriture est validée ou annulée avec elle ;
- **types d'écriture** : des tests s'adressent **directement à PostgreSQL**, sur une base
  telle que les migrations la laissent, avec le rôle de l'API, le rôle propriétaire et le
  superutilisateur. La base refuse alors d'emblée toute écriture d'un type absent de sa
  liste — qu'elle crédite un portefeuille depuis le compte de conservation, déplace des fonds
  d'un portefeuille à un autre ou les en sorte —, sans qu'un solde bouge, et quel que soit
  l'auteur qu'elle désigne ; un type voisin d'un type connu n'est pas ce type ; une table de
  même nom glissée par une session ne fait connaître aucun type. La liste est celle du code ;
  le rôle de l'API ne fait que la lire, et n'y ajoute rien même si le droit d'y écrire lui
  est rendu ; un type ne se modifie ni ne se retire, même par le propriétaire ; une écriture
  ne change pas de type après coup. Une écriture d'un type connu reste tenue par la règle de
  son opération, et **un test relit dans la base ces règles et exige que chaque type de la
  liste ait la sienne**. Un crédit, un transfert et un débit réels passent sans aucun type
  d'essai. Passée par le service, une écriture d'un type inconnu est un défaut : rien n'est
  écrit, pas même un compte ;
- **vérification du grand livre** : chaque altération faite avec le rôle propriétaire,
  contrôles suspendus — solde, compteur, montant, sens, actif, rang, ligne déplacée d'un
  compte à l'autre, écriture amputée d'une ligne — est relevée, avec ce qu'elle touche ; un
  registre sain n'en présente aucune ; une anomalie fait échouer l'étape, qui la consigne
  sans rien corriger ; au-delà de cinquante, la liste s'arrête et le dit ;
- **vérification du grand livre — types et opérations** : sur une base telle que les
  migrations la laissent, où un crédit approuvé, un transfert et un débit approuvé ont été
  écrits sous le rôle de l'API, toutes règles en vigueur, à côté de demandes en attente,
  refusée et retirée. Ce registre ne présente aucune anomalie. Puis chaque condition de
  chaque règle est altérée à son tour, avec le rôle propriétaire, règles suspendues — le type
  de l'écriture, sept types voisins d'un type connu, une troisième ligne, le sens, le montant
  et la monnaie de chaque ligne, le type et le titulaire de chaque compte, l'émetteur, le
  destinataire, le montant et la monnaie de l'opération, l'opération supprimée, l'écriture
  introuvable : chacune est relevée, sous son nom, avec l'opération ou l'écriture qu'elle
  désigne, et plus rien ne l'est une fois l'altération défaite. **Une écriture entière et
  équilibrée passée sans son opération — un crédit, un débit, un mouvement entre deux
  titulaires — n'est relevée que par ces contrôles** : ceux qui existaient n'en disent rien.
  Un ajustement qui se dit refusé ne couvre pas son écriture, qu'il la désigne encore ou non.
  Une écriture d'un type inconnu passée pendant que la règle était suspendue est relevée à
  chaque passage ; elle ne l'est plus si le propriétaire déclare son type — c'est la limite
  dite plus haut. Le maximum de cinquante anomalies vaut pour l'ensemble des contrôles ; un
  contrôle qui échoue ne fait pas taire les autres, et l'étape, le journal et la trace
  d'audit le nomment ; **un contrôle arrêté pour de vrai par le délai d'exécution des
  requêtes** — une autre session tient la table — échoue seul, puis réussit la table libérée.
  Un test donne chaque type d'écriture du produit à une écriture qui n'en est pas, et exige
  qu'elle soit relevée : un type ajouté sans son contrôle le ferait échouer. Et les quatre
  fichiers qui passent de vrais transferts et de vrais ajustements, par les services et par
  les routes de l'API, se terminent par la vérification, qui n'y relève rien ;
- **portefeuilles et back-office** : un titulaire ne lit que ses portefeuilles — aucune
  route, aucun paramètre ne désigne un autre compte ; un mouvement ne dit rien de l'autre
  partie, des frais perçus, ni des références internes ; un montant au-delà de 2⁵³, ou à
  dix-huit décimales, est rendu au chiffre près ; la pagination parcourt chaque mouvement
  une fois, sans en inventer ; le back-office exige un compte du personnel, la validation en
  deux étapes et la permission — et lire le grand livre n'autorise pas à y enregistrer un
  actif ; chaque consultation est au journal d'audit ; consulter ne change rien au
  registre, et **un test établit qu'aucune route de consultation du grand livre ni des
  portefeuilles n'y passe d'écriture** — une écriture ne passe que par une opération, sous
  ses propres routes : le transfert et, depuis le lot 3, l'ajustement du personnel ;
- **grand livre, clôture et copie des données** : un compte qui détient des fonds ne se clôt
  ni par son titulaire ni par le personnel ; vidé, il se clôt, ses écritures restent, et la
  trace de sa clôture garde ses identifiants dix ans ; un compte sans écriture n'impose
  aucune conservation et s'efface à trente jours ; la copie contient les portefeuilles qui
  ont servi et leurs mouvements, et dit lorsqu'elle en omet au-delà de 2 000 ;
- **transferts, règles de la base** : des tests s'adressent **directement à PostgreSQL**
  avec le rôle de l'API — et, pour ce que nul ne doit pouvoir faire, avec le rôle
  propriétaire. La base refuse alors : des plafonds négatifs, désordonnés, pour un niveau
  hors de 0 à 3 ou pour un actif inconnu ; des plafonds fixés par un compte suspendu, ou qui
  peut seulement les consulter ; leur suppression, même par le propriétaire ; un transfert
  depuis ou vers un compte suspendu ou clôturé ; un transfert qui annonce un autre niveau
  que celui de son émetteur ; un transfert d'un niveau sans plafonds, ou d'une unité
  au-dessus d'un plafond — par transfert, sur 24 heures, sur 31 jours ; à la validation de
  la transaction, un transfert dont l'écriture diffère en quoi que ce soit — montant, sens,
  compte, actif, type, nombre de lignes —, et une écriture de transfert sans transfert ;
  toute modification ou suppression d'un transfert. Le niveau que calcule la base est celui
  que calcule l'application, sur les huit combinaisons de niveaux acceptés. Les fenêtres
  font 24 et 744 heures quel que soit le fuseau de la session, y compris à un changement
  d'heure ;
- **transferts, service** : un transfert écrit ensemble sa ligne, son écriture, sa trace au
  journal et ses deux avis — un refus n'en laisse aucun, pas même sa clé ; le mot de passe
  est vérifié avant tout examen de la requête ; chaque plafond s'atteint exactement et ne
  se dépasse pas d'une unité ; un envoi de plus de 24 heures ne compte plus ; ce qu'un
  compte reçoit n'entame pas ses plafonds ; adresse inconnue, compte suspendu, jamais
  vérifié, clôturé, niveau fermé : la même réponse, au mot près, et elle vient après les
  plafonds et les fonds ; la même requête sous la même clé rend le transfert d'origine,
  même s'il ne serait plus possible ; une autre requête sous la même clé est refusée ; la
  clé d'un compte n'ouvre rien à un autre ; trente essais par heure et par compte ; le
  dixième destinataire refusé en 24 heures suspend les transferts du compte, le neuvième
  non ;
- **transferts simultanés** : huit requêtes identiques envoyées ensemble font un seul
  transfert, que toutes rendent ; six transferts d'un même émetteur ne dépassent pas ses
  plafonds, quatre jamais ses fonds ; des transferts croisés aboutissent tous ; six
  émetteurs vers un même destinataire : tout arrive ; un transfert lancé pendant la clôture
  de son émetteur ou de son destinataire attend, puis est refusé ; la suspension d'un
  émetteur attend son transfert en cours, et un transfert attend la suspension en cours de
  son émetteur, puis est refusé — celle d'un destinataire, elle, n'attend pas : le
  transfert en cours aboutit, le suivant est refusé ; un niveau retiré pendant la requête :
  la base refuse, rien n'est écrit, la requête se renvoie ;
- **transferts, routes** : fermées tant que la fonctionnalité l'est — les lectures restent
  ouvertes ; l'en-tête de la clé est exigé, et refusé s'il est répété ou mal formé ; régler
  les plafonds exige un compte du personnel, la validation en deux étapes et la permission
  — consulter n'autorise pas à fixer ; chaque réglage et chaque consultation est au journal
  d'audit ; le mouvement de chaque portefeuille porte l'écriture du transfert ; pour un
  tiers, un transfert n'existe pas ; les deux parties reçoivent leur avis ; l'historique du
  compte mentionne le transfert ; soixante demandes par minute et par adresse ; des
  plafonds ramenés à zéro referment le niveau, en envoi comme en réception ; pendant la
  maintenance, les titulaires attendent et le back-office règle les plafonds ;
- **transferts, clôture et copie des données** : des fonds retiennent la clôture, et une
  fois envoyés le compte se clôt ; l'autre partie garde ses transferts, sans l'adresse du
  compte clôturé ; la copie contient les transferts envoyés et reçus, et dit lorsqu'elle en
  omet au-delà de 2 000 ;
- **opérations du personnel, règles de la base** : des tests s'adressent directement à
  PostgreSQL avec le rôle de l'API — et, pour ce que nul ne doit pouvoir faire, avec le rôle
  propriétaire. La base refuse alors : une demande d'ajustement déposée sans la permission de
  demander — fût-ce avec celle d'approuver —, pour son propre portefeuille, pour un compte
  clôturé, inconnu ou dont l'inscription n'est pas achevée, d'un montant nul, sans raison ;
  une demande qui naît décidée, ou une seconde demande identique en attente ; une approbation
  ou un refus venant de l'auteur de la demande, du titulaire, ou de qui peut seulement
  demander ; une approbation après l'échéance ; toute retouche des termes d'une demande ou
  d'un gel — identifiant compris — et leur suppression, même par le propriétaire ; à la
  validation de la transaction, une approbation dont l'écriture n'est pas exactement celle de
  la demande — autre montant, autre sens, autre actif, portefeuille d'un autre, autre compte
  du même titulaire, contrepartie autre que le compte de conservation, ligne en plus —, et
  une écriture d'ajustement sans ajustement approuvé ; un gel posé sans la permission, sur
  son propre portefeuille, ou en double ; une levée par la conformité ; toute ligne sur un
  portefeuille gelé, hors ajustement ; la clôture d'un compte au portefeuille gelé, même par
  le propriétaire. L'heure d'une demande, d'une décision, d'un gel et d'une levée est celle
  de l'horloge de la base à l'instant de l'écriture — ni celle que fournit l'application, ni
  celle de l'ouverture de la transaction ; l'échéance est à 72 heures exactement. Les types
  d'écriture qui passent un gel sont, dans la base, ceux du code ;
- **opérations du personnel, services** : une demande ne déplace rien ; l'approbation passe
  l'écriture, enregistre la décision et prépare l'avis au titulaire ; refusée, elle n'écrit
  rien de cela, la demande reste en attente et la tentative est tracée ; la preuve de
  l'approbateur — mot de passe, puis second facteur — est vérifiée avant tout examen ; ni
  l'auteur de la demande ni le titulaire ne l'approuvent ni ne la refusent ; un débit que le
  portefeuille ne couvre plus est refusé ; l'auteur suspendu depuis, la demande ne s'approuve
  plus ; un compte clôturé ne reçoit rien — y compris s'il se clôt à l'instant où la demande,
  ou le gel, s'écrit ; une demande échoit après 72 heures, close par ce qui la rencontre en
  premier : une lecture, une liste, une demande identique, une décision, ou la tâche
  horaire ; le titulaire reçoit un message dans sa langue, daté de la décision, sans la
  justification ni le nom d'un membre du personnel — et aucun pour un refus, un retrait ou
  une échéance, ni après la clôture de son compte ; un portefeuille gelé garde son solde et
  se montre gelé dans la liste des portefeuilles, la page des mouvements et la copie des
  données ; rien n'en part — le refus précède tout autre examen — et rien n'y arrive — pour
  l'émetteur, c'est le refus unique du destinataire ; un compte suspendu et un portefeuille
  gelé s'ajustent : c'est par là que leurs fonds sortent ; des fonds ou un gel retiennent la
  clôture, qui cite les deux ;
- **gels, décisions et écritures simultanés** : le gel attend l'écriture en cours sur le
  portefeuille, et la suivante est refusée ; une écriture attend le gel en cours, puis est
  refusée ; un gel annulé ne gèle rien, et l'écriture qui l'attendait passe ; le gel attend
  le transfert en cours de l'émetteur ; le premier crédit d'un portefeuille jamais utilisé
  attend le gel ; un gel posé pendant une rafale de transferts : aucun n'aboutit après lui ;
  de deux gels du même portefeuille, de deux levées, de deux décisions sur une même demande,
  une seule s'applique ; de deux approbations, le portefeuille est crédité une fois ;
- **opérations du personnel, routes** : tant que les ajustements sont fermés, nul n'en
  demande ni n'en approuve — pas même un administrateur —, et les gels se posent ; refermés,
  ce qui est en attente se refuse et se retire encore ; chacune des neuf routes exige une
  session, un compte du personnel, la validation en deux étapes et **sa** permission —
  demander n'autorise pas à approuver, ni l'inverse ; la conformité gèle et consulte les
  gels, sans en lever ni toucher à un ajustement ; chaque refus d'accès est au journal
  d'audit, avec la permission qui manquait ; chaque corps de requête et chaque identifiant
  est vérifié avant tout ; un montant plus précis que l'actif n'est pas arrondi ; **avec de
  vrais soldes** : un portefeuille crédité par un ajustement transfère ; gelé, rien n'en part
  ni n'y arrive ; un débit sous double validation en sort pourtant le solde ; le gel levé,
  tout repart, et le compte vidé se clôt ; pendant la maintenance, les titulaires attendent,
  et le personnel ajuste, gèle et lève encore ; la copie des données dit quel portefeuille
  est gelé, l'historique ce que la plateforme y a fait — jamais pourquoi.

**Efficacité des tests vérifiée par mutation.** 2 234 défauts ont été introduits
volontairement, un par un, puis retirés ; chacun doit faire échouer au moins un test.

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
- Lot 5 : 277 défauts — 75 dans les règles SQL des versions et des acceptations, 202 dans le
  code (accès conditionné, routes, services, lecture et écriture en base, publication,
  corps de requête lu après les gardes, outil en ligne de commande, contrats et
  validation). **À la première passe, 16 des 275 défauts n'étaient pas détectés** :
  - treize révélaient un manque dans les tests, comblé depuis. Dans la base : une traduction
    dont le résumé n'était pas contrôlé, ou dont l'empreinte se publiait sans texte ; le
    caractère U+FEFF refusé partout au lieu de l'être en tête seulement ; la table des
    versions vidée d'un bloc, que seule la protection de la table voisine arrêtait ; une
    acceptation datée du début de sa transaction, donc parfois d'avant la publication du
    texte accepté. Dans le code : la règle « pour information » non transmise à la
    publication ; un compte clôturé encore tenu d'accepter ; la date des acceptations
    absente de la copie des données ; le refus de la base, quand l'auteur perd son droit en
    cours de requête, rendu en erreur serveur ; la durée du quota de publication ; les
    acceptations laissées en place à la clôture ; la valeur reçue rendue à la place de la
    valeur validée ;
  - un était détecté par un test existant, que le script ne désignait pas (le catalogue des
    permissions) ;
  - deux sont sans effet dans une base installée comme prévu — ils laissent au rôle de
    l'API un privilège, `TRUNCATE`, qui ne lui est jamais accordé : **ils ont été écartés**,
    et ne sont pas comptés.

  Quatre défauts ont été ajoutés avec ces corrections. Les défauts concernés ont été
  relancés un à un, puis **les 277 l'ont été d'une traite sur le code livré : tous sont
  détectés.**

- Lots 1 à 4 après le lot 5, qui modifie l'inscription, la clôture, la copie des données et
  le support commun des tests. **Tous les défauts rejouables par script — 31 au lot 1, 107
  au lot 2, 226 au lot 3, 249 au lot 4 — ont été rejoués sur le code livré : tous sont
  détectés.** Une première relance, avant les dernières corrections du lot, avait montré
  qu'un défaut du lot 3 **bloquait un test écrit pour le lot 5 au lieu de le faire
  échouer** (voir « Problèmes identifiés ») : le test a été corrigé.
- Phase 3, lot 1 : 320 défauts — 130 dans les règles SQL du grand livre, 190 dans le code
  (règles du domaine, service d'écriture, lecture et écriture en base, vérification
  périodique, vues, back-office, portefeuilles, copie des données, clôture, transactions,
  contrats). **À la première passe, 18 n'étaient pas détectés** :
  - dix-sept révélaient un manque dans les tests, comblé depuis. Dans la base (8) : un
    compte habilité à lire le grand livre, mais pas à y enregistrer un actif, n'était pas
    essayé ; quatre tables pouvaient perdre leur protection contre le vidage d'un bloc sans
    qu'un test le voie, celle des tables voisines arrêtant l'essai ; deux contraintes d'un
    compte — pas de solde négatif, pas de compteur négatif — n'étaient pas éprouvées
    seules, une contrainte voisine refusant les cas essayés ; une écriture de trois lignes
    dont celle du milieu manque. Dans le service (4) : sous une clé déjà utilisée, une écriture qui
    compte moins de lignes, qui vise un autre compte de la plateforme, ou dont les sens
    sont inversés ; la vérification périodique devant une écriture amputée de sa ligne du
    milieu. Au back-office (1) : la route qui enregistre un actif exigeant la permission
    de lire au lieu de la sienne — la base refusait de toute façon, par la même réponse.
    Dans les transactions et les réponses HTTP (3) : une pause nulle, ou plus longue que
    prévu, avant une nouvelle tentative ; l'avertissement journalisé quand une requête est
    abandonnée après un conflit. Dans les contrats (1) : des paramètres inconnus acceptés
    sur une route du back-office ;
  - un est sans effet — la taille des références d'une écriture comptée en caractères
    plutôt qu'en octets, alors que ces références n'admettent que des caractères d'un
    octet : **il a été écarté**, et n'est pas compté.

  Un défaut a été ajouté avec ces corrections. Les vingt défauts concernés ont été
  relancés, puis **les 320 l'ont été d'une traite sur le code livré : tous sont détectés.**
  L'un d'eux ne l'était que par un test resté bloqué jusqu'à son délai : la vérification du
  lot 2 l'a montré, et le test a été corrigé (voir plus bas).

  Trois d'entre eux faisaient échouer d'un coup les 65 tests d'un fichier : la préparation
  commune de ces tests ne pouvait plus ouvrir les comptes de la plateforme. Ils ont été
  vérifiés un à un. Deux sont aussi détectés par un test qui vise la règle ; **le troisième
  ne l'était que par cette préparation**, et une vérification ciblée a été ajoutée (voir
  « Problèmes identifiés »).

- Lots 1 à 5 de la phase 2 après ce lot, qui modifie la clôture, la copie des données, la
  tâche horaire, les transactions et le support commun des tests. Les 890 défauts rejouables
  par script — 31 au lot 1, 107 au lot 2, 226 au lot 3, 249 au lot 4, 277 au lot 5 — ont été
  rejoués sur le code livré. **889 sont détectés**, chacun par l'échec d'un test, sans
  qu'aucune exécution ait dû être interrompue. **Le dernier n'a plus d'effet, et a été
  retiré.** Placé dans la migration du lot 5, il privait `super_admin` de la permission de
  publier les conditions ; or la migration du grand livre, appliquée ensuite, attribue de
  nouveau tout le catalogue à `super_admin`. Deux bases ont été installées, l'une avec ce
  défaut, l'autre sans, puis comparées : même structure, mêmes rôles, mêmes permissions —
  alors qu'arrêtées à la migration du lot 5, la permission manque à la première. Le même
  défaut, placé dans la migration du grand livre, est détecté : il compte parmi les 320.
- Phase 3, lot 2 : 338 défauts — 125 dans les règles SQL des transferts et des plafonds, 213
  dans le code (règles du domaine, service, plafonds, lecture et écriture en base, routes,
  clé d'idempotence, bornes, messages, historique, copie des données, contrats). 341 avaient
  été écrits. **À leur première exécution, 8 n'étaient pas détectés** — un lors d'un essai
  préalable sur huit défauts, sept lors de la passe complète :
  - trois révélaient un manque dans les tests, comblé depuis. Un avis adressé à un compte
    clôturé — à l'adresse factice qu'il porte désormais — passait inaperçu : le test ne
    regardait que son ancienne adresse. Dans l'essai de deux transferts croisés, le second
    n'était pas encore engagé quand le premier écrivait : un verrou trop fort sur
    l'émetteur, qui les aurait fait s'interbloquer, n'était pas vu. Des plafonds étaient
    remplacés par la personne qui les avait fixés : un remplacement qui aurait gardé
    l'ancien auteur n'était pas vu ;
  - deux étaient confrontés au mauvais fichier de tests — une erreur du script de
    vérification, non des tests : le test qui les voit existait, et les voit ;
  - trois sont sans effet, et **ont été écartés** : retirer ou non au rôle de l'API le droit
    de vider chacune des deux tables ne change rien, ce droit ne lui étant jamais accordé ;
    le troisième modifie un calcul sans en changer aucun résultat. Ils ne sont pas comptés.

  Les défauts concernés ont été relancés, puis **les 338 l'ont été d'une traite sur le code
  livré (commit `b72a17c`) : tous sont détectés.** Quatre font échouer d'un coup les 81
  tests d'un fichier — la préparation commune de ces tests ne peut plus fixer ses plafonds.
  Rejoués un à un contre une copie du fichier dont la préparation tolère cet échec, **chacun
  est aussi détecté par un test qui vise la règle**.

- Un défaut du grand livre n'a plus d'effet depuis ce lot, et a été retiré — le même cas
  qu'au lot précédent. Placé dans la migration du grand livre, il privait `super_admin` des
  deux permissions du grand livre ; la migration des transferts, appliquée ensuite, lui
  attribue de nouveau tout le catalogue. Deux bases ont été installées, l'une avec ce
  défaut, l'autre sans, puis comparées : même structure, mêmes rôles, mêmes permissions —
  alors qu'arrêtées à la migration du grand livre, les deux permissions manquent à la
  première. Le même défaut, placé dans la migration des transferts, est détecté : il compte
  parmi les 338.
- Lots précédents après ce lot, qui modifie la copie des données, le catalogue des
  permissions, les messages et plusieurs de leurs tests. Les 1 208 défauts rejouables par
  script — 31, 107, 226, 249 et 276 pour les lots 1 à 5 de la phase 2, 319 pour le grand
  livre — ont été rejoués sur le même code : **tous sont détectés**, sans qu'aucune
  exécution ait dû être interrompue. Avec les 338 des transferts, **1 546 défauts ont été
  rejoués en une seule passe**, de quatre heures vingt.

  Douze d'entre eux font échouer d'un coup tous les tests d'un fichier : quatre des
  transferts (ci-dessus), trois du grand livre, cinq de l'outil qui publie les conditions
  d'utilisation. Chacun a été rejoué à part : tous sont aussi détectés par un test qui vise
  la règle. Pour l'outil de publication, les scénarios s'enchaînent : le premier échoue
  seul, pour la raison visée, et entraîne les suivants.

  **Deux défauts n'étaient détectés que par un test resté bloqué jusqu'à son délai de trente
  secondes** — et non par une vérification. Pour la première fois, la sortie complète des
  tests a été conservée, pour les 657 défauts de la phase 3, et l'on y a cherché les tests
  arrêtés par leur délai : une liste qui ignore son curseur rendait sans fin la même page à
  un parcours « page par page » que rien ne bornait. L'un des deux est du lot 1, où il avait
  passé pour une détection ordinaire. Après cette passe, les cinq parcours de ce genre que
  comptent les tests ont été bornés, et dix défauts qui faussent le passage d'une page à la
  suivante, relancés : chacun fait échouer une vérification, en moins de deux secondes (voir
  « Problèmes identifiés »). Ce point n'avait pas été examiné alors pour les 889 défauts de
  la phase 2, dont les sorties n'étaient pas conservées : on savait que chacun fait échouer
  un test, pas si c'est toujours par une vérification. Il l'a été au rejeu suivant, après le
  lot 3, l'outil conservant désormais toutes les sorties : **quatre défauts de la phase 2
  étaient dans ce cas** (ci-dessous).

- Phase 3, lot 3 : 359 défauts — 151 dans les règles SQL des ajustements et des gels, 208
  dans le code (règles du domaine, services des ajustements et des gels, lecture et écriture
  en base, routes, avis au titulaire, grand livre, transferts, portefeuilles, historique,
  copie des données, clôture, contrats). **À la première exécution, sur le code publié
  (commit `2922759`), 24 n'étaient pas détectés** :
  - **vingt-deux révélaient un manque dans les tests**, comblé depuis — le code, lui,
    applique chacune de ces règles. Dans la base (9) : une demande en attente, ou échue, qui
    désigne une écriture ; une demande déposée par qui peut seulement approuver, et une
    décision prise par qui peut seulement demander — aucun rôle livré ne sépare ces deux
    permissions, et les tests ne les séparaient pas davantage ; l'identifiant d'une demande,
    ou d'un gel, réécrit au moment de la décider, ou de le lever ; l'heure d'une demande, ou
    d'un gel, lue à l'ouverture de la transaction au lieu de l'instant de l'écriture ; la
    ligne du titulaire passée sur un autre de ses comptes que ses fonds disponibles — il
    n'existe pas encore d'autre type de compte : le test en crée un, le temps d'une
    transaction annulée. Dans les services (9) : une demande échue n'était close, dans les
    tests, que par une lecture — or elle doit l'être aussi par une liste, par une demande
    identique et par une décision : sans cela, la base laisse refuser une demande échue, qui
    s'afficherait « refusée » ; un compte clôturé à l'instant même où la demande, ou le gel,
    s'écrit — la base refuse, mais la réponse qui en est tirée n'était pas éprouvée (quatre
    défauts) ; l'avis au titulaire envoyé pour un ajustement qui n'est pas approuvé ; la date
    de cet avis, celle de la demande au lieu de celle de la décision. Sur les routes (4) :
    l'identifiant mal formé d'une demande à lire, à approuver ou à retirer ; la route qui
    gèle exigeant une autre permission que la sienne — la base refusait de toute façon, par
    la même réponse. Huit tests ont été ajoutés, d'autres complétés (commit `69a8ca5`) ;
  - deux sont sans effet, et **ont été écartés** : retirer ou non au rôle de l'API le droit
    de vider chacune des deux tables ne change rien, ce droit ne lui étant jamais accordé.
    Ils ne sont pas comptés.

  **Un vingt-cinquième passait pour détecté sans l'être pour la bonne raison** : il rendait
  la migration inapplicable, et les 47 tests du fichier échouaient sans qu'aucune règle soit
  éprouvée. Relevé en examinant les défauts qui font échouer une grande part d'un fichier.
  Réécrit pour que la migration s'applique — chaque rôle y reçoit alors toutes les
  permissions —, il fait échouer six tests, chacun sur la règle visée (voir « Problèmes
  identifiés »). Quatre autres défauts font échouer la plupart des tests d'un fichier ;
  examinés un à un, chacun échoue bien sur une vérification qui vise la règle.

  Deux défauts ont été ajoutés avec ces corrections — l'heure d'une décision, et celle d'une
  levée, lues à l'ouverture de la transaction —, ce qui ramène le compte à 359. Les
  vingt-deux défauts, celui qui a été réécrit et les deux ajoutés ont été relancés un à un
  contre les tests complétés : **tous sont détectés, chacun par un test qui vise la règle**.
  La sortie complète des tests a été conservée dès la première exécution : **aucun des 359
  n'est détecté par un test resté bloqué jusqu'à son délai**.

- Un défaut des transferts n'a plus d'effet depuis ce lot, et a été retiré — le même cas
  qu'aux deux lots précédents. Placé dans la migration des transferts, il privait
  `super_admin` des deux permissions des plafonds ; la migration des opérations du personnel,
  appliquée ensuite, lui attribue de nouveau tout le catalogue. Deux bases ont été
  installées, l'une avec ce défaut, l'autre sans, puis comparées : même structure, mêmes
  rôles, mêmes permissions — alors qu'arrêtées à la migration des transferts, les deux
  permissions manquent à la première. Le même défaut, placé dans la migration des opérations
  du personnel, est détecté : il compte parmi les 359. Les transferts gardent 337 défauts
  rejouables.
- Lots précédents après ce lot, qui modifie le grand livre, les transferts, les
  portefeuilles, la clôture, la copie des données, le catalogue des permissions et plusieurs
  de leurs tests. Les 1 904 défauts rejouables par script — 31, 107, 226, 249 et 276 pour les
  lots 1 à 5 de la phase 2, 319 pour le grand livre, 337 pour les transferts, 359 pour ce lot
  — ont été rejoués d'une traite sur le code livré (commit `69a8ca5`), en quatre heures trois
  quarts : **tous sont détectés**, sans qu'aucune exécution ait dû être interrompue.

  Douze d'entre eux font échouer d'un coup tous les tests d'un fichier — les mêmes qu'au lot
  précédent : quatre des transferts, trois du grand livre, cinq de l'outil qui publie les
  conditions d'utilisation. Les sept premiers ont été rejoués à part, contre les seuls tests
  qui visent la règle : chacun y est détecté. Pour l'outil de publication, les scénarios
  s'enchaînent : le premier échoue seul, pour la raison visée, et entraîne les suivants.
  Vingt-cinq autres font échouer la moitié au moins des tests d'un fichier ; la première
  erreur de chacun a été lue : toutes sont l'effet du défaut lui-même, aucun ne met les tests
  en échec sans éprouver de règle, comme celui qu'il a fallu réécrire plus haut. L'un d'eux
  était pourtant trop grossier, et a été réécrit lui aussi : pour éprouver que les contrôles
  d'un dossier sont refaits au jour du dépôt, il les refaisait « au 1er janvier 1970 » ; tout
  dossier était alors refusé, et 29 tests échouaient faute de pouvoir rien déposer. Il ignore
  maintenant le résultat de ces contrôles, et seuls échouent les deux tests qui laissent
  passer le temps entre l'enregistrement d'un dossier et son dépôt.

  **Quatre défauts de la phase 2 faisaient échouer leurs tests par le délai accordé à chaque
  test, et non par une vérification** — c'est l'examen promis au lot précédent, fait sur les
  sorties des 889 défauts de la phase 2, conservées pour la première fois. Trois touchent la
  lecture du corps d'une requête : un corps trop grand rendu au lieu d'être refusé, aucun
  délai de réception, la connexion gardée après un refus. Le serveur ne répondait plus, ou ne
  fermait pas la connexion ; le test bornait bien son attente, mais à huit secondes, quand un
  test unitaire en a cinq — sa propre vérification ne pouvait jamais parler. Le quatrième
  touche la clôture d'un compte : un verrou trop fort faisait attendre sans fin une
  modification qui ne doit pas attendre, jusqu'aux trente secondes du test. Pour trois des
  quatre, c'était la seule détection. Les deux attentes sont maintenant bornées à trois
  secondes (commit `a77b3af`) ; les onze défauts de la lecture du corps et celui du verrou,
  relancés, font chacun échouer une vérification. **Plus aucun des 1 904 défauts n'est
  détecté par un test resté bloqué** (voir « Problèmes identifiés »).

- Retouches du socle : 51 défauts — ce qui est pris pour une saturation, ce que l'API répond
  alors, ce que les tâches de fond écrivent, la règle d'une ligne par période, l'oubli des
  erreurs passées. **Tous sont détectés**, à la première exécution et sans compléter les
  tests, chacun par une vérification : aucun par un test resté bloqué, aucun en faisant
  échouer un fichier entier. Les dix-neuf défauts des lots précédents qui visent le même
  terrain — transactions, erreurs de la base, traduction des erreurs en réponses — ont été
  rejoués : tous détectés. Les autres défauts des lots précédents n'ont pas été rejoués ;
  leurs motifs s'appliquaient tous au code livré, ce qui portait à 1 955 les défauts
  rejouables par script.

- Robustesse du socle : 103 défauts — ce qui est tenu pour une tâche perdue, sa réinscription
  et la ligne qui la dit, la surveillance et son arrêt, l'ordre de l'arrêt, son échéance, ses
  codes de sortie, ses signaux, le lancement, la configuration. **Il a fallu quatre passes,
  et les premières ont trouvé plus que des manques** :
  - **un des nouveaux tests échouait une fois sur quatre, sans raison valable.** Pour simuler
    la perte de l'exécution en attente d'une tâche, il la retirait de deux listes de Redis ;
    la bibliothèque des files la range dans trois. Lancé seul, il passait le plus souvent ;
    répété par ce contrôle, il a échoué pour 35 défauts sur 98, puis 30 sur 104, y compris
    ceux qui ne le concernaient pas. Corrigé, puis répété 40 fois sans échec ;
  - cet échec fortuit **faisait passer pour détectés trois défauts qu'aucun test ne voyait**.
    Deux étaient de vrais manques : la file et la tâche prises l'une pour l'autre, dans la
    liste des tâches surveillées et dans le journal des erreurs — dans l'application, une
    tâche porte le nom de sa file, et les tests avaient repris ces noms ; ils en emploient
    maintenant deux différents. Le troisième était sans effet — une instruction retirée que
    deux gardes rendaient superflue — et a été écarté ;
  - un autre n'était pas détecté : la purge inscrite toutes les minutes au lieu de toutes les
    heures. Un test lit désormais la cadence inscrite dans Redis, au démarrage et après une
    réinscription ;
  - deux arrêtaient net les tests unitaires au lieu d'en faire échouer un : l'arrêt
    n'attendait plus la fermeture, dont l'échec n'avait alors personne pour le recevoir. Les
    tests le reçoivent maintenant, et leurs vérifications parlent ;
  - cinq faisaient échouer les cinq tests de l'arrêt à la fois, quand un seul était visé : le
    test en échec laissait une connexion ouverte, qui retenait la fermeture de l'application
    jusqu'au délai du test, et les suivants ne pouvaient plus démarrer. Les tests ferment
    désormais ces connexions.

  Six défauts ont été ajoutés avec l'arrêt demandé pendant l'initialisation. **À la quatrième
  passe, sur le code livré, les 103 sont détectés**, chacun par une vérification qui le
  concerne : aucun par un test resté bloqué, aucun en faisant échouer un fichier entier,
  aucun par l'échec d'un test étranger au défaut — la liste des tests en échec a été relue
  défaut par défaut. Les six défauts des retouches précédentes qui visent les deux
  traitements modifiés ont été rejoués : tous détectés. Les motifs des 1 955 défauts
  antérieurs s'appliquent tous au code livré : 2 058 défauts sont rejouables par script.

- Phase 3, lot 4 : 62 défauts — 50 dans les règles SQL (le contrôle du type à l'écriture, ce
  qui vaut pour un type connu, qui peut étendre la liste, son format, ses privilèges, le
  chemin de recherche des fonctions, le lien de chaque type à son opération, l'immutabilité
  d'une écriture), 4 dans le code qui traduit le refus de la base, 8 dans le catalogue des
  types. **Aucun n'a échappé aux tests** : chacun est détecté dès sa première exécution, par
  une vérification qui le concerne — aucun par un test resté bloqué, aucun en faisant échouer
  un fichier entier ; la liste des tests en échec a été relue défaut par défaut. Les tests
  ont pourtant été complétés deux fois, **à la relecture et non par ce contrôle** : pour
  éprouver le refus sous chaque rôle et pour chaque auteur ; puis, juste avant la livraison,
  pour établir qu'une écriture ne change pas de type après coup — sans quoi un contrôle fait
  à l'écriture se contournerait. Quatre défauts ont été ajoutés en chemin, deux en relisant
  la première passe, deux avec ce dernier test ; **les 62 ont été rejoués d'une traite sur le
  code livré**.

  Ce lot modifie le code du grand livre, les constantes des contrats et dix fichiers de tests
  des lots précédents ; deux motifs de défauts antérieurs ne s'appliquaient plus, et ont été
  réécrits. **Les défauts antérieurs n'ont pas tous été rejoués.** L'ont été, 257 en tout :
  les 140 qui touchent un type d'écriture ou un fichier de code modifié par ce lot — 77 du
  grand livre, 33 des transferts, 29 des opérations du personnel, 1 des retouches du
  socle — ; les 5 du grand livre que voit un test adapté par ce lot, et les 3 de la clôture
  que voit un fichier de tests modifié ; puis, parmi les autres défauts du grand livre, des
  transferts et des opérations du personnel, un sur huit, pris à intervalle régulier — 109.
  Tous sont détectés. Six le sont désormais par le refus nouveau lui-même, à bon droit : un
  type d'écriture faussé dans le code, ou mal formé, bute maintenant sur la liste ; les
  sorties des 251 autres ne le mettent pas en jeu. Les quelque 1 800 défauts restants n'ont
  pas été rejoués : leurs motifs s'appliquent tous au code livré, ce qui porte à 2 120 les
  défauts rejouables par script, mais **seul un rejeu complet — cinq heures environ —
  établirait qu'aucun n'a cessé d'être détecté**. Le risque est jugé faible : sept des dix
  fichiers de tests ne sont modifiés que par la déclaration de leurs types d'essai ; les
  trois autres ont en outre un test adapté ou ajouté, dont tous les défauts ont été rejoués.

- Phase 3, lot 5 : 90 défauts — 60 dans les trois lectures (10 pour le type des écritures, 23
  pour les transferts, 27 pour les ajustements : chaque condition retirée ou faussée,
  l'anomalie mal nommée ou désignant autre chose, le nombre d'anomalies non borné), 21 dans
  l'étape (un contrôle qui n'est pas exécuté, le maximum mal partagé, un contrôle en échec
  qui interrompt les autres, passe pour sain ou n'est pas nommé), 8 dans le registre des
  contrôles et leur inscription, 1 qui ajoute un type d'écriture au code et à la base sans
  son contrôle. **Aucun n'a échappé aux tests** : les 90 sont détectés dès la première passe
  complète, chacun par une vérification qui le concerne — aucun par un test resté bloqué,
  aucun parce qu'une lecture ne s'exécutait plus ; la liste des tests en échec a été relue
  défaut par défaut. Quand un défaut fait échouer plusieurs tests — parce qu'il fausse tous
  les scénarios, ou parce qu'un premier échec laisse derrière lui une écriture altérée —,
  c'est le premier échec qui a été relu. Deux défauts envisagés ont été écartés, et ne sont
  pas comptés : ils ne changent rien au comportement. Le fichier de tests est passé de 22
  à 25 tests avant cette passe, **à la relecture et non parce qu'un défaut avait échappé**,
  puis à 26 après elle, avec le test du délai d'exécution ; **les 90 ont ensuite été rejoués
  d'une traite sur le code livré**.

  Ce lot modifie le code de la vérification : deux motifs de défauts du lot 1 ne s'appliquaient
  plus, et ont été réécrits. Les 20 défauts antérieurs qui visent la vérification ont été
  rejoués : tous détectés, par les mêmes tests qu'avant. **Les autres défauts antérieurs n'ont
  pas été rejoués** : ce lot ne touche ni leur code, ni leurs tests — sauf quatre fichiers de
  tests, auxquels il ajoute un test final sans rien y changer. Leurs motifs s'appliquent tous
  au code livré, ce qui porte à 2 210 les défauts rejouables par script.

## Infrastructure : vérifications hors Docker

L'environnement de développement utilisé ne dispose **ni de Docker, ni d'accès aux dépôts de
paquets système**. Chaque fichier d'infrastructure y est donc exécuté hors Docker, avec le
vrai logiciel, avant d'être confié à l'intégration continue — qui, elle, l'exécute avec
Docker (section suivante) :

| Élément                             | Vérifié ici                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Reste à confirmer                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.Dockerfile`                    | Étapes rejouées une à une dans une arborescence vierge appartenant à `root`, à partir du seul contexte de build. L'artefact obtenu et l'outil d'administration ont été exécutés sous l'utilisateur `node`, sans droit d'écriture. Le répertoire des pièces y est créé comme le prescrit le fichier, réservé à l'utilisateur `node`. Depuis le lot 5 : l'outil de publication des conditions d'utilisation y est exécuté sous l'utilisateur `node` — refusé avec le rôle de l'API, refusé avec un numéro qui n'est pas le suivant, puis publication avec le rôle propriétaire.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Construction par Docker (images de base, couches, cache) ; instruction `VOLUME`                                                                                                                                                                                                                                                                                |
| Script d'initialisation PostgreSQL  | Exécuté tel quel sur une instance PostgreSQL 18.6 vierge (client `psql` 16.2) : rôles, bases, privilèges, connexions par mot de passe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Exécution par le point d'entrée de l'image officielle                                                                                                                                                                                                                                                                                                          |
| `docker-compose.yml`                | Séquence rejouée dans un espace réseau isolé, avec les mêmes noms d'hôtes, ports, commandes, variables et sondes : initialisation, migrations, API, Nginx. Fichier conforme au schéma officiel de la spécification Compose. Les deux variables de la vérification d'identité sont fournies à l'API comme le fichier les déduit, et les pièces écrites dans un répertoire vide monté à l'emplacement du volume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Orchestration par Docker Compose (ordre de démarrage, volumes, options de sécurité des conteneurs) ; le volume `kyc-documents` et l'expression `${KYC_ENCRYPTION_KEY:+…}`, que seul Compose interprète (cette forme ne figure pas dans le texte de la spécification ; sa prise en charge a été vérifiée dans le code source de Compose, pas par une exécution) |
| `nginx.conf`                        | Exécuté sans modification par Nginx 1.30.6 compilé depuis les sources : relais, sondes, limitation de débit, erreurs au format de l'API, journaux corrélés avec ceux de l'API. Route d'envoi des pièces : fichiers de 600 Ko, de 5 Mio exactement, de 5 Mio + 1 octet (refusé par l'API) et de 7 Mo (refusé par Nginx) ; quatre envois lents simultanés, le cinquième refusé. Depuis le lot 4 : aucune réponse de l'API n'est copiée sur le disque du proxy — le téléchargement d'une pièce de 5 Mio n'y laisse ni fichier ni avertissement, et la même exécution **sans** la directive ajoutée échoue. Depuis le lot 5, route de publication des conditions : un texte de 185 Ko relayé, 1,06 Mo refusé par l'API, 1,3 Mo refusé par Nginx sans rien transmettre.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exécution dans l'image `nginx:1.30-alpine`                                                                                                                                                                                                                                                                                                                     |
| Parcours d'identité de la CI        | Le script `infrastructure/ci/smoke-identity.sh` a été exécuté à travers ce Nginx : administrateur créé en ligne de commande, back-office refusé sans second facteur, activation du second facteur, ouverture de l'inscription, inscription, vérification, connexion, profil, historique, connexion en deux temps, recherche d'un compte et fermeture de ses sessions depuis le back-office. Depuis le lot 3 : vérification d'identité complète (déclaration, pièces, dépôt, examen, téléchargement d'une pièce de 5 Mio identique à l'octet près, acceptation, profil vérifié), puis contrôle du stockage par `check-kyc-storage.sh` sous l'utilisateur `node` — deux fichiers chiffrés, illisibles par un autre utilisateur. Depuis le lot 4 : copie des données (mot de passe redemandé, numéro de la pièce absent), clôture (confirmation exigée), connexion refusée ensuite, avis reçu à l'ancienne adresse, compte retrouvé par le back-office, dossier conservé. Depuis le lot 5 : inscription impossible tant qu'aucune version des conditions n'est publiée ; publication d'un texte de 185 Ko par le back-office, relu à l'octet près à travers le proxy ; inscription liée à la version en vigueur ; nouvelle version à accepter — compte arrêté, version dépassée refusée, acceptation, reprise ; acceptations dans la copie des données. Depuis le lot 1 de la phase 3 : enregistrement d'un actif — refusé à un titulaire, accepté une fois —, portefeuille à zéro et sans mouvement, aucun compte ouvert au grand livre, balance équilibrée, copie des données au nouveau format. Depuis le lot 2 de la phase 3 : ouverture des transferts ; rien ne part sans plafonds ; plafonds fixés au back-office — refusés à un titulaire, dans le désordre, ou plus précis que l'actif —, relus par le titulaire ; demandes refusées sans clé d'idempotence, sans le bon mot de passe, au-delà du plafond, au-delà du solde ; aucun transfert, aucun compte ouvert au grand livre ; refus visibles dans l'historique ; copie des données au format 4. Depuis le lot 3 de la phase 3 : ajustements fermés, puis ouverts ; crédit demandé par l'administrateur — qui ne peut pas l'approuver lui-même —, approuvé par un second administrateur avec son mot de passe et son second facteur ; e-mail au titulaire, sans la justification ; un second compte inscrit pour recevoir ; **un transfert mené à son terme**, renvoyé sous la même clé sans être fait deux fois ; portefeuille gelé — rien n'en part, le compte ne se clôt pas — ; débit sous double validation, les rôles inversés ; gel levé ; copie des données au format 5. Le second administrateur est créé par le parcours lui-même, par la commande `docker compose` du flux — exécutée ici par une commande `docker` factice, qui lance l'outil sur place. 259 contrôles dans le parcours ; 226 sans second administrateur, hors GitHub Actions — la double validation, le transfert abouti et le débit sont alors sautés. Puis `infrastructure/ci/publish-terms-cli.sh` est exécuté tel quel, l'outil de publication étant lancé sur place, depuis l'arborescence de l'image de migration, au lieu de l'être par `docker compose run` : numéro inexact refusé, version suivante publiée, texte servi par Nginx comparé au fichier. | Exécution dans la pile Docker                                                                                                                                                                                                                                                                                                                                  |
| Workflow de CI                      | Les commandes du job `verify` et les étapes de test du job `docker` sont exécutées ici avant chaque livraison ; l'étape qui lit les journaux du conteneur Nginx l'est par son équivalent, sur le journal d'erreurs de Nginx. **Le workflow lui-même s'exécute sur GitHub depuis le 2026-11-13.** Les actions sont épinglées sur des empreintes vérifiées.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **Toute exécution par GitHub** (voir ci-dessous)                                                                                                                                                                                                                                                                                                               |
| Moteur de migration natif de Prisma | Téléchargement bloqué ici : les migrations sont créées et appliquées avec la **version WebAssembly officielle du même moteur** (même révision). **Le moteur natif les applique dans la CI** (tests, conteneur de migration de la pile Compose, contrôle de dérive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Exécution par la CI                                                                                                                                                                                                                                                                                                                                            |
| PostgreSQL de développement         | Version 18.6, **réglée pour la vitesse : une transaction y est validée sans attendre le disque** (`fsync` et `synchronous_commit` désactivés). Une course qui dépend de la durée d'une validation ne peut donc pas y apparaître d'elle-même. Depuis le lot 3 de la phase 3, une répétition « disque lent » retarde chaque validation à la demande : les 1 261 tests d'intégration et de bout en bout passent ainsi retardés de 25 ms ; à 100 ms, un seul échoue, la base ne suivant plus (« Problèmes identifiés », point 9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | La CI exécute les mêmes tests sur un PostgreSQL 18.7 qui attend le disque : c'est elle qui a montré la seule course de ce genre (« Problèmes identifiés »).                                                                                                                                                                                                    |
| Images Docker                       | Les étiquettes `postgres:18-bookworm`, `redis:8-alpine`, `nginx:1.30-alpine` et `node:24-bookworm-slim` existent dans le registre des images officielles ; la CI les télécharge et les exécute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                              |
| Node.js 22 et 26                    | Non vérifiés. Seul Node.js 24.22.2 l'a été.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                              |

## Intégration continue : active

Le workflow (`.github/workflows/ci.yml`) s'exécute sur chaque demande de fusion et sur `main`
depuis le 2026-11-13. **Sa première exécution est passée au vert**, sans correction :

| Job                           | Ce qu'il a exécuté pour la première fois, avec succès                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Qualité, build et tests       | installation figée, mise en forme, build, lint, types, cohérence migrations/schéma, **tous les tests** sur des conteneurs PostgreSQL 18 et Redis 8, audit des dépendances — avec le **moteur de migration natif de Prisma**                      |
| Images Docker et pile Compose | construction des images, démarrage de la pile par Docker Compose, test de fumée et parcours d'identité complet à travers le conteneur Nginx, pièces chiffrées dans leur volume, aucune réponse copiée sur le disque du proxy, contrôle de dérive |

Ce qui était jusque-là rejoué hors Docker (section précédente) est donc désormais exécuté par
Docker lui-même, à chaque modification.

**Lot 5.** L'exécution qui a suivi sa publication sur la branche est passée au vert, sans
correction : la migration des conditions d'utilisation appliquée par le moteur natif de
Prisma, les 1 461 tests, et le parcours à travers le conteneur Nginx avec sa partie
« conditions d'utilisation » — publication d'un texte de 185 Ko, relecture à l'octet près,
refus au-delà des limites du proxy et de l'API, version à accepter.

**Lot 1 de la phase 3.** Même résultat, sans correction : la migration du grand livre
appliquée par le moteur natif de Prisma, les 1 710 tests, et le parcours à travers le
conteneur Nginx avec sa partie « grand livre » — un actif enregistré, un portefeuille à
zéro, aucun compte ouvert, une balance équilibrée, la copie des données au nouveau format.
Ce parcours envoie ses requêtes d'une seule adresse, en une dizaine de secondes : 74
d'entre elles sont comptées par la limite générale de l'API (120 par minute et par
adresse). Il reste de la marge, mais elle n'est pas illimitée — l'en-tête du script le
signale à qui l'allongera.

**Lot 2 de la phase 3.** Même résultat, sans correction : la migration des transferts
appliquée par le moteur natif de Prisma, les 1 979 tests, et le parcours à travers le
conteneur Nginx avec sa partie « transferts » — fonctionnalité ouverte, rien ne part sans
plafonds, plafonds fixés puis relus, chaque refus pour sa raison, aucun transfert, la copie
des données au nouveau format. **La marge du parcours se réduit** : rejoué ici à travers le
vrai Nginx, il compte 184 contrôles, et 87 de ses requêtes — contre 74 — sont comptées par
la limite générale de 120 par minute. Elle suffit encore ; le prochain lot qui allongera ce
parcours devra le scinder, ou relever cette limite pour la pile de test.

**Lot 3 de la phase 3.** Six exécutions avant celle qui accompagne ces lignes : cinq au vert,
**une en échec**. La première (commit `5ded567`) : la migration des opérations du personnel
appliquée par le moteur natif de Prisma, les 2 127 tests d'alors, et le parcours à travers le
conteneur Nginx avec sa partie « opérations du personnel » — le second administrateur y est
créé, pour la première fois, par une vraie commande `docker compose`. La deuxième (commit
`2922759`) : le parcours rendu strict. Sous GitHub Actions, il échoue désormais s'il n'a pas
de second administrateur ; **son succès établit donc que la double validation, le transfert
mené à son terme et le débit ont eu lieu dans la pile Docker.** La troisième (commit
`69a8ca5`) : les 2 135 tests, avec ceux qu'a demandés le contrôle par mutation. La
quatrième : la publication de cet état.

**L'exécution en échec** est la cinquième (commit `a77b3af`, qui ne modifiait que deux
fichiers de tests). Un test d'intégration sur 657 a échoué ; les tests de bout en bout, qui
viennent ensuite, n'ont alors pas été lancés. Ce test, écrit au lot 1 de la phase 3, n'était
pas touché par le commit, et il était passé aux dix exécutions précédentes : il exigeait un
nombre exact de nouvelles tentatives d'une transaction, alors que ce nombre dépend du temps
que met le disque à valider. Corrigé, il passe à l'exécution suivante (commit `e66b759`),
avec les 2 134 autres. Détail dans « Problèmes identifiés ».

**Les journaux de la CI ont été lus pour la première fois à cette occasion**, par un lien
temporaire que fournit l'API de GitHub — jusque-là, on ne connaissait d'une exécution que le
succès ou l'échec de ses étapes. C'est par eux que l'échec a été compris. Ils établissent
aussi ce que cet état ne pouvait que supposer du parcours : dans la pile Docker, il
envoie 162 requêtes, dont 123 comptées par la limite générale de 120 par minute, fait **une
pause de 49 secondes**, et s'achève en écrivant qu'il a éprouvé la double validation et un
transfert mené à son terme — relevé dans les deux dernières exécutions. Le parcours n'a été
ni scindé, ni la limite relevée, comme l'envisageait le paragraphe précédent : il se règle
sur ce que l'API annonce, et attend la fenêtre suivante lorsque la limite approche. Rejoué
ici à travers le vrai Nginx, il compte 259 contrôles ; 122 puis 119 de ses requêtes y sont
comptées par la limite, avec une pause de 43 secondes.

**Retouches du socle.** Une exécution avant celle qui accompagne ces lignes (commit
`fd0aa1a`) : au vert, sans correction, journaux lus. Le job de tests exécute les 2 160
tests — dont ceux qui saturent un vrai pool de connexions, sur un PostgreSQL qui attend son
disque —, sans dérive du schéma ni vulnérabilité connue. Le job Docker rejoue le parcours,
inchangé : 162 requêtes, 123 comptées par la limite, une pause. **Les pannes, elles, ne sont
pas rejouées par la CI** : les coupures de Redis et de la base ont été provoquées ici, à la
main, sur l'API compilée.

**Robustesse du socle.** Une exécution avant celle qui accompagne ces lignes (commit
`8cdfca9`) : au vert, sans correction, journaux des deux jobs lus. Le job de tests exécute
les 2 196 tests — dont ceux qui arrêtent une application réelle au milieu d'une requête, et
ceux qui vident un vrai Redis sous elle —, sans dérive du schéma ni vulnérabilité connue. Le
job Docker rejoue le parcours, inchangé : 162 requêtes, 123 comptées par la limite, une pause
de 49 secondes. **Son journal donne, pour la première fois, une durée d'arrêt sous Docker** :
à la fin du job, le conteneur de l'API s'arrête 85 millisecondes après la demande — 153 à
l'exécution précédente, avant ces corrections : l'arrêt sans incident était déjà rapide. Ce
journal ne montre pas le code de sortie, et aucune étape n'exige rien de cet arrêt. **Ni
l'arrêt pendant une panne de Redis, ni le retour d'un Redis vide ne sont rejoués par la
CI** : ils l'ont été ici, à la main, sur l'API compilée.

**Lot 4 de la phase 3.** Une exécution avant celle qui accompagne ces lignes (commit
`643a771`) : au vert, sans correction. Le job de tests, dont le journal a été lu : mise en
forme, compilation, analyse statique, types, cohérence des migrations, puis les 2 214 tests,
sur un PostgreSQL qui attend son disque, et aucune vulnérabilité connue. La nouvelle
migration y est appliquée par le moteur natif de Prisma : le fichier de tests de ce lot, qui
relit la liste et ses règles dans la base, y passe. Le job Docker, dont le journal a été lu à
partir du démarrage de la pile, non pendant la construction des images : le parcours,
inchangé, s'y déroule **sur une base qui ne connaît que les trois types d'écriture du
produit** — le crédit sous double validation, le transfert et le débit y passent (159
requêtes, dont 120 comptées par la limite, une pause de 46 secondes). **Ce parcours n'éprouve
pas le refus lui-même** : aucune de ses requêtes ne tente une écriture d'un autre type ; ce
refus est éprouvé par les tests. Et le journal ne montre pas la sortie du conteneur de
migration : que la nouvelle migration ait été appliquée dans la pile se déduit de ce qu'il
s'est terminé sans erreur avant le démarrage de l'API, non d'une ligne lue. À la fin du job,
le conteneur de l'API s'est arrêté en 134 millisecondes, contre 85 et 84 aux deux exécutions
précédentes : une durée relevée, dont rien n'est exigé.

**Une étape reste à ajouter, par vous.** L'outil qui publie une version en ligne de commande
n'a pas encore été exécuté dans la pile Docker. Le script qui le fait est prêt et a été
exécuté ici, hors Docker (`infrastructure/ci/publish-terms-cli.sh`) ; il reste à l'appeler
depuis le workflow, que l'outil qui prépare ce dépôt n'est pas autorisé à modifier. Dans
`.github/workflows/ci.yml`, job `docker`, juste après l'étape « Parcours d'identité et de
vérification d'identité à travers Nginx » :

```yaml
- name: Conditions d'utilisation publiées en ligne de commande
  run: infrastructure/ci/publish-terms-cli.sh
```

(avec le même retrait que les étapes voisines : six espaces devant le tiret.)

**Ce que cela ne dit pas.** Les journaux d'une exécution ne se lisent d'ici que depuis le
lot 3 de la phase 3 ; des exécutions antérieures, seuls le résultat et la durée de chaque
étape sont connus. La CI ne déploie rien, ne provoque aucune panne, et ne teste ni TLS, ni
sauvegarde, ni montée en charge (phase 9) ; elle n'exécute que Node.js 24.

## Problèmes identifiés

### Pendant le lot 5 de la phase 3

Le premier est le constat qui fonde le lot ; le deuxième, un défaut de ce lot lui-même,
corrigé avant sa publication ; le troisième, une conséquence voulue, à connaître.

1. **Une écriture en règle que personne n'avait demandée n'était relevée par rien.** La
   vérification horaire recalculait le registre ; les règles qui lient une écriture à son
   opération ne valaient qu'à l'écriture. Un test de ce lot passe un crédit de portefeuille
   entier et équilibré, sans demande ni approbation, pendant que la règle est suspendue par
   le propriétaire des tables : aucun des contrôles qui existaient ne le relève. De même pour
   un débit, et pour un mouvement entre deux titulaires hors de tout transfert — donc hors
   plafond. Aucune route de l'API ne le permettait, ni le rôle de l'API : il fallait le rôle
   propriétaire. **Corrigé par ce lot** : chacun est relevé au passage suivant.
2. **Une vérification incomplète pouvait passer pour complète — défaut de ce lot, corrigé
   avant sa publication.** Dans sa première version, quand l'un des trois contrôles ne
   pouvait pas s'exécuter et que les autres relevaient une anomalie, l'erreur de l'étape et
   la ligne du journal d'audit donnaient la liste des anomalies sans dire qu'un contrôle
   avait manqué — seule une autre ligne des journaux le disait : qui lisait la trace d'audit
   pouvait croire que tout le reste avait été relu. Relevé en écrivant le test de ce cas.
   L'erreur, la ligne de journal et la trace d'audit nomment maintenant le contrôle qui a
   manqué.
3. **Sur l'aperçu, la vérification horaire échoue désormais à chaque passage.** L'écriture
   d'essai du 15 novembre — celle qui avait révélé le défaut corrigé par le lot 4 — y est
   d'un type inconnu, et y restera : une écriture ne s'efface pas. Le lot 4 l'avait laissée
   sans la signaler ; ce lot la signale, toutes les heures, sans moyen de l'acquitter. C'est
   voulu : un moyen de faire taire une anomalie serait aussi un moyen de la cacher. **À vous
   de dire s'il faut recréer la base de l'aperçu** (décision 18).

### Pendant le lot 4 de la phase 3

Deux constats, faits l'un avant d'écrire le lot, l'autre en l'écrivant. Aucun n'a demandé de
modifier le code des lots précédents ; le second a demandé d'en modifier les tests.

1. **Le défaut était plus large que sa description.** L'état du lot 3 parlait d'un
   portefeuille crédité depuis le compte de conservation, et proposait une règle sur ce
   compte. En relisant les règles de la base avant d'écrire celle-ci, le même chemin existait
   sans passer par ce compte : une écriture équilibrée d'un type quelconque déplaçait des
   fonds **d'un portefeuille à un autre**, hors des plafonds et des niveaux de vérification
   que la base impose aux transferts. Les tests des lots précédents le faisaient eux-mêmes,
   sans que cela ait été relevé : ils déplaçaient ainsi des fonds entre des titulaires à qui
   les transferts sont fermés. Une règle sur le seul compte de conservation aurait laissé ce
   chemin ouvert ; la règle livrée — une liste
   fermée des types d'écriture — ferme les deux. Comme le premier, ce chemin supposait
   d'écrire dans la base à côté de l'API : aucune route ne l'ouvrait.
2. **Les tests des lots précédents reposaient sur ce défaut.** La migration appliquée, 254
   des 673 tests d'intégration ont échoué, tous sur le nouveau refus : pour disposer d'un
   solde, ou pour éprouver le grand livre avec des écritures qu'aucune opération ne produit —
   cinq lignes, plusieurs actifs, le compte des frais —, ils passaient des écritures de types
   inventés. Ils les passent toujours, faute de dépôt ou d'échange pour en produire de
   réelles ; mais chaque fichier déclare désormais ces types dans sa propre base jetable,
   avec le rôle propriétaire. **À connaître : dans ces dix fichiers, la base est donc plus
   permissive que celle d'une installation.** Trois garde-fous : le fichier de tests de ce
   lot travaille sur la base telle que les migrations la laissent, et y passe un crédit, un
   transfert et un débit réels ; le parcours de la CI et celui de l'aperçu font de même, à
   travers l'API ; enfin, le refus nouveau a été cherché dans le journal de PostgreSQL
   pendant l'exécution, un à un, des 45 fichiers de tests sur services réels : il n'apparaît
   que dans les deux fichiers qui l'éprouvent. Aucun autre test ne passe, ni n'échoue, à
   cause de lui.

### Pendant les corrections de robustesse

Le premier et le quatrième sont antérieurs à ces corrections ; le deuxième est un écart par
rapport à ce qui vous avait été proposé ; le troisième, un changement à connaître ; le
cinquième, un défaut de ces corrections elles-mêmes, corrigé avant leur publication.

1. **Une requête en cours à l'instant d'un arrêt recevait une erreur.** L'API fermait sa
   connexion à la base à la première étape de son arrêt, avant que son serveur ait fini de
   répondre. Trouvé en écrivant le test qui vérifie que les requêtes en cours vont à leur
   terme : une connexion retenue au milieu de son écriture, puis l'arrêt demandé — elle
   recevait `500`. Rien n'était perdu, la transaction était annulée ; mais à chaque mise à
   jour, les requêtes en train d'écrire échouaient. **Corrigé** : la base se ferme à la
   dernière étape, après les requêtes et les tâches en cours.

2. **La sonde de disponibilité ne dit rien des tâches planifiées — écart par rapport à la
   proposition.** Il était proposé de « faire dire à la sonde qu'elles manquent ». En
   l'écrivant, le défaut de l'idée est apparu : cette sonde décide si une instance reçoit du
   trafic, et toutes les instances lisent les mêmes tâches dans le même Redis. Une tâche
   manquante les aurait toutes fait déclarer indisponibles au même instant : le service
   entier coupé, pour un retard que la réinscription répare en moins d'une minute, et alors
   que les requêtes aboutissent. Le signal retenu est une ligne d'erreur à chaque
   réinscription. **Non fait, à confirmer** (décision 16).

3. **Un arrêt propre ne se terminait pas par le même code partout.** Hors conteneur, l'API se
   terminait par le signal reçu (code 143) ; premier processus d'un conteneur, où ce signal
   renvoyé à soi-même est ignoré, par le code 0 — par accident. Mesuré sur l'API compilée,
   dans les deux positions. C'est désormais 0 partout, et 1 pour un arrêt coupé à son
   échéance : une supervision qui attendait 143 est à régler.

4. **Pendant la première seconde de son lancement, l'API en conteneur ignore une demande
   d'arrêt.** Tant que le programme se charge, rien n'écoute les signaux ; or un premier
   processus de conteneur qui n'écoute pas n'est pas arrêté par le système. Mesuré : un
   signal envoyé 0,3 ou 0,7 seconde après le lancement est ignoré — l'API démarre, et répond
   encore douze secondes plus tard. Aucune donnée n'est en jeu : l'hébergeur force l'arrêt à
   l'expiration de son délai. **Non corrigé** : il faudrait charger l'application depuis un
   point d'entrée réduit, qui écoute d'abord. Ce qui suit le chargement est corrigé, en
   revanche : pendant l'initialisation, l'arrêt croisait le démarrage et se terminait le plus
   souvent par une erreur — code 1, trois essais sur quatre, à 1,2 ou 1,3 seconde du
   lancement — ; l'API s'arrête désormais aussitôt, par le code 0, en l'écrivant.

5. **Un des nouveaux tests échouait une fois sur quatre — trouvé avant publication.** Le test
   qui retire l'exécution en attente d'une tâche la cherchait dans deux des trois listes où
   la bibliothèque des files la range : selon l'instant, il la trouvait ou non. Lancé seul
   une demi-douzaine de fois, puis avec toute la suite, il était passé à chaque fois ; c'est
   le contrôle par mutation, qui le répète une centaine de fois, qui l'a montré — et montré
   qu'il masquait deux manques dans les tests (« mutation » ci-dessus). Il aurait fait
   échouer la CI une fois sur quatre, sans défaut dans le code. Corrigé ; les deux fichiers
   de tests de ces corrections ont ensuite été répétés 40 et 25 fois, sans échec. Rien de tel
   n'a été publié.

### Pendant les retouches du socle

Relevés en provoquant des pannes pour vérifier les deux corrections. Les trois premiers sont
antérieurs à ces retouches : **les deux premiers sont corrigés depuis** (« Robustesse du
socle »), le troisième reste ouvert ; le quatrième est un défaut de la correction elle-même,
corrigé avant sa publication.

1. **Si Redis revient vide, plus aucun message ne part — et rien ne le signale.** Les deux
   tâches planifiées de l'API, le relais de la boîte d'envoi et la purge, sont inscrites dans
   Redis au démarrage de l'API, et seulement là. Essai : Redis arrêté 12 secondes, puis
   relancé **sans ses données**. L'API s'y reconnecte, la sonde de disponibilité répond
   `200`, les requêtes aboutissent, aucune ligne d'erreur n'est écrite — et un événement
   écrit à ce moment attendait encore une minute plus tard : plus rien n'est relayé ni purgé
   jusqu'au redémarrage de l'API. Les codes de vérification, qui passent par ce relais, ne
   partent plus. Relancé **avec** ses données, comme le fait la pile Docker du dépôt
   (persistance activée, volume conservé), tout reprend de soi-même : un événement écrit de
   la même façon est parti en moins de vingt secondes. Le cas suppose donc une persistance
   absente, un volume perdu ou une bascule vers une instance neuve ; mais il est silencieux,
   et c'est ce silence qu'il fallait corriger. **Corrigé le 20 novembre** : l'API vérifie
   ses tâches toutes les trente secondes, réinscrit celle qui manque, et l'écrit. La sonde,
   elle, n'en dit rien (« Pendant les corrections de robustesse », point 2).

2. **L'API ne s'arrête pas d'elle-même tant que Redis est injoignable.** À la demande
   d'arrêt, elle ferme d'abord les exécutants de ses files, puis son serveur HTTP. Or la
   fermeture d'un exécutant attend sa connexion à Redis : pendant une coupure — et encore
   huit secondes après le retour d'une coupure de 40 secondes —, elle n'aboutit pas, le
   serveur HTTP continue de répondre, et le processus reste là : observé vingt secondes, et
   une fois plus de deux minutes, jusqu'à l'arrêt forcé. Après une coupure courte, ou une
   demi-minute après le retour, l'arrêt prend moins d'une seconde. Aucune donnée n'est en
   jeu : l'hébergeur force l'arrêt à l'expiration de son délai, une transaction interrompue
   est annulée, un événement non relayé reste en base. Mais une mise à jour déployée pendant
   une panne de Redis en est ralentie, et les requêtes en cours à cet instant sont coupées.
   Le comportement est celui de la bibliothèque des files, reproduit sans l'API. **Corrigé
   le 20 novembre** : l'API cesse d'accepter dès la demande, et s'arrête en huit secondes au
   plus.

3. **Pendant une coupure de Redis, une requête attend jusqu'à neuf secondes avant
   d'échouer.** La limitation de débit ne laisse rien passer sans compter : c'est voulu, et
   la requête répond `500`. Mais elle ne le fait qu'après une à neuf secondes, le temps de
   ses tentatives de reconnexion ; la sonde de disponibilité, elle, répond `503` en deux
   secondes, ce qui suffit à retirer l'instance du trafic. Relevé, non modifié : à revoir
   avec le point précédent.

4. **Le premier jet de la règle « une ligne par période » perdait des décomptes.** Écrire la
   ligne d'une erreur effaçait le nombre de répétitions des autres. Les tests unitaires
   d'alors passaient ; c'est l'essai de 40 secondes sans Redis qui l'a montré — une seule des
   six lignes portait son décompte. Corrigé avant publication, avec le test qui manquait ;
   l'essai refait donne les six.

### Pendant le lot 3 de la phase 3

Les cinq premiers ont été relevés avant la publication du lot, ou le jour même ; les cinq
autres, par le contrôle des tests qui l'a suivie. Le premier touche le produit : ouvert à la
fin du lot, il a été fermé par le lot 4 ; le deuxième, son déploiement ; les trois suivants,
le parcours de vérification ; les sixième, septième et huitième, les tests eux-mêmes — aucun
de ces trois-là n'a demandé de modifier le code livré. Les deux derniers touchent de nouveau
le produit : non ce lot, mais le socle sur lequel il repose, tel qu'il est depuis la phase 1.
Ouverts à la fin du lot, ils ont été corrigés depuis (« Retouches du socle »).

1. **La base de données ne ferme pas la liste des types d'écriture.** Ce lot fait vérifier
   par PostgreSQL qu'une écriture d'ajustement a son ajustement, approuvé par deux personnes
   habilitées. Mais le grand livre ne vérifie d'une écriture que l'arithmétique — entière,
   équilibrée, sans solde négatif —, pas la légitimité : une écriture équilibrée d'un
   **autre** type, écrite dans la base avec les identifiants de l'API, crédite un
   portefeuille depuis le compte de conservation, après ce lot comme avant. Constaté en
   préparant un essai sur la base de l'aperçu : pour y disposer d'un solde, un portefeuille a
   été crédité ainsi, par une écriture d'un type inventé, et la base l'a acceptée — c'est
   d'ailleurs de cette façon que la plupart des tests alimentent leurs portefeuilles. **La
   décision d'architecture, écrite avant cet essai, affirmait le contraire** ; elle a été
   corrigée avant la publication du lot, avec trois autres documents. Ce que la règle
   garantit : un défaut du code des ajustements — approbation par l'auteur, hors délai, d'un
   autre montant, passée deux fois — est arrêté par la base. Ce qu'elle ne garantit pas :
   qu'aucun autre code, ni personne disposant des identifiants de l'API, ne crédite un
   portefeuille. Aucune route de l'API ne le permet ; fermer ce chemin dans la base est
   proposé pour le lot suivant. **Fermé depuis par le lot 4**, qui a montré que le chemin
   était plus large encore (ci-dessus).
2. **Après un gel, la version précédente de l'API répond par une erreur serveur.** Essai fait
   sur la base de l'aperçu, la migration appliquée et la version du lot 2 encore en service :
   un transfert depuis un portefeuille gelé, ou vers lui, est refusé par la base — rien ne
   bouge —, mais cette version, qui ignore les gels, répond `500` ; la clôture, elle, reste
   refusée par un `409`. Le gel levé, tout refonctionne. Ce n'est pas un défaut de la version
   livrée, mais une contrainte de déploiement : ne geler qu'une fois toutes les instances à
   jour, et lever les gels avant un retour en arrière.
   [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) le dit.
3. **Le parcours de la CI a épuisé sa marge sur la limite de débit.** L'état du lot 2
   l'annonçait : 87 de ses requêtes, sur 120 admises par minute, étaient comptées par la
   limite générale. Avec la section de ce lot, il en envoie autant que la limite en admet
   — 119 et 122 comptées lors de deux exécutions rejouées ici. Plutôt que de relever la
   limite pour la pile de test, ou de scinder le parcours, il **se règle sur elle** : il lit
   ce que chaque réponse annonce et, lorsqu'il ne lui reste que cinq requêtes, attend la
   fenêtre suivante — une pause, de 43 secondes lors de ces deux exécutions. La limite n'est
   ni relevée, ni contournée. Une réserve : le parcours reconnaît la limite générale à la
   première valeur annoncée ; réglée sur la même valeur qu'une limite propre à une route, il
   les confondrait.
4. **Le parcours pouvait réussir sans avoir éprouvé la double validation.** Faute de second
   administrateur, il la sautait — en l'écrivant dans sa sortie. Or les journaux d'une
   exécution de la CI ne se lisaient pas encore d'ici : une exécution réussie ne disait donc
   pas si la double validation avait eu lieu. Sous GitHub Actions, où le parcours crée
   lui-même le second administrateur, il **échoue** désormais s'il n'en a pas. L'exécution
   qui a suivi est passée : la double validation, le transfert mené à son terme et le débit y
   ont donc eu lieu — ce que les journaux, lus depuis (point 8), confirment. Ailleurs, rien
   ne change : sans second administrateur, il saute ces passages et le dit.
5. **Le parcours inscrit deux comptes, et ne se rejoue plus que trois fois par heure sur une
   pile conservée.** Il lui faut un destinataire pour son transfert ; or la route
   d'inscription admet dix requêtes par heure et par adresse, refusées ou non, et le parcours
   lui en envoie désormais trois — deux inscriptions, et une troisième qui doit être refusée.
   Relevé sur l'aperçu, où une exécution de trop a échoué à l'inscription du second compte
   (`429`). Sans effet dans la CI, dont la pile est neuve à chaque exécution. **La
   documentation publiée avec le lot annonçait cinq exécutions par heure** : elle ne comptait
   que les deux inscriptions réussies. L'erreur a été relevée en relisant cet état, vérifiée
   sur l'aperçu — une requête refusée consomme bien une unité — et corrigée dans
   [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) et [`CHANGELOG.md`](CHANGELOG.md).
6. **Vingt-deux règles n'étaient éprouvées par aucun test, et un contrôle ne contrôlait
   rien.** Le contrôle par mutation — un défaut introduit, un test doit échouer — a montré
   vingt-deux défauts que les tests publiés avec le lot laissaient passer. **Aucun n'était
   dans le code livré**, qui applique chacune de ces règles ; mais rien n'aurait signalé leur
   disparition. Parmi elles : une demande échue, que la base laisse refuser, se serait
   affichée « refusée » si le service avait cessé de la clore d'abord ; la séparation entre
   demander et approuver n'était éprouvée, dans la base, qu'avec des rôles qui détiennent les
   deux permissions ou aucune ; la route qui gèle aurait pu exiger une autre permission sans
   qu'un test le voie, la base refusant par la même réponse. Huit tests ont été ajoutés,
   d'autres complétés, sans toucher au code livré. Par ailleurs, un des défauts du contrôle
   rendait la migration inapplicable : tous les tests du fichier échouaient, et il passait
   pour détecté sans qu'aucune règle soit éprouvée. Il a été réécrit. Détail dans « Résultats
   de tests ».
7. **Quatre défauts volontaires de la phase 2 n'étaient détectés que par un test resté
   bloqué.** L'état du lot 2 l'avait promis : les sorties complètes des 889 défauts de la
   phase 2, conservées pour la première fois, ont été examinées. Quatre faisaient échouer
   leurs tests par le délai accordé à chaque test — cinq secondes pour un test unitaire,
   trente pour les autres — et non par une vérification ; pour trois d'entre eux, c'était la
   seule détection. Chaque fois, le défaut faisait attendre le test : un serveur qui ne
   répond plus, ou ne ferme pas la connexion ; une écriture qui attend un verrou que rien ne
   rendra. Le premier test bornait bien son attente, mais à huit secondes, au-delà des cinq
   dont il disposait : sa vérification ne pouvait jamais parler. Le second ne la bornait pas.
   Un test arrêté par son délai échoue, mais tard, sans dire pourquoi — et il aurait échoué
   de la même façon pour un défaut sans rapport. Tous deux échouent maintenant en trois
   secondes, sur une vérification qui dit ce qui a manqué. Le rejeu n'en montre aucun autre :
   sur les 1 904 défauts, ces quatre-là seulement arrêtaient encore un test par son délai,
   les deux relevés au lot précédent étant corrigés. Les attentes que les tests bornent
   eux-mêmes ont aussi été relevées une à une : aucune ne dépasse plus le délai de son test.
8. **La CI a échoué une fois, sur un test qui dépendait de la vitesse du disque.** Le commit
   qui corrigeait le point précédent ne touchait que deux fichiers de tests ; son exécution a
   pourtant échoué — sur un troisième, écrit au lot 1 de la phase 3 et passé aux dix
   exécutions précédentes. Deux transactions s'y croisent ; PostgreSQL annule l'une, que
   l'API relance après une courte pause. Le test exigeait qu'une seule nouvelle tentative
   suffise. Or il en faut deux lorsque la validation de la première transaction tarde à
   devenir visible — elle attend le disque : relancée trop tôt, l'autre relit l'état d'avant,
   et PostgreSQL l'annule de nouveau. Les deux transactions aboutissent alors comme prévu, et
   c'est bien pour cela que les tentatives s'espacent : **le code est juste, le test en
   exigeait trop**. Il vérifie désormais ce qui est garanti — que la transaction annulée est
   relancée, trois fois au plus, et que seule sa dernière tentative voit l'écriture de
   l'autre.

   **Rien ne pouvait le montrer ici** : le PostgreSQL de l'environnement de développement est
   réglé pour la vitesse et valide sans attendre le disque ; celui de la CI, comme celui
   d'une installation réelle, l'attend. L'échec a été reproduit en retardant ici chaque
   validation : à 25 ms, l'ancien test échoue à chaque fois, par la même différence que dans
   la CI ; le nouveau passe de 0 à 100 ms. **Les 1 261 tests d'intégration et de bout en bout
   ont ensuite été rejoués, retardés de 25 ms : tous passent**, dans le délai ordinaire de
   chaque test. Aucun autre ne dépend donc de cette durée, à ce retard du moins. À 100 ms —
   le délai de chaque test étant alors relevé, pour que la lenteur seule n'en arrête aucun —,
   un seul échoue, pour une autre raison (point suivant). La répétition « disque lent »,
   à 25 ms, rejoint les vérifications faites avant chaque livraison. Les opérations livrées
   qui relancent une transaction — écritures du grand livre, transferts, ajustements — ne
   sont pas exposées à cette course : elles n'emploient pas le mode de transaction en cause,
   que seul ce test demande, pour provoquer un conflit. Chez elles, une transaction attend
   l'autre, si longue que soit sa validation.

   L'échec a été compris en lisant, pour la première fois, les journaux d'une exécution de la
   CI (voir « Intégration continue »).

9. **Quand la base ne suit plus, l'API répond `500` là où `503` serait exact.** La même
   répétition a été poussée à 100 ms par validation, bien au-delà de ce que demande un disque
   en bon état : sur les 1 261 tests, un seul échoue. Il lance 72 transferts à la fois entre
   six portefeuilles, sur dix connexions à la base. Les transferts d'un même portefeuille
   passent un à un, chacun retenu par sa validation ; ceux qui, au bout de deux secondes,
   attendent encore une connexion libre sont abandonnés par Prisma — 24 ou 25 sur 72 selon
   les passes, tous pour ce motif, sans un seul interblocage. Rejoué seul, le test passe à 25
   et à 50 ms, échoue à partir de 75 ms. Ni lui ni les verrous ne sont en cause : à ce
   retard, la rafale dépasse ce que dix connexions écoulent en deux secondes.

   **Ce que cela montre touche le socle.** Cet abandon n'est pas reconnu par le traitement
   des erreurs de l'API. Vérifié à part, en occupant l'unique connexion d'un pool : une
   seconde transaction est abandonnée au bout de deux secondes, une requête simple au bout de
   cinq, et la fonction qui traduit les erreurs donne, pour l'une comme pour l'autre,
   `500 INTERNAL_ERROR` — la réponse d'un défaut du programme. Or le service est alors
   saturé, non défaillant : `503`, avec le délai avant de réessayer, serait la réponse
   exacte, et la supervision y lirait une surcharge plutôt qu'une panne. La transaction
   abandonnée n'a rien écrit : la requête peut être renvoyée, avec la même clé d'idempotence
   s'il s'agit d'un transfert. **Non corrigé dans ce lot** : c'est une règle nouvelle du
   socle, qui change une réponse de l'API ; elle est proposée en tête du prochain lot
   (« Suite proposée de la phase 3 »). **Corrigé depuis** : voir « Retouches du socle ».

10. **Une erreur d'une file de tâches de fond échappe aux journaux structurés.** Relevé dans
    la sortie des tests : celui du relais de la boîte d'envoi passe, mais affiche de temps à
    autre une erreur de BullMQ — il retire le planificateur et vide la file alors qu'une
    exécution s'achève, et la tâche ne retrouve plus sa clé. Sans conséquence ici ; le
    message figurait déjà dans des sorties du lot 2, sans avoir été relevé. Ce qu'il montre
    en revanche : aucun des trois traitements de fond de l'API n'écoute les erreurs de son
    exécutant, et BullMQ les écrit alors lui-même sur la sortie d'erreur, sans format ni
    identifiant. Une connexion à Redis perdue ou un verrou de tâche expiré ne paraîtraient
    donc pas dans les journaux structurés — ce qui n'a pas été éprouvé hors des tests. **Non
    corrigé dans ce lot** ; proposé avec le point précédent. **Corrigé depuis**, et éprouvé
    hors des tests : voir « Retouches du socle ».

### Pendant le lot 2 de la phase 3

Les cinq premiers ont été traités avant la publication du lot ; le sixième, relevé par la
vérification qui l'a suivie, l'a été le jour même. Le premier touche le produit ; les
autres, ses tests, l'outil qui les éprouve et sa documentation.

1. **La base contrôlait l'écriture d'un transfert en se fiant à l'ordre de ses deux
   lignes** : le débit de l'émetteur en première, le crédit du destinataire en seconde. Or
   rien, dans le grand livre, ne fixe cet ordre. L'application écrit bien le débit d'abord,
   et aucun transfert n'aurait été refusé à tort ; mais la règle tenait à un détail que
   personne n'a décidé, et le jour où il aurait changé, tous les transferts auraient été
   refusés. Elle examine désormais chaque ligne pour elle-même — un débit du montant chez
   l'émetteur, un crédit du montant chez le destinataire, et rien d'autre —, et un test
   passe l'écriture dans l'autre ordre.
2. **Trois défauts volontaires n'étaient pas détectés par les tests** (voir « mutation »
   ci-dessus). Le plus instructif concerne deux transferts croisés — de A vers B pendant
   que B envoie à A. Le test les faisait bien aboutir tous deux, mais le second n'avait
   encore rien retenu quand le premier écrivait : un verrou plus fort sur l'émetteur, avec
   lequel ils se seraient interbloqués, passait donc inaperçu. Le test place désormais les
   deux transferts au point où ils se gênent — chacun ayant verrouillé son émetteur et
   retenu les deux titulaires — et borne l'attente du premier à trois secondes ; avec le
   défaut, il échoue sur ce délai.
3. **Deux défauts volontaires étaient confrontés au mauvais fichier de tests.** L'outil de
   vérification les annonçait non détectés, alors que le test qui les voit existait, dans
   un autre fichier. Sans conséquence pour le produit ; mais un tel résultat se lit d'abord
   comme un manque dans les tests, et a été examiné comme tel avant que l'outil soit
   corrigé.
4. **Ce que devient un transfert quand l'une de ses parties est suspendue au même instant
   n'était établi que par un raisonnement sur les verrous, sans essai.** Trois tests ont
   été ajoutés. Ils confirment que la suspension d'un émetteur attend son transfert en
   cours, et qu'un transfert attend la suspension en cours de son émetteur, puis est
   refusé. Ils établissent aussi que **la suspension d'un destinataire, elle, n'attend
   pas** : un transfert déjà en cours aboutit, le suivant est refusé, et les fonds reçus
   restent sur un compte qui ne peut plus rien envoyer. La documentation le dit
   ([`docs/SECURITY.md`](docs/SECURITY.md)).
5. **Le nom d'un test promettait plus qu'il ne vérifiait.** « Aucune route publiée ne passe
   d'écriture » n'examinait que les routes du grand livre et des portefeuilles : exact au
   lot 1, où aucune autre n'écrivait ; trompeur depuis qu'un transfert en passe une. Le
   test dit maintenant ce qu'il vérifie.
6. **Deux défauts volontaires n'étaient détectés que par un test bloqué.** Une liste qui
   ignore son curseur rend toujours la même page ; le test qui la parcourait « page par
   page » tournait alors sans fin, jusqu'au délai de trente secondes accordé à chaque test.
   Il finissait donc par échouer — mais tard, sans dire pourquoi, et, pour le grand livre,
   en faisant échouer six tests voisins. L'un des deux cas est dans les tests des transferts ;
   **l'autre date du lot 1** — ni le test, ni le code en cause n'ont changé depuis —, et la
   vérification d'alors l'avait compté comme une détection ordinaire : elle ne gardait que
   le résumé de chaque exécution. La passe finale de ce lot garde les sorties complètes, et
   c'est en y cherchant les tests arrêtés par leur délai que ces deux cas sont apparus. Les
   cinq parcours de ce genre — deux datent de la phase 2 — s'arrêtent maintenant après un
   nombre de pages qui ne peut pas être atteint sans défaut, et l'échec vient de la
   vérification qui suit : avec les deux défauts, en moins d'une seconde, et sans entraîner
   d'autre test. Les sorties des 889 défauts de la phase 2, qui n'avaient pas été conservées,
   ont été examinées au rejeu suivant : quatre cas de plus (« Pendant le lot 3 de la
   phase 3 », point 7).

### Pendant le lot 1 de la phase 3

Les trois premiers ont été corrigés avant la première publication du lot ; le quatrième,
relevé par la vérification qui l'a suivie, l'a été le jour même. Les deux premiers touchent
le produit ; les deux autres, ses tests.

1. **L'ordre des verrous d'une écriture l'exposait à s'interbloquer avec une opération.**
   L'écriture verrouillait d'abord ses comptes ; la base retenait ensuite leur titulaire, à
   chaque ligne. Une opération qui aurait procédé dans l'autre sens — verrouiller le
   titulaire, pour contrôler un plafond par exemple, puis passer une écriture — aurait
   formé un cycle avec elle : PostgreSQL annule alors l'une des deux transactions, après
   une seconde d'attente. Rien n'aurait été écrit à moitié, et l'écriture aurait été
   relancée ; mais c'est un échec évitable, que les prochaines opérations auraient
   rencontré. Trouvé à la relecture, alors qu'aucune opération n'existe. L'ordre est
   désormais unique — les titulaires, puis les comptes. Un test provoque le croisement et
   vérifie qu'aucune transaction n'est annulée ; l'ordre inverse, introduit volontairement,
   fait échouer trois tests.
2. **Une erreur que PostgreSQL ne signale qu'à la validation d'une transaction n'était pas
   reconnue.** C'est à cet instant que la base vérifie qu'une écriture est entière et
   équilibrée, et c'est parfois à cet instant seulement qu'elle annonce que deux
   transactions se sont croisées. Or la bibliothèque d'accès à la base ne présente pas ces
   erreurs comme celles d'une instruction : le code qui lit le code d'erreur de
   PostgreSQL ne les reconnaissait pas. Un croisement annoncé à la validation n'aurait donc
   pas été relancé, et aurait répondu `500`. Constaté par un essai, avant d'écrire le
   service ; le code lit désormais les deux formes, et des tests le vérifient sur un vrai
   PostgreSQL — deux transactions qui se croisent, une règle refusée à la validation.
3. **Dix-sept défauts volontaires n'étaient pas détectés par les tests** (voir
   « mutation » ci-dessus). Le plus instructif est une récidive : au lot 5 de la phase 2,
   la protection d'une table contre le vidage d'un bloc pouvait disparaître sans qu'un test
   le voie, parce que celle de la table voisine arrêtait l'essai. Les tests du grand livre
   ont été écrits de la même façon, pour quatre tables, et la même vérification l'a relevé
   de nouveau. Chaque table est maintenant essayée seule, les protections des autres étant
   levées le temps de l'essai. Autre cas du même genre : une route du back-office qui exigeait la mauvaise
   permission passait inaperçue, parce que la base refusait à sa place, par la même
   réponse ; le test lit désormais, au journal d'audit, quel contrôle a refusé.
4. **Un défaut volontaire n'était détecté que par la préparation des tests.** Trois défauts
   du grand livre faisaient échouer d'un coup les 65 tests d'un fichier : ils empêchent la
   préparation commune de ces tests d'ouvrir les comptes de la plateforme. Un tel résultat
   ne dit pas si un test vise la règle. Chacun a donc été rejoué contre une copie du fichier
   dont la préparation tolère cet échec, en ne lançant que les tests concernés. Deux
   échouent encore, sur la règle elle-même. Le troisième — un seul compte de la plateforme
   par actif, au lieu d'un par type et par actif — **passait** : le jour où la préparation
   aurait changé, plus rien ne l'aurait relevé. Un test ouvre désormais, dans un actif
   neuf, un compte de chaque type.

### Pendant le lot 5 de la phase 2

Tous corrigés avant la première publication du lot. Les trois premiers touchent le
produit ; les autres, ses tests.

1. **Une inscription croisée par une publication pouvait révéler qu'une adresse avait déjà
   un compte.** Entre le premier contrôle d'une inscription et son écriture, une nouvelle
   version peut être publiée. La demande était alors refusée (`409`) si l'adresse était
   libre ou en attente de vérification — la base refuse l'acceptation d'une version
   dépassée —, mais admise (`202`) si l'adresse appartenait déjà à un compte, puisque rien
   n'est écrit dans ce cas. À cet instant précis, la réponse distinguait donc les deux.
   Trouvé à la relecture du code. La version en vigueur est maintenant relue dans la
   transaction, et la réponse est la même dans les trois cas ; un test provoque le
   croisement, et échoue sans la correction.
2. **Une version lue par son numéro à l'instant même de sa publication pouvait être
   annoncée comme n'étant pas en vigueur** : la version et le numéro en vigueur étaient lus
   ensemble. Trouvé à la relecture ; le numéro en vigueur est maintenant lu après la
   version.
3. **L'outil de publication ne disait pas où il avait cherché un fichier introuvable.**
   Lancé depuis un autre dossier que celui du fichier, il répondait seulement que le fichier
   ne pouvait pas être lu. Constaté en publiant le texte de démonstration de l'aperçu ; il
   nomme maintenant le chemin complet, et la documentation dit d'où s'entend un chemin
   relatif.
4. **Le parcours de la pile complète comportait deux fautes**, trouvées en le rejouant hors
   Docker avant de le confier à la CI : son texte de test dépassait la longueur maximale
   d'un texte — la publication était refusée, à juste titre ; et, sur une pile où une
   version existe déjà, sa première inscription n'attendait pas que l'ouverture de
   l'inscription soit visible.
5. **Un test écrit pour ce lot bloquait au lieu d'échouer.** Trouvé en rejouant un défaut
   volontaire du lot 3 : quand la lecture d'un corps de requête lève une erreur hors de
   tout traitement, la requête reste sans réponse — le test attendait indéfiniment, et
   l'arrêt de son serveur aussi. Il échoue maintenant en trois secondes. Le même travers
   avait déjà été trouvé de cette façon aux lots 2 et 4.
6. **Seize défauts volontaires sur 275 n'étaient pas détectés à la première passe** (voir
   « mutation » ci-dessus), dont treize manques dans les tests, comblés. Le plus notable :
   une acceptation pouvait être datée d'avant la publication du texte accepté si sa
   transaction avait commencé plus tôt. La base l'empêchait déjà ; aucun test ne
   l'établissait.

Comme au lot 4, des requêtes simultanées ont été envoyées à l'API de l'aperçu : neuf salves
de seize requêtes autour d'une publication — deux publications du même numéro, des
acceptations de la version que l'on remplace, une clôture qui croise une acceptation, des
inscriptions avec une adresse libre et avec une adresse déjà prise. Aucune erreur serveur ;
une seule publication aboutit par salve ; les inscriptions reçoivent la même réponse dans
les deux cas.

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
- **Conditions d'utilisation : le texte n'existe pas.** Rien n'est publié ; l'inscription
  répond `503` tant que la version 1 ne l'est pas.
- **Conditions : une publication est immédiate, définitive, et l'affaire d'une seule
  personne.** Ni brouillon, ni date d'effet, ni seconde validation ; une erreur se corrige
  par la version suivante — que chaque compte devra accepter de nouveau si elle l'exige.
- **Conditions : aucune annonce.** Ni e-mail ni préavis : le titulaire découvre la nouvelle
  version à sa prochaine requête, refusée tant qu'il n'a pas accepté.
- **Conditions : accepter est un appel de l'API.** Elle enregistre qu'un compte identifié a
  déclaré accepter telle version, avec l'empreinte du texte alors en vigueur ; elle ne peut
  pas établir que ce texte a été affiché ni lu — c'est le rôle de l'interface (phase 7).
- **Conditions : la preuve après la clôture.** L'acceptation est supprimée avec le compte ;
  il en reste l'entrée du journal d'audit (compte, version, empreintes, date, adresse IP).
- **Conditions : le texte est conservé tel qu'il est fourni** (texte brut ou Markdown).
  L'API ne le met pas en forme et ne vérifie pas que la traduction anglaise dit la même
  chose que le français ; les listes de versions se limitent aux cent plus récentes.
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
  PostgreSQL — une requête interrompue, rien d'écrit à moitié — et répondrait `409`, à
  renvoyer telle quelle (`500` avant le lot 1 de la phase 3). Une
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

Grand livre :

- **Deux opérations existent, toutes deux fermées.** Le transfert entre titulaires et
  l'ajustement par le personnel écrivent dans le registre : il a été éprouvé par ses tests —
  écritures simultanées comprises — et par le parcours de la CI, jamais par un usage, ni sous
  charge.
- **Aucun actif n'est enregistré**, et la liste à tenir n'est pas arrêtée (décision 12).
- **Actifs : un enregistrement est immédiat, définitif, et l'affaire d'une seule
  personne.** Ni double validation, ni correction, ni retrait : un actif enregistré avec un
  nombre de décimales erroné doit l'être de nouveau sous un autre code, et l'actif erroné
  reste — chaque titulaire y garde un portefeuille à zéro.
- **Pas de rapprochement.** La balance et la vérification horaire établissent que le
  registre est cohérent avec lui-même, pas que les fonds existent chez la banque,
  l'opérateur de monnaie mobile ou le dépositaire.
- **Une anomalie ne déclenche aucune alerte.** Elle est dans les journaux et au journal
  d'audit, à chaque passage ; rien n'est corrigé automatiquement, et la conduite à tenir se
  limite aujourd'hui à une consigne : passer en maintenance, ne rien corriger à la main,
  examiner.
- **La vérification relit tout le registre** à chaque passage — depuis le lot 5, en trois
  lectures : le registre, tous les transferts, tous les ajustements approuvés. Sans
  conséquence aujourd'hui ; **jamais mesurée sur un registre volumineux**, à borner quand le
  volume grandira. Elle rapporte cinquante anomalies au plus, tous contrôles confondus.
- **La vérification relit ce que la base refuse à l'écriture, non ce qui dépendait du
  moment** (lot 5) : ni les plafonds et le niveau de vérification à l'heure d'un transfert,
  ni les permissions à l'heure d'une approbation, ni un gel alors en vigueur. Et **rien ne
  permet d'acquitter une anomalie** : une écriture ancienne d'un type inconnu est signalée à
  chaque passage, tant que la base existe.
- **Le propriétaire du schéma peut tout** : lever une règle, puis altérer une ligne. Ses
  identifiants ne servent qu'aux migrations et aux outils d'exploitation ; la vérification
  horaire est là pour relever une telle altération.
- **Comptes de la plateforme : un point de contention à mesurer.** Les écritures d'un même
  compte passent une à une ; or tout dépôt et tout retrait toucheront le compte de
  conservation de leur actif. À mesurer sous charge avant l'ouverture, et à répartir si
  nécessaire.
- **Un compte qui détient des fonds ne se clôt pas.** Le titulaire les envoie à un autre
  compte, si les transferts lui sont ouverts ; sinon le personnel les en sort par un débit
  sous double validation — la plateforme les rend alors hors de l'API, et **rien ne vérifie
  qu'elle l'a fait**. La procédure de sortie reste à écrire avant l'ouverture des dépôts.
- **Le back-office ne corrige le registre que par un ajustement** : le crédit ou le débit
  d'un portefeuille contre le compte de conservation, à deux. Il ne peut ni annuler une
  écriture, ni en passer une entre deux comptes de la plateforme, ni toucher aux frais
  perçus. Il n'a pas d'écran (phase 7).
- **Pas de fonds réservés** : une opération a lieu entièrement, ou pas du tout. Ils
  viendront avec la première opération en plusieurs temps.
- **Les écritures ne s'effacent jamais**, y compris après la clôture d'un compte et au-delà
  de dix ans — passé ce terme, plus rien ne les rattache à une personne. À faire confirmer
  (décision 6).

Transferts entre titulaires :

- **Rien n'a encore été transféré hors des tests et du parcours de la CI.** Aucun plafond
  n'est fixé, la fonctionnalité est fermée, aucun portefeuille n'est crédité. Ni usage réel,
  ni mesure sous charge.
- **Aucune valeur de plafond n'est arrêtée** (décision 5), et un changement de plafonds est
  l'affaire d'une seule personne, sans double validation ; il prend effet aussitôt.
- **Un transfert est définitif** : ni annulation, ni délai de rétractation, ni bénéficiaires
  enregistrés, ni confirmation d'un nouveau destinataire. Le personnel ne peut ni annuler, ni
  modifier un transfert ; depuis le lot 3, il peut seulement en compenser l'effet par deux
  ajustements — un débit chez l'un, un crédit chez l'autre —, chacun sous double validation.
- **Suspendre un destinataire n'arrête pas le transfert déjà en cours vers lui** : il
  aboutit, et les fonds restent sur le compte suspendu, qui ne peut plus rien envoyer. Les
  transferts suivants sont refusés. Ces fonds en sortent par un débit sous double
  validation (lot 3).
- **Le second facteur n'est exigé que s'il est activé** — il reste facultatif pour un
  titulaire. Sans lui, le mot de passe suffit à envoyer des fonds, dans la limite des
  plafonds.
- **Les plafonds ne portent que sur les envois, actif par actif** : rien ne borne ce qu'un
  compte reçoit ou détient, ni le total de ses envois tous actifs confondus — il n'existe
  pas de taux de change pour les additionner.
- **Recevoir suppose un niveau ouvert, donc le droit d'envoyer** : il n'existe pas de
  réglage « réception seule ».
- **Aucune surveillance des transactions** : ni filtrage (sanctions, personnes politiquement
  exposées), ni détection de fractionnement ou de comptes multiples (phase 8).
- **Sonder des adresses reste possible, lentement** : jusqu'à neuf refus par 24 heures et par
  compte ne suspendent rien ; chacun demande la preuve du titulaire, un niveau ouvert et
  des fonds suffisants pour le montant demandé.
- **Le destinataire voit l'adresse e-mail de l'émetteur** ; aucun nom n'est montré, aucun
  libellé ne peut être joint à un transfert.
- **Les avis par e-mail ne sont pas garantis** : sans serveur d'envoi, ils ne partent pas, et
  le transfert a lieu quand même. Aucune notification dans l'application (phase 7).
- **Le back-office ne consulte pas les transferts en tant que tels** : il lit les écritures
  du grand livre, qui portent l'identifiant du transfert, et le journal d'audit, qui garde
  chaque transfert et chaque refus. Pas d'écran (phase 7).
- **La clé d'idempotence est conservée avec le transfert, sans limite de durée** : un client
  ne doit y mettre qu'une valeur aléatoire.
- **Les transferts d'un même émetteur passent un à un.** Sans conséquence pour un
  particulier ; à mesurer si un compte devait un jour en émettre beaucoup (un marchand).

Opérations du personnel :

- **Aucun ajustement n'a été passé hors des tests et du parcours de la CI.** La
  fonctionnalité est fermée. Ni usage réel, ni mesure sous charge.
- **Pas de rapprochement, pas de montant maximal, pas de pièce jointe.** Un crédit constate
  ce que deux personnes déclarent ; sa justification est un texte, qui doit désigner la
  pièce. La procédure qui fonde un ajustement n'est pas écrite (décision 15).
- **La liste des types d'écriture est fermée pour ce qui s'écrit désormais, non pour ce qui
  l'a été** (lot 4) : la base ne réexamine pas les écritures antérieures à la migration.
  Depuis le lot 5, la vérification horaire les signale, à chaque passage. Un type ajouté à la
  liste sans la règle qui le lie à son opération rouvrirait le chemin : deux tests le gardent
  pour les types présents, rien dans la base ne l'impose — et **ajouté à la main par le
  propriétaire des tables, il ne serait signalé par rien**. Le propriétaire des tables peut
  suspendre ces règles, comme toutes celles du grand livre : la vérification horaire relève
  alors, après coup, ce qui a été écrit.
- **La base vérifie la qualité des deux intervenants, pas leur présence** : c'est l'API qui
  les lui désigne, et c'est elle qui vérifie la preuve de l'approbateur. Qui écrirait dans la
  base avec les identifiants de l'API pourrait fabriquer une demande et son approbation au
  nom de deux administrateurs existants — en laissant une demande ineffaçable qu'ils n'ont
  pas faite. Même limite que pour les changements de rôle.
- **Seul `super_admin` prend part à un ajustement et lève un gel** ; il n'existe pas de rôle
  « finance ». Il faut deux administrateurs, chacun avec la validation en deux étapes.
  L'approbateur redonne son mot de passe et son second facteur ; l'auteur de la demande, non.
- **Lever un gel est l'acte d'une seule personne**, sans double validation.
- **Un gel se voit, vaut pour un seul actif, et arrête aussi ce qui arrive** : ni gel
  discret, ni gel de tout un compte en une fois, ni gel des seules sorties. Le support ne
  consulte pas les gels.
- **Un gel et sa levée n'envoient aucun message.** Un ajustement en envoie un, **qui n'est
  pas garanti** : sans serveur d'envoi, il ne part pas, et l'ajustement a lieu quand même.
- **Une demande en attente ne retient pas la clôture du compte** : clôturé, il ne reçoit plus
  rien, et la demande ne peut plus qu'être refusée, retirée, ou échoir.
- **Les justifications sont conservées sans limite de durée**, y compris après la clôture du
  compte ; le titulaire ne les lit jamais (décision 6).
- **Après un gel, pas de retour à la version précédente de l'API** sans avoir levé les gels :
  elle répondrait par une erreur serveur à tout transfert qui touche un portefeuille gelé.
- **Pas d'écran** (phase 7) : demander, approuver, geler et lever se font par les routes de
  l'API.

Socle :

- **Observabilité** : journaux structurés et identifiants de corrélation uniquement.
  OpenTelemetry, métriques et tableaux de bord Grafana ne sont pas commencés.
- **Sauvegardes, restauration, alertes** : non commencées (phase 9).
- **WebSockets** : non commencés (aucun cas d'usage avant les notifications en temps réel).
- **Transactions** : une transaction annulée pour conflit n'est reprise automatiquement que
  pour les écritures du grand livre, les transferts et l'approbation d'un ajustement (trois
  nouvelles tentatives, étalées sur un quart de seconde au plus). Partout ailleurs, la
  requête répond `409` et c'est au client de la renvoyer.
- **Base saturée** : une transaction qui attend plus de deux secondes une connexion libre à
  la base est abandonnée — une requête simple, au bout de cinq —, et l'API répond `503` avec
  le délai avant de réessayer. Elle reconnaît cette situation **au message de l'erreur**,
  faute de code : une mise à jour de Prisma ou de `pg` qui en changerait les termes ferait
  revenir le `500` — et échouer le test qui la provoque. L'API ne relance pas elle-même la
  requête. Devant une base qui accepte la connexion et ne répond plus, les deux réponses se
  mêlent : `500` pour la requête qui ouvrait une connexion, `503` pour celles qui attendaient
  derrière elle. Le nombre de connexions — dix par instance — n'a pas été éprouvé sous charge
  (phase 9).
- **Journaux des tâches de fond** : une même erreur ne s'écrit qu'une fois par demi-minute,
  avec le nombre de ses répétitions ; une erreur qui cesse ne laisse pas de ligne de fin — la
  durée d'une panne se lit à trente secondes près. Aucune alerte n'est branchée sur ces
  lignes (phase 9). Les pannes qui ont éprouvé ces journaux ont été provoquées à la main ;
  aucun test automatique ne les rejoue.
- **Redis qui perd ses données** : l'API réinscrit ses tâches planifiées en moins d'une
  minute, et l'écrit ; **elle ne rend pas ce que Redis portait d'autre**. Les événements déjà
  remis à la file et pas encore traités sont perdus — leurs messages ne partent pas, et aucun
  outil ne les rejoue — ; les compteurs de la limitation de débit repartent de zéro ; une
  connexion en attente de sa seconde étape est à refaire. La persistance de Redis reste
  exigée ; la pile Docker du dépôt l'active. La sonde de disponibilité ne dit rien des tâches
  planifiées, et aucune alerte n'est branchée sur la ligne qui en parle (phase 9).
- **Arrêt de l'API** : borné à huit secondes. À cette échéance — atteinte quand Redis est
  injoignable —, les requêtes et les tâches encore en cours sont coupées ; aucune donnée
  n'est en jeu. Pendant la première seconde de son lancement en conteneur, l'API ignore une
  demande d'arrêt. Sous Docker, aucune étape ne vérifie l'arrêt — le journal de la CI n'en
  donne que la durée, pour l'arrêt sans incident —, et aucun test automatique n'envoie un
  vrai signal à un vrai processus : l'arrêt pendant une panne et le signal réel ont été
  éprouvés à la main, hors Docker.
- **Requêtes pendant une coupure de Redis** : elles échouent (`500`) — la limitation de débit
  ne laisse rien passer sans compter —, mais après une à neuf secondes d'attente.
- **Boîte d'envoi** : remise « au moins une fois » (les consommateurs doivent être
  idempotents) ; nouvelle tentative par événement et non par consommateur ; pas encore
  d'outil pour rejouer un événement abandonné. Les événements publiés sont supprimés après
  trente jours ; les événements abandonnés, jamais.
- **Limitation de débit** : fenêtre fixe, par adresse IP, complétée par des limites par compte
  sur la connexion, les codes et les transferts.
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
5. **Plafonds de transfert : les valeurs.** Le mécanisme est livré, et **vide** : rien ne
   part tant qu'aucune valeur n'est saisie. À arrêter avec votre conseil, pour chaque
   monnaie tenue et pour chaque niveau — 0 (adresse e-mail vérifiée, aucun dossier
   accepté), 1, 2 et 3 : le montant admis par transfert, sur 24 heures et sur 31 jours ; ou
   la décision de laisser un niveau fermé — un compte de ce niveau ne peut alors ni envoyer,
   ni recevoir. À dire aussi : faut-il borner ce qu'un compte **reçoit** ou **détient**
   (non réalisé), et qui, chez vous, peut changer ces valeurs — aujourd'hui `super_admin`
   seul, et une seule personne suffit.
6. **Durées de conservation et droits des personnes** — à faire confirmer par votre conseil :
   la conservation de dix ans après la clôture (et son application aux dossiers refusés), le
   délai de trente jours avant effacement, la durée de conservation du journal d'audit, les
   formalités auprès de l'autorité de contrôle, et la liste des pièces acceptées. Depuis le
   grand livre : les écritures comptables ne s'effacent jamais, et un compte clôturé qui en
   a eu garde ses identifiants dix ans. Depuis les opérations du personnel : les
   justifications des ajustements et des gels — des textes libres, qui peuvent nommer une
   personne — sont conservées sans limite de durée.
7. **Examen des dossiers** : qui examine, avec quelle consigne écrite (quand accepter, quand
   refuser), et comment les fichiers reçus sont ouverts sans risque (analyse antivirus ou
   poste isolé).
8. **Vérification des entreprises** : en avez-vous besoin au lancement, et pour quelles
   formes de société ?
9. **Conditions d'utilisation** : **le texte**, à faire rédiger et valider par votre conseil
   — rien ne peut être publié sans lui, et personne ne peut s'inscrire avant. Puis, pour
   chaque version suivante, **la règle** : doit-elle être acceptée de nouveau avant de
   continuer à utiliser le compte, ou seulement signalée ? L'API permet désormais les deux,
   version par version. Restent à dire : laquelle s'applique, s'il faut un préavis ou un
   e-mail d'annonce (non réalisés), et qui, chez vous, est autorisé à publier.
10. **Hébergement cible** (fournisseur, région) et exigences de localisation des données —
    les pièces d'identité y sont désormais soumises.
11. **Statut réglementaire visé en RDC** et calendrier des autorisations : il conditionne
    l'ordre d'ouverture des fonctionnalités — à commencer par le transfert entre
    titulaires et les ajustements, livrés fermés.
12. **Actifs à tenir** : quelles monnaies la plateforme tient-elle au lancement, et avec
    combien de décimales chacune ? L'enregistrement est définitif. À titre d'exemple : 2
    pour le franc congolais et le dollar, 8 pour le bitcoin ; pour un jeton, le nombre
    dépend des réseaux retenus, à arrêter avec la phase 5. Rien ne presse tant que les
    dépôts n'existent pas : un actif enregistré trop tôt ne se retire pas.
13. **Accès au grand livre** : qui, chez vous, doit pouvoir lire les soldes et les
    mouvements de tous les titulaires (finance, conformité, support), et qui peut
    enregistrer un actif ? Aujourd'hui, `super_admin` seul pour l'un et l'autre, et une
    seule personne suffit pour enregistrer.
14. **Transferts : cinq choix faits sans vous, à confirmer.** Chacun se change sans
    reprendre le reste (ADR 0026) :
    - le destinataire est désigné par son **adresse e-mail** — pas par un numéro de
      téléphone, ni par un identifiant public —, et le refus est le même quelle qu'en soit
      la cause ;
    - chaque partie voit **l'adresse e-mail de l'autre**, et aucun nom ;
    - le **mot de passe est redemandé à chaque transfert**, avec le second facteur
      seulement s'il est activé — faut-il le rendre obligatoire pour transférer ?
    - les plafonds portent sur **les envois**, par monnaie et par niveau, sur 24 heures et
      31 jours **glissants** — pas par jour ni par mois civils ;
    - la **base de données applique elle-même les plafonds** : un outil qui écrirait à
      côté de l'API ne les contourne pas, et une correction manuelle devra passer par une
      opération prévue pour cela.

    S'y ajoutent trois points que le code ne tranche pas : un transfert est **sans
    frais** ; il est **définitif**, sans délai de rétractation ; aucun **libellé** ne
    l'accompagne.

15. **Ajustements et gels : une procédure à écrire, et huit choix à confirmer.** Avant toute
    ouverture, à arrêter avec votre conseil : **ce qui fonde un ajustement** — quelle pièce,
    quel rapprochement avec la banque ou l'opérateur, à partir de quel montant il faut
    davantage — et **qui**, chez vous, demande, approuve, gèle et lève. Puis les huit choix
    faits sans vous ; chacun se change sans reprendre le reste (ADR 0027) :
    - la contrepartie d'un ajustement est toujours le **compte de conservation** : il
      constate des fonds reçus ou rendus hors de l'API — ni geste commercial, ni écriture
      contre les frais perçus ;
    - **seul `super_admin`** prend part à un ajustement et lève un gel ; la conformité gèle ;
      aucun rôle « finance » n'a été créé ;
    - l'**approbateur** redonne son mot de passe et son second facteur ; l'auteur de la
      demande, non ;
    - **aucun montant maximal** ne borne un ajustement, et aucun niveau de vérification n'est
      exigé du titulaire crédité ;
    - le titulaire est **prévenu par e-mail d'un ajustement, pas d'un gel** ; il ne lit
      jamais une justification ;
    - un gel **se voit**, vaut pour **un actif**, arrête **aussi ce qui arrive** et retient
      la clôture ; le lever est l'acte d'**une seule personne** ;
    - une demande **échoit après 72 heures**, comme une demande de changement de rôle ;
    - les ajustements sont **fermés par défaut** ; les gels, non : on gèle à tout moment.

16. **Socle : treize choix techniques à confirmer.** Sans objection de votre part, ils
    restent. Les six des premières retouches (ADR 0028) :
    - une base saturée se reconnaît **au message de l'erreur** ; un test la provoque pour de
      vrai, et signalera tout changement ;
    - le délai annoncé au client est de **cinq secondes** ;
    - ces refus, et les erreurs des tâches de fond, s'écrivent au niveau **« erreur »** ;
    - l'API **ne relance pas** elle-même une requête refusée faute de connexion ;
    - une même erreur de tâche de fond s'écrit **une fois par demi-minute** ;
    - les **passages en échec** du relais et de la purge sont écrits eux aussi.

    Et les sept des corrections de robustesse (ADR 0029) :
    - la sonde de disponibilité **ne signale pas** les tâches planifiées manquantes — c'est
      l'écart par rapport à la proposition ; une ligne du journal le dit ;
    - les tâches sont vérifiées **toutes les trente secondes**, et réinscrites au-delà
      d'**une minute** de retard ;
    - chaque réinscription s'écrit au niveau **« erreur »** ;
    - l'API se donne **huit secondes** pour s'arrêter ;
    - un arrêt propre se termine par le **code 0**, un arrêt coupé à l'échéance par le
      code 1 ;
    - l'API **refuse les connexions dès la demande d'arrêt** : une instance se retire du
      trafic avant d'être arrêtée ;
    - à l'échéance, **ce qui est encore en cours est coupé**.

17. **Lot 4 : fait sans votre confirmation — à valider, avec cinq choix.** D'abord le
    principe : ce lot était proposé, non confirmé ; votre « continue » a été pris pour un
    accord. S'il ne devait pas être fait, ou pas ainsi, il se retire. **Votre « vas y » du
    23 novembre a été lu comme son maintien** — le lot 5 repose sur lui ; dites-le si ce
    n'était pas le cas. Puis les cinq choix faits pour qu'il soit complet (ADR 0030) ; sans
    objection de votre part, ils restent :
    - une **liste fermée des types d'écriture**, plutôt que la règle proposée sur le seul
      compte de conservation : elle ferme aussi le déplacement d'un portefeuille à un autre ;
    - les **écritures déjà passées ne sont pas réexaminées** : la règle vaut pour ce qui
      s'écrit après la migration ;
    - la **vérification horaire n'est pas étendue** au type des écritures — proposé pour la
      suite. **Ce choix est repris : c'est le lot 5**, fait sur votre « vas y » ;
    - un type inconnu passé par le code est **un défaut, non un refus prévu** : erreur
      serveur, rien d'écrit, un code d'erreur propre dans les journaux (`MGX13`) ;
    - les **tests gardent leurs écritures d'essai**, dont ils déclarent les types avec le
      rôle propriétaire, dans leur propre base.

18. **Lot 5 : cinq choix à confirmer, et une question sur l'aperçu.** L'étape, vous l'avez
    approuvée ; ces choix ont été faits en la construisant (ADR 0031). Sans objection de
    votre part, ils restent :
    - une anomalie ancienne est **signalée à chaque passage, sans moyen de l'acquitter** : un
      moyen de la faire taire serait aussi un moyen de la cacher ;
    - les **demandes d'ajustement non approuvées ne sont pas relues** : seul un ajustement
      approuvé a une écriture ;
    - **ce qui dépendait du moment n'est pas relu** : plafonds et niveau de vérification à
      l'heure d'un transfert, permissions à l'heure d'une approbation, gel alors en vigueur ;
    - un contrôle qui ne peut pas s'exécuter fait échouer l'étape **sans ligne au journal
      d'audit**, quand les autres n'ont rien relevé : ce n'est pas une anomalie du registre ;
    - le type d'une écriture se compare à **la liste que tient la base**, non à celle du
      code : un type que le propriétaire des tables y ajouterait à la main ne serait pas
      signalé.

    **Et une question : faut-il recréer la base de l'aperçu ?** L'écriture d'essai du 15 novembre
    y fait échouer la vérification toutes les heures, et y ajoute chaque fois une ligne au
    journal d'audit. La recréer efface les comptes et les données de l'aperçu ; la garder laisse
    l'alerte en place — ce qui montre aussi, sur un cas réel, ce que la vérification relève. Rien
    n'a été fait sans vous.
