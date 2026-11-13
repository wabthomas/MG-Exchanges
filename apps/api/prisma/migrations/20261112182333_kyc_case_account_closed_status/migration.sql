-- Nouveau statut d'un dossier de vérification : accepté, jusqu'à la clôture du compte.
--
-- Cette migration ne fait que cela. PostgreSQL interdit d'utiliser une nouvelle valeur d'un type
-- énuméré dans la transaction qui l'ajoute : les règles qui s'en servent (contraintes,
-- déclencheurs) sont dans la migration suivante.

-- AlterEnum
ALTER TYPE "kyc_case_status" ADD VALUE 'ACCOUNT_CLOSED';
