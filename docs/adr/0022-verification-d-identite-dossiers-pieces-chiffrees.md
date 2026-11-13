# 0022 — Vérification d'identité : dossiers par niveau, pièces chiffrées, examen humain

**Statut :** acceptée (2026-11-12)

## Contexte

Aucune opération financière ne pourra être ouverte à un compte dont le titulaire n'est pas
identifié. La loi n° 22/068 du 27 décembre 2022 (lutte contre le blanchiment de capitaux et le
financement du terrorisme) demande, pour une personne physique, ses nom, postnom et prénom, sa
date et son lieu de naissance et son adresse ; la vérification se fait sur **un document
officiel original, en cours de validité, comportant une photographie, dont il est pris copie** ;
ces pièces se conservent **dix ans** après la fin de la relation (article 48). En RDC, la carte
d'électeur tient couramment lieu de pièce d'identité.

Cette lecture de la loi est la nôtre : elle doit être confirmée par un conseil juridique avant
l'ouverture au public.

Jusqu'ici, le profil d'un compte était purement déclaratif (lot 2), et la fonctionnalité `kyc`
existait fermée (ADR 0012). Ce lot la construit pour les **particuliers** ; la vérification des
entreprises (KYB) est reportée.

## Décision

### Un dossier par compte et par niveau

Trois niveaux, obtenus dans l'ordre : **1** identité (pièce et autoportrait), **2** adresse
(justificatif de domicile), **3** origine des fonds. Pour chaque niveau, le titulaire prépare
un **dossier** : une déclaration, puis des pièces, puis le dépôt.

```
DRAFT ──dépôt──▶ SUBMITTED ──▶ APPROVED ──▶ SUPERSEDED   (un dossier plus récent est accepté)
                     │             └──────▶ REVOKED      (retrait motivé par la conformité)
                     └──────▶ REJECTED
```

- Seul un dossier en préparation se modifie ou s'efface. **Déposé, il est une preuve** : ni la
  déclaration ni les pièces ne changent plus, quelle que soit la décision.
- Une décision est définitive. Un dossier refusé ne se rouvre pas : le titulaire en prépare
  un autre. Renouveler une pièce, c'est déposer un nouveau dossier ; accepté, il remplace
  l'ancien au même instant, sans interruption de la vérification.
- **Le niveau vérifié d'un compte n'est stocké nulle part** : c'est le plus haut niveau dont
  tous les précédents ont un dossier accepté en vigueur. Retirer le niveau 1 fait donc
  retomber tout le compte à zéro, sans rien réécrire.

### La base impose le parcours

Comme pour les rôles (ADR 0018), les règles qui comptent ne reposent pas sur le seul code de
l'API. Contraintes, index uniques et déclencheurs de `kyc_cases` et `kyc_documents` refusent
(erreur `MGX03`) : un dépôt sans les pièces obligatoires ou sans le niveau précédent ; toute
modification d'un dossier déposé ; une décision prise par un compte qui n'est pas actif ou ne
détient pas `kyc.review` (`kyc.revoke` pour un retrait) ; une décision du titulaire sur son
propre dossier ; une pièce ajoutée à un dossier déjà déposé — y compris au même instant que
le dépôt. Trois index uniques servent de dernier rempart : un seul dossier ouvert et un seul
dossier accepté par compte et par niveau, et **une même pièce d'identité ne vérifie qu'un seul
compte**.

### Les pièces ne sont jamais conservées en clair

- Formats acceptés : JPEG, PNG, PDF (un autoportrait est une image), de 1 Ko à 5 Mio. Le type
  est lu sur les premiers octets du fichier ; celui qu'annonce le client n'est pas cru.
- Chaque fichier est chiffré (AES-256-GCM) avec **une clé qui lui est propre**. Cette clé,
  chiffrée par une clé maîtresse (`KYC_ENCRYPTION_KEY`), est conservée en base avec la
  description de la pièce ; le fichier chiffré est écrit hors de la base (`KYC_STORAGE_DIR`).
  Il faut donc **les trois** — le volume, la base et la clé maîtresse — pour lire une pièce ;
  effacer la ligne rend le fichier définitivement illisible.
- L'identité de la pièce (identifiant, dossier, nature) est authentifiée avec le contenu : un
  fichier recopié à la place d'un autre ne se déchiffre pas. À la relecture, l'empreinte
  SHA-256 du fichier reçu est vérifiée.
- Le **numéro de la pièce d'identité** est chiffré en base ; une empreinte à clé (HMAC) permet
  de reconnaître une même pièce sur plusieurs comptes sans rien déchiffrer. Le titulaire ne le
  revoit que masqué.
- La clé maîtresse est distincte de celle des secrets de connexion (ADR 0017), et chaque usage
  en dérive sa propre sous-clé (HKDF).
- Sans `KYC_STORAGE_DIR` et `KYC_ENCRYPTION_KEY`, l'API démarre mais la vérification répond
  `503` : il n'existe aucun mode « sans chiffrement ».

Le stockage est un port (`DocumentStorage`) ; l'implémentation livrée écrit sur un système de
fichiers — un volume. Un stockage objet s'ajoutera comme une autre implémentation, sans
toucher au chiffrement, qui a lieu avant.

### Envoi d'un fichier

Le client envoie **le fichier lui-même comme corps de la requête**, avec son propre
`Content-Type` — pas un formulaire `multipart`. L'API reste ainsi sans analyseur de
formulaires (ADR 0011), et sans dépendance de plus. Le corps n'est lu qu'**après** tous les
contrôles qui peuvent refuser l'envoi (jeton, fonctionnalité, quota, dossier) : le contenu
d'un envoi irrecevable n'est jamais gardé en mémoire, et le refus part sans attendre la fin
de l'envoi. La réception est bornée : 5 Mio, deux minutes, huit réceptions à la fois par
instance (au-delà : `503` avec `Retry-After`), quarante envois par heure et par compte. Nginx
transmet ce corps au fil de l'eau, sans copie sur son disque, et n'admet un corps volumineux
que sur cette route.

### Examen par la conformité

- Trois permissions : `kyc.read` (file, dossiers, pièces), `kyc.review` (accepter, refuser),
  `kyc.revoke` (retirer une vérification acceptée). Un rôle système `compliance` les réunit,
  avec la lecture des comptes ; il se confère comme tout rôle, à quatre yeux (ADR 0018). Le
  rôle `support` ne voit aucune pièce.
- La conformité ne voit que des dossiers déposés, du plus ancien au plus récent. La fiche d'un
  dossier signale ce qui aide à le juger : le même fichier ou la même pièce d'identité vus sur
  d'autres comptes, le dossier accepté que celui-ci remplacerait, les autres dossiers du
  compte.
- **Nul n'examine son propre dossier**, et **toute consultation est journalisée** — chaque
  page de la file, chaque fiche, chaque téléchargement de pièce, avant que le contenu ne soit
  rendu. Une pièce n'est servie qu'en pièce jointe.
- Un refus porte un à cinq motifs, communiqués au titulaire, et une note interne qui ne l'est
  jamais. Le titulaire est prévenu de chaque décision par e-mail et la retrouve dans son
  historique ; il ne connaît ni l'examinateur, ni la note, ni le motif d'un retrait.
- L'examen reste possible pendant la maintenance et lorsque la fonctionnalité est fermée aux
  titulaires : la file doit pouvoir être vidée, et une vérification frauduleuse retirée, à
  tout moment.

### Ce que la vérification établit dans le compte

Ce qu'un dossier accepté établit **prime** sur ce que le titulaire a déclaré dans son profil :
noms, naissance et nationalité au niveau 1, adresse au niveau 2. Ces champs ne se modifient
plus par le profil (`409`) : en changer passe par un nouveau dossier. Une adresse ne vaut
vérifiée que tant que l'identité l'est.

Le module `kyc` dépend du module d'identité ; l'inverse n'est pas vrai. L'identité lit les
dossiers acceptés par un port en lecture seule et n'en écrit aucun.

### Conservation

Un dossier resté en préparation trente jours sans changement est effacé avec ses pièces : on
ne garde pas les pièces d'identité de quelqu'un qui n'a jamais déposé son dossier. Un dossier
déposé n'est jamais effacé par l'application.

## Alternatives écartées

- **Formulaire `multipart/form-data`** : un analyseur et une dépendance de plus, des limites
  plus difficiles à tenir (taille de chaque partie, nombre de parties), et le retour des
  requêtes « simples » qu'un formulaire d'un autre site peut forger.
- **Pièces dans la base** (`bytea`) : sauvegardes et réplication alourdies par des
  mégaoctets de fichiers, et une seule fuite — celle de la base — livrerait tout.
- **Niveau vérifié stocké sur le compte** : une valeur de plus à tenir cohérente avec les
  dossiers, pour économiser une lecture indexée.
- **Vérification automatique par un prestataire** (lecture optique, comparaison de visages) :
  c'est un choix commercial et réglementaire qui n'est pas pris. Le parcours livré le
  permettra : un prestataire deviendrait un examinateur de plus, ou une aide à l'examinateur.

## Conséquences

- **L'examen est entièrement humain.** Rien ne compare l'autoportrait à la pièce, ne lit la
  pièce, ni ne consulte une liste de sanctions ou de personnes politiquement exposées.
- **Le contenu des fichiers n'est pas analysé** au-delà de leur signature : pas d'antivirus.
  Un examinateur ouvre donc des fichiers envoyés par des inconnus ; son poste doit être
  protégé en conséquence.
- **Trois choses à sauvegarder, dont une à part** : la base, le volume des pièces, et la clé
  maîtresse — celle-ci séparément des deux autres. La perdre rend toutes les pièces
  illisibles. Sa rotation n'est pas outillée.
- Avec plusieurs instances de l'API, le volume des pièces doit être partagé.
- Une pièce est tenue en mémoire le temps d'être reçue et chiffrée : 160 Mio au plus par
  instance (huit envois, jusqu'à quatre copies de 5 Mio chacun — le fichier reçu, sa version
  assemblée, ses deux versions chiffrées). Un chiffrement au fil de l'eau l'éviterait ; il
  n'a pas paru justifié pour des fichiers de 5 Mio.
- L'expiration d'une pièce après l'acceptation ne retire pas la vérification ; aucune relance
  n'est envoyée. La conservation de dix ans après la fin de la relation, puis l'effacement,
  restent à écrire avec la clôture des comptes.
- Les niveaux n'ouvrent encore aucun droit : les plafonds par niveau viendront avec les
  portefeuilles. La vérification des entreprises reste à concevoir.
- Les valeurs chiffrées ici (taille, durée, quotas, trente jours) sont des valeurs de départ.
