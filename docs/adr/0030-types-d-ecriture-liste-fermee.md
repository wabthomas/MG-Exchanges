# 0030 — Types d'écriture : une liste fermée, tenue par la base

**Statut :** acceptée (2026-11-23) — complète les ADR 0025 (grand livre), 0026 (transferts) et 0027 (opérations du personnel). Ferme le chemin que l'ADR 0027 relevait sans le fermer. Cinq choix, faits ici sans le propriétaire, sont à confirmer (plus bas).

## Contexte

Le grand livre vérifiait d'une écriture son **arithmétique** — entière, équilibrée, sans
solde négatif (ADR 0025) —, non sa **légitimité**. Deux familles d'écritures seulement
étaient liées à une opération : `transfer.internal` à un transfert (ADR 0026),
`adjustment.credit` et `adjustment.debit` à un ajustement approuvé par deux personnes
(ADR 0027). Le type d'une écriture (`ledger_entries.kind`) était un texte libre : la base en
contrôlait la forme, pas la valeur.

Il restait donc un chemin, décrit dans l'ADR 0027 (« La base ne ferme pas la liste des types
d'écriture ») : sous le rôle de l'API, une écriture équilibrée **d'un type quelconque** était
validée. Deux conséquences, constatées par des tests avant ce lot :

- **créditer un portefeuille depuis le compte de conservation**, sans demande ni
  approbation — une écriture `test.deposit` de deux lignes ;
- **déplacer des fonds d'un portefeuille à un autre hors des règles des transferts** — ni
  niveau de vérification, ni plafond, ni contrôle des deux parties : une écriture
  `test.transfer` de deux lignes.

Aucune route de l'API ne passe de telles écritures : le code du produit n'en écrit que trois
types, par `LedgerService`. Le chemin n'était ouvert qu'à un code fautif, ou à qui
exécuterait du SQL sous le rôle de l'API. La double validation des ajustements, imposée par
la base, ne protégeait donc que d'un défaut du code des ajustements. La base d'aperçu en
porte la trace : une écriture `preview.seed`, écrite ainsi le 15 novembre, y a crédité un
portefeuille.

## Décision

### La base tient la liste des types d'écriture, et refuse les autres

- Une table, **`ledger_entry_kinds`** (`key`, `description`), est la liste des types
  d'écriture que la base connaît. La migration `ledger_entry_kinds` y inscrit les trois types
  des opérations existantes : `transfer.internal`, `adjustment.credit`, `adjustment.debit`.
- **Une écriture d'un type absent de la liste est refusée**, dès l'insertion de son en-tête,
  quels que soient le rôle qui écrit, l'auteur qu'elle désigne et ses lignes (déclencheur
  `ledger_entries_kind_known`, erreur nouvelle **`MGX13`**). Un type mal formé reste refusé
  d'abord pour sa forme.
- **Le contrôle a lieu à l'insertion de l'en-tête, et là seulement.** Il suffit à deux
  conditions, que d'autres règles tiennent : une écriture ne se modifie pas, pas même dans la
  transaction qui l'écrit (ADR 0025), et un type ne se retire pas de la liste. La première
  est éprouvée ici aussi : rendre modifiable le type d'une écriture contournerait le
  contrôle — écrire l'en-tête sous un type connu, puis le changer.
- **Chaque type de la liste est déjà lié à son opération**, par les règles des ADR 0026
  et 0027 : une écriture `transfer.internal` n'existe pas sans son transfert — deux lignes,
  sur les portefeuilles de deux titulaires actifs, dans les plafonds — ; une écriture
  `adjustment.*` pas sans son ajustement approuvé — deux lignes, le portefeuille contre le
  compte de conservation.

Les deux règles ensemble donnent ce que le lot cherchait : sous le rôle de l'API, **des fonds
n'entrent dans un portefeuille et n'en sortent que par un ajustement approuvé, et ne passent
d'un portefeuille à un autre que par un transfert**. Il n'existe plus d'écriture « libre ».

### La liste ne s'étend que par migration, avec la règle du nouveau type

- La liste est **du code**, comme le plan de comptes (ADR 0025) : elle vit dans
  `@mgx/contracts` (`LEDGER_ENTRY_KINDS`), est recopiée en base par migration, et un test
  vérifie que les deux sont identiques. Les types des opérations
  (`INTERNAL_TRANSFER_ENTRY_KIND`, `LEDGER_ADJUSTMENT_ENTRY_KINDS`) sont contraints, à la
  compilation, d'y figurer.
- **Seul le rôle propriétaire de la table y ajoute un type** — celui des migrations. Le rôle
  de l'API n'a que `SELECT` ; un déclencheur (`ledger_entry_kinds_enforce`, `MGX13`) refuse
  son ajout même si le privilège lui était rendu par erreur, et une table temporaire de même
  nom ne fait de personne le propriétaire de la liste.
- **Un type ne se modifie ni ne se retire**, même par le propriétaire (`MGX01`) : des
  écritures le portent, des règles le nomment.
- **Ajouter un type, c'est écrire dans la même migration la règle qui le lie à son
  opération.** Un type connu de la base sans règle rouvre exactement le chemin que ce lot
  ferme. Un test le garde pour les types présents : il relit dans la base les contrôles de
  fin de transaction posés sur `ledger_entries`, et exige que chaque type de la liste y soit
  nommé — et aucun autre.

### Ce qui est déjà écrit n'est pas réexaminé

- La règle est un **déclencheur à l'insertion**, non une clé étrangère : elle vaut pour ce
  qui s'écrit après la migration. Une écriture ne se modifie ni ne s'efface, pas même par le
  propriétaire (ADR 0025) : une écriture d'un autre type passée auparavant **reste dans le
  grand livre**, et la migration s'applique sans la toucher.
- `docs/DEPLOYMENT.md` donne la requête qui recense ces écritures, à exécuter avant
  d'appliquer la migration à une base qui a déjà servi. La production n'a jamais servi ; la
  base d'aperçu en porte une (`preview.seed`).

### Dans le code : un défaut, pas un cas attendu

- Le type d'une écriture est une **constante de l'opération** qui la passe, jamais une donnée
  reçue d'un client. `LedgerService` ne contrôle donc pas le type d'avance ; le dépôt traduit
  `MGX13` en `LedgerIntegrityError`, comme `MGX08` : l'API répond `500`, l'incident est
  journalisé, rien n'est écrit.
- Aucune route, aucun contrat de l'API ne change.

### Dans les tests : des types d'essai, déclarés par le propriétaire

- Les tests du grand livre lui-même passent des écritures qu'aucune opération ne produit —
  plusieurs actifs, cinq lignes, le compte des frais. Ils les passaient sous des types
  inventés (`test.deposit`, `test.transfer`…). Chaque fichier de test **déclare désormais ces
  types, avec le rôle propriétaire, dans sa propre base jetable**
  (`registerEntryKindsInSql`) — ce que fait une migration, et ce que les tests faisaient déjà
  pour un actif sans auteur ou des plafonds sans auteur.
- La base modèle des tests, elle, ne connaît que les trois types du produit, et un fichier
  (`ledger-entry-kinds-schema.spec.ts`) s'exécute sur une base **telle que les migrations la
  laissent** : c'est là qu'est éprouvé ce qu'une base de production refuse.
- Un test qui oublie de déclarer un type échoue sur `MGX13`, code propre à cette règle — non
  sur un refus qu'il attendait pour une autre raison. Vérifié sur les 45 fichiers de tests à
  services réels : la règle n'est atteinte que dans les deux fichiers qui l'éprouvent.

## Choix à confirmer

Ce lot figurait dans la « suite proposée » comme **à confirmer** ; il a été mené sur la
consigne de continuer. Cinq choix y ont été faits sans le propriétaire ; chacun se change
sans reprendre le reste.

1. **La règle est plus large que celle proposée.** La proposition disait : « toute ligne sur
   le compte de conservation appartient à une opération que la base connaît ». La règle
   retenue ferme **la liste des types d'écriture** : elle couvre aussi les mouvements d'un
   portefeuille à un autre, que la proposition laissait passer.
2. **Les écritures déjà passées ne sont pas réexaminées**, et celle de la base d'aperçu y
   reste.
3. **La vérification horaire n'est pas étendue** : elle ne signale ni une écriture d'un type
   inconnu, ni une écriture sans son opération.
4. **Un type inconnu est un défaut du code** (`500`), avec un code d'erreur à lui (`MGX13`).
5. **Les tests gardent leurs écritures d'essai**, déclarées par le rôle propriétaire : ils
   n'alimentent pas les portefeuilles par de vrais ajustements.

## Alternatives écartées

- **La règle telle que proposée — borner les lignes du compte de conservation.** Elle ferme
  l'entrée et la sortie des fonds, non leur déplacement : une écriture d'un type inventé
  entre deux portefeuilles restait validée, hors niveau de vérification et hors plafond. Elle
  demandait en outre une règle par type de compte de la plateforme, à compléter à chaque
  nouveau compte ; la liste des types, elle, ne se complète qu'avec une opération.
- **Une clé étrangère** de `ledger_entries.kind` vers la liste. Toutes les écritures
  existantes devraient la satisfaire : une base qui porte une seule écriture d'un autre
  type — c'est le cas de la base d'aperçu — ne se migrerait qu'en déclarant ce type,
  c'est-à-dire en rouvrant le chemin pour lui. Le refus porterait un code générique (`23503`)
  et non un code de l'application ; et vider la liste « en cascade » entraînerait les
  écritures, protégées par ailleurs.
- **Une contrainte `CHECK (kind IN (…))`, ou un type énuméré.** La liste ne serait plus une
  donnée que l'on compare aux contrats par une requête ; l'étendre demanderait de remplacer
  la contrainte — donc de revalider toute la table — ou de modifier le type d'une colonne
  d'une table qui ne se modifie pas.
- **Contrôler le type dans `LedgerService` seulement.** C'est la base qui a le dernier mot
  dans ce projet (ADR 0018, 0025) : un contrôle du code ne protège ni d'un autre code, ni
  d'un accès SQL.
- **Étendre la liste par le back-office**, comme les actifs. Un actif est une donnée ; un
  type d'écriture ouvre un chemin à des fonds et ne vaut que par la règle qui l'accompagne,
  laquelle est du SQL relu : une migration.
- **Interdire tout type d'essai, et alimenter les portefeuilles des tests par de vrais
  ajustements.** Les tests des transferts le pourraient ; ceux du grand livre ont besoin
  d'écritures qu'aucune opération ne produit. Le rôle propriétaire garde de toute façon le
  pouvoir d'ajouter un type — c'est celui des migrations.
- **Réutiliser `MGX08`** (« règle du grand livre enfreinte »). Plusieurs tests attendent
  `MGX08` à la validation d'une écriture d'essai : avec le même code, un type oublié les
  aurait fait réussir pour une mauvaise raison.

## Conséquences

- **Le chemin relevé par l'ADR 0027 est fermé pour le rôle de l'API.** Une écriture
  `test.deposit` ou `preview.seed`, écrite en SQL sous ce rôle, est refusée — équilibrée ou
  non.
- **Ce qui reste hors de portée de la base, inchangé :** qui détient les identifiants du rôle
  de l'API peut écrire l'opération **entière** — un ajustement, sa demande et son
  approbation, au nom de deux membres du personnel habilités (limite de l'ADR 0018) ; un
  transfert entre deux comptes actifs, dans les plafonds. Chacune laisse sa ligne
  ineffaçable. Et **le propriétaire du schéma peut tout** : ajouter un type sans règle,
  désactiver un déclencheur.
- **Toute opération à venir demande une migration** : dépôts, retraits, frais, échanges
  arriveront chacun avec son type **et** sa règle. Il n'y a plus de moyen de passer « à la
  main » une écriture sous le rôle de l'API — pas même une écriture de correction :
  aujourd'hui, elle passe par un ajustement, donc par deux personnes.
- **Un type sans règle rouvre le chemin**, et rien dans la base ne l'empêche : c'est une
  discipline de migration, gardée par un test pour les types présents. Ce test lit la
  définition des déclencheurs ; une règle écrite autrement qu'eux lui échappera et devra y
  être ajoutée.
- **Les écritures antérieures restent** — une dans la base d'aperçu, aucune en production,
  qui n'a jamais servi. La vérification horaire ne les signale pas.
- **Déploiement sans ordre imposé.** La version précédente de l'API ne passe que les trois
  types connus : elle fonctionne après la migration, et revenir à elle ne demande pas de
  défaire la migration.
- **Le contrôle de forme du type d'une écriture devient redondant** pour un type accepté — un
  type mal formé ne peut pas figurer dans la liste. Il est gardé : il répond le premier, avec
  son propre code.
- **Coût :** une lecture par clé primaire, dans une table de trois lignes, à chaque en-tête
  d'écriture.
- **Les tests alimentent encore les portefeuilles par des écritures d'essai**, dans leur base
  jetable, sous des types que le propriétaire y déclare. Ce n'est pas le chemin du produit ;
  le parcours de l'intégration continue, lui, alimente par de vrais ajustements, sur une base
  qui ne connaît que les trois types.
- Les types et leurs descriptions sont des constantes du code recopiées dans la migration :
  en ajouter un demande une migration, et un test fixe les unes et les autres aux mêmes
  valeurs.
