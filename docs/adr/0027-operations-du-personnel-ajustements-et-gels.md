# 0027 — Opérations du personnel : ajustements sous double validation, gel d'un portefeuille

**Statut :** acceptée (2026-11-15) — l'ouverture de la fonctionnalité, les personnes à habiliter et la procédure qui fonde un ajustement (quelle pièce, quel rapprochement) restent à décider par le propriétaire et son conseil ; huit choix, faits ici sans lui, sont à confirmer (voir « Choix à confirmer »). La limite relevée ici — la base ne fermait pas la liste des types d'écriture — est levée par l'ADR 0030 (2026-11-23).

## Contexte

Le grand livre tient des comptes (ADR 0025) et les titulaires s'envoient des fonds (ADR 0026) — mais **aucune route ne créditait un portefeuille** : il n'y avait rien à envoyer.
Les dépôts et les retraits supposent un prestataire de paiement et une autorisation
(phases 4 et 5). D'ici là, et après, le personnel doit pouvoir faire trois choses que rien
ne permettait :

- **constater** des fonds reçus ou rendus hors de l'API, et corriger une erreur — un grand
  livre dont les écritures ne s'effacent pas se corrige par une écriture inverse ;
- **arrêter** les mouvements d'un portefeuille, le temps d'un examen ;
- **faire sortir** les fonds d'un compte qui ne peut pas les envoyer lui-même — suspendu,
  gelé, à clôturer : un compte qui détient des fonds ne se clôt pas (ADR 0025), et rien ne
  permettait de le vider.

La première crée des fonds dans le registre. C'est l'acte le plus dangereux que le
back-office puisse faire : il ne doit dépendre ni d'une personne seule, ni de la seule
justesse du code de l'API.

## Décision

### Un ajustement : une demande, puis l'approbation d'une seconde personne

- Un membre du personnel **demande** le crédit ou le débit du portefeuille d'un titulaire :
  le compte, l'actif, le sens, le montant, une justification. **Rien ne bouge.**
- Un **second** l'**approuve** — ou le refuse, avec un motif. L'auteur peut retirer sa
  demande. Sans décision, elle **échoit après 72 heures**.
- **L'écriture n'est passée qu'à l'approbation**, dans la transaction de celle-ci, avec la
  décision, sa trace au journal d'audit et l'événement qui préviendra le titulaire. Elle est
  validée entière ou annulée entière.
- Un ajustement approuvé **ne s'annule pas** : il se corrige par un ajustement inverse, lui
  aussi demandé par l'un et approuvé par l'autre.
- Il n'existe **aucune route qui crédite ou débite en une fois**.

### L'écriture : le portefeuille contre le compte de conservation

- Type `adjustment.credit` ou `adjustment.debit`, deux lignes du même montant, dans le même
  actif : l'une sur les **fonds disponibles** du titulaire (`user_available`), dans le sens
  de l'ajustement ; l'autre, de sens inverse, sur le **compte de conservation** de la
  plateforme (`platform_custody`).
- Un crédit dit donc : « la plateforme conserve, hors du grand livre, des fonds de plus, et
  les doit à ce titulaire ». Un débit dit l'inverse. La balance reste équilibrée : ce que la
  plateforme conserve égale ce qu'elle doit.
- Aucun compte ne devient négatif (ADR 0025) : on ne débite pas un portefeuille au-delà de
  son solde — ni à la demande, ni à l'approbation, où le contrôle est refait sous le verrou
  du compte. Il n'y a pas de « dette » d'un titulaire.
- La clé d'idempotence de l'écriture est `adjustment:<identifiant>` : un ajustement ne passe
  qu'une écriture.
- L'écriture ne porte que des identifiants — celui de l'ajustement, celui de l'auteur de la
  demande, celui de l'approbateur. **La justification n'y figure pas** : une écriture ne
  s'efface jamais.

### La double validation est imposée par la base de données

Comme pour les changements de rôle (ADR 0018), la règle ne repose pas sur le code de l'API.
PostgreSQL vérifie lui-même, quel que soit le code qui écrit (erreur `MGX11`) :

- une demande naît en attente, déposée par un compte **actif** détenant
  `adjustments.request`, pour un **autre** que lui ; la base fixe son heure et son échéance ;
- elle se décide **une seule fois**, et ses termes ne changent jamais ;
- l'approbation et le refus viennent d'un compte actif détenant `adjustments.approve`, qui
  n'est **ni l'auteur de la demande, ni le titulaire** ;
- à l'approbation, la demande n'est pas échue — à l'horloge de la base —, et **son auteur
  est toujours habilité** : la demande d'un compte suspendu depuis, ou privé de son rôle, ne
  s'approuve plus ;
- **à la validation de la transaction**, l'écriture désignée est bien celle de l'ajustement
  — son type, ses deux lignes, son montant, le portefeuille, le compte de conservation — ;
- réciproquement, **une écriture de type `adjustment.*` n'existe pas sans son ajustement
  approuvé**.

Ce dernier couple est ce qui distingue ce lot de l'ADR 0018. Là-bas, la base **applique**
elle-même le changement, par une fonction aux droits du propriétaire, parce que l'API n'a
aucun droit d'écriture sur les attributions. Ici, l'API passe l'écriture — par
`LedgerService`, le seul chemin de l'argent — et la base **vérifie**, à la validation, que
l'écriture et l'ajustement vont ensemble. Une écriture d'ajustement écrite en SQL sous le rôle
de l'API, sans son ajustement approuvé par deux personnes habilitées, n'est pas validée.

La garantie s'arrête là, et c'est moins que pour les rôles : la base **ne ferme pas la liste
des types d'écriture** (voir « Conséquences »). _Depuis l'ADR 0030, elle la ferme : une
écriture d'un autre type est refusée._

Le rôle propriétaire n'a **pas de chemin à part** : il n'existe pas d'ajustement « sans
auteur », contrairement à un actif ou à des plafonds.

### L'approbateur prouve qu'il est là

Approuver exige de nouveau le mot de passe de l'approbateur **et son second facteur**
(`HolderProofService`, comme pour un transfert, une clôture, une copie des données), vérifiés
avant tout examen de la demande. Un jeton de session dérobé ne suffit pas à approuver. Les
essais erronés sont bornés et tracés.

### Pas de clé d'idempotence fournie par le client

Les routes par lesquelles un titulaire déplace des fonds exigent l'en-tête `Idempotency-Key`
(ADR 0026). Celles-ci, non, parce que chaque étape est protégée autrement :

- **demander** ne déplace rien. Et **une seule demande identique** — même portefeuille, même
  sens, même montant — peut être en attente : une demande renvoyée par erreur est refusée
  (`409`), elle ne peut pas être approuvée deux fois ;
- **approuver** fait passer la demande de « en attente » à « approuvée », une fois : une
  approbation renvoyée répond `409`, sans rien écrire. De deux approbations simultanées, la
  demande étant verrouillée la première, une seule s'applique.

### Fermé par défaut

Demander et approuver exigent que la fonctionnalité `manualAdjustments` soit ouverte
(ADR 0012) — par une décision d'administrateur, justifiée et tracée. La refermer arrête l'un
et l'autre ; consulter, refuser et retirer restent possibles, pour que ce qui était en
attente puisse être clos.

### Ce que le titulaire en sait

- Il est **prévenu par e-mail** de tout crédit et de tout débit : le sens, le montant, la
  date — dans sa langue. Des fonds ne bougent pas sur son portefeuille à son insu.
- Le mouvement figure dans son portefeuille (`adjustment.credit`, `adjustment.debit`) et
  l'événement dans l'historique de son compte.
- **Il ne lit jamais la justification** : elle est interne. Une demande refusée, retirée ou
  échue ne lui est pas signalée.

### Geler un portefeuille

- Un gel porte sur **le portefeuille d'un titulaire dans un actif**. Tant qu'il est en
  vigueur, **aucune ligne d'écriture ne passe** sur les comptes de ce titulaire dans cet
  actif : rien n'en part, rien n'y arrive. Le solde demeure ; ses autres portefeuilles ne
  sont pas concernés.
- **Seules passent les écritures d'ajustement** : c'est par elles, sous double validation,
  que des fonds quittent un portefeuille gelé.
- **La règle est posée sur le grand livre**, par un déclencheur sur les lignes d'écriture
  (erreur `MGX12`), et non dans chaque opération. Elle vaut donc d'office pour les
  transferts, et pour toute opération à venir — qui n'aura pas à s'en souvenir.
  `LedgerService` fait le même contrôle avant d'écrire, pour répondre clairement
  (`WalletFrozenError`).
- **Le gel est exact.** Il verrouille le titulaire — comme le fait un transfert sur son
  émetteur —, puis ses comptes dans l'actif, après avoir ouvert, vide, celui du portefeuille
  s'il n'existait pas. Une écriture en cours s'achève avant lui ; toute écriture qui le suit
  l'attend, puis le voit. Aucun mouvement n'est validé sur un portefeuille après son gel.
- **Geler et lever sont deux permissions.** Geler : `wallet_freezes.create` ; lever :
  `wallet_freezes.lift`. La base relit ces droits au moment d'écrire. Chaque acte est
  justifié ; nul ne gèle son propre portefeuille, ni n'en lève le gel. Un gel levé **reste**,
  avec qui l'a levé, quand et pourquoi ; un seul gel en vigueur par portefeuille.
- **Le titulaire le voit** : son portefeuille porte `frozen`, un transfert qu'il tente
  répond `403 WALLET_FROZEN`, le gel et sa levée figurent dans son historique. Il n'en lit
  jamais le motif, et ne reçoit aucun message.
- **Qui lui envoie des fonds ne l'apprend pas** : il reçoit le refus unique du destinataire
  (`RECIPIENT_UNAVAILABLE`, ADR 0026).
- **Un compte au portefeuille gelé ne se clôt pas**, ni par son titulaire ni par le
  personnel : la clôture efface ce qui identifie le compte, alors qu'un examen est en cours.
  Le gel est d'abord levé.
- Geler ne dépend d'aucune fonctionnalité à ouvrir : on gèle à tout moment, y compris
  pendant la maintenance.

### Sortir les fonds d'un compte à fermer

Un **débit** sous double validation, qui passe sur un compte suspendu et sur un portefeuille
gelé ; puis la levée du gel éventuel ; puis la clôture. La plateforme rend les fonds au
titulaire hors de l'API : le grand livre constate qu'elle ne les conserve plus.

### Qui peut quoi

Six permissions : `adjustments.read`, `adjustments.request`, `adjustments.approve`,
`wallet_freezes.read`, `wallet_freezes.create`, `wallet_freezes.lift`.

- `super_admin` les détient toutes ;
- `compliance` reçoit `wallet_freezes.read` et `wallet_freezes.create` : **elle gèle, elle ne
  lève pas**, et ne prend part à aucun ajustement ;
- `support` n'en reçoit aucune.

Demander et approuver sont deux permissions distinctes : un rôle à venir peut n'avoir que
l'une. La règle des quatre yeux, elle, ne dépend pas des rôles.

### Ordre des verrous

Une approbation verrouille **la demande**, puis — par le grand livre — **le titulaire**, puis
**les comptes** (ADR 0025). Un gel verrouille le titulaire, puis ses comptes. Une clôture
verrouille le titulaire. Tous prennent le titulaire avant les comptes : ils s'attendent sans
s'interbloquer.

### Clôture, conservation, copie des données

- Une demande en attente **ne retient pas** la clôture d'un compte : clôturé, il ne reçoit
  plus rien — la demande ne s'approuve plus, elle se refuse, se retire ou échoit.
- **Rien ne s'efface** : ni une demande, décidée ou non, ni un gel, levé ou non. Ils ne
  portent que des identifiants de compte et des justifications.
- La copie des données (format `5`) dit, pour chaque portefeuille, s'il est gelé ; les
  mouvements d'ajustement y figurent comme les autres. **Les justifications n'y figurent
  pas.**

## Choix à confirmer

Huit choix relèvent du produit ou de l'organisation plus que de la technique. Ils ont été
faits pour que le lot soit complet et vérifiable ; chacun se change sans reprendre le reste.

1. **La contrepartie d'un ajustement est toujours le compte de conservation.** Un ajustement
   constate des fonds reçus ou rendus hors de l'API ; il n'existe pas d'ajustement « offert »
   (geste commercial), ni contre les frais perçus.
2. **Seul `super_admin` prend part à un ajustement**, et seul il lève un gel ; la conformité
   gèle. Aucun rôle « finance » n'a été créé.
3. **L'approbateur présente de nouveau son mot de passe et son second facteur.** L'auteur de
   la demande, non.
4. **Aucun plafond ne borne un ajustement, et aucun niveau de vérification n'est exigé du
   titulaire crédité** : c'est aux deux personnes d'en juger.
5. **Le titulaire est prévenu par e-mail d'un ajustement, pas d'un gel** ; il ne lit jamais
   une justification.
6. **Un gel se voit** (`frozen`, `WALLET_FROZEN`), **vaut pour un actif**, **arrête aussi ce
   qui arrive**, et **retient la clôture**. Le lever est l'acte d'une seule personne.
7. **Une demande échoit après 72 heures**, comme une demande de changement de rôle.
8. **Les ajustements sont une fonctionnalité fermée par défaut** ; les gels, non.

## Alternatives écartées

- **Une route qui crédite en une fois**, réservée à `super_admin`. Écarté : une personne
  seule, ou un seul compte compromis, créerait des fonds.
- **Faire respecter la double validation par le seul code de l'API.** Écarté : c'est la
  règle qui doit tenir même si ce code est fautif (ADR 0018).
- **Faire passer l'écriture par la base elle-même**, à l'approbation, comme pour les rôles.
  Écarté : il n'y aurait plus un seul chemin pour l'argent. La base vérifie l'accord de
  l'écriture et de l'ajustement ; elle ne la passe pas.
- **Une table générique de « demandes à approuver »**, commune aux rôles et aux ajustements.
  Écarté : chaque demande a ses termes, typés, que la base vérifie un à un.
- **Exiger `Idempotency-Key` sur ces routes.** Non retenu : voir plus haut.
- **Un gel porté par le compte du grand livre** (une colonne). Écarté : un compte ne change
  que par ses lignes, et la colonne ne dirait ni qui, ni quand, ni pourquoi, ni qui l'a levé.
- **Un gel vérifié par chaque opération.** Écarté : la première opération qui l'oublierait
  le contournerait.
- **Un gel qui ne retient que les sorties.** Non retenu : des fonds reçus sur un portefeuille
  gelé y resteraient pris, et la règle « rien n'y passe » est plus simple à garantir et à
  expliquer. À revoir si l'usage le demande (choix 6).
- **Un gel que le titulaire ne voit pas.** Non réalisé : ses transferts seraient refusés sans
  qu'il puisse comprendre pourquoi. Pour une mesure qui ne doit pas alerter son objet, ce
  n'est pas l'outil.
- **Geler tout le compte.** Non réalisé : la suspension d'un compte existe déjà, et arrête
  tout — connexion comprise. Le gel est plus fin : un portefeuille, le compte restant
  utilisable.
- **Une double validation pour lever un gel.** Non réalisée : à revoir avant l'ouverture.
- **Laisser un débit rendre un solde négatif**, pour constater une dette. Écarté : aucun
  compte ne devient négatif (ADR 0025).
- **Les fonds réservés dans ce lot.** Non réalisés : rien ne les emploie encore. Un gel n'est
  pas une réservation — il arrête un portefeuille entier, il n'en met pas une part de côté.
- **Joindre une pièce** à une demande. Non réalisé : la justification est un texte, qui doit
  désigner la pièce.

## Conséquences

- **Des fonds peuvent désormais exister dans le registre** — et les transferts s'éprouver
  avec de vrais soldes. Un crédit vaut ce que valent les deux personnes qui l'ont décidé :
  **rien ne le rapproche de fonds réellement détenus**. Le rapprochement reste à construire,
  avec les dépôts et les retraits.
- **Deux personnes habilitées qui s'entendent créditent n'importe quel portefeuille**, du
  montant qu'elles veulent — comme deux comptes d'administration compromis. Rien ne borne un
  ajustement ; chacun est tracé, ineffaçable, et signalé au titulaire.
- **La base ne ferme pas la liste des types d'écriture.** Elle garantit qu'une écriture de
  type `adjustment.*` a son ajustement approuvé ; elle ne garantit pas qu'une écriture d'un
  **autre** type ne touche ni un portefeuille, ni le compte de conservation. Le grand livre
  vérifie l'arithmétique d'une écriture — entière, équilibrée, sans solde négatif —, non sa
  légitimité (ADR 0025) : une écriture équilibrée d'un type quelconque, écrite en SQL sous le
  rôle de l'API, est validée, après ce lot comme avant. Constaté sur la base d'aperçu : une
  écriture de type `preview.seed`, ainsi écrite, a crédité un portefeuille. La double
  validation imposée par la base protège donc d'un défaut du code des ajustements — une
  approbation par l'auteur, hors délai, d'un autre montant, passée deux fois — ; elle ne
  protège pas d'un code, ni d'un attaquant, qui passerait une écriture d'un autre type. Pour
  les rôles, l'API n'a aucun droit d'écriture sur les attributions : il n'y a pas d'autre
  chemin. Ici, il y en a un. **Le fermer** — toute ligne sur le compte de conservation
  appartient à une opération que la base connaît — est proposé pour la suite : cela demande
  de revoir la façon dont les tests alimentent les portefeuilles (écritures `test.deposit`).
  _Fait depuis (ADR 0030) : la base tient la liste des types d'écriture et refuse toute
  écriture d'un autre type ; les tests déclarent leurs types d'essai avec le rôle
  propriétaire, dans leur base jetable. La limite suivante — la base vérifie la qualité des
  deux intervenants, pas leur présence — demeure._
- **La base vérifie la qualité des deux intervenants, pas leur présence** : c'est l'API qui
  les lui désigne (même limite que l'ADR 0018). Un attaquant capable d'exécuter du SQL sous
  le rôle de l'API pourrait fabriquer une demande et son approbation au nom de deux
  administrateurs existants ; il laisserait une demande ineffaçable qu'ils n'ont jamais
  faite. La preuve redemandée à l'approbateur est vérifiée par l'API, non par la base.
- **Il faut deux administrateurs** pour qu'un ajustement aboutisse, chacun avec la
  validation en deux étapes.
- **Changements pour les clients de l'API** : chaque portefeuille porte `frozen` ; la copie
  des données passe au format `5` ; l'historique connaît quatre types de plus
  (`WALLET_CREDITED`, `WALLET_DEBITED`, `WALLET_FROZEN`, `WALLET_UNFROZEN`) ; un code
  d'erreur s'ajoute (`WALLET_FROZEN`, 403) ; `features.manualAdjustments` apparaît dans
  l'état de la plateforme ; un mouvement peut porter `adjustment.credit` ou
  `adjustment.debit` ; une clôture peut être refusée parce qu'un portefeuille est gelé ; neuf
  routes de back-office.
- **Un gel coûte une lecture indexée par ligne d'écriture** sur un compte de titulaire. Sans
  conséquence aux volumes actuels.
- **Les types d'écriture qui passent un gel sont une liste, tenue deux fois** — dans la base
  et dans le code ; un test vérifie qu'elles s'accordent. Y ajouter un type, c'est décider
  qu'une opération se mène sur un portefeuille gelé : seule une opération à deux personnes
  devrait y figurer.
- **Geler ouvre le compte du portefeuille s'il n'existait pas.** Un titulaire peut donc avoir
  un compte, vide, dans un actif où il n'a jamais rien reçu : c'est sans effet sur ce qu'il
  voit — un portefeuille à zéro —, et sur la clôture.
- **Un gel n'est pas discret**, et le support ne le voit pas : il ne peut pas dire à un
  titulaire pourquoi ses transferts sont refusés.
- **La justification d'une demande ou d'un gel est un texte libre, conservé indéfiniment** :
  ce qu'on y écrit d'une personne y reste, même après la clôture de son compte et le terme de
  conservation. La même réserve que pour le grand livre vaut ici : **ce n'est pas un avis
  juridique** (décision 6).
- **L'échéance des demandes est comptée à l'horloge de la base** ; les demandes échues sont
  closes à chaque lecture, à chaque décision, et par la tâche horaire.
- **Le propriétaire du schéma peut tout**, ici comme ailleurs — désactiver un déclencheur,
  puis écrire. Tant que les règles sont en place, lui non plus ne passe pas un ajustement
  sans deux personnes habilitées.
- Les types des écritures, l'échéance et les clés des permissions sont des constantes du code
  recopiées dans la migration : les changer demande une migration. Les tests fixent les unes
  et les autres aux mêmes valeurs.
