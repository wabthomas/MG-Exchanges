# 0009 — Boîte d'envoi transactionnelle sur BullMQ

**Statut :** acceptée (2026-11-11)

## Contexte

Écrire une donnée en base puis publier un événement sont deux écritures dans deux systèmes :
une panne entre les deux produit soit une donnée sans événement, soit l'inverse.
`@nestjs/outbox` existe mais n'a que quelques semaines (0.1.x) et gère son propre schéma,
hors des migrations Prisma exigées par le projet.

## Décision

- Table `outbox_events` gérée par les migrations Prisma.
- `OutboxService.append(tx, …)` écrit l'événement dans la transaction métier.
- Un relais, cadencé par un planificateur BullMQ, réserve les événements en attente
  (`FOR UPDATE SKIP LOCKED`), les publie sur la file `domain-events` avec l'identifiant de
  l'événement comme identifiant de traitement, puis les marque publiés.
- Échec : nouvelle tentative avec délai exponentiel, puis état `DEAD` journalisé.
- Les consommateurs s'enregistrent par type d'événement et doivent être idempotents.

## Conséquences

- Remise « au moins une fois », sans perte ni publication fantôme ; sûre avec plusieurs instances.
- Reste à faire : rejeu des événements `DEAD`, purge des événements publiés, nouvelle
  tentative par consommateur plutôt que par événement.
- `@nestjs/outbox` sera réévalué lorsqu'il atteindra une version stable.
