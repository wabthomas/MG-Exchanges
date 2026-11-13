# 0018 — Changements de rôle : double validation imposée par la base de données

**Statut :** acceptée (2026-11-12)

## Contexte

Le lot 1 interdisait à l'API toute écriture sur les tables de droits : les rôles ne
s'attribuaient qu'en ligne de commande (ADR 0015). Il faut maintenant pouvoir les gérer depuis
le back-office, sans que l'attribution d'un rôle redevienne une simple écriture de l'API : ni
un administrateur seul, ni un défaut du code de l'API ne doivent suffire à créer un
administrateur.

L'ADR 0015 envisageait d'accorder à l'API « un droit d'écriture ciblé sur `user_roles` ».
Cette décision **y renonce** : l'API n'obtient aucun droit d'écriture sur les attributions.

## Décision

**Aucune route n'attribue un rôle.** Un administrateur dépose une **demande**
(`role_change_requests`) ; un **second** l'approuve ; l'approbation applique le changement.
Nul ne prend part à un changement de ses propres rôles. Une demande échoit après 72 heures.

**C'est PostgreSQL qui applique et qui vérifie.** Le rôle applicatif conserve un accès en
lecture seule à `user_roles`. Un déclencheur sur `role_change_requests`, dont la fonction
s'exécute avec les droits du propriétaire (`SECURITY DEFINER`, chemin de recherche figé,
`EXECUTE` retiré à `PUBLIC`), écrit l'attribution au moment où une demande passe à `APPROVED`
— après avoir vérifié lui-même :

- que l'approbateur n'est ni l'auteur de la demande, ni l'intéressé (contraintes `CHECK`) ;
- que l'auteur et l'approbateur sont, à cet instant, actifs et détenteurs de `roles.manage` ;
- que la demande était en attente, n'est pas échue, et que ses termes n'ont pas changé ;
- qu'un rôle n'est attribué qu'à un compte actif.

Une demande décidée ne se modifie plus et ne s'efface pas, même par le propriétaire.

**Les approbations sont appliquées une à une.** La fonction prend un verrou consultatif tenu
jusqu'à la fin de la transaction, puis seulement vérifie la qualité des deux intervenants.
Sans lui, deux approbations simultanées dont chacune retire son rôle à l'un des intervenants
de l'autre seraient vérifiées sur le même état de départ et passeraient toutes les deux,
alors qu'aucun ordre ne les admet ensemble — jusqu'à ne laisser aucun administrateur. Les
changements de rôle sont rares : les sérialiser ne coûte rien. Deux décisions simultanées sur
une **même** demande sont départagées par l'écriture conditionnelle
(`… WHERE status = 'PENDING'`) : une seule s'applique.

L'API fait les mêmes contrôles en amont, pour répondre clairement (`403`, `409`) ; ils ne
sont pas la garantie. Le refus de la base est traduit en `409 CONFLICT` et journalisé.

**Rôles système.** `super_admin` (tout) et `support` (trouver un compte, le suspendre, fermer
ses sessions). Le support ne gère pas les rôles, ne retire pas un second facteur et n'agit pas
sur les comptes du personnel.

## Conséquences

- La règle des quatre yeux ne dépend plus de la justesse du code de l'API : un contrôle
  oublié ou fautif dans un service ne permet ni à un administrateur d'approuver sa propre
  demande, ni d'écrire une attribution sans demande.
- **Limite : la base vérifie la qualité des intervenants, pas leur présence.** C'est l'API
  qui lui désigne l'auteur et l'approbateur. Un attaquant capable d'exécuter du SQL arbitraire
  sous le rôle de l'API (injection SQL, prise de contrôle du processus) pourrait fabriquer une
  demande et son approbation au nom de deux administrateurs existants — ou, plus simplement,
  se fabriquer leurs sessions. Au lot 1, ce même attaquant ne disposait d'aucun chemin vers
  une attribution de rôle ; il en existe désormais un, dès lors que deux administrateurs
  existent. Ce que la base lui refuse toujours : écrire directement une attribution, effacer
  ou réécrire la demande qui en garde la trace, toucher au schéma, modifier le journal
  d'audit. L'attaque laisserait donc une demande ineffaçable que les deux administrateurs
  nommés n'ont jamais faite. La fermer exigerait une preuve que l'API ne peut pas produire
  seule : une signature matérielle (WebAuthn) vérifiée à l'approbation — à étudier avec les
  clés d'accès.
- Il faut **au moins deux administrateurs** pour faire évoluer les rôles par l'API. Avec un
  seul — ou aucun —, le recours est l'outil en ligne de commande, qui exige l'accès au rôle
  propriétaire : c'est voulu.
- Une part de la logique métier vit dans une migration SQL : elle est couverte par des tests
  d'intégration dédiés (`back-office-schema.spec.ts`), mutations comprises, et toute évolution
  passe par une nouvelle migration.
- Le déclencheur lit l'heure de la base pour l'échéance ; l'API lit la sienne. Un écart
  d'horloge se traduit par un refus (`409`), jamais par une approbation tardive.
- Les rôles restent définis par migration : pas de création de rôle ni de modification de
  leurs permissions depuis le back-office à ce stade.
