# 0013 — Sessions par jetons opaques, vérifiées en base

**Statut :** acceptée (2026-11-11)

## Contexte

Les clients (mobile d'abord, puis web) doivent rester connectés sur des réseaux instables,
et une plateforme financière doit pouvoir couper un accès **immédiatement** : appareil perdu,
mot de passe compromis, compte suspendu. Le plan initial évoquait des JWT de courte durée.

## Décision

- Une connexion ouvre une **session** enregistrée en base (`user_sessions`).
- Deux jetons **opaques** (256 bits d'aléa, préfixes `mgx_at_` / `mgx_rt_`) : un jeton d'accès
  de 10 minutes et un jeton de renouvellement. Seules leurs empreintes SHA-256 sont stockées.
- Chaque requête authentifiée relit en base l'état de la session et du compte.
- Le jeton de renouvellement **change à chaque usage**. La réutilisation d'un jeton déjà
  remplacé révoque la session entière ; une tolérance de 10 secondes couvre la réponse perdue.
- Deux échéances : inactivité (14 jours, repoussée à chaque renouvellement) et durée de vie
  maximale (60 jours).

**Pourquoi pas des JWT.** Un JWT se vérifie sans base, mais ne se révoque pas : pour couper un
accès immédiatement, il faut de toute façon consulter un état serveur à chaque requête — le
seul avantage du JWT disparaît. Il resterait son inconvénient : une clé de signature dont le
vol permet de forger l'identité de n'importe qui, administrateurs compris. Un jeton opaque ne
vaut que par sa ligne en base : il n'y a rien à voler qui permette d'en fabriquer un.

## Conséquences

- Une lecture indexée en base par requête authentifiée. Si la charge l'exige, un cache Redis
  pourra s'intercaler derrière la même interface, sans changer l'API.
- Si un domaine est extrait en service séparé, il validera les jetons auprès du module
  d'identité (introspection) ou la passerelle émettra des jetons signés internes ; à décider alors.
- Les clients doivent conserver le dernier jeton de renouvellement reçu et ne pas lancer deux
  renouvellements à plus de 10 secondes d'intervalle avec le même jeton.
