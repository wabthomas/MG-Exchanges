# 0031 — Vérification horaire : le type des écritures et leur opération sont relus

**Statut :** acceptée (2026-11-23) — complète les ADR 0025 (grand livre), 0026 (transferts), 0027 (opérations du personnel) et 0030 (types d'écriture), dont elle reprend le troisième choix. L'étape elle-même a été approuvée par le propriétaire ; les choix de conception, faits ici sans lui, sont à confirmer (plus bas).

## Contexte

La base refuse, **à l'écriture**, trois choses que la vérification horaire ne relisait pas :

- une écriture d'un type absent de la liste `ledger_entry_kinds` (ADR 0030) ;
- un transfert dont l'écriture n'est pas la sienne, et une écriture `transfer.internal` sans
  son transfert (ADR 0026) ;
- un ajustement approuvé dont l'écriture n'est pas la sienne, et une écriture
  `adjustment.credit` ou `adjustment.debit` sans son ajustement approuvé (ADR 0027).

La vérification horaire (`verify-ledger`, ADR 0025) recalculait l'**arithmétique** du grand
livre — soldes, enchaînement des lignes, équilibre des écritures et des actifs. Elle ne
disait rien de la **légitimité** d'une écriture : une écriture entière et équilibrée, d'un
type quelconque ou sans opération, lui paraissait saine.

Or une règle à l'écriture ne dit rien de ce qui est déjà écrit, ni de ce qui s'écrit pendant
qu'elle est neutralisée. Deux cas l'ont rendu concret :

- l'ADR 0030 a laissé en place, sans les réexaminer, les écritures antérieures à la liste
  des types — la base d'aperçu en porte une, `preview.seed` ;
- le propriétaire du schéma peut désactiver un déclencheur, puis écrire : c'est précisément
  ce que la vérification périodique est là pour relever (ADR 0025), et elle ne relevait
  alors qu'une écriture mal formée, non une écriture bien formée que personne n'a demandée.

Constaté par un test de ce lot : une écriture `adjustment.credit` entière — le compte de
conservation débité, un portefeuille crédité —, passée sans demande ni approbation pendant
que la règle était neutralisée, n'est désignée par **aucune** des cinq anomalies qui
existaient.

## Décision

### Trois contrôles, chacun relit les règles de sa propre migration

L'étape `verify-ledger` exécute désormais trois contrôles. Chacun est **une instruction**,
qui lit donc un seul état de la base, et reprend **clause pour clause** la règle que la base
applique à l'écriture : ce qu'elle refuse alors est ce que le contrôle relève après coup.

| Contrôle      | Anomalie                    | Règle relue (migration)                                          | Désigne          |
| ------------- | --------------------------- | ---------------------------------------------------------------- | ---------------- |
| `ledger`      | `ENTRY_KIND_UNKNOWN`        | `ledger_entries_kind_known` (`ledger_entry_kinds`)               | l'écriture       |
| `transfers`   | `TRANSFER_ENTRY_MISMATCH`   | `transfers_entry_matches` (`internal_transfers`)                 | **le transfert** |
| `transfers`   | `ENTRY_WITHOUT_TRANSFER`    | `ledger_entries_transfer_recorded` (`internal_transfers`)        | l'écriture       |
| `adjustments` | `ADJUSTMENT_ENTRY_MISMATCH` | `ledger_adjustments_entry_matches` (`staff_ledger_operations`)   | **l'ajustement** |
| `adjustments` | `ENTRY_WITHOUT_ADJUSTMENT`  | `ledger_entries_adjustment_recorded` (`staff_ledger_operations`) | l'écriture       |

- Le contrôle `ledger` est celui qui existait, avec une sixième branche ; ses cinq premières
  anomalies sont inchangées.
- `TRANSFER_ENTRY_MISMATCH` : l'écriture que désigne un transfert est de type
  `transfer.internal` et se compose d'**exactement deux lignes** — l'une débite le
  portefeuille de l'émetteur, l'autre crédite celui du destinataire, du montant du
  transfert, dans son actif. Un transfert dont l'écriture n'existe pas est relevé de même.
- `ADJUSTMENT_ENTRY_MISMATCH` : pour un ajustement **approuvé**, l'écriture est du type de
  son sens et se compose d'exactement deux lignes — le portefeuille du titulaire d'un côté,
  le compte de conservation de la plateforme de l'autre, du montant de l'ajustement, dans
  son actif. Une demande en attente, refusée, annulée ou échue n'a pas d'écriture — une
  contrainte l'impose (`ledger_adjustments_decision_check`) — et n'est pas relue.
- `ENTRY_WITHOUT_ADJUSTMENT` : une écriture d'ajustement que ne désigne aucun ajustement
  **approuvé** — un ajustement d'un autre état ne suffit pas, quand bien même il la
  désignerait, la contrainte retirée.
- **Ce que désigne l'anomalie** est ce qu'il faut ouvrir pour instruire : l'opération quand
  c'est elle qui ne correspond plus, l'écriture quand elle est sans opération. Jamais un
  montant, comme pour les anomalies existantes.

Une même altération produit en général plusieurs anomalies, et c'est voulu : une ligne
modifiée déséquilibre son écriture (`ENTRY_UNSOUND`), rompt la suite de son compte
(`POSTING_CHAIN_BROKEN`) et ne correspond plus à son opération. À l'inverse, une écriture
**entière et équilibrée** d'un type réservé, passée sans son opération, n'est désignée que
par une anomalie — celle de ce lot : les contrôles d'arithmétique ne voient rien.

### Un registre : le grand livre ne connaît toujours aucune opération

Le grand livre expose `LedgerCheckRegistry`. Un module qui passe des écritures y inscrit un
contrôle (`LedgerCheck` : un nom, et une fonction qui rend au plus _n_ anomalies) ;
`transfers` et `adjustments` y inscrivent chacun le leur, au démarrage. L'étape exécute le
contrôle du grand livre, puis ceux du registre, dans l'ordre d'inscription.

- Le sens des dépendances de l'ADR 0025 est gardé : `transfers` et `adjustments` dépendent
  de `ledger`, jamais l'inverse. C'est le mécanisme déjà retenu pour la tâche horaire
  (`MaintenanceStepRegistry`) et pour la clôture d'un compte (`AccountDataRegistry`).
- Un nom ne s'inscrit qu'une fois ; l'inscrire deux fois est une erreur de démarrage.
- **Le prix :** les instructions des deux modules lisent les tables du grand livre
  (`ledger_entries`, `ledger_postings`, `ledger_accounts`). Leurs règles en base le font
  déjà, dans leurs migrations ; le code applicatif, lui, ne le faisait pas jusqu'ici.

### Le type se compare à la liste de la base, non à celle du code

`ENTRY_KIND_UNKNOWN` relit `ledger_entry_kinds` — la liste que la base consulte elle-même à
l'écriture — et non la constante `LEDGER_ENTRY_KINDS` du code.

- La vérification relève ainsi **ce que la base aurait refusé**, ni plus ni moins. Et une
  migration qui ajoute un type précède la version du code qui le connaît : pendant un
  déploiement, comparer à la constante ferait signaler par l'ancienne version des écritures
  légitimes de la nouvelle.
- **La limite, constatée par un test :** un type que le propriétaire ajoute à la liste hors
  d'une migration cesse d'être signalé. La vérification tient pour connu tout type de la
  liste ; elle ne dit pas d'où il vient.

### Cinquante anomalies pour l'ensemble ; un contrôle qui échoue ne fait pas taire les autres

- Le maximum de cinquante anomalies par passage (ADR 0025) vaut **pour l'ensemble** des
  contrôles : chacun n'est interrogé que sur ce qu'il en reste ; le maximum atteint, les
  suivants ne sont pas interrogés. Un contrôle qui rendrait plus qu'on ne lui demande
  n'allonge pas la liste.
- **Un contrôle qui ne peut pas s'exécuter** — son instruction dépasse le délai d'exécution
  des requêtes, par exemple — est journalisé (`Ledger verification check failed`, avec son
  nom), et **les autres s'exécutent tout de même**. L'étape échoue dans tous les cas :
  - si les autres relèvent une anomalie, elle est signalée comme d'habitude, et l'erreur, la
    ligne de journal et la trace d'audit **nomment le contrôle qui a manqué**
    (`failedChecks`) — la liste ne dit rien de ce qu'il relit ;
  - sinon, l'étape échoue avec une erreur distincte (`LedgerVerificationIncompleteError`),
    **sans trace d'audit** : un grand livre qui n'a pas été vérifié en entier n'est pas une
    anomalie, et la trace `ledger.verification_failed` garde un seul sens.

### Un type nouveau arrive avec son contrôle : un test le garde

L'ADR 0030 demande qu'un type arrive avec la règle qui le lie à son opération. Il doit aussi
arriver avec le contrôle qui la relit. Un test le garde : pour **chaque** type de
`LEDGER_ENTRY_KINDS`, il donne ce type à une écriture qui appartient à une autre opération,
et exige que la vérification désigne cette écriture. Un type ajouté aux contrats et à la
base sans contrôle le fait échouer.

Il n'y a pas d'assertion au démarrage : un module absent ne s'inscrit pas, et l'API démarre
sans que rien ne le relève. Le garde est le test, non l'exécution.

### Rien n'est corrigé, rien ne s'acquitte

- Comme pour les anomalies existantes : journal, trace d'audit, échec de l'étape, **aucune
  correction automatique**.
- **Aucun moyen d'acquitter une anomalie.** L'étape échoue à chaque passage tant que
  l'anomalie demeure — et une écriture ne s'efface pas : une écriture d'un type inconnu est
  signalée **indéfiniment**, jusqu'à ce que la base soit recréée ou que son type soit
  déclaré par une migration.
- Aucune migration, aucune route, aucun contrat de l'API ne change.

## Choix à confirmer

Le propriétaire a approuvé l'étape — « étendre la vérification horaire au type des écritures
et à leur opération » — telle qu'elle était proposée, en une phrase. Les choix suivants ont
été faits pendant le lot, sans lui ; chacun se change sans reprendre le reste.

1. **Une anomalie ancienne est signalée à chaque passage, sans moyen de l'acquitter.** Sur
   la base d'aperçu, l'étape `verify-ledger` échoue donc désormais toutes les heures, à
   cause de l'écriture `preview.seed`. L'autre voie — une liste d'écritures « connues et
   acceptées » — est écartée plus bas.
2. **Les ajustements non approuvés ne sont pas relus** : seule la correspondance d'un
   ajustement approuvé avec son écriture l'est. Une demande refusée qui désignerait, la
   contrainte retirée, l'écriture d'une autre opération n'est pas signalée — aucun fonds n'a
   bougé de ce fait.
3. **Ce qui dépendait du moment de l'opération n'est pas relu** : plafonds et niveau de
   vérification à l'heure d'un transfert, comptes actifs, permissions de ceux qui ont
   demandé et approuvé un ajustement, gel alors en vigueur.
4. **Un contrôle qui échoue fait échouer l'étape sans trace d'audit**, quand les autres
   n'ont rien relevé.
5. **Le type se compare à la liste de la base** : un type ajouté à la main par le
   propriétaire n'est pas signalé.

## Alternatives écartées

- **Une seule instruction, dans le grand livre, qui lit `transfers` et
  `ledger_adjustments`.** Elle lirait un seul état pour les trois contrôles, mais ferait
  dépendre le grand livre des opérations qui s'en servent — l'inverse de l'ADR 0025 —, et
  chaque opération à venir (dépôt, retrait, frais) y ajouterait sa branche. Les trois
  instructions lisent trois états successifs ; c'est sans conséquence, parce qu'une
  opération et son écriture sont validées dans la même transaction et ne changent plus :
  aucun des trois états n'en montre une sans l'autre.
- **Comparer le type à la constante du code.** Écarté plus haut : faux positifs pendant un
  déploiement, et un écart avec ce que la base refuse réellement.
- **Une liste d'écritures acquittées**, pour faire taire une anomalie connue. C'est une
  écriture de plus dans la base que le propriétaire du schéma peut altérer — le moyen même
  de masquer ce que la vérification cherche. Si le besoin se confirme, il demande sa propre
  décision : qui acquitte, sous quelle validation, avec quelle trace.
- **Relire les règles « du moment »** (plafonds, niveau, permissions). Elles dépendent d'un
  état qui a changé depuis — un plafond relevé, un rôle retiré — et que rien ne conserve à
  la date de l'opération : la relecture signalerait des opérations régulières.
- **Arrêter au premier contrôle qui échoue.** Un contrôle trop lent ferait taire les
  suivants à chaque passage, sans limite de durée.
- **Une trace d'audit pour une vérification incomplète.** Le journal d'audit consigne des
  faits sur le grand livre ; « la base n'a pas répondu à temps » est un incident
  d'exploitation, déjà journalisé et déjà compté comme un échec de l'étape.
- **Une assertion au démarrage** — chaque type de la liste a son contrôle. Elle demanderait
  que chaque contrôle déclare les types qu'il couvre, déclaration que rien ne vérifierait ;
  le test, lui, le constate sur une écriture réelle.

## Conséquences

- **Une écriture bien formée que personne n'a demandée est désormais relevée**, dans
  l'heure : un crédit sans ajustement approuvé, un mouvement entre deux portefeuilles sans
  transfert, une écriture d'un type inconnu. C'est ce que le propriétaire du schéma — ou une
  restauration partielle — peut produire et que rien ne signalait.
- **Elle est relevée, pas empêchée**, et **personne n'est alerté** : la limite de l'ADR 0025
  est inchangée — une erreur dans les journaux, une trace d'audit, aucune alerte branchée
  avant la phase 9.
- **Sur la base d'aperçu, l'étape échoue à chaque passage**, à cause de l'écriture
  `preview.seed`. C'est le comportement décidé, non un défaut ; la base d'aperçu est
  jetable, et la recréer la ferait disparaître. La production n'a jamais servi.
- **Avant de déployer cette version sur une base qui a servi**, exécuter la requête de
  recensement de `docs/DEPLOYMENT.md` : chaque écriture qu'elle rend fera échouer l'étape,
  toutes les heures, indéfiniment.
- **Ce qui n'est pas relu**, outre les règles « du moment » : un type ajouté à la main par
  le propriétaire, et tout ce que les règles relues ne disent pas — la vérification n'établit
  pas que l'opération était justifiée, seulement qu'elle existe et correspond à son écriture.
  Qui détient les identifiants du rôle de l'API peut toujours écrire l'opération entière
  (limite de l'ADR 0018) ; elle ne sera pas signalée.
- **Trois instructions par passage au lieu d'une**, chacune soumise au délai d'exécution des
  requêtes (15 s par défaut). Les deux nouvelles relisent tous les transferts et tous les
  ajustements approuvés, avec leurs lignes. **Leur durée n'a jamais été mesurée sur un grand
  livre volumineux** — pas plus que celle de la première (ADR 0025). Un contrôle qui dépasse
  le délai échoue à chaque passage sans avoir rien vérifié : l'étape échoue, le journal le
  dit, et c'est le signal qu'il faut borner la relecture — par tranches, ou sur une
  réplique.
- **Le texte des règles existe en deux exemplaires** : dans la migration, qui l'applique à
  l'écriture, et dans le contrôle, qui le relit. Rien ne les compare mécaniquement. Les
  tests altèrent une à une les données sur lesquelles porte chaque clause — type, nombre de
  lignes, sens, montant, actif, type et titulaire du compte — et exigent l'anomalie ; une
  clause ajoutée plus tard à une migration devra l'être aussi au contrôle.
- Les noms des anomalies et des contrôles sont des constantes du code, inscrites dans les
  journaux et dans le journal d'audit : les renommer change ce que la supervision lit.
