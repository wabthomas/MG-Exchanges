# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions selon
[SemVer](https://semver.org/lang/fr/).

## [Non publié] — Phase 3, lot 5 : la vérification horaire relit le type des écritures et leur opération

**La vérification horaire relève désormais une écriture bien formée que personne n'a
demandée** (ADR 0031, cinq choix à confirmer). Ni migration, ni route, ni contrat de l'API,
ni dépendance nouvelle : rien ne change pour un client de l'API.

### Ajouté

- **Cinq anomalies de plus**, relevées à chaque passage de l'étape `verify-ledger` :
  - `ENTRY_KIND_UNKNOWN` — une écriture d'un type absent de `ledger_entry_kinds` ;
  - `TRANSFER_ENTRY_MISMATCH` — l'écriture que désigne un transfert n'est pas la sienne
    (type, deux lignes, sens, montant, actif, comptes), ou n'existe pas ;
  - `ENTRY_WITHOUT_TRANSFER` — une écriture `transfer.internal` sans son transfert ;
  - `ADJUSTMENT_ENTRY_MISMATCH` — de même pour un ajustement approuvé ;
  - `ENTRY_WITHOUT_ADJUSTMENT` — une écriture `adjustment.credit` ou `adjustment.debit`
    sans ajustement **approuvé** qui la désigne.

  Chacune reprend, clause pour clause, une règle que la base applique à l'écriture
  (ADR 0026, 0027, 0030) : ce qu'elle refuse alors est ce qui est relevé après coup. Avant
  ce lot, un crédit entier et équilibré passé sans demande ni approbation — règle
  neutralisée par le propriétaire du schéma — n'était désigné par aucune anomalie.

- `LedgerCheckRegistry` : les modules `transfers` et `adjustments` y inscrivent le contrôle
  de leurs propres écritures ; le grand livre les exécute sans connaître aucune opération.
- **Un contrôle qui ne peut pas s'exécuter ne fait pas taire les autres** : il est
  journalisé (`Ledger verification check failed`), les autres s'exécutent, et l'étape échoue
  dans tous les cas — en nommant le contrôle qui a manqué.
- Tests, sur une base telle que les migrations la laissent : chaque clause de chaque règle
  altérée une à une ; des écritures entières passées sans leur opération ; le maximum
  d'anomalies partagé entre les contrôles ; un contrôle arrêté par le délai d'exécution des
  requêtes, sans rien simuler ; et un test qui exige, pour chaque type d'écriture du
  produit, qu'une écriture de ce type sans son opération soit relevée.
- ADR 0031. `DEPLOYMENT.md` : la table des dix anomalies, ce que les journaux portent, que
  faire d'une écriture d'un type inconnu. `DATABASE.md`, `ARCHITECTURE.md`, `SECURITY.md`.

### Modifié — à prendre en compte pour l'exploitation

- **Sur une base qui porte une écriture d'un type inconnu, l'étape `verify-ledger` échoue
  désormais à chaque passage**, tant que l'écriture demeure — et une écriture ne s'efface
  pas. Avant de mettre en service cette version sur une base qui a déjà servi, exécuter la
  requête de `DEPLOYMENT.md` (« Grand livre ») : chaque écriture qu'elle rend sera signalée
  toutes les heures. **C'est le cas de la base d'aperçu** (écriture `preview.seed`).
- **Journaux** : `Ledger verification failed` et l'entrée d'audit
  `ledger.verification_failed` portent `failedChecks` quand un contrôle a manqué ; ligne
  nouvelle `Ledger verification check failed` (`check`, `err`) ; erreur nouvelle
  `The ledger could not be verified entirely: … check(s) failed (…)`, sans entrée d'audit.
- Le maximum de cinquante anomalies par passage vaut pour l'ensemble des contrôles.
- **Trois instructions par passage au lieu d'une**, chacune bornée par
  `DATABASE_STATEMENT_TIMEOUT_MS`.
- **Une opération nouvelle apporte son contrôle** (`LedgerCheck`), avec son type d'écriture
  et sa règle (`ARCHITECTURE.md`) ; un test échoue sinon.

### Non fait

- **Rien ne permet d'acquitter une anomalie** : une écriture ancienne d'un type inconnu est
  signalée indéfiniment, jusqu'à ce que la base soit recréée ou son type déclaré par une
  migration.
- **Ce qui dépendait du moment n'est pas relu** : plafonds et niveau de vérification à
  l'heure d'un transfert, permissions à l'heure d'une approbation, gel alors en vigueur.
  Les ajustements non approuvés ne sont pas relus.
- **Un type ajouté à la liste à la main, par le propriétaire, n'est pas signalé** : la
  vérification tient pour connu tout type de la liste.
- **La durée des trois instructions n'a jamais été mesurée sur un grand livre volumineux.**
- **Une anomalie n'alerte toujours personne** (phase 9), et rien n'est corrigé
  automatiquement.

## [Non publié] — Phase 3, lot 4 : types d'écriture en liste fermée

**La base n'accepte plus d'écriture hors d'une opération qu'elle connaît** (ADR 0030, cinq
choix à confirmer). Une migration ; ni route, ni contrat de l'API, ni dépendance nouvelle :
rien ne change pour un client de l'API.

### Corrigé

- **Une écriture équilibrée d'un type inventé, écrite en SQL sous le rôle de l'API, n'est
  plus acceptée.** Seules les écritures `transfer.internal`, `adjustment.credit` et
  `adjustment.debit` étaient liées à leur opération ; toute autre passait — un portefeuille
  crédité depuis le compte de conservation, des fonds déplacés d'un portefeuille à un autre
  hors des règles des transferts (constaté sur la base d'aperçu au lot 3). La base tient
  désormais la liste des types d'écriture et refuse tout autre (`MGX13`), quels que soient le
  rôle qui écrit et l'auteur que l'écriture désigne. Le même essai, rejoué sur la base
  d'aperçu migrée : refusé, rien n'a bougé.

### Ajouté

- Migration `20261123121500_ledger_entry_kinds` : table `ledger_entry_kinds` (trois types) et
  déclencheur `ledger_entries_kind_known`. Seul le rôle propriétaire ajoute un type, par
  migration ; un type ne se modifie ni ne se retire ; le rôle de l'API ne fait que lire la
  liste.
- `@mgx/contracts` : `LEDGER_ENTRY_KINDS`, la même liste — le type de chaque opération doit y
  figurer, le compilateur le vérifie — ; un test exige que la base et le code s'accordent.
- `MGX13` traduit en `LedgerIntegrityError` : un type inconnu passé par le code est un défaut
  (`500`), et rien n'est écrit.
- Tests : la liste et ses droits ; le refus sous chaque rôle et pour chaque auteur ; les
  trois chemins fermés, soldes inchangés ; un test relit dans la base les règles de fin de
  transaction et exige que chaque type de la liste ait la sienne, et aucun autre.
- ADR 0030. `DATABASE.md` : `ledger_entry_kinds`. `DEPLOYMENT.md` : la requête qui recense
  les écritures d'un autre type, ce que les journaux portent.

### Modifié — à prendre en compte pour l'exploitation

- **Avant de migrer une base qui a déjà servi**, exécuter la requête de `DEPLOYMENT.md`
  (« Grand livre ») : un résultat non vide désigne des écritures faites hors de l'API. La
  migration s'applique dans les deux cas.
- La version précédente de l'API fonctionne sur la base migrée : aucun ordre de mise en
  service particulier, et un retour arrière ne demande rien. Constaté sur la base d'aperçu.
- **Une opération nouvelle apporte son type d'écriture** : dans `LEDGER_ENTRY_KINDS` et, par
  sa migration, dans `ledger_entry_kinds`, avec la règle qui lie l'écriture à l'opération
  (`ARCHITECTURE.md`, « Ajouter un module métier »).
- Tests : chaque fichier qui passe des écritures d'essai (`test.deposit`…) déclare leurs
  types, avec le rôle propriétaire, dans sa base jetable (`registerEntryKindsInSql`).

### Non fait

- **Les écritures déjà passées ne sont pas réexaminées** : une écriture d'un autre type
  antérieure à la migration reste dans le grand livre — la base d'aperçu en porte une.
- **La vérification horaire ne relit pas le type des écritures**, ni leur lien à une
  opération. _Fait au lot 5 (ci-dessus)._
- **Un type ajouté sans sa règle rouvrirait le chemin** : un test le garde pour les types
  présents ; rien dans la base ne l'empêche.
- **Qui détient les identifiants du rôle de l'API peut encore écrire une opération
  entière** — un ajustement et son approbation, au nom de deux membres habilités du
  personnel ; un transfert dans les plafonds. Le propriétaire du schéma, lui, peut tout.

## [Non publié] — Socle : tâches planifiées surveillées, arrêt borné

**Deux corrections du socle** (ADR 0029) — les deux comportements que les essais de panne
des retouches précédentes avaient relevés sans les corriger — **et une troisième**, trouvée
en reprenant l'arrêt. Ni migration, ni dépendance nouvelle, ni route nouvelle : rien ne
change pour un client de l'API.

### Corrigé

- **Un Redis revenu vide ne laisse plus l'API sans relais ni purge.** Les tâches planifiées
  n'existent que dans Redis, et l'API ne les y inscrivait qu'à son démarrage : Redis relancé
  sans ses données, plus aucun événement ne partait — codes de vérification compris —
  jusqu'au redémarrage de l'API, sans qu'aucune sonde ni aucune ligne le dise. Chaque
  instance vérifie désormais toutes les trente secondes que ses tâches planifiées sont dans
  Redis et à l'heure, et réinscrit celle qui ne l'est pas. Essai sur l'API compilée : les
  deux tâches réinscrites 14 à 18 secondes après le retour de Redis, l'événement resté en
  attente parti aussitôt.
- **L'API s'arrête en un temps borné, que Redis réponde ou non.** Tant que Redis était
  injoignable — et quelques secondes encore après son retour d'une longue coupure —, elle
  ne s'arrêtait pas d'elle-même et continuait de répondre ; seul `SIGKILL` y mettait fin.
  Au signal, elle cesse désormais aussitôt d'accepter des connexions, ferme ce qu'elle peut,
  et se termine au plus tard après `SHUTDOWN_TIMEOUT_MS` (huit secondes par défaut).
- **Une requête en cours à l'instant de l'arrêt reçoit sa réponse.** La base était fermée
  avant que le serveur HTTP ait fini de répondre : une requête qui écrivait à cet instant
  échouait (`500`, transaction annulée). La base se ferme désormais à la dernière étape,
  après les requêtes et les tâches de fond en cours.

### Ajouté

- `SHUTDOWN_TIMEOUT_MS` : durée maximale d'un arrêt, en millisecondes — 8 000 par défaut,
  de 1 000 à 120 000.
- **Ligne `Background schedule registered again`** (niveau `error`, contexte
  `JobSchedules`), champs `queue`, `scheduler`, `reason` : `missing` — la tâche n'était plus
  dans Redis, qui a donc perdu des données — ou `late` — elle avait plus d'une minute de
  retard.
- **Lignes de l'arrêt** (contexte `Shutdown`) : `Shutdown requested`, `Shutdown complete`,
  et, au niveau `error`, `Shutdown did not complete in time: exiting`,
  `Shutdown failed: exiting`, `Second shutdown signal: exiting now`.
- `docker-compose.yml` : `stop_grace_period: 10s` pour l'API — le délai par défaut de
  Docker, désormais écrit, parce que celui de l'API doit lui rester inférieur.
- Tests : Redis vidé sous l'application, qui réinscrit ses tâches et relaie de nouveau ; un
  test parcourt Redis et échoue si une tâche planifiée n'est pas surveillée ; l'arrêt sur
  l'application réelle à l'écoute d'un port — connexion refusée dès la demande, requête et
  tâche de fond en cours menées à leur terme, échéance, codes de sortie.
- ADR 0029. `DEPLOYMENT.md` : « Au retour de Redis », « Arrêt de l'API ».

### Modifié — à prendre en compte pour l'exploitation

- **Un arrêt propre se termine par le code 0** ; il se terminait par le signal reçu (143)
  hors conteneur, et déjà par 0 dans un conteneur. **Un code 1 à l'arrêt** signifie une
  fermeture coupée à l'échéance : aucune donnée n'est en jeu.
- **Un signal reçu pendant l'initialisation**, avant que l'API n'écoute, met fin au
  processus sur-le-champ : code 0, une ligne sur la sortie d'erreur. Auparavant, l'arrêt y
  croisait l'initialisation et se terminait le plus souvent par une erreur (code 1).
- **Dès le signal, l'API refuse les connexions nouvelles** : les deux sondes cessent de
  répondre. Retirer l'instance du trafic avant de l'arrêter.
- **Le délai d'arrêt de l'orchestrateur doit dépasser `SHUTDOWN_TIMEOUT_MS`.**
- Un second signal pendant l'arrêt y met fin sur-le-champ.

### Non fait

- **La sonde de disponibilité ne dit rien des tâches planifiées**, contrairement à ce qui
  était proposé : elle retirerait du trafic toutes les instances à la fois, pour un retard
  que l'API répare seule en moins d'une minute (ADR 0029, premier choix à confirmer).
- **Aucun test automatique n'envoie un vrai signal à un vrai processus** : l'arrêt réel est
  éprouvé à la main, sur l'API compilée — y compris en processus 1, sa position dans l'image
  Docker. Sous Docker même, aucune étape ne le vérifie : le journal de l'intégration continue
  n'en donne que la durée, pour l'arrêt sans incident, et pas le code de sortie.
- **Pendant la première seconde après son lancement** — le chargement du programme —, l'API
  n'écoute pas encore ses signaux : dans un conteneur, un arrêt demandé à cet instant est
  ignoré, et l'orchestrateur tue le processus à l'expiration de son délai. Antérieur à ces
  corrections.
- **Pendant une coupure de Redis, une requête ordinaire répond toujours `500`** après une à
  neuf secondes : inchangé.

## [Non publié] — Socle : base saturée, erreurs des files de tâches de fond

**Deux retouches du socle** (ADR 0028), relevées en contrôlant les tests du lot 3 de la
phase 3 : une base saturée répond `503`, avec le délai avant de réessayer, au lieu de `500` ;
ce que les files de tâches de fond signalent passe par les journaux structurés. Ni migration,
ni dépendance nouvelle, ni route nouvelle.

### Modifié — à prendre en compte par un client

- **Base saturée : `503 SERVICE_UNAVAILABLE` et `Retry-After: 5`**, au lieu de
  `500 INTERNAL_ERROR`, lorsque toutes les connexions de l'API à la base sont occupées et
  qu'aucune ne se libère à temps — deux secondes pour une transaction, cinq pour toute autre
  requête. L'opération refusée n'avait pas commencé ; la requête se renvoie telle quelle
  après ce délai, sous la même `Idempotency-Key` si la route en demande une. Toute route qui
  lit ou écrit en base peut répondre ainsi. Une transaction trop longue, une base injoignable
  ou une connexion rompue restent des erreurs `500`.
- Document OpenAPI : la convention est écrite en tête ; la description des réponses `503`
  renvoie à `Retry-After`.

### Ajouté

- **Journaux des files de tâches de fond** (`QueueErrorLog`) : ce que BullMQ signale hors de
  toute requête — connexion à Redis perdue, verrou d'une tâche expiré — est écrit au niveau
  `error` sous `Background queue error`, avec la file (`queue`) et la provenance (`source` :
  `queue` ou `worker`). Jusque-là, BullMQ l'écrivait lui-même sur la sortie d'erreur, sans
  format : 120 erreurs brutes pour 12 secondes sans Redis, contre six lignes désormais.
- **Passages en échec du relais et de la purge** : une ligne `Background job failed`, avec la
  file. Un passage du relais échoué — base injoignable, par exemple — ne laissait aucune
  ligne.
- **Une ligne par période** : une même erreur venue du même objet s'écrit une fois, puis une
  fois toutes les trente secondes tant qu'elle dure, avec `repeated` — le nombre
  d'occurrences passées sous silence. L'échec du traitement d'un événement
  (`Domain event handling failed`) s'écrit toujours à chaque fois.
- Une saturation est journalisée (`Request failed`, niveau `error`) avec le code
  `SERVICE_UNAVAILABLE`, qui la distingue d'une panne.
- Tests : la saturation est provoquée avec un vrai pool de connexions — les erreurs sont
  celles que Prisma et `pg` lèvent réellement — ; un test parcourt l'application et échoue si
  une file ou un exécutant n'est pas écouté.
- ADR 0028. `DEPLOYMENT.md`, « Saturation et pannes » : ce que l'API répond et écrit, relevé
  en arrêtant Redis puis la base sous l'API compilée.

### Constaté, non corrigé ici — corrigé depuis (section précédente)

Relevé par ces essais de panne ; antérieur à ces retouches (`PROJECT_STATUS.md`, « Problèmes
identifiés ») :

- **L'API ne s'arrête pas d'elle-même tant que Redis est injoignable**, ni dans les secondes
  qui suivent son retour d'une longue coupure : seul `SIGKILL` y met fin. Aucune donnée n'est
  en jeu.
- **Un Redis revenu vide n'a plus les tâches planifiées** : plus rien n'est relayé ni purgé
  jusqu'au redémarrage de l'API, alors que `GET /health/ready` répond `200` et qu'aucune
  ligne d'erreur n'est écrite.

## [Non publié] — Phase 3, lot 3 : opérations du personnel

**Crédit et débit manuels d'un portefeuille, sous double validation ; gel d'un
portefeuille** (ADR 0027). C'est la première route de l'API par laquelle des fonds entrent
dans un portefeuille — constatés par deux membres du personnel, **sans rapprochement avec
des fonds réellement détenus** — et le moyen de faire sortir ceux d'un compte suspendu, d'un
portefeuille gelé ou d'un compte à clôturer. Les ajustements sont **fermés par défaut**
(fonctionnalité `manualAdjustments`).

### Ajouté

- **Ajustement manuel d'un portefeuille** : `POST /admin/ledger/adjustments` (`userId`,
  `assetCode`, `direction` — `CREDIT` ou `DEBIT` —, `amount`, `reason`) dépose une demande ;
  **rien ne bouge tant qu'un second membre du personnel ne l'a pas approuvée**
  (`POST /admin/ledger/adjustments/{id}/approve`). L'approbation passe l'écriture au grand
  livre — contrepartie : le compte de conservation de la plateforme — dans la même
  transaction que la décision, sa trace au journal d'audit et l'avis au titulaire. Refus
  motivé (`…/reject`), retrait par l'auteur (`…/cancel`), échéance après 72 heures.
  Consultation : `GET /admin/ledger/adjustments` (filtres `status`, `userId`) et
  `GET /admin/ledger/adjustments/{id}`.
- **Preuve de l'approbateur** : l'approbation exige de nouveau son mot de passe et son second
  facteur (`currentPassword`, `code` ou `recoveryCode`), vérifiés avant tout examen de la
  demande.
- **Quatre yeux** : nul ne prend part à un ajustement de son propre portefeuille ;
  l'approbation et le refus viennent d'un autre que l'auteur de la demande. Une seule demande
  identique — même portefeuille, même sens, même montant — peut être en attente.
- **Gel d'un portefeuille** : `POST /admin/ledger/wallet-freezes` (`userId`, `assetCode`,
  `reason`) arrête tout mouvement sur le portefeuille d'un titulaire dans un actif — ni
  envoi, ni réception —, hors les ajustements. `POST /admin/ledger/wallet-freezes/{id}/lift`
  (`reason`) le lève ; le gel levé reste. Consultation : `GET /admin/ledger/wallet-freezes`
  (filtres `userId`, `status`).
- **Sortie des fonds d'un compte à fermer** : un débit sous double validation passe sur un
  compte suspendu et sur un portefeuille gelé.
- Fonctionnalité `manualAdjustments` (`features.manual_adjustments`), fermée par défaut :
  demander et approuver l'exigent ; consulter, refuser, retirer, geler et lever, non.
- Code d'erreur nouveau : `WALLET_FROZEN` (403) — un transfert depuis un portefeuille gelé.
  Un transfert **vers** un portefeuille gelé répond le refus unique du destinataire
  (`422 RECIPIENT_UNAVAILABLE`).
- Permissions nouvelles : `adjustments.read`, `adjustments.request`, `adjustments.approve`,
  `wallet_freezes.read`, `wallet_freezes.create`, `wallet_freezes.lift` — détenues par
  `super_admin` ; `compliance` reçoit `wallet_freezes.read` et `wallet_freezes.create` : elle
  gèle un portefeuille, sans pouvoir lever un gel.
- **Message** : le titulaire est prévenu par e-mail de tout crédit et de tout débit passé par
  la plateforme, dans sa langue (`wallet_adjusted`) — sans la justification. Un gel et sa
  levée n'envoient aucun message.
- **Règles portées par la base** (erreurs `MGX11`, `MGX12`) : demande déposée par un compte
  actif détenant `adjustments.request`, pour un autre que lui ; décidée une seule fois, par
  un second compte actif détenant `adjustments.approve`, sans que ses termes changent ;
  approuvée seulement si elle n'est pas échue — à l'horloge de la base — et si son auteur est
  toujours habilité ; à la validation de la transaction, un ajustement approuvé a son
  écriture — exactement la sienne — et toute écriture d'ajustement a son ajustement
  approuvé ; gel posé et levé par des comptes habilités, jamais sur son propre portefeuille ;
  le gel attend l'écriture en cours et toute écriture qui le suit le voit ; **aucune ligne
  d'écriture ne passe sur un portefeuille gelé** (`MGX12`), quelle que soit l'opération ; un
  compte au portefeuille gelé ne se clôt pas ; ni demande, ni gel ne s'effacent.
- Tâche horaire : les demandes d'ajustement échues sont closes (`expire-ledger-adjustments`).
- CI : le parcours à travers Nginx ouvre les ajustements, fait créditer un portefeuille par
  deux administrateurs, **mène un transfert à son terme** — renvoyé sous la même clé, il
  n'est pas fait deux fois —, gèle le portefeuille, en sort le solde par un débit, lève le
  gel. Il se règle désormais sur la limite de débit que l'API annonce.
- ADR 0027. Migration `20261114204743_staff_ledger_operations`. Aucune dépendance nouvelle.

### Modifié

- Portefeuilles (`GET /me/wallets`, `GET /me/wallets/{assetCode}/movements`) : chaque
  portefeuille porte **`frozen`**. Un mouvement peut porter `kind: "adjustment.credit"` ou
  `"adjustment.debit"`.
- Copie des données : `formatVersion` passe à `5` — `frozen` sur chaque portefeuille.
- Historique du compte (`GET /me/activity`) : quatre types de plus — `WALLET_CREDITED`,
  `WALLET_DEBITED`, `WALLET_FROZEN`, `WALLET_UNFROZEN`.
- `GET /system/status` : `features.manualAdjustments`.
- `GET /admin/roles` : le catalogue compte vingt-trois permissions ; `compliance` en détient
  sept.
- Clôture d'un compte : un portefeuille gelé la retient (`409`), pour le titulaire comme pour
  le personnel.
- Transferts : un portefeuille gelé s'ajoute aux causes du refus unique du destinataire.
- Le parcours `infrastructure/ci/smoke-identity.sh` ouvre les ajustements, **crédite un
  portefeuille** et laisse le tout ouvert : il reste réservé à une pile de test. Pour la
  double validation, il lui faut un second administrateur (`SECOND_ADMIN_EMAIL`,
  `SECOND_ADMIN_PASSWORD`) ; sous GitHub Actions, il le crée lui-même, et échoue s'il n'en
  a pas — ailleurs, il saute la double validation et le dit. Il inscrit désormais
  **deux comptes par exécution** — le second reçoit le transfert —, soit trois requêtes
  d'inscription avec celle qui doit être refusée : sur une pile conservée, la route en
  admettant dix par heure et par adresse, refusées ou non, il ne se rejoue que trois fois
  par heure.

### Corrigé — outillage de test

- Deux tests ne pouvaient pas signaler un blocage. L'un (lecture du corps d'une requête)
  bornait son attente à huit secondes, au-delà des cinq accordées à un test unitaire ;
  l'autre (verrous pris à la clôture d'un compte) ne la bornait pas. Devant un serveur qui ne
  répond plus, ou une écriture qui attend un verrou, ils n'échouaient que par le délai du
  test, sans rien en dire. Ils échouent désormais en trois secondes, sur une vérification.
- Un test des nouvelles tentatives d'une transaction exigeait qu'une seule suffise. Il en
  faut parfois deux, selon le temps que met le disque à valider la transaction concurrente :
  le test a échoué une fois dans la CI, et ne le pouvait pas sur un PostgreSQL réglé pour ne
  pas attendre le disque. Il vérifie désormais ce qui est garanti : une à trois nouvelles
  tentatives, dont seule la dernière voit l'écriture de l'autre transaction.

Aucun code de l'API n'est modifié par ces corrections.

### Non réalisé

- **Rapprochement** d'un ajustement avec des fonds réellement détenus ; plafond par
  ajustement ; pièce justificative jointe (la justification est un texte).
- **La base ne ferme pas la liste des types d'écriture** : elle exige d'une écriture
  `adjustment.credit` ou `adjustment.debit` qu'elle ait son ajustement approuvé, mais accepte
  une écriture équilibrée d'un autre type. La double validation est la seule route de l'API
  qui apporte des fonds ; elle ne protège pas d'un accès en écriture à la base sous le rôle
  de l'API (voir `docs/SECURITY.md`, « Opérations du personnel »). _Fermé depuis par le
  lot 4, ci-dessus._
- **Fonds réservés** — toujours reportés à la première opération en plusieurs temps.
- Pas de double validation de la levée d'un gel ; pas de gel de tout un compte en une fois ;
  pas de gel que le titulaire ne verrait pas ; le support ne consulte pas les gels.
- Ni dépôt, ni retrait par un titulaire ; ni frais.

## [Non publié] — Phase 3, lot 2 : transferts entre titulaires

**Première opération qui déplace des fonds** — entre deux titulaires, à l'intérieur de la
plateforme (ADR 0026). **Fermée par défaut**, et **aucun plafond n'est livré avec le code** :
leurs valeurs restent à décider. **Aucune route ne crédite un portefeuille** : tant que les
dépôts n'existent pas, il n'y a rien à transférer. Les **fonds réservés**, annoncés pour ce
lot, n'y sont pas : un transfert immédiat n'en a pas l'usage, ils viendront avec la première
opération en plusieurs temps.

### Ajouté

- **Transfert entre deux titulaires** : `POST /me/transfers` (`recipientEmail`, `assetCode`,
  `amount`, `currentPassword`, `code` ou `recoveryCode`). Immédiat, définitif, sans frais :
  une écriture du grand livre débite le portefeuille de l'émetteur et crédite celui du
  destinataire, dans la même transaction que le transfert, son inscription au journal
  d'audit et les messages aux deux parties.
- **Clé d'idempotence fournie par le client** : en-tête `Idempotency-Key`, obligatoire (16 à
  128 caractères). La même requête renvoyée sous la même clé ne transfère rien de plus : la
  réponse est celle d'origine, avec l'en-tête `Idempotent-Replayed: true`. Une autre requête
  sous la même clé répond `422 IDEMPOTENCY_KEY_REUSED`. Une requête refusée ne retient pas sa
  clé.
- **Preuve du titulaire à chaque transfert** : le mot de passe et, si la validation en deux
  étapes est activée, un code — vérifiés avant tout examen de la requête.
- **Plafonds par actif et par niveau de vérification** (0 à 3) : par transfert, sur 24 heures
  glissantes, sur 31 jours glissants ; seuls comptent les envois. Un niveau sans plafonds
  dans un actif n'y envoie ni n'y reçoit rien. **Ce sont des données du back-office** :
  `GET /admin/transfer-limits`, `PUT /admin/transfer-limits/{assetCode}/{level}` (trois
  montants, une justification ; effet immédiat ; des plafonds se remplacent, ils ne se
  suppriment pas).
- **Ce que je peux envoyer** : `GET /me/transfer-limits` — niveau du compte, plafonds, envois
  des 24 dernières heures et des 31 derniers jours, montant encore admis, actif par actif.
- **Mes transferts** : `GET /me/transfers` (envoyés et reçus, paginés) et
  `GET /me/transfers/{transferId}`. Chaque partie voit l'adresse e-mail que porte aujourd'hui
  le compte de l'autre — `null` s'il a été clôturé —, rien d'autre.
- **Destinataire désigné par son adresse e-mail ; un seul refus**, quelle qu'en soit la
  cause — adresse inconnue, compte suspendu, clôturé, pas encore vérifié, niveau fermé :
  `422 RECIPIENT_UNAVAILABLE`, prononcé en dernier. Le dixième en 24 heures suspend les
  transferts du compte pendant 24 heures.
- Codes d'erreur nouveaux : `TRANSFER_NOT_PERMITTED` (403), `IDEMPOTENCY_KEY_REUSED`,
  `INSUFFICIENT_FUNDS`, `TRANSFER_LIMIT_EXCEEDED`, `RECIPIENT_UNAVAILABLE` (422).
- **Messages** : l'émetteur et le destinataire sont prévenus par e-mail, chacun dans sa
  langue (`transfer_sent`, `transfer_received`).
- **Bornes** : 60 demandes de transfert par minute et par adresse IP ; 30 transferts tentés
  par heure et par compte.
- Permissions nouvelles `transfer_limits.read` et `transfer_limits.write`, détenues par
  `super_admin` seul.
- **Règles portées par la base** (erreur `MGX10`) : plafonds positifs et croissants, fixés
  par un compte actif détenant `transfer_limits.write` ou par le rôle propriétaire, jamais
  supprimés ; transfert entre deux comptes actifs et distincts ; niveau de vérification de
  l'émetteur recalculé par la base ; niveau ouvert, plafonds respectés — cumuls recomptés par
  la base, à son horloge, sous le verrou de l'émetteur ; niveau du destinataire ouvert ; à la
  validation de la transaction, un transfert a son écriture — exactement la sienne — et
  toute écriture de transfert a son transfert ; transferts immuables.
- CI : le parcours à travers Nginx ouvre les transferts, constate que rien ne part sans
  plafonds, les fixe, les relit côté titulaire, et vérifie chaque refus — sans clé
  d'idempotence, sans le bon mot de passe, sans plafonds, au-delà du plafond, au-delà du
  solde, montant trop précis. Aucun transfert n'y aboutit : aucune route ne crédite un
  portefeuille.
- ADR 0026. Migration `20261114082147_internal_transfers`. Aucune dépendance nouvelle.

### Modifié

- Copie des données : `formatVersion` passe à `4` — `transfers` ajouté (transferts envoyés
  et reçus, les 2 000 plus récents).
- Historique du compte (`GET /me/activity`) : trois types de plus — `TRANSFER_SENT`,
  `TRANSFER_FAILED` (preuve du titulaire refusée), `TRANSFER_REFUSED`.
- `GET /admin/roles` : le catalogue compte dix-sept permissions.
- CORS : `Idempotency-Key` s'ajoute aux en-têtes qu'une page peut envoyer,
  `Idempotent-Replayed` à ceux qu'elle peut lire.
- Portefeuilles : un mouvement peut désormais porter `kind: "transfer.internal"`.
- Le parcours `infrastructure/ci/smoke-identity.sh` ouvre les transferts et **les laisse
  ouverts** : il reste réservé à une pile de test.

### Non réalisé

- **Fonds réservés** — reportés à la première opération en plusieurs temps.
- **Valeurs des plafonds** : aucune n'est fournie ; à arrêter par le propriétaire, avec la
  conformité.
- Ni dépôt, ni retrait, ni frais ; pas d'annulation d'un transfert, pas de délai de
  rétractation, pas de bénéficiaires enregistrés, pas de message joint à un transfert.
- Pas de double validation d'un changement de plafonds ; pas de plafond en réception, ni
  tous actifs confondus ; pas de surveillance des transactions ni de filtrage.
- Pas de crédit ni de débit manuel par le back-office ; pas de gel d'un portefeuille.

## [Non publié] — Phase 3, lot 1 : grand livre en partie double

**Aucune route ne déplace de fonds.** Ce lot livre l'endroit où les opérations écriront, et
les règles qu'elles ne pourront pas enfreindre (ADR 0025). Les plafonds par niveau de
vérification, le statut réglementaire et la liste des actifs à tenir restent à décider.

### Ajouté

- **Grand livre en partie double** : toute variation d'un solde est une écriture d'au moins
  deux lignes, dont les débits égalent les crédits, actif par actif. Une écriture ne se
  modifie ni ne s'efface ; chaque ligne garde son rang sur son compte et le solde qui en
  résulte. Aucun compte ne devient négatif.
- **Plan de comptes** : `user_available` (fonds dont un titulaire dispose),
  `platform_custody` (fonds conservés pour les titulaires hors du grand livre),
  `platform_fees` (frais gagnés). Il s'étendra avec les opérations.
- **Actifs enregistrés par le back-office** : `POST /admin/ledger/assets` (code, libellé,
  nature, nombre de décimales — 0 à 18 ; **définitif**) et `GET /admin/ledger/assets`.
  Aucun actif n'est créé par migration.
- **Portefeuilles du titulaire, en lecture** : `GET /me/wallets` — un portefeuille par actif
  tenu, à zéro tant que rien n'y est passé — et `GET /me/wallets/{assetCode}/movements`, du
  plus récent au plus ancien, paginés.
- **Consultation par le back-office** : `GET /admin/ledger/accounts`,
  `GET /admin/ledger/accounts/{accountId}/postings`, `GET /admin/ledger/entries/{entryId}`,
  `GET /admin/ledger/trial-balance` (balance par actif et par type de compte). Chaque
  consultation est inscrite au journal d'audit.
- Permissions nouvelles `ledger.read` et `ledger.manage_assets`, détenues par `super_admin`
  seul.
- **`LedgerService`**, seul chemin du code vers un solde : `post` (dans sa propre
  transaction) et `postWithin` (dans celle de l'opération). Écritures **idempotentes** par
  leur clé ; comptes verrouillés dans un ordre unique — les titulaires, puis les comptes ;
  fonds insuffisants et titulaire clôturé refusés sans rien écrire.
- **Règles portées par la base** (erreurs `MGX08` et `MGX09`) : écriture entière et
  équilibrée à la validation de la transaction ; ligne dans l'actif de son compte ; rang et
  solde calculés par la base, sous le verrou du compte ; solde jamais négatif ; solde d'un
  compte égal à celui de sa dernière ligne ; actifs, plan de comptes, écritures et lignes
  immuables ; comptes jamais supprimés ; seul enregistre un actif un compte actif détenant
  `ledger.manage_assets`, ou le rôle propriétaire ; dates lues à l'horloge de la base.
- **Nouvelle tentative sur conflit** : `UnitOfWork.run(work, { retry })` relance entière une
  transaction que PostgreSQL a annulée parce qu'elle en croisait une autre (interblocage,
  conflit de sérialisation) — trois nouvelles tentatives au plus, espacées au hasard.
- **Vérification périodique** : l'étape `verify-ledger` de la tâche horaire relit tout le
  grand livre ; une anomalie est journalisée et inscrite au journal d'audit
  (`ledger.verification_failed`). Rien n'est corrigé automatiquement.
- **Clôture et grand livre** : un compte qui détient des fonds ne se clôt pas ; les écritures
  ne s'effacent jamais ; dès qu'une écriture a été passée sur un compte du titulaire, la
  trace de sa clôture garde son adresse et son numéro dix ans.
- CI : le parcours à travers Nginx enregistre un actif, lit le portefeuille à zéro d'un
  titulaire et la balance du grand livre.
- ADR 0025. Migration `20261113160828_ledger`. Aucune dépendance nouvelle.

### Modifié

- **Une requête annulée parce qu'elle en croisait une autre répond `409 CONFLICT`**
  (« The request conflicted with another one. Please try again. ») et non plus `500` : rien
  n'a été écrit, elle est à refaire.
- Copie des données : `formatVersion` passe à `3` — `wallets` ajouté (portefeuilles qui ont
  servi et leurs mouvements, 2 000 au plus par portefeuille).
- Clôture d'un compte : `409 CONFLICT` si l'un de ses portefeuilles détient encore des fonds
  (motif `FUNDS_REMAINING`) ; `legalRetentionUntil` vaut aussi dix ans après la clôture
  lorsqu'une écriture a été passée sur un de ses comptes.
- Les routes des portefeuilles peuvent répondre `403 TERMS_ACCEPTANCE_REQUIRED` : elles sont
  fermées au compte qui doit accepter les conditions d'utilisation.
- `GET /admin/roles` : le catalogue compte quinze permissions.
- Tâche horaire : une étape de plus, `verify-ledger`.

### Non réalisé

- **Aucune opération** : ni dépôt, ni retrait, ni transfert, ni frais. Les soldes valent
  zéro. Pas d'en-tête `Idempotency-Key`, pas de fonds réservés, pas de plafonds : ils
  viendront avec la première opération.
- Pas d'écriture manuelle ni de correction par le back-office ; pas de rapprochement avec
  les fonds réellement détenus ; pas d'alerte branchée sur une anomalie.

## [Non publié] — Phase 2, lot 5 : conditions d'utilisation versionnées

Le texte des conditions n'est pas fourni par ce lot, et la règle — faut-il accepter de nouveau
à chaque changement ? — n'y est pas tranchée : le texte se publie comme une donnée, et la
règle se choisit à chaque publication (ADR 0024).

### Ajouté

- **Versions publiées** : chaque version des conditions porte un numéro (1, 2, 3…), un texte
  en français — il fait foi — et, facultativement, sa traduction anglaise, un résumé de ce
  qui change, et sa règle `requiresAcceptance` : à accepter par chaque compte, ou seulement
  signalée. La version en vigueur est la plus récente. **Une version publiée ne change plus
  et ne se retire pas.**
- **Lecture publique** : `GET /terms/current`, `GET /terms/versions`,
  `GET /terms/versions/{number}` (`?locale=fr|en` ; le français est servi si la traduction
  manque). Le texte est rendu à l'octet près, avec son empreinte SHA-256.
- **Acceptation** : `GET /me/terms` dit où en est le compte ; `POST /me/terms/acceptance`
  accepte la version en vigueur — et elle seule (`409 TERMS_VERSION_NOT_CURRENT` sinon).
  L'acceptation est datée par la base, inscrite à l'historique et au journal d'audit avec
  l'empreinte du texte.
- **Accès conditionné, refus par défaut** : tant qu'un compte doit accepter, ses routes
  répondent `403 TERMS_ACCEPTANCE_REQUIRED`, sauf celles qui déclarent rester ouvertes
  (`@AllowBeforeTermsAcceptance()`) : voir son compte, accepter, se déconnecter, mot de passe,
  sessions, validation en deux étapes, historique, **copie des données et clôture**. Le
  back-office n'est pas concerné. Une route ajoutée plus tard est fermée d'office.
- **Publication par le back-office** : `POST /admin/terms/versions` (définitif ; le numéro
  publié est désigné par la requête, une publication ne se rejoue pas) et
  `GET /admin/terms/versions` (auteur, règle, empreintes, nombre d'acceptations). Permission
  nouvelle `terms.publish`, détenue par `super_admin` seul.
- **Publication en ligne de commande** : `pnpm terms:publish`, à partir de fichiers, avec le
  rôle propriétaire de la base — pour installer la première version avant l'ouverture.
- **Règles portées par la base** (erreurs `MGX06` et `MGX07`) : numérotation sans trou ni
  doublon, publications sérialisées ; versions immuables ; empreinte recalculée et comparée ;
  seul publie un compte actif détenant `terms.publish`, ou le rôle propriétaire ; on n'accepte
  que la version en vigueur ; une acceptation ne se modifie pas et ne s'efface qu'avec le
  compte ; un compte ne se clôt pas en gardant une acceptation ; dates lues à l'horloge de la
  base.
- **Corps JSON volumineux lu après les gardes** : la publication admet un mébioctet ; son
  corps n'est lu qu'après l'authentification et le contrôle des droits
  (`common/http/deferred-json-body.ts`). La limite commune (100 Ko) vaut toujours ailleurs.
- Reverse proxy : limite propre à la route de publication (1 100 Ko), corps transmis au fil
  de l'eau.
- CI : le parcours à travers Nginx publie un texte de 185 Ko et le relit à l'octet près,
  vérifie les refus au-delà des limites, l'inscription liée à la version en vigueur, puis une
  nouvelle version à accepter : compte arrêté, acceptation, reprise.
- `infrastructure/ci/publish-terms-cli.sh` : publie une version avec l'outil en ligne de
  commande dans la pile Compose, telle que `DEPLOYMENT.md` la donne — fichier monté en
  lecture seule, numéro inexact refusé, texte servi par Nginx comparé au fichier. **Le
  workflow ne l'appelle pas encore** : l'étape à y ajouter figure dans `DEPLOYMENT.md`.
- ADR 0024. Migration `20261113043000_terms_of_use`. Aucune dépendance nouvelle.

### Modifié — incompatible avec un client des lots précédents

- **Inscription** : `acceptedTermsVersion` (numéro de la version lue) remplace
  `acceptTerms: true`. `409 TERMS_VERSION_NOT_CURRENT` si ce n'est pas la version en vigueur ;
  **`503 SERVICE_UNAVAILABLE` tant qu'aucune version n'est publiée**. Ces réponses sont les
  mêmes que l'adresse soit libre ou déjà prise — y compris quand une version est publiée
  pendant la demande.
- **Comptes existants** : aucun n'a accepté de version. Dès la publication de la version 1,
  chacun doit l'accepter avant de continuer — personnel compris, hors back-office.
- Les routes du profil, du téléphone et de la vérification d'identité peuvent répondre
  `403 TERMS_ACCEPTANCE_REQUIRED`.
- `GET /me` et la réponse de connexion portent `termsAcceptanceRequired`.
- Copie des données : `formatVersion` passe à `2` — `terms.acceptances` ajouté,
  `account.termsAcceptedAt` retiré.
- Fiche d'un compte au back-office : `terms` (`accepted`, `acceptanceRequired`) remplace
  `termsAcceptedAt`.
- Historique : type nouveau `TERMS_ACCEPTED`. Codes d'erreur nouveaux :
  `TERMS_ACCEPTANCE_REQUIRED` (403), `TERMS_VERSION_NOT_CURRENT` (409).
- `GET /admin/roles` : le catalogue compte treize permissions.
- Base : la colonne `users.terms_accepted_at` est **renommée** `registered_at` (elle ne datait
  que la demande d'inscription). **Cette migration n'est pas compatible avec la version
  précédente de l'API : l'arrêter avant de migrer** (`DEPLOYMENT.md`).

### Non réalisé

- Aucun e-mail n'annonce une nouvelle version : le titulaire l'apprend à sa prochaine
  connexion. Ni brouillon, ni date d'effet différée, ni double validation d'une publication.

## [Non publié] — Intégration continue activée

### Modifié

- Le workflow de CI a quitté `infrastructure/ci/ci.yml` pour `.github/workflows/ci.yml` : il
  s'exécute désormais sur chaque demande de fusion et sur `main`. Sa première exécution
  (2026-11-13) est passée au vert sans correction — premières exécutions réelles de la
  construction des images, de la pile Docker Compose, du parcours à travers le conteneur
  Nginx et du moteur de migration natif de Prisma. Les scripts qu'il appelle restent dans
  `infrastructure/ci/`.

## [Non publié] — Phase 2, lot 4 : clôture de compte, conservation légale, effacement, copie des données

### Ajouté

- **Clôture par le titulaire** : `POST /me/close`. Immédiate et définitive ; elle exige de
  nouveau le mot de passe et, s'il est activé, le second facteur, plus `confirm: true`.
  Sessions, mot de passe, second facteur, codes et profil sont supprimés dans la même
  transaction ; l'adresse, le numéro et la pièce d'identité sont libres aussitôt.
- **Clôture par le personnel** : `POST /admin/users/{userId}/close`, permission nouvelle
  `users.close` (rôles `super_admin` et `compliance`) ; motif (`HOLDER_REQUEST` ou
  `PLATFORM_DECISION`), justification et `confirm: true` obligatoires ; titulaire toujours
  prévenu, jamais de la raison.
- **Copie des données** : `POST /me/data-export` remet, en un document JSON versionné, ce que
  la plateforme détient sur le compte — sans secret, sans fichier, numéro de pièce masqué.
  Même preuve que la clôture ; trois copies au plus par vingt-quatre heures ; chaque copie est
  inscrite à l'historique et signalée par e-mail.
- **Conservation légale** : les dossiers de vérification sur lesquels une décision a été prise
  sont conservés dix ans après la clôture ; un dossier jamais examiné est effacé à la clôture,
  avec ses fichiers.
- **Effacement à l'échéance** : la purge horaire efface les dossiers conservés et leurs
  fichiers, puis l'adresse et le numéro que gardait la trace de la clôture — trente jours
  après la clôture, ou au terme des dix ans. Elle supprime aussi désormais les événements
  publiés de la boîte d'envoi après trente jours.
- **Règles portées par la base** (erreurs `MGX04` et `MGX05`) : un compte ne se clôt qu'avec
  sa trace et vidé de ses secrets ; rien ne s'écrit plus sur un compte clôturé, y compris par
  une requête partie avant la clôture ; une clôture par le personnel vient d'un compte actif
  détenant `users.close` ; rien de ce que la loi impose de conserver ne s'efface avant le
  terme, lu à l'horloge de la base.
- Back-office : la fiche d'un compte clôturé porte `closure` ; une recherche par adresse ou
  par numéro retrouve aussi les comptes clôturés qui les portaient, jusqu'à leur effacement.
- E-mails : avis de clôture (envoyé à l'ancienne adresse) et avis de copie des données.
- CI : le parcours à travers Nginx (`infrastructure/ci/smoke-identity.sh`) va jusqu'à la
  copie des données et à la clôture — connexion refusée ensuite, avis reçu à l'ancienne
  adresse, dossier conservé, compte retrouvé par le back-office ; une étape vérifie que le
  proxy n'a copié aucune réponse sur son disque.
- ADR 0023. Migrations `20261112182333_kyc_case_account_closed_status` et
  `20261112182356_account_closure`. Aucune dépendance nouvelle.

### Modifié — à prendre en compte par un client du lot 3

- Un compte clôturé **n'existe plus pour la connexion** : son ancienne adresse reçoit
  `401 INVALID_CREDENTIALS`, comme une adresse inconnue. `403 ACCOUNT_DISABLED` ne désigne
  plus qu'un compte suspendu.
- Toute requête qui écrit sur un compte clôturé entre-temps répond `409 CONFLICT`
  (« This account is closed. »).
- L'inscription refuse le domaine réservé `closed.invalid` (`400 VALIDATION_FAILED`).
- Historique : trois types nouveaux — `DATA_EXPORTED`, `DATA_EXPORT_FAILED`,
  `ACCOUNT_CLOSURE_FAILED`.
- Dossiers de vérification : statut nouveau `ACCOUNT_CLOSED` (accepté jusqu'à la clôture du
  compte), visible du back-office (`GET /admin/kyc/cases?status=ACCOUNT_CLOSED`).
- `GET /admin/roles` : le catalogue compte douze permissions ; `compliance` détient
  `users.close`.
- La fiche d'un compte au back-office porte `closure` (`null` tant qu'il est ouvert) ; les
  actions du back-office sur un compte clôturé répondent `409 CONFLICT`.

### Corrigé

- **Reverse proxy : une pièce téléchargée par un examinateur passait, en clair, par un
  fichier temporaire de Nginx** (défaut du lot 3). Une réponse plus grande que les tampons du
  proxy était copiée sur son disque le temps d'être relayée, puis supprimée. Plus aucune
  réponse de l'API n'y est écrite (`proxy_max_temp_file_size 0`) ; un test lit la
  configuration, et le parcours de la pile complète échoue si Nginx signale un tel fichier.
- **Requêtes simultanées à la clôture** — trois défauts de ce lot, trouvés en envoyant des
  requêtes concurrentes à l'API après sa première publication sur la branche :
  - un changement de mot de passe qui croisait la clôture répondait `500` ; il répond `409`,
    comme toute écriture arrivée après la clôture (de même une connexion, à l'instant où
    l'empreinte de son mot de passe est recalculée) ;
  - une demande de réinitialisation du mot de passe qui croisait la clôture répondait `409`
    « compte clôturé » au lieu de sa réponse unique `202` : pendant un instant, elle disait
    qu'un compte portait cette adresse ;
  - la clôture pouvait s'interbloquer avec une autre écriture du même compte ; PostgreSQL
    interrompait alors l'une des deux requêtes (`500`). La clôture cède maintenant le passage
    et recommence ; si le compte reste occupé, elle répond `409` et rien n'a changé.

### Corrigé — outillage de test

- Les tests d'intégration et de bout en bout s'exécutaient avec le délai par défaut de Jest
  (5 secondes) et non celui prévu (30) : le réglage par projet n'était pas pris en compte.
- Un test de bout en bout pouvait démarrer une seconde application avant d'avoir arrêté la
  première : les deux se disputaient les files Redis, d'où un échec intermittent d'un test
  d'envoi d'e-mail. Le support de test le refuse désormais.
- Quatre tests des lots 1 et 2 attendaient que les événements soient remis à la file, non
  qu'ils soient traités : l'un échouait par intermittence sous charge, et trois autres
  pouvaient conclure « aucun message n'est parti » avant que le traitement soit terminé. Ils
  attendent désormais la fin du traitement.

## [Non publié] — Phase 2, lot 3 : vérification d'identité (KYC) des particuliers

### Ajouté

- **Vérification d'identité en trois niveaux**, obtenus dans l'ordre : identité (pièce et
  autoportrait), adresse (justificatif de domicile), origine des fonds. Pour chaque niveau, le
  titulaire prépare un dossier, y joint ses pièces et le dépose : `GET /me/verification`,
  `PUT /me/verification/{identity,address,source-of-funds}`, `…/cases/{id}`,
  `…/cases/{id}/documents`, `…/cases/{id}/submit`. Fonctionnalité `kyc`, fermée par défaut.
- **Envoi des pièces** : le fichier est le corps de la requête (JPEG, PNG ou PDF, de 1 Ko à
  5 Mio), contrôlé sur son contenu. Réception bornée en taille, en durée et en nombre, après
  tous les contrôles qui peuvent refuser l'envoi.
- **Pièces chiffrées au repos** (AES-256-GCM, une clé par fichier, clé maîtresse
  `KYC_ENCRYPTION_KEY`), écrites hors de la base dans `KYC_STORAGE_DIR` ; numéro de la pièce
  d'identité chiffré en base, rendu masqué au titulaire. Sans ces deux variables, la
  vérification répond `503`.
- **Examen par la conformité** : file des dossiers déposés, fiche, téléchargement d'une pièce,
  acceptation, refus motivé, retrait d'une vérification (`/admin/kyc/cases/…`). Permissions
  `kyc.read`, `kyc.review`, `kyc.revoke` ; rôle système `compliance`. Chaque consultation est
  journalisée ; nul n'examine son propre dossier. La fiche signale un même fichier ou une même
  pièce d'identité présentés par d'autres comptes.
- **Règles portées par la base** (erreur `MGX03`) : un dossier déposé ne se modifie plus ; une
  décision ne vient que d'un compte actif habilité, jamais du titulaire ; les niveaux se
  suivent ; une même pièce d'identité ne vérifie qu'un seul compte.
- Le titulaire est prévenu par e-mail de chaque décision, et la retrouve dans son historique
  (`IDENTITY_VERIFICATION_SUBMITTED`, `…_APPROVED`, `…_REJECTED`, `…_REVOKED`).
- Purge horaire des dossiers restés en préparation trente jours, avec leurs pièces.
- Nginx : route d'envoi dédiée (6 Mio, transmission au fil de l'eau sans copie sur disque,
  quatre envois simultanés par adresse). Compose et image : volume `kyc-documents`.
- ADR 0022. Migration `20261112102342_kyc`. Aucune dépendance nouvelle.

### Modifié — à prendre en compte par un client du lot 2

- `GET /me` porte `verificationLevel` (0 à 3).
- Le profil porte `placeOfBirth`, `nationality`, `identityVerified`, `addressVerified`. Une
  fois l'identité ou l'adresse vérifiées, les champs correspondants sont ceux du dossier
  accepté, et **`PATCH /me/profile` répond `409 CONFLICT`** si l'on tente de les modifier.
- La fiche d'un compte au back-office porte `verification` ; son profil est le profil vérifié
  lorsqu'il existe.
- Historique : les actions d'un membre du personnel sur le compte d'un client figurent dans
  l'historique de ce client, **plus dans celui du membre du personnel**.
- `GET /admin/roles` liste un troisième rôle système, `compliance` ; le catalogue compte onze
  permissions.
- Les journaux expurgent aussi les clés nommées `encryptionKey`, `masterKey` et
  `documentNumber`.

## [Non publié] — Phase 2 : envoi réel des e-mails

### Ajouté

- **Envoi des e-mails par SMTP** : le prestataire se choisit au déploiement (`SMTP_HOST`,
  `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, et au besoin `SMTP_SECURITY`, `SMTP_PORT`).
  Définir `SMTP_HOST` active l'envoi ; `NOTIFICATION_DELIVERY` accepte désormais `smtp`.
- Connexion chiffrée et certificat vérifié, obligatoires en pré-production et en production ;
  vérification du serveur et des identifiants au démarrage, sans bloquer celui-ci.
- Une boîte inexistante (refus définitif du destinataire) n'est pas relancée.
- ADR 0021. Dépendance : `nodemailer`.

### Modifié

- Avec un serveur SMTP configuré, l'inscription, le renvoi du code et le mot de passe oublié
  ne répondent plus `503` en pré-production et en production ; la boîte de réception de
  développement n'existe plus dès que les e-mails partent réellement.
- Les SMS restent indisponibles : la vérification du numéro de téléphone répond toujours
  `503` hors développement.

## [Non publié] — Phase 2, lot 2 : sécurité du compte, profil, back-office des comptes

### Ajouté

- **Validation en deux étapes** (TOTP, RFC 6238) : activation, confirmation, désactivation ;
  dix codes de secours à usage unique ; secret chiffré au repos (AES-256-GCM) ; un code n'est
  accepté qu'une fois. La connexion se fait alors en deux temps (`POST /auth/mfa/verify`) ;
  aucune session n'existe entre les deux.
- **Essais bornés par compte** sur la seconde étape (5 en 15 minutes, 20 en 24 heures), et
  message au titulaire en cas de blocage.
- **Profil** (`/me/profile`) : identité déclarée, adresse, langue ; les champs laissés vides
  le restent, rien n'est vérifié à ce stade.
- **Vérification du numéro de téléphone** par code SMS (`/me/phone/verification`,
  `/me/phone/verify`) ; un numéro vérifié n'appartient qu'à un compte.
- **Historique d'activité** (`/me/activity`) : événements de sécurité du compte, interventions
  du support comprises.
- **Connexion depuis un appareil inconnu** signalée au titulaire par e-mail (`deviceId`
  facultatif à la connexion).
- **Back-office des comptes** : liste, recherche par identifiant complet
  (`POST /admin/users/search`), fiche, suspension et réactivation, fermeture des sessions,
  retrait du second facteur. Chaque action porte une justification ; chaque accès est inscrit
  au journal d'audit.
- **Rôles sous double validation** (`/admin/role-changes`) : demande, puis approbation par un
  second administrateur. La règle est appliquée par un déclencheur PostgreSQL ; le rôle
  applicatif de la base n'écrit toujours pas lui-même dans la table des rôles attribués.
  Rôle système `support`.
- **Purge horaire** des données expirées (inscriptions jamais vérifiées, sessions closes,
  codes échus, activations de second facteur abandonnées, demandes de rôle échues).
- Migrations `account_security` et `back_office_accounts`.
- Permissions : `users.read`, `users.suspend`, `users.revoke_sessions`, `users.reset_mfa`,
  `roles.read`, `roles.manage`. Code d'erreur : `MFA_ENROLLMENT_REQUIRED`.
- Variable **obligatoire** `AUTH_SECRETS_ENCRYPTION_KEY` (32 octets en base64) — à
  sauvegarder hors de la base : la perdre rend tous les seconds facteurs invérifiables.
- Tests : 762 au total, dont 292 sur PostgreSQL, Redis et BullMQ réels.
- ADR 0017 à 0020.

### Modifié — ruptures pour un client du lot 1

- `POST /auth/login` répond par un objet à `status` : `AUTHENTICATED` (avec les jetons) ou
  `MFA_REQUIRED` (avec un jeton de connexion en attente).
- `POST /auth/email/verify` exige le mot de passe choisi à l'inscription, en plus du code.
- Une nouvelle inscription sur une adresse jamais vérifiée **remplace** la précédente.
- Le mot de passe oublié ne s'applique qu'à un compte actif : une inscription jamais vérifiée
  ne se réinitialise pas.
- **Toute route `/admin` exige la validation en deux étapes** (`403 MFA_ENROLLMENT_REQUIRED`
  sinon), y compris pour un administrateur créé en ligne de commande.

### Corrigé

- Un tiers pouvait créer un compte à l'adresse d'une personne, avec son propre mot de passe,
  et attendre qu'elle l'active elle-même (défaut du lot 1, trouvé à la relecture) : voir les
  ruptures ci-dessus sur la vérification de l'adresse, la réinscription et le mot de passe oublié.

## [Non publié] — Phase 2, lot 1 : comptes, authentification, sessions, autorisations

### Ajouté

- Inscription de comptes individuels avec vérification de l'adresse e-mail par code à usage
  unique ; aucune réponse ne révèle l'existence d'un compte.
- Connexion avec blocage temporaire après échecs répétés ; sessions par jetons opaques,
  renouvellement avec détection de réutilisation, expiration par inactivité et absolue.
- Gestion de ses sessions (liste, fermeture, déconnexion) ; mot de passe oublié,
  réinitialisation et changement ; hachage Argon2id natif, règles de choix NIST.
- Authentification exigée par défaut sur toutes les routes ; rôles et permissions du
  back-office ; administration des paramètres de la plateforme (`/api/v1/admin/system-settings`).
- Outil en ligne de commande `admin:create` : premier compte d'administration, créé hors de l'API.
- Module de notifications : port d'envoi, modèles en français et en anglais, boîte de
  réception de développement (`/api/v1/dev/mailbox`).
- Migration `identity_foundations` : comptes, secrets, rôles, permissions, codes, sessions,
  avec leurs contraintes ; tables de droits en lecture seule pour le rôle applicatif.
- Codes d'erreur : `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_DISABLED`,
  `INVALID_OR_EXPIRED_CODE`, `COUNTRY_NOT_SUPPORTED`.
- Variables : `AUTH_CODE_HMAC_SECRET` (obligatoire), `AUTH_*`, `NOTIFICATION_DELIVERY`.
- CI : parcours d'identité de bout en bout à travers Nginx (`infrastructure/ci/smoke-identity.sh`).
- Tests : 492 au total, dont 165 sur PostgreSQL, Redis et BullMQ réels.
- ADR 0013 à 0016.

### Modifié

- Document OpenAPI : schéma d'erreur partagé (`ProblemDetails`), authentification par jeton.
- Les réponses `401` portent l'en-tête `WWW-Authenticate: Bearer`.

## Phase 1 : analyse et fondations

### Ajouté

- Monorepo pnpm (`apps/api`, `packages/{shared,validation,contracts,config}`), versions
  épinglées par catalogue, délai minimal de 3 jours avant adoption d'une publication,
  scripts d'installation refusés par défaut.
- Outillage : TypeScript 6 strict (ESM), ESLint 10 avec analyse de types, règles
  d'architecture et interdiction des calculs monétaires en virgule flottante, Prettier, Jest 30.
- `@mgx/shared` : montants exacts (`Money`, `bigint`), analyse et formatage décimaux, sept
  modes d'arrondi explicites, points de base, répartition sans perte.
- `@mgx/validation`, `@mgx/contracts` : schémas Zod partagés (montants sur le fil, erreurs
  RFC 9457, état de la plateforme, catalogue des codes d'erreur).
- API NestJS 12 : configuration validée au démarrage, journalisation structurée Pino avec
  expurgation des secrets, gestion centralisée des erreurs, identifiant de requête, REST
  versionné, validation par schéma, en-têtes de sécurité, CORS strict, limitation de débit
  Redis, documentation OpenAPI soumise aux règles d'environnement, sondes de santé, arrêt propre.
- PostgreSQL 18 + Prisma 7 : première migration (`system_settings`, `audit_logs`,
  `outbox_events`), contraintes CHECK, journal d'audit en ajout seul (déclencheurs),
  séparation des rôles propriétaire / applicatif, historique des migrations inaccessible
  au rôle applicatif.
- Modules de plateforme : paramètres système (mode maintenance, fonctionnalités désactivées
  par défaut), journal d'audit, boîte d'envoi transactionnelle relayée par BullMQ.
- Tests : 275 tests (unitaires, propriétés, intégration et bout en bout sur PostgreSQL,
  Redis et BullMQ réels).
- Infrastructure : image Docker de l'API, Docker Compose (PostgreSQL, Redis, migrations,
  API, Nginx), Nginx avec erreurs au format de l'API, workflow d'intégration continue
  (`infrastructure/ci/ci.yml`, à activer en le déplaçant dans `.github/workflows/`).
- Base fantôme de Prisma Migrate (`SHADOW_DATABASE_URL`) pour le contrôle de cohérence
  entre migrations et schéma.
- Documentation : architecture, base de données, API, sécurité, déploiement, 12 ADR.
