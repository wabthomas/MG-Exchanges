# 0028 — Base saturée et erreurs des files : `503` avec délai, journaux structurés

**Statut :** acceptée (2026-11-18) — complète les ADR 0008 (erreurs), 0009 (boîte d'envoi sur BullMQ) et 0011 (journaux) ; complétée par l'ADR 0029. Six choix restent à confirmer (plus bas).

## Contexte

Deux défauts du socle, relevés en contrôlant les tests du lot 3 de la phase 3
(`PROJECT_STATUS.md`, « Problèmes identifiés », points 9 et 10) :

- **Une base saturée répondait `500`.** Lorsque toutes les connexions du pool sont occupées,
  une transaction attend deux secondes puis Prisma l'abandonne ; une requête simple attend
  cinq secondes puis le pool `pg` l'abandonne. Aucune de ces deux erreurs n'était reconnue :
  l'API répondait `500 INTERNAL_ERROR`, la réponse d'un défaut du programme. Or rien n'est
  alors en panne, l'opération n'a pas commencé, et la requête peut être renvoyée. Relevé sous
  72 transferts simultanés, chaque validation retardée de 100 ms : 24 à 30 d'entre eux
  étaient ainsi abandonnés.
- **Les erreurs des files échappaient aux journaux structurés.** Sans écouteur, BullMQ écrit
  lui-même sur la sortie d'erreur, sans format ni champ. Éprouvé sur l'API compilée : Redis
  arrêté 12 secondes, 120 erreurs brutes (960 lignes), aucune ligne structurée ; base
  supprimée huit secondes, huit passages du relais en échec et **aucune ligne nulle part** —
  la trace n'en restait que dans Redis.

## Décision

### Une base saturée répond `503`, avec le délai avant de réessayer

- **Ce qui est reconnu** (`isDatabaseSaturated`) — deux erreurs, selon qui renonce le
  premier :
  - celle de Prisma, code `P2028`, dont le message contient « Unable to start a transaction
    in the given time » ;
  - celle du pool `pg`, une erreur nue dont le message est exactement « timeout exceeded when
    trying to connect ».
- **Ce que l'API répond** : `503 SERVICE_UNAVAILABLE`, « The service is temporarily
  overloaded. Please retry in a few seconds. », `Retry-After: 5`. Le refus est journalisé au
  niveau `error` (`Request failed`), avec le code qui le distingue d'une panne.
- **Ce qui n'en est pas** : les autres erreurs `P2028` — transaction trop longue, déjà close,
  introuvable : elle avait commencé —, une base qui refuse les connexions, une connexion
  rompue. Elles restent des erreurs `500`.
- **Aucune relance automatique** : `UnitOfWork` ne relance que les conflits (ADR 0025).

Établi par des tests sur un PostgreSQL réel, avec les erreurs que Prisma et le pool lèvent
réellement : la transaction refusée n'a rien exécuté ; une écriture du grand livre refusée
n'a rien laissé, et passe une fois lorsqu'elle est renvoyée sous la même clé ; une requête
authentifiée répond `503` et non `401`, sa session reste valide ; une connexion refusée n'est
pas comptée comme un mot de passe erroné. Rejouée, la rafale de 72 transferts à 100 ms voit
30 refus, tous reconnus.

### Les files et leurs exécutants écrivent dans les journaux structurés

- **`QueueErrorLog`** (`infrastructure/queue`) reçoit ce que BullMQ signale hors de toute
  requête et l'écrit au niveau `error` :
  - `Background queue error` — champs `queue`, `source` (`queue` ou `worker`), `err` ;
  - `Background job failed` — champs `queue`, `err` : un passage du relais ou de la purge.
- **Tout objet est écouté.** Les files le sont d'office : `QueueErrorLog` parcourt
  l'application à son démarrage. Chaque exécutant l'est par son traitement
  (`@OnWorkerEvent('error')`), dès sa création. Un test parcourt l'application réelle et
  échoue si une file ou un exécutant n'a pas ses écouteurs.
- **Une ligne par période.** Une même erreur — même nom, même message — venue du même objet
  s'écrit une fois, puis une fois toutes les trente secondes tant qu'elle dure, avec
  `repeated` : le nombre d'occurrences passées sous silence depuis la ligne précédente. Deux
  erreurs différentes, ou la même sur deux objets, ne se masquent jamais.
- **L'échec du traitement d'un événement** (`Domain event handling failed`) garde sa ligne,
  avec l'identité de l'événement, **à chaque fois**.

Éprouvé de la même façon après la correction : Redis arrêté 12 secondes, six lignes — trois
files, trois exécutants — ; 40 secondes, douze lignes, dont six annoncent 129 répétitions ;
base supprimée huit secondes, une ligne `Background job failed`. La sortie d'erreur reste
vide dans les trois cas.

## Choix à confirmer

Six choix ont été faits sans vous ; chacun se change sans reprendre le reste.

1. **La saturation se reconnaît à un message.** Ni Prisma ni `pg` ne donnent à ces erreurs
   un code qui leur soit propre. Une montée de version qui en changerait les termes ferait
   revenir le `500` — et échouer le test qui les provoque avec un vrai pool saturé.
2. **`Retry-After: 5`** : le délai des autres refus pour saturation (réception des pièces,
   API injoignable derrière Nginx).
3. **Niveau `error`**, pour une saturation comme pour une erreur de file : ce sont des
   signaux à traiter, non des incidents ordinaires. Un conflit entre deux requêtes reste au
   niveau `warn`.
4. **Pas de relance automatique** d'une transaction refusée faute de connexion : c'est au
   client d'attendre.
5. **Une ligne toutes les trente secondes** par erreur et par objet. Une erreur qui cesse ne
   laisse pas de ligne de fin : la durée d'un épisode se lit à trente secondes près.
6. **Les passages en échec du relais et de la purge sont désormais écrits** — au-delà de ce
   que demandait le point 10, qui ne visait que les erreurs des exécutants.

## Alternatives écartées

- **Agrandir le pool ou allonger l'attente.** Écarté comme réponse : cela déplace le seuil,
  pas la réponse une fois le seuil atteint. Le dimensionnement relève du déploiement.
- **Relancer la transaction refusée.** Écarté : sous saturation, insister aggrave.
- **Répondre `429`.** Écarté : le client n'a rien fait de trop.
- **Un code d'erreur nouveau.** Non retenu : `SERVICE_UNAVAILABLE` existe, et c'est déjà ce
  que répond Nginx quand l'API ne suit plus ; le client n'a rien à distinguer.
- **Répondre `503` aussi quand la base est injoignable.** Non retenu : c'est une panne, que
  la supervision doit voir comme telle, et rien n'indique alors que l'opération n'a pas
  commencé.
- **Écrire chaque occurrence.** Écarté : dix lignes par seconde tant que Redis ne répond pas.
- **Une ligne de fin d'épisode, par minuterie.** Non réalisé : une minuterie par erreur, pour
  une information que la ligne suivante porte déjà quand l'erreur dure.
- **Écouter les exécutants d'office, comme les files.** Écarté : un exécutant doit être
  écouté dès sa création, ce que seul son traitement garantit.

## Conséquences

- **Un client doit savoir attendre** : toute route qui lit ou écrit en base peut répondre
  `503` avec `Retry-After`. C'est écrit dans le document OpenAPI.
- **La supervision distingue une saturation d'une panne** par le code de la ligne
  `Request failed`, et lit les erreurs des files au même endroit que le reste.
- **Devant une base qui accepte la connexion et ne répond plus, les deux réponses se
  mêlent** : `500` pour la requête qui ouvrait une connexion, `503` pour celles qui
  attendaient derrière elle.
- **Ces essais de panne ont relevé deux comportements antérieurs, non corrigés ici** : l'API
  ne s'arrête pas d'elle-même tant que Redis est injoignable ; et un Redis revenu **vide**
  n'a plus les tâches planifiées, que l'API n'inscrit qu'à son démarrage — plus rien n'est
  relayé, sans qu'aucune sonde ni aucune ligne le dise. Décrits dans `DEPLOYMENT.md`
  (« Saturation et pannes ») et proposés à la correction dans `PROJECT_STATUS.md`.
  **Corrigés depuis : ADR 0029.**
