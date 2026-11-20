# 0026 — Transferts entre titulaires : immédiats, idempotents, plafonnés par niveau de vérification

**Statut :** acceptée (2026-11-14) — les valeurs des plafonds, les actifs et les niveaux à ouvrir, et l'ouverture même de la fonctionnalité restent à décider par le propriétaire et son conseil ; cinq choix de produit, faits ici sans lui, sont à confirmer (voir « Choix à confirmer »)

## Contexte

Le grand livre (ADR 0025) tient des comptes, mais aucune opération n'y écrivait. La première
à construire est la plus simple : faire passer des fonds d'un titulaire à un autre, **à
l'intérieur de la plateforme**. Rien n'y entre, rien n'en sort ; ce que la plateforme
conserve ne change pas.

Elle oblige pourtant à trancher tout ce que les opérations suivantes reprendront : comment un
client renvoie une requête sans payer deux fois, ce qu'on exige de lui avant de déplacer ses
fonds, combien un compte peut envoyer selon ce que la plateforme sait de son titulaire, ce
qu'une partie apprend de l'autre.

Une décision manquait : **les plafonds par niveau de vérification** (décision 5). La note de
fin du lot précédent disait ce lot impossible à terminer sans elle. Plutôt que d'attendre, ou
d'inventer des montants, les plafonds sont devenus **des données** : le code n'en livre
aucun, et tant que personne n'en a saisi, rien ne part. Le lot se construit, se vérifie et se
livre ainsi sans la décision — qui devient : « quelles valeurs saisir ».

## Décision

### Un transfert est immédiat et définitif

- Il déplace un montant, dans un actif, des **fonds disponibles** de l'émetteur vers ceux du
  destinataire. Une seule écriture du grand livre le réalise : type `transfer.internal`, deux
  lignes — un débit, un crédit, du même montant.
- **Une seule transaction** écrit le transfert, son écriture, son inscription au journal
  d'audit et les deux événements qui préviendront les parties. Elle est validée entière ou
  annulée entière : il n'existe pas de transfert « en attente », ni à moitié fait.
- Il **ne s'annule pas**. Un transfert fait par erreur ne se défait que par un transfert en
  sens inverse, que seul le destinataire peut faire.
- Il est **sans frais** : le compte `platform_fees` ne reçoit rien. Tarifer est une décision
  de produit, qui n'est pas prise.
- La ligne `transfers` garde les deux comptes, l'actif, le montant, l'écriture, le **niveau
  de vérification de l'émetteur à cet instant** — celui dont les plafonds ont été appliqués —,
  la clé d'idempotence et l'empreinte de la requête. Elle ne porte **aucune adresse** et
  aucun texte libre : un transfert n'a ni libellé, ni message.

### Fermé trois fois par défaut

Pour qu'un transfert aboutisse, il faut que quelqu'un ait décidé, chaque fois avec une
justification inscrite au journal d'audit :

1. d'**enregistrer l'actif** (ADR 0025) ;
2. de **fixer des plafonds** pour le niveau de vérification de l'émetteur _et_ pour celui du
   destinataire, dans cet actif ;
3. d'**ouvrir la fonctionnalité** `internalTransfers`, fermée comme toute fonctionnalité
   réglementée (`PUT /admin/system-settings/features.internal_transfers`).

Fermée, la route répond `403 FEATURE_DISABLED` avant d'examiner quoi que ce soit — pas même
le mot de passe. Consulter ses transferts et ses plafonds reste possible.

### La clé d'idempotence est fournie par le client

Toute route qui déplace des fonds exige l'en-tête `Idempotency-Key` : 16 à 128 caractères
(lettres, chiffres, `.`, `_`, `:`, `-`, le premier étant une lettre ou un chiffre) — un UUID
convient. Absent, répété ou mal formé : `400`.

- **La même requête sous la même clé ne transfère rien de plus.** Le transfert d'origine est
  rendu, avec le même statut `201`, et l'en-tête `Idempotent-Replayed: true` dit que rien n'a
  été refait. Rien n'est écrit, personne n'est prévenu une seconde fois, et l'essai ne compte
  dans aucune borne.
- « La même requête » : le même destinataire, le même actif, le même montant — `1.5` et
  `1.50` désignent le même transfert. La base en garde une empreinte SHA-256.
- **Une autre requête sous une clé déjà employée est refusée** (`422 IDEMPOTENCY_KEY_REUSED`).
- Une clé vaut **pour le compte qui la présente** : deux comptes peuvent employer la même.
- Une requête **refusée ne retient pas sa clé** : corrigée, elle peut être renvoyée sous la
  même.
- Une clé **n'expire pas** : elle vit aussi longtemps que le transfert, c'est-à-dire
  toujours.
- La même requête envoyée plusieurs fois **au même instant** : un seul transfert, que toutes
  rendent.
- Rejouer exige, comme transférer, la preuve du titulaire : une clé n'est pas un moyen de
  relire un transfert.

La clé du client n'est pas celle du grand livre : l'écriture porte la sienne
(`transfer:<identifiant du transfert>`), comme le prévoyait l'ADR 0025.

### La preuve du titulaire, à chaque transfert

Une session ouverte ne suffit pas. Chaque transfert présente à nouveau le **mot de passe**
et, si la validation en deux étapes est activée, le **second facteur** — code de
l'application ou code de secours. C'est la même preuve que pour clôturer son compte ou en
emporter les données (`HolderProofService`) ; les essais erronés sont bornés par compte.

Elle est vérifiée **avant tout examen de la requête** : qui n'a qu'un jeton dérobé ne déplace
rien, et ne peut pas se servir de cette route pour apprendre si une adresse a un compte. Il
lit en revanche, comme le titulaire, les portefeuilles, les transferts passés et les plafonds
du compte : ces lectures ne demandent que la session.

### Des plafonds par actif et par niveau de vérification

| Plafond       | Porte sur                                              |
| ------------- | ------------------------------------------------------ |
| par transfert | le montant d'un transfert                              |
| sur 24 heures | ce transfert, plus les envois des 24 dernières heures  |
| sur 31 jours  | ce transfert, plus les envois des 744 dernières heures |

- Un jeu de plafonds par **actif** et par **niveau de vérification**, de 0 (adresse e-mail
  vérifiée, aucun dossier accepté) à 3. Par transfert ≤ sur 24 heures ≤ sur 31 jours.
- **Sans plafond, rien.** Un niveau qui n'a pas de plafonds dans un actif — ou dont le
  plafond par transfert est nul — n'y **envoie** ni n'y **reçoit**.
- Seuls comptent **les envois**, dans l'actif du transfert. Ce qu'un compte reçoit n'entame
  pas ses plafonds, et les plafonds du destinataire ne bornent pas ce qu'il reçoit : il
  suffit que son niveau soit ouvert.
- Les fenêtres sont **glissantes** et comptées **en heures**, à l'horloge de la base : pas de
  remise à zéro à minuit, pas de fuseau, pas de changement d'heure.
- Le niveau d'un compte est le plus haut dont tous les précédents sont vérifiés : un niveau
  2 accepté ne compte pas si le niveau 1 ne l'est pas, ou ne l'est plus. Une vérification
  retirée abaisse le niveau **aussitôt** ; les cumuls, eux, suivent le compte.
- Chaque plafond est **inclus** : son montant exact passe, pas une unité de plus.
- Le refus dit lequel est dépassé (`422 TRANSFER_LIMIT_EXCEEDED`) ; un niveau fermé répond
  `403 TRANSFER_NOT_PERMITTED`. Le titulaire lit à tout moment ce qu'il peut encore envoyer
  (`GET /me/transfer-limits`).

**Les fixer.** `PUT /admin/transfer-limits/{actif}/{niveau}` — permission
`transfer_limits.write` ; les lire, `transfer_limits.read`. Les deux ne sont détenues que par
`super_admin`. Un couple actif-niveau à la fois, trois montants et une justification ;
l'ancien et le nouveau jeu sont inscrits au journal d'audit. L'effet est **immédiat**, y
compris pour ce qui a déjà été envoyé : abaisser un plafond sous le cumul d'un compte
l'arrête. Des plafonds **ne se suppriment pas** : refermer un niveau, c'est les ramener à
zéro — la ligne reste, et dit qui l'a décidé.

### Le destinataire : une adresse, et un seul refus

- Le destinataire est désigné par son **adresse e-mail**.
- Adresse inconnue, compte dont l'adresse n'est pas vérifiée, suspendu ou clôturé, niveau de
  vérification fermé dans l'actif : **le même refus**, mot pour mot
  (`422 RECIPIENT_UNAVAILABLE`). La route ne dit pas quelles adresses ont un compte.
- Ce refus vient **en dernier** — après la preuve du titulaire, les plafonds et les fonds :
  pour l'obtenir, il faut un transfert qui aurait abouti. Sonder une adresse coûte donc un
  compte vérifié, alimenté, et le risque de réellement envoyer.
- Ces refus sont **comptés par émetteur** : le dixième en 24 heures suspend tout transfert de
  ce compte pendant 24 heures.
- Seul son propre compte est nommé : se désigner soi-même répond `422`, en le disant.

### Ce que chaque partie voit de l'autre

L'**adresse e-mail que porte aujourd'hui le compte de l'autre** — et rien d'autre : ni nom,
ni identité vérifiée, ni solde. L'émetteur la connaît, puisqu'il l'a saisie ; le destinataire
apprend d'où viennent les fonds. Elle est lue au moment d'afficher : si l'autre compte a été
clôturé depuis, elle vaut `null`.

Les deux parties sont **prévenues par e-mail**, chacune dans sa langue. L'émetteur l'est
pour qu'un transfert qu'il n'aurait pas fait ne lui échappe pas : le message dit quoi faire.
Ces messages informent, ils ne conditionnent rien : sans moyen de remise, ils sont
abandonnés ; une partie clôturée entre-temps n'est plus prévenue.

### L'ordre des contrôles

1. la session est valide, les conditions d'utilisation sont acceptées, la fonctionnalité est
   ouverte ;
2. la clé d'idempotence et la requête ont la forme attendue ;
3. **la preuve du titulaire** ;
4. l'actif est tenu ; le montant est à sa précision, strictement positif ; le destinataire
   n'est pas l'émetteur ;
5. **déjà fait sous cette clé ?** — le transfert d'origine est rendu, ou la clé refusée ;
6. les bornes du compte (voir ci-dessous) ;
7. dans la transaction, **sous le verrou du compte de l'émetteur** : il est actif ; la
   requête n'a pas abouti entre-temps ; les plafonds ; les fonds ; **le destinataire** ; puis
   l'écriture, le transfert, le journal, les événements.

Un refus de l'étape 7 est **inscrit au journal d'audit** (`transfer.refused`) avec son motif,
l'actif, le montant et — s'il existe — le compte visé ; jamais l'adresse saisie, qui peut
être celle de n'importe qui. Il apparaît, comme un transfert envoyé ou une preuve refusée,
dans l'historique de sécurité que le titulaire consulte.

### Les bornes

| Borne                                             | Valeur                  | Portée         |
| ------------------------------------------------- | ----------------------- | -------------- |
| demandes de transfert                             | 60 par minute           | par adresse IP |
| transferts tentés, aboutis ou refusés             | 30 par heure            | par compte     |
| destinataires refusés                             | le 10ᵉ bloque 24 heures | par compte     |
| essais erronés du mot de passe, du second facteur | celles de la phase 2    | par compte     |

Chaque transfert abouti envoie un message au destinataire : la borne horaire empêche d'en
faire un moyen de harcèlement.

### La base de données a le dernier mot

Comme pour le grand livre, la migration `internal_transfers` fait refuser par PostgreSQL,
quel que soit le code qui écrit :

- des plafonds négatifs ou désordonnés, pour un niveau hors de 0 à 3 ; des plafonds fixés
  par un compte qui n'est pas actif ou ne détient pas `transfer_limits.write` — sans auteur,
  par un autre rôle que le propriétaire de la base ; leur suppression ; leur changement
  d'actif ou de niveau ;
- un transfert d'un compte, ou vers un compte, qui n'est pas **actif** ;
- un transfert qui ne porte pas **le niveau de vérification de l'émetteur à cet instant** ;
- un transfert d'un niveau **fermé**, ou qui **dépasse un plafond** — les cumuls étant
  recomptés par la base, sous le verrou de l'émetteur ;
- un transfert vers un compte dont le niveau est fermé dans l'actif ;
- à la validation de la transaction : un transfert dont l'écriture **n'est pas la sienne** —
  autre type, autre nombre de lignes, autre compte, autre sens, autre montant, autre actif —
  et **une écriture de type `transfer.internal` sans transfert**. Aucun mouvement de ce type
  n'échappe donc aux plafonds ;
- toute **modification, suppression ou vidage** des transferts, même par le propriétaire du
  schéma ; deux transferts sous la même clé pour un même émetteur ; deux transferts pour une
  même écriture.

L'heure d'un transfert et celle d'une modification de plafonds sont celles de **l'horloge de
la base** ; ce que l'appelant fournit est ignoré. Les fonctions ont un chemin de recherche
figé. Une règle enfreinte lève `MGX10`.

L'application fait les mêmes contrôles en amont, pour répondre clairement. Si la base refuse
ce qu'elle avait admis — un niveau retiré, un plafond abaissé, un destinataire suspendu
pendant la requête —, rien n'est écrit et la réponse est `409 CONFLICT` : renvoyée, la
requête est examinée dans l'état nouveau.

### Concurrence : un transfert à la fois par émetteur

- Un transfert verrouille d'abord **le compte de son émetteur** (`FOR NO KEY UPDATE`) : ses
  transferts passent un à un, et chacun compte les précédents dans ses cumuls. Six transferts
  envoyés ensemble ne dépassent ni les plafonds, ni les fonds.
- Il passe ensuite son écriture, qui retient les deux titulaires puis verrouille les comptes
  (ADR 0025). C'est l'ordre que cette ADR prescrivait : un titulaire se verrouille _avant_
  une écriture, jamais après.
- Le verrou de l'émetteur n'exclut pas celui qu'une écriture prend sur ses titulaires : deux
  **transferts croisés** — de l'un à l'autre et de l'autre à l'un — aboutissent tous deux,
  sans s'interbloquer.
- **Transfert et clôture s'excluent.** La clôture d'un compte attend son transfert en cours,
  puis voit les fonds qu'il laisse. Un transfert attend la clôture en cours de son émetteur
  (`409`) ou de son destinataire (`422 RECIPIENT_UNAVAILABLE`), puis est refusé.
- La transaction s'ouvre avec l'option `retry` : annulée par PostgreSQL pour en avoir croisé
  une autre, elle est relancée entière.

### Clôture, conservation, copie des données

Les transferts s'inscrivent à `AccountDataRegistry` (ADR 0023) :

- **ils ne s'opposent pas à la clôture** : ce sont les fonds restants qui la retiennent, et
  c'est le grand livre qui le dit. Un compte se vide par un transfert, puis se clôt ;
- **rien n'est effacé** : un transfert est la trace d'une écriture. L'autre partie garde les
  siens ; elle n'y voit plus l'adresse du compte clôturé ;
- la durée de conservation est celle que fixe le grand livre dès qu'une écriture existe (dix
  ans) : un transfert en passe toujours une ;
- la **copie des données** (format `4`) contient les transferts envoyés et reçus — les 2 000
  plus récents, et le dit s'il en existe de plus anciens.

## Choix à confirmer

Cinq choix relèvent du produit plus que de la technique. Ils ont été faits pour que le lot
soit complet et vérifiable ; chacun se change sans reprendre le reste.

1. **Le destinataire est désigné par son adresse e-mail**, et le refus est le même quelle
   qu'en soit la cause.
2. **Chaque partie voit l'adresse e-mail de l'autre**, et aucun nom.
3. **Le mot de passe est redemandé à chaque transfert**, avec le second facteur s'il est
   activé.
4. **Les plafonds** sont fixés par actif et par niveau, ne portent que sur les envois, sur 24
   heures et 31 jours glissants ; **une seule personne** peut les changer, avec une
   justification.
5. **La base de données applique elle-même les plafonds** : un outil qui écrirait à côté de
   l'API ne les contourne pas.

## Alternatives écartées

- **Attendre la décision sur les plafonds.** Écarté : en faire des données laisse la décision
  entière au propriétaire, sans retenir la construction.
- **Livrer des plafonds par défaut**, par migration. Écarté : ces montants engagent la
  plateforme devant son régulateur ; ils se décident, se justifient et se tracent — ils ne
  sont pas un fait du code.
- **Les fonds réservés dans ce lot**, comme le proposait la note de fin du lot 1. Non
  réalisé : un transfert immédiat n'en a pas l'usage. Un type de compte que rien n'emploie ne
  s'éprouverait que dans l'abstrait ; il viendra avec la première opération qui retient des
  fonds entre deux instants — retrait, séquestre, ordre.
- **Un transfert en deux temps**, que le destinataire accepte, ou que l'émetteur annule.
  Écarté pour ce lot : il suppose des fonds réservés et un état à faire expirer.
- **Désigner le destinataire par un identifiant public ou un numéro de téléphone.** Non
  réalisé : tout compte a une adresse vérifiée, pas un numéro ; un identifiant public serait
  une notion nouvelle, à décider avec les écrans.
- **Des refus distincts** — « adresse inconnue », « compte suspendu ». Écarté : ils diraient
  quelles adresses ont un compte.
- **La session seule**, sans mot de passe. Écarté : un jeton dérobé déplacerait des fonds.
- **Des fenêtres calendaires** — par jour, par mois. Écarté : elles dépendent d'un fuseau, et
  permettent d'envoyer deux plafonds de part et d'autre de minuit.
- **Des plafonds dans les paramètres du système**, en clé-valeur. Écarté : ce sont des
  montants typés, par actif et par niveau, que la base doit pouvoir appliquer elle-même.
- **Supprimer la ligne pour refermer un niveau.** Écarté : la trace de qui a fermé, et quand,
  disparaîtrait avec elle.
- **Plafonner aussi ce qu'un compte reçoit, ou détient.** Non réalisé : rien ne le demande à
  ce jour. Si la réglementation l'exige pour les niveaux bas, cela s'ajoute à côté des
  plafonds d'envoi (décision 5).
- **Répondre `200` à une requête rejouée.** Écarté : la réponse rejouée est celle d'origine,
  statut compris ; un client qui ignore l'en-tête se comporte correctement.
- **Une double validation pour changer un plafond.** Non réalisée : l'acte est réservé à
  `super_admin`, justifié et tracé. À revoir avant l'ouverture, comme pour les actifs.
- **Un libellé libre sur le transfert.** Écarté : un transfert ne s'efface jamais ; ce n'est
  pas un endroit où laisser écrire des données personnelles, ni un canal de messages.

## Conséquences

- **Personne ne peut transférer aujourd'hui**, et pas seulement parce que la fonctionnalité
  est fermée : aucun actif n'est enregistré, aucun plafond n'est fixé — et **aucune route ne
  crédite un portefeuille**. Tant que les dépôts n'existent pas, seuls des fonds passés au
  grand livre par un opérateur pourraient circuler.
- **Changements pour les clients de l'API** : la copie des données passe au format `4`
  (`transfers` ajouté) ; l'historique de sécurité connaît trois types de plus
  (`TRANSFER_SENT`, `TRANSFER_FAILED`, `TRANSFER_REFUSED`) ; cinq codes d'erreur s'ajoutent ;
  quatre routes de titulaire et deux de back-office ; l'en-tête `Idempotent-Replayed` est
  lisible par un navigateur.
- **Un transfert abouti dit que l'adresse a un compte qui peut recevoir.** C'est inhérent au
  fait de désigner par adresse. Le refus unique, sa place en dernier et le compteur rendent le
  sondage coûteux ; ils ne le rendent pas impossible à qui accepte d'envoyer réellement.
- **Le destinataire ne choisit pas de recevoir**, et apprend l'adresse de l'émetteur.
  Quiconque connaît une adresse peut lui envoyer des fonds — et le message qui les accompagne.
  Il peut les renvoyer ; il ne peut pas les refuser.
- **Une erreur de destinataire ne se rattrape pas** sans lui. L'écran devra faire confirmer
  l'adresse avant d'envoyer (phase 7).
- **Les plafonds valent ce que valent les niveaux.** Ouvrir le niveau 0 dans un actif, c'est
  y laisser recevoir — et envoyer — quiconque a vérifié une adresse e-mail.
- **Un plafond n'est pas une surveillance.** Rien ne détecte des envois fractionnés juste
  sous un plafond, de nombreux émetteurs vers un même compte, ni ne confronte les parties à
  des listes de sanctions. Ces contrôles relèvent de la fonction conformité et devront
  exister avant l'ouverture (décision 11).
- **Les plafonds bornent les écritures de type `transfer.internal`.** Une autre opération qui
  ferait passer des fonds d'un titulaire à un autre — échange, séquestre — apportera ses
  propres règles.
- **Les transferts ne s'effacent jamais.** Ils ne portent que des identifiants de compte :
  après la clôture d'un compte et le terme de conservation, plus rien ne dit à qui ils se
  rapportaient. La même réserve que pour le grand livre vaut ici : **ce n'est pas un avis
  juridique** (décision 6).
- **Abaisser un plafond prend effet aussitôt**, sans prévenir les titulaires : un compte qui
  avait déjà envoyé plus que le nouveau plafond ne peut plus rien envoyer avant que ses envois
  sortent de la fenêtre.
- **Le cumul relit les envois de l'émetteur sur 31 jours** à chaque transfert, sous son
  verrou. Sans conséquence aux volumes d'un particulier ; à mesurer pour un compte qui
  enverrait des milliers de transferts par mois.
- **Le propriétaire du schéma peut tout**, ici comme ailleurs : fixer des plafonds sans
  auteur, désactiver un déclencheur. Le rôle applicatif, lui, ne le peut pas.
- Le format de la clé, les durées des fenêtres et le type de l'écriture sont des constantes
  du code recopiées dans la migration : les changer demande une migration. Les tests fixent
  les unes et les autres aux mêmes valeurs.
