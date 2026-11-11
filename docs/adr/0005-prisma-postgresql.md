# 0005 — Prisma 7, PostgreSQL 18, rôles séparés, SQL complémentaire

**Statut :** acceptée (2026-11-11)

## Contexte

PostgreSQL est la base principale et Prisma l'ORM demandé. L'étiquette `latest` de Prisma
pointe vers une version candidate (8.0.0-rc) dont la CLI diffère. Prisma ne modélise ni
contraintes `CHECK`, ni index partiels, ni déclencheurs — indispensables à l'intégrité financière.

## Décision

- **Prisma 7.10.1** épinglé, générateur `prisma-client` (client ESM généré dans `src/generated`,
  non versionné), adaptateur `@prisma/adapter-pg`.
- **PostgreSQL 18** minimum : clés primaires `uuidv7()` natives, ordonnées dans le temps.
- Le schéma n'évolue que par migrations. Contraintes, index partiels et déclencheurs sont
  ajoutés à la main dans le SQL de la migration, recensés dans `DATABASE.md` et vérifiés par des tests.
- **Deux rôles** : propriétaire (migrations) et applicatif (données seulement).
- Transactions explicites via `UnitOfWork` ; le client transactionnel est passé en paramètre.
- SQL brut paramétré (`Prisma.sql`) là où l'ORM ne suffit pas (`FOR UPDATE SKIP LOCKED`).

## Conséquences

- L'intégrité ne dépend pas du seul code applicatif : la base refuse les états invalides.
- `prisma generate` doit précéder compilation et tests (automatisé par les scripts).
- La CI vérifie que les migrations correspondent au schéma (`db:check-drift`) : Prisma les
  rejoue pour cela dans une base fantôme jetable, distincte de la base principale
  (`SHADOW_DATABASE_URL`).
- L'historique des migrations (`_prisma_migrations`) est retiré au rôle applicatif.
- Passage à Prisma 8 à sa sortie stable.
