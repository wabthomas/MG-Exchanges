# 0029 — Tâches planifiées surveillées, arrêt borné

**Statut :** acceptée (2026-11-20) — complète les ADR 0009 (boîte d'envoi sur BullMQ) et 0028 (erreurs des files). Corrige les deux comportements que l'ADR 0028 relevait sans les corriger. Sept choix restent à confirmer (plus bas).

## Contexte

Les essais de panne de l'ADR 0028 avaient relevé deux défauts plus anciens
(`PROJECT_STATUS.md`, « Problèmes identifiés ») :

- **Un Redis revenu vide laissait l'API sans relais ni purge, en silence.** Les deux tâches
  planifiées — le relais de la boîte d'envoi, la purge horaire — n'existent que dans Redis :
  un planificateur BullMQ et sa prochaine exécution. L'API les inscrivait à son démarrage,
  et seulement là. Redis relancé sans ses données, elle s'y reconnectait, la sonde de
  disponibilité répondait `200`, aucune ligne d'erreur n'était écrite — et plus aucun
  événement ne partait jusqu'à son redémarrage. Les codes de vérification passent par ce
  relais.
- **L'API ne s'arrêtait pas d'elle-même tant que Redis était injoignable.** NestJS ferme une
  application en trois temps : les modules (`onModuleDestroy`), puis le serveur HTTP, puis
  le reste (`onApplicationShutdown`). Les exécutants de files se ferment au premier temps,
  et leur fermeture attend une connexion à Redis. Sans Redis, elle ne revenait pas : le
  serveur HTTP n'était jamais fermé et continuait de répondre, le processus restait là
  jusqu'au `SIGKILL` de l'orchestrateur.

En reprenant l'arrêt, un troisième défaut est apparu, lui aussi antérieur :

- **Une requête qui écrivait en base à l'instant de l'arrêt échouait (`500`).** La base
  était fermée au premier temps, avant que le serveur HTTP ait mené ses requêtes à leur
  terme. Éprouvé par un test : une connexion retenue au milieu de son travail en base,
  l'arrêt demandé, puis la connexion libérée — elle recevait `500`. Aucune donnée n'était
  en jeu : la transaction était annulée.

## Décision

### Les tâches planifiées s'inscrivent par `JobSchedules`, qui les surveille

- **Un seul point d'inscription** : `JobSchedules.register` (`infrastructure/queue`). Il
  inscrit la tâche — le même `upsertJobScheduler` qu'auparavant —, puis la surveille.
- **Chaque instance vérifie ses tâches toutes les trente secondes**, et réinscrit celle
  qui :
  - **manque** (`missing`) : son planificateur n'est plus dans Redis ;
  - **est en retard** (`late`) de plus d'une minute : le planificateur est là, mais son
    exécution en attente a disparu, ou personne ne l'exécute.
- **Réinscrire une tâche saine ne la décale pas** — BullMQ garde le créneau de l'exécution
  en attente : plusieurs instances peuvent réparer en même temps. Une vérification en cours
  n'est pas doublée ; pendant une coupure, elle attend la reconnexion et répare dès qu'elle
  a lieu.
- **Chaque réparation écrit une ligne `error`**, contexte `JobSchedules` :
  `Background schedule registered again`, champs `queue`, `scheduler`, `reason`. Elle dit à
  l'exploitant que Redis a perdu des données — et l'API ne peut pas rendre ce qu'il portait
  d'autre. Une vérification qui échoue passe par `QueueErrorLog` (ADR 0028).
- **Un test parcourt Redis** et échoue s'il y trouve un planificateur que `JobSchedules`
  ne surveille pas : une tâche inscrite ailleurs ne peut pas passer inaperçue.

Éprouvé sur l'API compilée : Redis arrêté 12 secondes puis relancé **vide** — les deux
tâches réinscrites 14 à 18 secondes après son retour, l'événement resté en attente parti
aussitôt, sans redémarrage. Relancé **avec** ses données : aucune réparation, aucune ligne,
la purge garde son créneau. Arrêté 75 secondes, données conservées : une ligne `late` pour
le relais, qui avait attendu Redis plus d'une minute, aucune pour la purge.

### L'arrêt est borné, et ferme la base en dernier

- **L'API écoute elle-même `SIGTERM` et `SIGINT`** (`bootstrap/shutdown.ts`) ; l'écoute de
  NestJS (`enableShutdownHooks`) est retirée.
- **Au signal, le serveur HTTP cesse aussitôt d'accepter des connexions**, avant toute
  autre étape. Les requêtes en cours vont à leur terme ; les connexions que les clients
  gardent ouvertes sans requête sont fermées au fur et à mesure.
- **L'application se ferme ensuite dans l'ordre de NestJS** : les tâches de fond en cours
  s'achèvent, le serveur HTTP attend ses dernières réponses, puis les files, Redis **et la
  base** sont fermés. La base passe du premier temps au dernier
  (`PrismaService.onApplicationShutdown`) : rien n'est fermé sous une requête ou une tâche
  en cours.
- **Une échéance** : `SHUTDOWN_TIMEOUT_MS`, huit secondes par défaut (d'une seconde à deux
  minutes). Si la fermeture n'a pas abouti, l'API écrit
  `Shutdown did not complete in time: exiting` (`error`) et se termine.
- **Codes de sortie** : 0 quand tout s'est fermé ; 1 à l'échéance, si la fermeture échoue,
  ou à un second signal — qui met fin à l'arrêt sur-le-champ.
- **Pendant l'initialisation**, avant que l'API n'écoute, il n'y a rien à mener à son
  terme : un signal met fin au processus sur-le-champ, par le code 0, après un avis sur la
  sortie d'erreur (`bootstrap/start.ts`). Fermer une application à demi initialisée, comme
  le faisait l'écoute de NestJS, croisait l'initialisation : trois essais sur quatre se
  terminaient par une erreur (« Connection is closed », code 1).

Éprouvé sur l'API compilée, puis de nouveau en processus 1 d'un espace de processus séparé
— sa position dans l'image Docker :

| Arrêt demandé                                       | Avant                                     | Désormais                            |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| en service normal                                   | environ 0,1 s ; code 143 (0 en conteneur) | de même ; code 0                     |
| cinq secondes après la perte de Redis               | tourne et répond encore 20 s plus tard    | refuse dans la seconde ; 8 s, code 1 |
| huit secondes après le retour d'une coupure de 40 s | de même                                   | 8 s, code 1                          |
| pendant qu'une requête écrit en base                | `500`                                     | sa réponse                           |

## Choix à confirmer

Sept choix ont été faits sans vous ; chacun se change sans reprendre le reste.

1. **La sonde de disponibilité ne dit rien des tâches planifiées** — contrairement à ce que
   la proposition annonçait. Elle sert à retirer une instance du trafic ; or une instance
   sans relais sert encore ses requêtes, et toutes partagent les mêmes tâches : les
   déclarer indisponibles couperait tout le service pour un retard que l'API répare seule
   en moins d'une minute. Le signal est la ligne du journal.
2. **Vérification toutes les trente secondes, retard toléré d'une minute.** Le retard doit
   dépasser la durée d'un passage : pendant qu'une tâche s'exécute, sa prochaine échéance
   peut être passée de toute cette durée.
3. **La ligne de réparation est de niveau `error`, et s'écrit à chaque fois** — sans la
   règle « une ligne par demi-minute » : une réparation n'est pas une erreur qui se répète
   dix fois par seconde.
4. **Huit secondes pour s'arrêter**, sous les dix que Docker accorde par défaut ;
   `docker-compose.yml` écrit désormais ce délai (`stop_grace_period: 10s`).
5. **Un arrêt propre se termine par le code 0**, et non plus par le signal reçu (143 hors
   conteneur). En processus 1 d'un conteneur, un signal renvoyé à soi-même est ignoré : le
   code était déjà 0, par accident. Il l'est désormais partout, par décision.
6. **L'API refuse les connexions dès le signal.** Elle ne continue pas de servir pendant
   qu'elle se ferme : l'instance doit être retirée du trafic avant d'être arrêtée, ce que
   `DEPLOYMENT.md` demandait déjà.
7. **À l'échéance, ce qui est en cours est coupé** : requêtes et tâches. Une transaction
   interrompue est annulée, un événement non relayé reste dans la boîte d'envoi, une tâche
   interrompue est reprise — la remise reste « au moins une fois ».

## Alternatives écartées

- **Réinscrire à la reconnexion, sans vérification périodique.** Écarté : Redis peut perdre
  ses données sans que la connexion tombe — vidage, éviction, bascule derrière un
  répartiteur —, et chaque objet BullMQ a sa propre connexion.
- **Faire échouer la sonde de disponibilité.** Écarté : voir le premier choix. Une
  information ajoutée à sa réponse sans en changer le code ne serait lue par personne.
- **Garder l'écoute de NestJS et lui ajouter une échéance.** Écarté : le serveur HTTP y est
  fermé après les modules ; pendant l'attente, l'instance continuerait d'accepter du trafic.
- **Forcer la fermeture des exécutants** (`close(true)`). Écarté : elle couperait les tâches
  en cours à chaque arrêt, et non aux seuls arrêts sans Redis.
- **Fermer toutes les connexions HTTP au signal.** Écarté : les requêtes en cours seraient
  coupées. Seules les connexions inactives sont fermées.
- **Renvoyer le signal après la fermeture**, pour garder le code 143. Écarté : sans effet en
  processus 1, donc deux comportements selon l'hébergement.
- **Un test automatique qui tue un vrai processus.** Non réalisé : il dépendrait d'une
  compilation préalable. Le lancement réel est éprouvé avec des signaux et une fin de
  processus injectés ; les vrais signaux, à la main, sur l'API compilée.

## Conséquences

- **Un Redis qui perd ses données ne laisse plus l'API muette** : elle repart en moins
  d'une minute, et le dit. Ce que Redis portait d'autre reste perdu — événements remis à la
  file et pas encore traités, compteurs de la limitation de débit, connexions en attente de
  leur seconde étape : la persistance de Redis reste exigée.
- **Une ligne `late` suit toute coupure de Redis de plus d'une minute** : la tâche a attendu
  Redis. Elle est attendue, et sans effet. Répétée, elle dit qu'aucun exécutant ne prend la
  tâche.
- **Le délai d'arrêt de l'orchestrateur doit dépasser `SHUTDOWN_TIMEOUT_MS`.**
- **Un code de sortie 1 à l'arrêt** signifie une fermeture coupée à l'échéance, non une
  panne du programme.
- **Non couvert par un test automatique** : l'envoi d'un vrai signal à un vrai processus,
  et les valeurs par défaut du lancement (les signaux du processus, sa fin réelle, sa sortie
  d'erreur). **Non mesuré sous Docker** : l'intégration continue arrête la pile sans relever
  sa durée ni son code de sortie.
- **Reste ouvert, antérieur à cette décision** : pendant le chargement du programme — la
  première seconde environ après le lancement —, l'API n'écoute pas encore ses signaux. En
  processus 1 d'un conteneur, un signal reçu à cet instant est ignoré : elle démarre, et
  l'orchestrateur la tue à l'expiration de son délai. Le corriger demanderait de charger
  l'application après avoir installé l'écoute, depuis un point d'entrée réduit.
- **Inchangé** : pendant une coupure de Redis, une requête ordinaire répond toujours `500`
  après une à neuf secondes (`PROJECT_STATUS.md`, « Problèmes identifiés »).
