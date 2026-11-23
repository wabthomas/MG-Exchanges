-- CreateTable
CREATE TABLE "ledger_entry_kinds" (
    "key" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255) NOT NULL,

    CONSTRAINT "ledger_entry_kinds_pkey" PRIMARY KEY ("key")
);

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par
-- test/integration/ledger-entry-kinds-schema.spec.ts.
--
-- La base ferme la liste des types d'écriture. Jusqu'ici, elle vérifiait d'une écriture
-- l'arithmétique — entière, équilibrée, sans solde négatif — et, pour deux types seulement,
-- l'opération : une écriture équilibrée d'un type quelconque créditait un portefeuille depuis
-- le compte de conservation, ou déplaçait des fonds d'un portefeuille à un autre hors des
-- règles des transferts. Désormais, quel que soit le code qui écrit :
--   * « ledger_entry_kinds » est la liste des types d'écriture que la base connaît. Elle ne
--     s'étend que par migration : seul le rôle propriétaire de la table y ajoute un type ; un
--     type ne se modifie ni ne se retire ; le rôle applicatif ne fait que la lire ;
--   * une écriture d'un type absent de cette liste est refusée, quelles que soient ses lignes ;
--   * chaque type de la liste est lié à son opération par les règles de sa propre migration :
--     une écriture « transfer.internal » n'existe pas sans son transfert (migration
--     « internal_transfers »), une écriture « adjustment.credit » ou « adjustment.debit » pas
--     sans son ajustement approuvé (« staff_ledger_operations »). Ajouter un type à la liste,
--     c'est écrire dans la même migration la règle qui le lie à son opération : un type sans
--     règle rouvrirait le chemin que cette migration ferme.
-- Plus aucune écriture ne déplace donc de fonds hors d'un transfert ou d'un ajustement
-- approuvé — ni depuis le compte de conservation, ni d'un portefeuille à un autre.
-- Les écritures passées avant cette migration ne sont pas réexaminées : une écriture ne se
-- modifie ni ne s'efface. La règle vaut pour tout ce qui s'écrit ensuite.
-- Une règle enfreinte lève l'erreur MGX13 ; la modification ou le retrait d'un type, MGX01.
-- =======================================================================================

-- --- ledger_entry_kinds ----------------------------------------------------------------------
-- Même format que le type d'une écriture (« ledger_entries_kind_format_check »).
ALTER TABLE "ledger_entry_kinds"
  ADD CONSTRAINT "ledger_entry_kinds_key_format_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$');

-- Faire connaître un type, c'est ouvrir un chemin à des écritures : seul le rôle propriétaire
-- de la table le fait — celui des migrations. L'API se connecte avec le rôle applicatif, qui
-- n'a en outre que SELECT sur cette table (voir « Privilèges ») : la règle tient même si ce
-- privilège lui était rendu par erreur.
CREATE FUNCTION "mgx_enforce_ledger_entry_kind"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables AS t
    WHERE t.schemaname = TG_TABLE_SCHEMA
      AND t.tablename = TG_TABLE_NAME
      AND t.tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'a ledger entry kind can only be registered by the owner role'
      USING ERRCODE = 'MGX13';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entry_kinds_enforce"
  BEFORE INSERT ON "ledger_entry_kinds"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_ledger_entry_kind"();

-- Des écritures portent ce type, et des règles le nomment : un type ne change pas, et ne se
-- retire pas. La liste s'étend par migration.
CREATE TRIGGER "ledger_entry_kinds_immutable_row"
  BEFORE UPDATE OR DELETE ON "ledger_entry_kinds"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_entry_kinds_immutable_truncate"
  BEFORE TRUNCATE ON "ledger_entry_kinds"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- ledger_entries --------------------------------------------------------------------------
-- Une écriture est d'un type que la base connaît. Le contrôle suit l'insertion de l'en-tête
-- (AFTER) : un type mal formé est d'abord refusé par « ledger_entries_kind_format_check ».
-- Un type ne se retirant pas, celui qui est connu à l'écriture de l'en-tête l'est encore à la
-- validation de la transaction.
CREATE FUNCTION "mgx_check_ledger_entry_kind"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ledger_entry_kinds" AS k WHERE k."key" = NEW."kind") THEN
    RAISE EXCEPTION 'ledger entry % is of kind "%", which the database does not know',
      NEW."id", NEW."kind"
      USING ERRCODE = 'MGX13';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ledger_entries_kind_known"
  AFTER INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_ledger_entry_kind"();

-- --- Robustesse des fonctions ----------------------------------------------------------------
-- Les règles ne résolvent les noms que dans le schéma de l'application (voir la migration
-- « ledger ») : une table temporaire nommée « ledger_entry_kinds », placée par une session, ne
-- fait connaître aucun type.
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_enforce_ledger_entry_kind"()',
    '"mgx_check_ledger_entry_kind"()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', signature, current_schema());
  END LOOP;
END
$$;

-- --- Privilèges ----------------------------------------------------------------------------
-- Défense en profondeur : en plus des déclencheurs, le rôle applicatif perd les privilèges
-- dont il n'a pas l'usage. Il ne fait que lire la liste.
DO $$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grants.grantee
    FROM information_schema.role_table_grants AS grants
    JOIN pg_tables AS tables
      ON tables.schemaname = grants.table_schema AND tables.tablename = grants.table_name
    WHERE grants.table_schema = current_schema()
      AND grants.table_name = 'ledger_entry_kinds'
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ledger_entry_kinds" FROM %I',
      grantee_name);
  END LOOP;
END
$$;

-- --- Types d'écriture ------------------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques. Chacun
-- de ces types a déjà sa règle : « ledger_entries_transfer_recorded » (migration
-- « internal_transfers ») et « ledger_entries_adjustment_recorded » (migration
-- « staff_ledger_operations »).
INSERT INTO "ledger_entry_kinds" ("key", "description") VALUES
  ('transfer.internal', 'Transfer of funds from one holder to another.'),
  ('adjustment.credit',
   'Manual credit of a wallet, requested by one member of staff and approved by another.'),
  ('adjustment.debit',
   'Manual debit of a wallet, requested by one member of staff and approved by another.');
