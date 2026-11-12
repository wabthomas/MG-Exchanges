# Décisions d'architecture (ADR)

Chaque décision structurante est consignée ici : contexte, décision, conséquences. Une
décision n'est jamais réécrite ; si elle change, un nouvel ADR la remplace et le précise.

| N°                                                                | Décision                                                                       | Statut                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| [0001](0001-monorepo-pnpm.md)                                     | Monorepo pnpm, versions épinglées, chaîne d'approvisionnement                  | Acceptée                      |
| [0002](0002-node-24-esm-typescript-6.md)                          | Node.js 24 LTS, modules ES, TypeScript 6 strict                                | Acceptée                      |
| [0003](0003-monolithe-modulaire-nestjs.md)                        | Monolithe modulaire NestJS 12, couches vérifiées                               | Acceptée                      |
| [0004](0004-tests-jest-esm.md)                                    | Jest 30 en mode ESM ; services réels pour l'intégration                        | Acceptée                      |
| [0005](0005-prisma-postgresql.md)                                 | Prisma 7, PostgreSQL 18, rôles séparés, SQL complémentaire                     | Acceptée                      |
| [0006](0006-validation-zod-contrats.md)                           | Validation par schémas Zod partagés                                            | Acceptée                      |
| [0007](0007-representation-des-montants.md)                       | Représentation des montants                                                    | Acceptée                      |
| [0008](0008-erreurs-rfc-9457.md)                                  | Erreurs normalisées RFC 9457 et codes stables                                  | Acceptée                      |
| [0009](0009-boite-d-envoi-transactionnelle.md)                    | Boîte d'envoi transactionnelle sur BullMQ                                      | Acceptée                      |
| [0010](0010-limitation-de-debit-redis.md)                         | Limitation de débit maison sur Redis                                           | Acceptée                      |
| [0011](0011-socle-http-configuration-journaux.md)                 | En-têtes natifs, configuration typée, Pino                                     | Acceptée                      |
| [0012](0012-fonctionnalites-fermees-par-defaut.md)                | Fonctionnalités réglementées fermées par défaut                                | Acceptée                      |
| [0013](0013-sessions-jetons-opaques.md)                           | Sessions par jetons opaques, vérifiées en base                                 | Acceptée                      |
| [0014](0014-mots-de-passe-argon2id.md)                            | Mots de passe : Argon2id natif, règles NIST                                    | Acceptée                      |
| [0015](0015-autorisations-refus-par-defaut.md)                    | Autorisations : refus par défaut, RBAC, amorçage hors de l'API                 | Acceptée — complétée par 0018 |
| [0016](0016-codes-usage-unique-non-divulgation.md)                | Codes à usage unique et non-divulgation des comptes                            | Acceptée                      |
| [0017](0017-validation-en-deux-etapes-totp.md)                    | Validation en deux étapes : TOTP, secret chiffré, connexion en deux temps      | Acceptée                      |
| [0018](0018-roles-double-validation-en-base.md)                   | Changements de rôle : double validation imposée par la base                    | Acceptée                      |
| [0019](0019-back-office-comptes-tracabilite.md)                   | Back-office des comptes : actions justifiées, accès journalisés                | Acceptée                      |
| [0020](0020-conservation-et-purge-des-donnees-d-identite.md)      | Conservation et purge des données d'identité                                   | Acceptée                      |
| [0021](0021-envoi-des-e-mails-par-smtp.md)                        | Envoi des e-mails par SMTP                                                     | Acceptée                      |
| [0022](0022-verification-d-identite-dossiers-pieces-chiffrees.md) | Vérification d'identité : dossiers par niveau, pièces chiffrées, examen humain | Acceptée                      |
