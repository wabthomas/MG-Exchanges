# 0025 — Grand livre en partie double : écritures immuables, règles portées par la base

**Statut :** acceptée (2026-11-13) — les actifs à tenir, les plafonds par niveau de vérification et la durée de conservation des écritures restent à décider par le propriétaire et son conseil

## Contexte

La phase 3 doit donner à la plateforme de quoi tenir des fonds : savoir, à tout instant et
sans doute possible, ce que chaque titulaire détient, ce que la plateforme conserve pour lui,
et par quelles opérations on en est arrivé là. Tout ce qui suivra — transferts, dépôts,
retraits, échange, séquestre — s'appuiera dessus.

Trois décisions ne relèvent pas du code et ne sont pas prises :

- **les plafonds** par niveau de vérification (décision 5) ;
- **le statut réglementaire** visé, qui conditionne l'ouverture de toute opération
  (décision 11) ;
- **les actifs** que la plateforme tiendra — dollar, franc congolais, cryptoactifs.

Ce lot devait pouvoir être construit, vérifié et livré sans elles. Il ne contient donc
**aucune opération** : aucune route ne dépose, ne retire ni ne transfère de fonds. Il livre
l'endroit où les opérations écriront, et les règles qu'elles ne pourront pas enfreindre.

## Décision

### Une écriture en partie double, entière, équilibrée, définitive

- Un solde ne s'écrit pas : il **résulte** d'écritures. Une **écriture** (`ledger_entries`)
  porte au moins deux **lignes** (`ledger_postings`) ; chaque ligne débite ou crédite un
  **compte** (`ledger_accounts`) d'un montant strictement positif.
- **Pour chaque actif, les débits d'une écriture égalent ses crédits.** Rien ne se crée ni ne
  se perd ; cent dollars ne compensent pas cent francs.
- Une écriture est **définitive** : elle ne se modifie ni ne s'efface, pas plus que ses
  lignes. Une erreur se corrige par une écriture inverse, qui laisse les deux visibles.
- Chaque ligne conserve son **rang sur son compte** (1, 2, 3… sans trou) et le **solde qui en
  résulte**. Le relevé d'un compte se lit donc sans rien recalculer, et la moindre altération
  rompt une chaîne que l'on sait vérifier.
- Une écriture porte un **type** (`kind`) — l'opération qui l'a produite —, son **auteur**,
  la requête à son origine et des **références** techniques. Les références sont bornées :
  des textes ASCII courts (identifiants, codes), des entiers, des booléens — ni texte libre
  long, ni structure imbriquée. Une écriture ne s'efface jamais : ce n'est pas un endroit où
  ranger des données personnelles, et il revient à chaque opération de ne pas en mettre.

### Un plan de comptes court, qui s'étendra avec les opérations

| Type               | Appartient à  | Augmente au | Rôle                                                |
| ------------------ | ------------- | ----------- | --------------------------------------------------- |
| `user_available`   | un titulaire  | crédit      | fonds dont il dispose                               |
| `platform_custody` | la plateforme | débit       | fonds conservés hors du grand livre pour son compte |
| `platform_fees`    | la plateforme | crédit      | frais gagnés par la plateforme                      |

- Les avoirs d'un titulaire sont une **dette** de la plateforme envers lui ; ce qu'elle
  conserve pour lui — en banque, en monnaie mobile, en cryptoactifs — est un **actif**. Un
  dépôt débite `platform_custody` et crédite `user_available` ; un retrait fait l'inverse. La
  **balance** — total des comptes qui augmentent au débit, total de ceux qui augmentent au
  crédit — s'équilibre donc dans chaque actif, et dit à tout instant ce que la plateforme
  doit et ce qu'elle détient.
- **Aucun compte ne devient négatif**, celui d'un titulaire comme celui de la plateforme :
  on ne dépense, ne rend ni ne conserve ce qu'on n'a pas. Il n'y a pas de découvert, même
  passager au sein d'une écriture.
- **Un compte par type et par actif**, pour chaque titulaire et pour la plateforme. Il est
  ouvert par la première écriture qui le touche.
- Le plan est **du code** : il vit dans `@mgx/contracts`, est recopié en base par migration,
  et un test vérifie que les deux sont identiques. Les types à venir (fonds réservés,
  séquestre…) arriveront avec les opérations qui en ont besoin.

### Les actifs sont des données, enregistrées une fois pour toutes

- Aucun actif n'est créé par migration : le catalogue se remplit par le back-office
  (`POST /admin/ledger/assets`, permission `ledger.manage_assets`), avec une justification
  inscrite au journal d'audit. Tenir un nouvel actif ne demande aucun déploiement.
- **Un actif enregistré ne change plus et ne se retire pas.** Tous les montants s'expriment
  en nombre entier de son unité minimale (ADR 0007) : changer son nombre de décimales
  changerait la valeur de chaque ligne déjà écrite.
- De 0 à 18 décimales : un montant est un entier d'au plus 38 chiffres (`NUMERIC(38,0)`).
- Enregistrer un actif **n'ouvre aucune opération** : chaque titulaire voit seulement
  apparaître un portefeuille à zéro.

### La base de données a le dernier mot

Comme pour les rôles (ADR 0018), les dossiers (ADR 0022), la clôture (ADR 0023) et les
conditions d'utilisation (ADR 0024), la migration `ledger` fait refuser par PostgreSQL, quel
que soit le code qui écrit :

- une écriture **incomplète ou déséquilibrée** — vérifié à la validation de la transaction,
  pour l'en-tête comme pour chacune de ses lignes : rien ne s'ajoute donc à une écriture déjà
  validée ;
- une ligne dans un **autre actif** que celui de son compte ;
- un **solde négatif** — contrôlé ligne après ligne ;
- un **solde écrit directement** : le rang d'une ligne et le solde qui en résulte sont
  calculés par la base, sous le verrou du compte, et ce que l'appelant fournit est ignoré ; à
  la validation de toute transaction qui a touché un compte, son solde doit être celui de sa
  dernière ligne. Un compte dont le solde ne correspond plus n'accepte plus aucune ligne ;
- toute **modification, suppression ou vidage** des actifs, du plan de comptes, des
  écritures et des lignes — même par le propriétaire du schéma — et toute suppression d'un
  compte ;
- un compte ouvert autrement que vide, ou pour qui ne peut pas détenir de fonds — inscription
  inachevée, compte clôturé ;
- l'enregistrement d'un actif par un compte qui n'est pas actif ou ne détient pas
  `ledger.manage_assets` ; sans auteur, par un autre rôle que le propriétaire de la base ;
- une ligne sur le compte d'un **titulaire clôturé**, et la **clôture d'un titulaire qui
  détient des fonds**.

Les dates — enregistrement d'un actif, ouverture d'un compte, écriture — sont celles de
**l'horloge de la base**. Les fonctions de la migration ont un chemin de recherche figé. Le
rôle applicatif ne peut qu'ajouter ; il garde `UPDATE` sur les comptes, sans quoi il ne
pourrait pas les verrouiller, mais un solde écrit par ce biais n'est jamais validé.

Deux erreurs nouvelles : `MGX08`, règle du grand livre enfreinte ; `MGX09`, fonds
insuffisants. La seconde est un cas **attendu**.

### Un seul chemin dans le code : `LedgerService`

Aucun module n'écrit un solde. Il décrit une écriture — sa clé, son type, son auteur, ses
lignes — et la confie à `LedgerService` :

- `post(écriture)` la passe dans sa propre transaction ;
- `postWithin(tx, écriture)` la passe dans la transaction de l'opération : l'écriture est
  validée ou annulée avec ce que l'opération écrit par ailleurs (son état, son entrée
  d'audit, ses événements).

Le service fait en amont les contrôles que la base refera — forme de l'écriture, équilibre,
actifs enregistrés avec le bon nombre de décimales, titulaires en mesure de détenir des
fonds, soldes suffisants ligne après ligne — pour refuser clairement et **sans rien écrire** :
dans la transaction d'un appelant, un refus pour fonds insuffisants, titulaire clôturé ou clé
déjà utilisée laisse la transaction utilisable.

Deux erreurs sont **attendues**, et l'opération appelante les traduit pour son utilisateur :
fonds insuffisants (l'erreur désigne le compte) et titulaire clôturé. Les autres signalent un
défaut de l'appelant ou du grand livre lui-même.

### Idempotence : la clé est dans l'écriture

Chaque écriture porte une **clé d'idempotence**, unique en base, que l'opération construit à
partir de ce qui la rend unique (`transfer:<identifiant du transfert>`).

- Repasser **la même écriture** sous la même clé ne l'écrit pas une seconde fois : le
  résultat d'origine est rendu, marqué `replayed` — y compris si les fonds ont été dépensés
  depuis. Une requête renvoyée n'attend pas derrière les autres écritures des mêmes comptes.
- Présenter **une autre écriture** sous une clé déjà utilisée est refusé : autre type, autres
  comptes, autres sens, autres montants, autre nombre de lignes, autre ordre. L'auteur, la
  requête et les références n'entrent pas dans la comparaison : la même opération,
  représentée par un autre chemin, reste la même écriture.
- La même écriture présentée plusieurs fois **au même instant** : une seule passe, toutes
  rendent le même résultat.

L'en-tête HTTP `Idempotency-Key`, qui protégera les routes des opérations, viendra avec elles
(lot suivant) ; il s'appuiera sur cette clé, sans la remplacer.

### Concurrence : un ordre de verrouillage unique, et une nouvelle tentative bornée

- **Les titulaires, puis les comptes.** Une écriture retient d'abord ses titulaires, dans
  l'ordre de leurs identifiants (`UserRepository.holdOpen`, verrou `FOR KEY SHARE` — celui
  que prend une clé étrangère) ; puis elle ouvre les comptes qui manquent, dans l'ordre de
  leurs clés, et verrouille tous ses comptes dans l'ordre de leurs identifiants
  (`FOR UPDATE`). Deux écritures qui se croisent s'attendent, sans s'interbloquer ; la
  seconde lit le solde laissé par la première.
- **Règle pour les opérations à venir** : une opération peut verrouiller un titulaire — même
  en exclusivité, pour vérifier un plafond — _avant_ de passer une écriture, jamais après.
- **Écriture et clôture s'excluent.** Une écriture en cours retient son titulaire : la
  clôture attend, puis voit les fonds et échoue. Une clôture en cours fait attendre
  l'écriture, qui est ensuite refusée. La clôture n'a donc rien à verrouiller dans le grand
  livre.
- **Nouvelle tentative.** Si PostgreSQL annule malgré tout une transaction parce qu'elle en
  croisait une autre (interblocage, conflit de sérialisation), l'option `retry` de
  `UnitOfWork.run` la relance **entière** : trois nouvelles tentatives au plus, après des
  pauses tirées au hasard, de plus en plus longues (20, 60 puis 150 ms au plus).
  `LedgerService.post` s'en sert. Les tentatives épuisées, ou sans cette option, la requête
  répond `409 CONFLICT` — « à refaire » —, plus jamais `500`.
- Une transaction qui passe **plusieurs** écritures tient les verrous de la première pendant
  qu'elle demande ceux de la suivante : elle peut s'interbloquer avec une autre, et doit donc
  s'ouvrir avec `retry`.

### Lire : portefeuilles, relevés, balance

- **Le titulaire** lit ses portefeuilles (`GET /me/wallets`) — un par actif tenu, à zéro
  tant que rien n'y a été passé — et leurs mouvements (`GET /me/wallets/{actif}/movements`),
  du plus récent au plus ancien. Chaque lecture est filtrée par le compte de l'appelant.
- **Le back-office** (`ledger.read`) consulte les actifs, les comptes, les lignes d'un
  compte, une écriture entière et la balance. **Chaque consultation est inscrite au journal
  d'audit** : les comptes et leurs lignes sont les opérations des titulaires.
- Les deux permissions ne sont détenues que par `super_admin`. Les ouvrir à la conformité ou
  à une fonction financière est une décision d'organisation, pas de code.
- Un solde et les lignes qui le justifient sont lus **en une seule instruction** : ils se
  correspondent toujours. Les montants ne passent ni par un nombre flottant, ni par une
  bibliothèque décimale : texte en base, `bigint` dans le code, chaîne décimale sur le fil.

### Vérification périodique

Une étape de la tâche horaire, `verify-ledger`, relit **tout** le grand livre et recalcule ce
que la base garantit à chaque écriture : solde de chaque compte, enchaînement des lignes,
actif de chaque ligne, écritures entières et équilibrées, équilibre de chaque actif.

Aucune écriture normale ne peut enfreindre ces règles : une anomalie signale une altération
faite hors de l'application — déclencheurs désactivés par le propriétaire du schéma,
restauration partielle — ou un défaut des règles elles-mêmes. Elle est journalisée, inscrite
au journal d'audit (`ledger.verification_failed`), fait échouer l'étape, et **rien n'est
corrigé automatiquement** : corriger un grand livre est une décision humaine, qui passe par
des écritures.

### Clôture, conservation, copie des données

Le grand livre s'inscrit à `AccountDataRegistry` (ADR 0023) :

- **des fonds s'opposent à la clôture** (`409`, motif `FUNDS_REMAINING`) : ils sont d'abord
  retirés ou transférés. La base le refuse elle aussi ;
- **rien n'est effacé, jamais** : une écriture a toujours deux côtés, et l'effacer
  déséquilibrerait le grand livre. Les comptes et leurs lignes restent, rattachés à une ligne
  de compte qui ne porte plus aucun identifiant ;
- dès lors qu'**une écriture a été passée** sur un compte du titulaire, la trace de sa
  clôture garde son adresse et son numéro **dix ans** : c'est ce qui permet, pendant ce
  temps, de rattacher une opération à une personne. Passé ce terme, les écritures demeurent,
  mais plus rien dans la base ne dit à qui elles se rapportaient ;
- la **copie des données** (format `3`) contient les portefeuilles qui ont servi et leurs
  mouvements — les 2 000 plus récents par portefeuille, et le dit s'il en existe de plus
  anciens.

## Alternatives écartées

- **Une colonne « solde » mise à jour par chaque opération**, sans écritures. Écarté : on ne
  saurait ni expliquer un solde, ni le vérifier, ni corriger une erreur sans la faire
  disparaître. C'est le défaut classique des plateformes qui perdent des fonds.
- **Calculer le solde en additionnant les lignes à chaque lecture**, sans le conserver.
  Écarté : le contrôle « fonds suffisants » doit se faire sous verrou, vite, à chaque
  écriture. Le solde est conservé — mais la base prouve, à chaque transaction, qu'il est
  celui de la dernière ligne.
- **Des règles dans le seul code de l'application.** Écarté : ce sont précisément celles qui
  doivent tenir quand ce code est fautif, ou quand un outil écrit à côté de lui.
- **Des montants signés** (une ligne positive ou négative) plutôt qu'un sens débit / crédit.
  Écarté : le vocabulaire comptable est celui des auditeurs et des rapprochements bancaires,
  et un montant toujours positif écarte une famille d'erreurs de signe.
- **Le niveau d'isolation `SERIALIZABLE` pour toute écriture**, à la place des verrous.
  Écarté : il transforme chaque croisement en transaction annulée, à relancer ; un ordre de
  verrouillage fixe fait attendre, sans rien annuler. La nouvelle tentative reste là pour ce
  que l'ordre ne couvre pas.
- **Un type de compte « ouverture » ou « capitaux »**, pour équilibrer une mise de fonds
  initiale. Non réalisé : il n'y a pas de fonds à reprendre. Les types s'ajoutent quand une
  opération en a besoin.
- **Des comptes autorisés à passer en négatif** (découvert, compte d'attente). Non réalisé :
  aucun besoin à ce stade, et c'est la garantie la plus simple à expliquer.
- **Enregistrer les actifs par migration.** Écarté : la liste des actifs est une décision du
  propriétaire, tracée et justifiée, non un fait du code.
- **Une double validation pour enregistrer un actif.** Non réalisée : l'acte est rare,
  réservé à `super_admin`, justifié et tracé. À revoir avant l'ouverture des opérations.

## Conséquences

- **Aucune opération financière n'existe encore.** Les soldes valent zéro et le resteront
  tant qu'un lot ultérieur n'aura pas livré une opération — ce qui attend les plafonds
  (décision 5) et le statut réglementaire (décision 11).
- **Changements pour les clients de l'API** : la copie des données passe au format `3`
  (`wallets` ajouté) ; la clôture peut répondre `409` pour un nouveau motif ; une requête
  annulée par un croisement répond `409 CONFLICT` et non plus `500`. Deux routes de
  titulaire et six routes de back-office s'ajoutent.
- **Une erreur sur un actif ne se rattrape pas** : un nombre de décimales erroné oblige à
  enregistrer l'actif sous un autre code. Le code, le libellé, la nature et les décimales se
  vérifient deux fois avant d'enregistrer.
- **Les écritures ne s'effacent jamais**, y compris après la clôture d'un compte et au-delà
  de dix ans : passé ce terme elles ne sont plus rattachées à une personne. La durée de dix
  ans s'appuie sur la même lecture non confirmée de la loi n° 22/068 que l'ADR 0022 : **elle
  n'est pas un avis juridique** (décision 6).
- **Un compte qui détient des fonds ne peut pas être clôturé**, pas même par le personnel :
  tant qu'aucune opération de retrait n'existe, c'est sans effet — aucun compte ne détient de
  fonds —, mais la procédure de sortie des fonds d'un compte à fermer devra exister avant
  l'ouverture des dépôts.
- **Le rang d'une ligne sérialise les écritures d'un même compte** : c'est voulu pour le
  compte d'un titulaire ; pour les comptes de la plateforme, que tout dépôt et tout retrait
  toucheront, ce sera un point de contention à mesurer sous charge avant l'ouverture, et à
  répartir si nécessaire.
- **La vérification relit tout le grand livre** à chaque passage, en une instruction : sans
  conséquence aujourd'hui, à borner — par tranches, ou sur une réplique — quand le volume le
  demandera. Elle rapporte cinquante anomalies au plus par passage.
- **La vérification ne prouve pas que les fonds existent.** Elle établit que le grand livre
  est cohérent avec lui-même ; le rapprochement avec ce que détiennent réellement la banque,
  l'opérateur de monnaie mobile ou le dépositaire viendra avec les dépôts et les retraits.
- **Le propriétaire du schéma peut tout** : désactiver un déclencheur, puis altérer une
  ligne. C'est la limite de toute règle portée par la base ; la vérification périodique est
  là pour le relever, et le rôle applicatif, lui, ne le peut pas.
- Les bornes (clé de 8 à 160 caractères, 2 à 100 lignes, références de 2 048 octets, 18
  décimales) sont des constantes du code recopiées dans la migration : les changer demande
  une migration. Les tests fixent les unes et les autres aux mêmes valeurs.
