# Décisions d'architecture (ADR)

Chaque décision structurante est consignée ici : contexte, décision, conséquences. Une
décision n'est jamais réécrite ; si elle change, un nouvel ADR la remplace et le précise.

| N°                                                 | Décision                                                      | Statut   |
| -------------------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-monorepo-pnpm.md)                      | Monorepo pnpm, versions épinglées, chaîne d'approvisionnement | Acceptée |
| [0002](0002-node-24-esm-typescript-6.md)           | Node.js 24 LTS, modules ES, TypeScript 6 strict               | Acceptée |
| [0003](0003-monolithe-modulaire-nestjs.md)         | Monolithe modulaire NestJS 12, couches vérifiées              | Acceptée |
| [0004](0004-tests-jest-esm.md)                     | Jest 30 en mode ESM ; services réels pour l'intégration       | Acceptée |
| [0005](0005-prisma-postgresql.md)                  | Prisma 7, PostgreSQL 18, rôles séparés, SQL complémentaire    | Acceptée |
| [0006](0006-validation-zod-contrats.md)            | Validation par schémas Zod partagés                           | Acceptée |
| [0007](0007-representation-des-montants.md)        | Représentation des montants                                   | Acceptée |
| [0008](0008-erreurs-rfc-9457.md)                   | Erreurs normalisées RFC 9457 et codes stables                 | Acceptée |
| [0009](0009-boite-d-envoi-transactionnelle.md)     | Boîte d'envoi transactionnelle sur BullMQ                     | Acceptée |
| [0010](0010-limitation-de-debit-redis.md)          | Limitation de débit maison sur Redis                          | Acceptée |
| [0011](0011-socle-http-configuration-journaux.md)  | En-têtes natifs, configuration typée, Pino                    | Acceptée |
| [0012](0012-fonctionnalites-fermees-par-defaut.md) | Fonctionnalités réglementées fermées par défaut               | Acceptée |
