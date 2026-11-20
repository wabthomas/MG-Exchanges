-- CreateEnum
CREATE TYPE "asset_kind" AS ENUM ('FIAT', 'CRYPTO');

-- CreateEnum
CREATE TYPE "ledger_side" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "ledger_account_owner" AS ENUM ('USER', 'PLATFORM');

-- CreateTable
CREATE TABLE "assets" (
    "code" VARCHAR(12) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "kind" "asset_kind" NOT NULL,
    "scale" SMALLINT NOT NULL,
    "registered_by" UUID,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ledger_account_types" (
    "key" VARCHAR(64) NOT NULL,
    "owner" "ledger_account_owner" NOT NULL,
    "normal_side" "ledger_side" NOT NULL,
    "description" VARCHAR(255) NOT NULL,

    CONSTRAINT "ledger_account_types_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "type_key" VARCHAR(64) NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "user_id" UUID,
    "normal_side" "ledger_side" NOT NULL,
    "balance" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "posting_count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "idempotency_key" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "posting_count" SMALLINT NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" VARCHAR(64),
    "request_id" VARCHAR(128),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_postings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entry_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "account_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "side" "ledger_side" NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "account_sequence" BIGINT NOT NULL,
    "balance_after" DECIMAL(38,0) NOT NULL,

    CONSTRAINT "ledger_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_postings_entry_id_line_number_key" ON "ledger_postings"("entry_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_postings_account_id_account_sequence_key" ON "ledger_postings"("account_id", "account_sequence");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_type_key_fkey" FOREIGN KEY ("type_key") REFERENCES "ledger_account_types"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/ledger-schema.spec.ts.
--
-- Grand livre en partie double. La base impose elle-même, quel que soit le code qui écrit :
--   * un actif enregistré ne se modifie ni ne se retire ; seul l'enregistre un membre du
--     personnel actif qui détient « ledger.manage_assets » — ou le rôle propriétaire ;
--   * le plan de comptes ne change que par migration ;
--   * un compte s'ouvre vide, pour un titulaire actif ou suspendu (ou pour la plateforme), ne
--     change ni de type, ni d'actif, ni de titulaire, et ne se supprime pas ;
--   * une écriture et ses lignes ne se modifient ni ne s'effacent ;
--   * chaque ligne est passée sous le verrou de son compte : la base calcule son rang et le
--     solde qui en résulte, dans l'actif du compte ; un solde ne devient jamais négatif ;
--   * le solde d'un compte est celui de sa dernière ligne — vérifié avant chaque ligne, et à
--     la validation de toute transaction qui a touché au compte ;
--   * à la validation de la transaction, une écriture a toutes les lignes qu'elle a déclarées,
--     sur deux comptes au moins, et pour chaque actif le total de ses débits égale celui de
--     ses crédits ; plus rien ne s'y ajoute ensuite ;
--   * rien ne s'écrit sur les comptes d'un titulaire clôturé, et un titulaire ne se clôt pas
--     tant qu'un de ses comptes détient des fonds ; s'il a eu des écritures, la trace de sa
--     clôture garde son adresse et son numéro dix ans.
-- Une règle enfreinte lève l'erreur MGX08 ; des fonds insuffisants, MGX09 ; une ligne passée
-- sur le compte d'un titulaire clôturé, MGX05 ; une règle de clôture, MGX04 ; la modification
-- d'une table en ajout seul, MGX01.
-- =======================================================================================

-- --- assets --------------------------------------------------------------------------------
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_code_format_check"
    CHECK ("code" ~ '^[A-Z][A-Z0-9]{1,11}$'),
  -- Un montant est un entier de 38 chiffres au plus : au-delà de 18 décimales, il ne resterait
  -- plus de place pour sa partie entière.
  ADD CONSTRAINT "assets_scale_check"
    CHECK ("scale" BETWEEN 0 AND 18),
  -- Une ligne de texte : non vide, sans espace en tête ni en fin, sans caractère de contrôle.
  -- Mêmes règles que le contrat d'enregistrement (@mgx/contracts).
  ADD CONSTRAINT "assets_name_check"
    CHECK ("name" ~ '\S'
           AND "name" !~ '^\s|\s$'
           AND "name" !~ '[\u0001-\u001F\u007F-\u009F]');

CREATE FUNCTION "mgx_enforce_asset"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."registered_by" IS NULL THEN
    -- Sans auteur : réservé au rôle propriétaire (outil d'exploitation). L'API, elle, se
    -- connecte avec le rôle applicatif et désigne toujours un membre du personnel.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_tables AS t
      WHERE t.schemaname = TG_TABLE_SCHEMA
        AND t.tablename = TG_TABLE_NAME
        AND t.tableowner = current_user
    ) THEN
      RAISE EXCEPTION 'an asset without a registrar can only be registered by the owner role'
        USING ERRCODE = 'MGX08';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "users" AS u
    JOIN "user_roles" AS ur ON ur."user_id" = u."id"
    JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
    WHERE u."id" = NEW."registered_by"
      AND u."status" = 'ACTIVE'
      AND rp."permission_key" = 'ledger.manage_assets'
  ) THEN
    RAISE EXCEPTION 'account % is not entitled to register an asset', NEW."registered_by"
      USING ERRCODE = 'MGX08';
  END IF;

  NEW."registered_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "assets_enforce"
  BEFORE INSERT ON "assets"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_asset"();

-- Tous les montants du grand livre s'expriment dans l'unité minimale de leur actif : changer
-- son nombre de décimales changerait leur valeur. Un actif enregistré ne change plus.
CREATE TRIGGER "assets_immutable_row"
  BEFORE UPDATE OR DELETE ON "assets"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "assets_immutable_truncate"
  BEFORE TRUNCATE ON "assets"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- ledger_account_types ------------------------------------------------------------------
ALTER TABLE "ledger_account_types"
  ADD CONSTRAINT "ledger_account_types_key_format_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*$');

-- Le sens normal d'un type est recopié sur chaque compte à son ouverture : un type ne change
-- pas, et ne se retire pas. Le plan de comptes s'étend par migration.
CREATE TRIGGER "ledger_account_types_immutable_row"
  BEFORE UPDATE OR DELETE ON "ledger_account_types"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_account_types_immutable_truncate"
  BEFORE TRUNCATE ON "ledger_account_types"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- ledger_accounts -----------------------------------------------------------------------
-- Un compte par type et par actif : pour chaque titulaire, et pour la plateforme.
CREATE UNIQUE INDEX "ledger_accounts_user_key"
  ON "ledger_accounts" ("user_id", "asset_code", "type_key")
  WHERE "user_id" IS NOT NULL;

CREATE UNIQUE INDEX "ledger_accounts_platform_key"
  ON "ledger_accounts" ("asset_code", "type_key")
  WHERE "user_id" IS NULL;

ALTER TABLE "ledger_accounts"
  -- Aucun compte ne devient négatif : on ne dépense, ne rend ni ne conserve ce qu'on n'a pas.
  ADD CONSTRAINT "ledger_accounts_balance_check"
    CHECK ("balance" >= 0),
  ADD CONSTRAINT "ledger_accounts_posting_count_check"
    CHECK ("posting_count" >= 0),
  -- Sans ligne, pas de solde.
  ADD CONSTRAINT "ledger_accounts_empty_check"
    CHECK ("posting_count" > 0 OR "balance" = 0);

CREATE FUNCTION "mgx_enforce_ledger_account"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_type "ledger_account_types"%ROWTYPE;
  holder_status "user_status";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Seuls le solde et le nombre de lignes changent — et seule une ligne les fait changer :
    -- voir « mgx_apply_ledger_posting » et « mgx_check_ledger_account_balance ».
    IF (NEW."id", NEW."type_key", NEW."asset_code", NEW."user_id", NEW."normal_side",
        NEW."created_at")
       IS DISTINCT FROM
       (OLD."id", OLD."type_key", OLD."asset_code", OLD."user_id", OLD."normal_side",
        OLD."created_at") THEN
      RAISE EXCEPTION 'ledger account % cannot change its type, its asset or its holder', OLD."id"
        USING ERRCODE = 'MGX08';
    END IF;
    RETURN NEW;
  END IF;

  SELECT t.* INTO account_type FROM "ledger_account_types" AS t WHERE t."key" = NEW."type_key";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account type % does not exist', NEW."type_key"
      USING ERRCODE = 'MGX08';
  END IF;
  IF (account_type."owner" = 'USER') <> (NEW."user_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'a ledger account of type % belongs to %', NEW."type_key",
      CASE account_type."owner" WHEN 'USER' THEN 'a holder' ELSE 'the platform, not to a holder' END
      USING ERRCODE = 'MGX08';
  END IF;

  IF NEW."user_id" IS NOT NULL THEN
    -- Un compte inconnu est laissé à la clé étrangère, qui le signale ; un compte clôturé, au
    -- déclencheur « ledger_accounts_account_open », exécuté avant celui-ci. Reste
    -- l'inscription jamais vérifiée : elle peut être purgée, elle ne détient donc pas de fonds.
    SELECT u."status" INTO holder_status FROM "users" AS u WHERE u."id" = NEW."user_id";
    IF FOUND AND holder_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
      RAISE EXCEPTION 'account % cannot hold funds: it is %',
        NEW."user_id", lower(holder_status::text)
        USING ERRCODE = 'MGX08';
    END IF;
  END IF;

  IF NEW."balance" <> 0 OR NEW."posting_count" <> 0 THEN
    RAISE EXCEPTION 'a ledger account is opened empty'
      USING ERRCODE = 'MGX08';
  END IF;

  NEW."normal_side" := account_type."normal_side";
  NEW."created_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Rien ne s'ajoute à un compte clôturé (MGX05) : même déclencheur que pour ses autres lignes.
-- Son nom le fait s'exécuter avant « ledger_accounts_enforce ». Il verrouille le titulaire
-- (FOR KEY SHARE) jusqu'à la fin de la transaction : une clôture attend, puis voit le compte.
CREATE TRIGGER "ledger_accounts_account_open"
  BEFORE INSERT ON "ledger_accounts"
  FOR EACH ROW
  WHEN (NEW."user_id" IS NOT NULL)
  EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();

CREATE TRIGGER "ledger_accounts_enforce"
  BEFORE INSERT OR UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_ledger_account"();

-- Un compte ne se supprime pas : il porte l'historique de ses lignes.
CREATE TRIGGER "ledger_accounts_no_delete"
  BEFORE DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_accounts_no_truncate"
  BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Le solde d'un compte et son nombre de lignes ne sont que le reflet de sa dernière ligne.
-- Vérifié à la validation de toute transaction qui a modifié le compte : un solde écrit
-- directement, sans la ligne qui le justifie, n'est jamais validé — quel que soit le rôle.
CREATE FUNCTION "mgx_check_ledger_account_balance"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account "ledger_accounts"%ROWTYPE;
BEGIN
  SELECT a.* INTO account FROM "ledger_accounts" AS a WHERE a."id" = NEW."id";
  IF EXISTS (
       SELECT 1 FROM "ledger_postings" AS p
       WHERE p."account_id" = account."id"
         AND p."account_sequence" > account."posting_count"
     )
     OR (account."posting_count" > 0 AND NOT EXISTS (
       SELECT 1 FROM "ledger_postings" AS p
       WHERE p."account_id" = account."id"
         AND p."account_sequence" = account."posting_count"
         AND p."balance_after" = account."balance"
     )) THEN
    RAISE EXCEPTION 'the balance of ledger account % is not the one of its last posting',
      account."id"
      USING ERRCODE = 'MGX08';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_accounts_balance_proven"
  AFTER UPDATE ON "ledger_accounts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_ledger_account_balance"();

-- --- ledger_entries ------------------------------------------------------------------------
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_idempotency_key_format_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  ADD CONSTRAINT "ledger_entries_kind_format_check"
    CHECK ("kind" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  -- Une écriture a deux lignes au moins. Le plafond borne le travail des vérifications faites
  -- à la validation de la transaction.
  ADD CONSTRAINT "ledger_entries_posting_count_check"
    CHECK ("posting_count" BETWEEN 2 AND 100),
  ADD CONSTRAINT "ledger_entries_actor_id_check"
    CHECK (("actor_type" = 'SYSTEM') = ("actor_id" IS NULL)),
  ADD CONSTRAINT "ledger_entries_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 4096);

CREATE FUNCTION "mgx_stamp_ledger_entry"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- L'heure d'une écriture est lue à l'horloge de la base, jamais à celle de l'application.
  NEW."posted_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_entries_stamp"
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "mgx_stamp_ledger_entry"();

-- Une écriture ne se modifie ni ne s'efface : une erreur se corrige par une écriture inverse.
CREATE TRIGGER "ledger_entries_immutable_row"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_entries_immutable_truncate"
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- ledger_postings -----------------------------------------------------------------------
ALTER TABLE "ledger_postings"
  ADD CONSTRAINT "ledger_postings_amount_check"
    CHECK ("amount" > 0),
  ADD CONSTRAINT "ledger_postings_line_number_check"
    CHECK ("line_number" >= 1),
  ADD CONSTRAINT "ledger_postings_account_sequence_check"
    CHECK ("account_sequence" >= 1),
  ADD CONSTRAINT "ledger_postings_balance_after_check"
    CHECK ("balance_after" >= 0);

-- Passe une ligne sur son compte. Le rang de la ligne et le solde qui en résulte sont calculés
-- ici, sous le verrou du compte : ce que l'appelant aurait fourni est ignoré.
CREATE FUNCTION "mgx_apply_ledger_posting"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account "ledger_accounts"%ROWTYPE;
  new_balance numeric;
BEGIN
  -- Une ligne à la fois par compte. Le verrou est tenu jusqu'à la fin de la transaction : la
  -- ligne suivante lit le solde que celle-ci a validé.
  SELECT a.* INTO account
  FROM "ledger_accounts" AS a
  WHERE a."id" = NEW."account_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account % does not exist', NEW."account_id"
      USING ERRCODE = 'MGX08';
  END IF;

  -- Un montant n'a de sens que dans l'actif de son compte : mille francs ne sont pas mille
  -- dollars, et un centime n'est pas un satoshi.
  IF NEW."asset_code" IS DISTINCT FROM account."asset_code" THEN
    RAISE EXCEPTION 'ledger account % is kept in %, not in %',
      account."id", account."asset_code", NEW."asset_code"
      USING ERRCODE = 'MGX08';
  END IF;

  -- Rien ne s'écrit sur les comptes d'un titulaire clôturé. Le verrou (FOR KEY SHARE, celui
  -- que prend une clé étrangère) et celui de la clôture s'excluent : soit la ligne est passée
  -- avant la clôture — qui la voit, et échoue si elle laisse des fonds —, soit elle attend la
  -- clôture et est refusée.
  IF account."user_id" IS NOT NULL THEN
    PERFORM 1 FROM "users" AS u
    WHERE u."id" = account."user_id" AND u."status" <> 'CLOSED'
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'account % is closed: nothing can be posted to its ledger accounts',
        account."user_id"
        USING ERRCODE = 'MGX05';
    END IF;
  END IF;

  -- Le solde du compte n'est que le reflet de sa dernière ligne. S'il en diffère, le compte a
  -- été altéré : plus rien ne s'y écrit tant qu'il n'a pas été examiné.
  IF account."posting_count" > 0 AND NOT EXISTS (
    SELECT 1 FROM "ledger_postings" AS p
    WHERE p."account_id" = account."id"
      AND p."account_sequence" = account."posting_count"
      AND p."balance_after" = account."balance"
  ) THEN
    RAISE EXCEPTION 'the balance of ledger account % is not the one of its last posting',
      account."id"
      USING ERRCODE = 'MGX08';
  END IF;

  -- Le sens normal du compte augmente son solde ; l'autre le diminue.
  new_balance := account."balance"
    + CASE WHEN NEW."side" = account."normal_side" THEN NEW."amount" ELSE -NEW."amount" END;
  IF new_balance < 0 THEN
    RAISE EXCEPTION 'insufficient funds on ledger account %', account."id"
      USING ERRCODE = 'MGX09';
  END IF;

  NEW."account_sequence" := account."posting_count" + 1;
  NEW."balance_after" := new_balance;

  UPDATE "ledger_accounts"
  SET "balance" = new_balance, "posting_count" = NEW."account_sequence"
  WHERE "id" = account."id";

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_postings_apply"
  BEFORE INSERT ON "ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION "mgx_apply_ledger_posting"();

CREATE TRIGGER "ledger_postings_immutable_row"
  BEFORE UPDATE OR DELETE ON "ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_postings_immutable_truncate"
  BEFORE TRUNCATE ON "ledger_postings"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Une écriture est entière et équilibrée, ou n'est pas. Vérifié à la validation de la
-- transaction, pour l'en-tête comme pour chacune de ses lignes — une ligne ajoutée plus tard à
-- une écriture déjà validée la rendrait incomplète, et serait donc refusée :
--   * elle a exactement le nombre de lignes qu'elle a déclaré, numérotées 1, 2, 3… ;
--   * ses lignes portent sur deux comptes au moins ;
--   * pour chaque actif, le total de ses débits égale celui de ses crédits.
CREATE FUNCTION "mgx_check_ledger_entry"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked uuid;
  declared integer;
  written integer;
  last_line integer;
  accounts integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    checked := NEW."id";
  ELSE
    checked := NEW."entry_id";
  END IF;

  SELECT e."posting_count" INTO declared FROM "ledger_entries" AS e WHERE e."id" = checked;
  SELECT count(*), max(p."line_number"), count(DISTINCT p."account_id")
  INTO written, last_line, accounts
  FROM "ledger_postings" AS p
  WHERE p."entry_id" = checked;

  IF written IS DISTINCT FROM declared OR last_line IS DISTINCT FROM declared THEN
    RAISE EXCEPTION 'ledger entry % declares % postings and holds %', checked, declared, written
      USING ERRCODE = 'MGX08';
  END IF;
  IF accounts < 2 THEN
    RAISE EXCEPTION 'ledger entry % moves nothing: all its postings are on one account', checked
      USING ERRCODE = 'MGX08';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ledger_postings" AS p
    WHERE p."entry_id" = checked
    GROUP BY p."asset_code"
    HAVING sum(CASE p."side" WHEN 'DEBIT' THEN p."amount" ELSE -p."amount" END) <> 0
  ) THEN
    RAISE EXCEPTION 'ledger entry % is not balanced: its debits and credits differ', checked
      USING ERRCODE = 'MGX08';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_sound"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_ledger_entry"();

CREATE CONSTRAINT TRIGGER "ledger_postings_entry_sound"
  AFTER INSERT ON "ledger_postings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_ledger_entry"();

-- --- users, account_closures ---------------------------------------------------------------
-- Un compte ne se clôt pas tant qu'il détient des fonds : ils sont d'abord retirés ou
-- transférés. Une ligne en cours attend la clôture, ou la clôture l'attend (voir
-- « mgx_apply_ledger_posting ») : ce contrôle voit donc tout ce qui a été passé avant elle.
CREATE FUNCTION "mgx_forbid_closure_with_funds"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ledger_accounts" AS a WHERE a."user_id" = NEW."id" AND a."balance" <> 0
  ) THEN
    RAISE EXCEPTION 'account % still holds funds: it cannot be closed', NEW."id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_closure_leaves_no_funds"
  BEFORE UPDATE ON "users"
  FOR EACH ROW
  WHEN (NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED')
  EXECUTE FUNCTION "mgx_forbid_closure_with_funds"();

-- Conservation : dès lors qu'une écriture a été passée sur un compte du titulaire, la trace de
-- sa clôture garde son adresse et son numéro dix ans — ce qui permet de rattacher une
-- opération à une personne (même durée, comptée de la même façon, que pour les dossiers de
-- vérification : voir la migration « account_closure » et l'ADR 0025). Les écritures, elles,
-- ne s'effacent jamais.
CREATE FUNCTION "mgx_enforce_closure_ledger_retention"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ledger_accounts" AS a
    WHERE a."user_id" = NEW."user_id" AND a."posting_count" > 0
  ) AND (NEW."legal_retention_until" IS NULL
         OR NEW."legal_retention_until"
            < ((NEW."closed_at" AT TIME ZONE 'UTC') + INTERVAL '10 years') AT TIME ZONE 'UTC')
  THEN
    RAISE EXCEPTION
      'the identifiers of account % must be retained for ten years after its closure: entries were posted to its ledger accounts',
      NEW."user_id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NEW;
END;
$$;

-- Son nom le fait s'exécuter après « account_closures_enforce », qui verrouille le compte.
CREATE TRIGGER "account_closures_ledger_retention"
  BEFORE INSERT ON "account_closures"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_closure_ledger_retention"();

-- --- Robustesse des fonctions ----------------------------------------------------------------
-- Les règles ne doivent résoudre les noms que dans le schéma de l'application : sans cela, une
-- table temporaire homonyme (« ledger_accounts », « users »…) placée par la session sur son
-- chemin de recherche répondrait à leur place. Leur chemin de recherche est figé sur le schéma
-- dans lequel la migration s'exécute.
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_enforce_asset"()',
    '"mgx_enforce_ledger_account"()',
    '"mgx_check_ledger_account_balance"()',
    '"mgx_stamp_ledger_entry"()',
    '"mgx_apply_ledger_posting"()',
    '"mgx_check_ledger_entry"()',
    '"mgx_forbid_closure_with_funds"()',
    '"mgx_enforce_closure_ledger_retention"()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', signature, current_schema());
  END LOOP;
END
$$;

-- --- Privilèges ----------------------------------------------------------------------------
-- Défense en profondeur : en plus des déclencheurs, le rôle applicatif perd les privilèges
-- dont il n'a pas l'usage. Il garde UPDATE sur « ledger_accounts » : c'est ce privilège qui
-- permet de verrouiller un compte (FOR UPDATE), et c'est sous son nom que la base met le solde
-- à jour lorsqu'il passe une ligne.
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
      AND grants.table_name IN (
        'assets', 'ledger_account_types', 'ledger_accounts', 'ledger_entries', 'ledger_postings')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "assets" FROM %I', grantee_name);
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ledger_account_types" FROM %I',
      grantee_name);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE "ledger_accounts" FROM %I', grantee_name);
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger_entries" FROM %I', grantee_name);
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger_postings" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Plan de comptes -----------------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "ledger_account_types" ("key", "owner", "normal_side", "description") VALUES
  ('user_available', 'USER', 'CREDIT', 'Funds a holder can use.'),
  ('platform_custody', 'PLATFORM', 'DEBIT',
   'Funds held outside the ledger on behalf of holders: bank, mobile money, custody of crypto-assets.'),
  ('platform_fees', 'PLATFORM', 'CREDIT', 'Fees earned by the platform.');

-- --- Catalogue des permissions -------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('ledger.read', 'View the ledger: assets, accounts, balances, entries and the trial balance.'),
  ('ledger.manage_assets', 'Register the assets in which the platform keeps accounts.');

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
