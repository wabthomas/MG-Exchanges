-- CreateTable
CREATE TABLE "transfer_limits" (
    "asset_code" VARCHAR(12) NOT NULL,
    "kyc_level" SMALLINT NOT NULL,
    "per_transfer_max" DECIMAL(38,0) NOT NULL,
    "daily_max" DECIMAL(38,0) NOT NULL,
    "monthly_max" DECIMAL(38,0) NOT NULL,
    "set_by" UUID,
    "set_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_limits_pkey" PRIMARY KEY ("asset_code","kyc_level")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sender_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "entry_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_digest" BYTEA NOT NULL,
    "sender_level" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfers_entry_id_key" ON "transfers"("entry_id");

-- CreateIndex
CREATE INDEX "transfers_sender_id_asset_code_created_at_idx" ON "transfers"("sender_id", "asset_code", "created_at");

-- CreateIndex
CREATE INDEX "transfers_sender_id_id_idx" ON "transfers"("sender_id", "id");

-- CreateIndex
CREATE INDEX "transfers_recipient_id_id_idx" ON "transfers"("recipient_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_sender_id_idempotency_key_key" ON "transfers"("sender_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "transfer_limits" ADD CONSTRAINT "transfer_limits_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_limits" ADD CONSTRAINT "transfer_limits_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/transfers-schema.spec.ts.
--
-- Transferts entre titulaires. La base impose elle-même, quel que soit le code qui écrit :
--   * des plafonds — par transfert, sur 24 heures, sur 31 jours — positifs ou nuls et
--     croissants ; seul les fixe un membre du personnel actif qui détient
--     « transfer_limits.write » — ou le rôle propriétaire ; une ligne de plafonds ne se
--     supprime pas, et ne change ni d'actif, ni de niveau ;
--   * un transfert ne se modifie ni ne s'efface ; son heure est celle de la base ;
--   * il a lieu entre deux comptes distincts, tous deux actifs ;
--   * le niveau qu'il porte est le niveau de vérification de l'émetteur à cet instant ; ce
--     niveau a des plafonds dans l'actif, et le montant les respecte tous — les cumuls étant
--     comptés sous le verrou de l'émetteur, un transfert à la fois ;
--   * le niveau de vérification du destinataire est lui aussi ouvert dans l'actif ;
--   * à la validation de la transaction, l'écriture qu'il désigne est la sienne : de type
--     « transfer.internal », deux lignes — l'une débite les fonds disponibles de l'émetteur,
--     l'autre crédite ceux du destinataire, du même montant dans le même actif ; et toute
--     écriture de ce type a son transfert.
-- Une règle enfreinte lève l'erreur MGX10 ; la modification d'une table en ajout seul, MGX01.
-- =======================================================================================

-- --- Niveau de vérification d'un compte ------------------------------------------------------
-- Le plus haut niveau dont tous les précédents sont vérifiés : un niveau 2 accepté ne compte
-- pas tant que le niveau 1 ne l'est pas — ou ne l'est plus. Même règle que l'application
-- (`verifiedLevelOf`) ; un test vérifie que les deux s'accordent.
CREATE FUNCTION "mgx_verified_level"(uuid) RETURNS smallint
LANGUAGE sql
STABLE
AS $$
  SELECT (CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM "kyc_cases" AS c
      WHERE c."user_id" = $1 AND c."status" = 'APPROVED' AND c."level" = 1
    ) THEN 0
    WHEN NOT EXISTS (
      SELECT 1 FROM "kyc_cases" AS c
      WHERE c."user_id" = $1 AND c."status" = 'APPROVED' AND c."level" = 2
    ) THEN 1
    WHEN NOT EXISTS (
      SELECT 1 FROM "kyc_cases" AS c
      WHERE c."user_id" = $1 AND c."status" = 'APPROVED' AND c."level" = 3
    ) THEN 2
    ELSE 3
  END)::smallint;
$$;

-- --- transfer_limits -------------------------------------------------------------------------
ALTER TABLE "transfer_limits"
  ADD CONSTRAINT "transfer_limits_kyc_level_check"
    CHECK ("kyc_level" BETWEEN 0 AND 3),
  -- Positifs ou nuls, et croissants : un transfert ne dépasse pas ce qu'une journée admet, ni
  -- une journée ce qu'un mois admet.
  ADD CONSTRAINT "transfer_limits_amounts_check"
    CHECK (0 <= "per_transfer_max"
           AND "per_transfer_max" <= "daily_max"
           AND "daily_max" <= "monthly_max");

CREATE FUNCTION "mgx_enforce_transfer_limit"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."asset_code", NEW."kyc_level") IS DISTINCT FROM (OLD."asset_code", OLD."kyc_level")
  THEN
    RAISE EXCEPTION 'transfer limits cannot change their asset or their verification level'
      USING ERRCODE = 'MGX10';
  END IF;

  IF NEW."set_by" IS NULL THEN
    -- Sans auteur : réservé au rôle propriétaire (outil d'exploitation). L'API, elle, se
    -- connecte avec le rôle applicatif et désigne toujours un membre du personnel.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_tables AS t
      WHERE t.schemaname = TG_TABLE_SCHEMA
        AND t.tablename = TG_TABLE_NAME
        AND t.tableowner = current_user
    ) THEN
      RAISE EXCEPTION 'transfer limits without an author can only be set by the owner role'
        USING ERRCODE = 'MGX10';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "users" AS u
    JOIN "user_roles" AS ur ON ur."user_id" = u."id"
    JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
    WHERE u."id" = NEW."set_by"
      AND u."status" = 'ACTIVE'
      AND rp."permission_key" = 'transfer_limits.write'
  ) THEN
    RAISE EXCEPTION 'account % is not entitled to set transfer limits', NEW."set_by"
      USING ERRCODE = 'MGX10';
  END IF;

  NEW."set_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "transfer_limits_enforce"
  BEFORE INSERT OR UPDATE ON "transfer_limits"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_transfer_limit"();

-- Des plafonds ne se suppriment pas : refermer un niveau, c'est les ramener à zéro — la ligne
-- reste, et dit qui l'a décidé.
CREATE TRIGGER "transfer_limits_no_delete"
  BEFORE DELETE ON "transfer_limits"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "transfer_limits_no_truncate"
  BEFORE TRUNCATE ON "transfer_limits"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- transfers -------------------------------------------------------------------------------
ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_check"
    CHECK ("amount" > 0),
  ADD CONSTRAINT "transfers_parties_check"
    CHECK ("sender_id" <> "recipient_id"),
  ADD CONSTRAINT "transfers_sender_level_check"
    CHECK ("sender_level" BETWEEN 0 AND 3),
  -- Même format que le contrat (@mgx/contracts) : 16 à 128 caractères sûrs.
  ADD CONSTRAINT "transfers_idempotency_key_format_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  -- Une empreinte SHA-256.
  ADD CONSTRAINT "transfers_request_digest_check"
    CHECK (octet_length("request_digest") = 32);

-- Cumul des envois d'un émetteur dans un actif, sur 24 heures et sur 31 jours glissants, à
-- l'horloge de la base. Les durées sont comptées en heures : elles ne dépendent d'aucun fuseau.
CREATE FUNCTION "mgx_transfer_usage"(
  uuid,
  varchar,
  OUT "last_24_hours" numeric,
  OUT "last_31_days" numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
  moment timestamptz := clock_timestamp();
BEGIN
  SELECT
    coalesce(sum(t."amount") FILTER (WHERE t."created_at" > moment - INTERVAL '24 hours'), 0),
    coalesce(sum(t."amount"), 0)
  INTO "last_24_hours", "last_31_days"
  FROM "transfers" AS t
  WHERE t."sender_id" = $1
    AND t."asset_code" = $2
    AND t."created_at" > moment - INTERVAL '744 hours';
END;
$$;

CREATE FUNCTION "mgx_enforce_transfer"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sender_status "user_status";
  recipient_status "user_status";
  verified smallint;
  ceilings "transfer_limits"%ROWTYPE;
  used record;
BEGIN
  -- L'heure d'un transfert est lue à l'horloge de la base, jamais à celle de l'application.
  NEW."created_at" := clock_timestamp();

  -- Un transfert à la fois par émetteur : le verrou est tenu jusqu'à la fin de la transaction,
  -- le transfert suivant compte donc celui-ci dans ses cumuls. Ce verrou n'exclut pas celui
  -- qu'une écriture du grand livre prend sur ses titulaires (FOR KEY SHARE) : deux transferts
  -- croisés, de l'un à l'autre et de l'autre à l'un, ne s'interbloquent pas. Un compte inconnu
  -- est laissé à la clé étrangère, qui le signale.
  SELECT u."status" INTO sender_status
  FROM "users" AS u WHERE u."id" = NEW."sender_id"
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF sender_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'account % cannot send a transfer: it is %',
      NEW."sender_id", lower(sender_status::text)
      USING ERRCODE = 'MGX10';
  END IF;

  SELECT u."status" INTO recipient_status
  FROM "users" AS u WHERE u."id" = NEW."recipient_id"
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF recipient_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'account % cannot receive a transfer: it is %',
      NEW."recipient_id", lower(recipient_status::text)
      USING ERRCODE = 'MGX10';
  END IF;

  -- Les plafonds appliqués sont ceux du niveau de vérification de l'émetteur à cet instant.
  verified := "mgx_verified_level"(NEW."sender_id");
  IF NEW."sender_level" IS DISTINCT FROM verified THEN
    RAISE EXCEPTION 'the verification level of account % is %, not %',
      NEW."sender_id", verified, NEW."sender_level"
      USING ERRCODE = 'MGX10';
  END IF;

  SELECT l.* INTO ceilings
  FROM "transfer_limits" AS l
  WHERE l."asset_code" = NEW."asset_code" AND l."kyc_level" = verified;
  IF NOT FOUND OR ceilings."per_transfer_max" = 0 THEN
    RAISE EXCEPTION 'transfers in % are not open to verification level %',
      NEW."asset_code", verified
      USING ERRCODE = 'MGX10';
  END IF;
  IF NEW."amount" > ceilings."per_transfer_max" THEN
    RAISE EXCEPTION 'the transfer exceeds the limit per transfer of verification level % in %',
      verified, NEW."asset_code"
      USING ERRCODE = 'MGX10';
  END IF;

  SELECT * INTO used FROM "mgx_transfer_usage"(NEW."sender_id", NEW."asset_code");
  IF used."last_24_hours" + NEW."amount" > ceilings."daily_max" THEN
    RAISE EXCEPTION 'the transfer exceeds the limit over 24 hours of verification level % in %',
      verified, NEW."asset_code"
      USING ERRCODE = 'MGX10';
  END IF;
  IF used."last_31_days" + NEW."amount" > ceilings."monthly_max" THEN
    RAISE EXCEPTION 'the transfer exceeds the limit over 31 days of verification level % in %',
      verified, NEW."asset_code"
      USING ERRCODE = 'MGX10';
  END IF;

  -- Recevoir suppose, comme envoyer, que le niveau de vérification soit ouvert dans l'actif.
  IF NOT EXISTS (
    SELECT 1 FROM "transfer_limits" AS l
    WHERE l."asset_code" = NEW."asset_code"
      AND l."kyc_level" = "mgx_verified_level"(NEW."recipient_id")
      AND l."per_transfer_max" > 0
  ) THEN
    RAISE EXCEPTION 'transfers in % are not open to the verification level of account %',
      NEW."asset_code", NEW."recipient_id"
      USING ERRCODE = 'MGX10';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "transfers_enforce"
  BEFORE INSERT ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_transfer"();

-- Un transfert ne se modifie ni ne s'efface : c'est sur lui que se comptent les plafonds.
CREATE TRIGGER "transfers_immutable_row"
  BEFORE UPDATE OR DELETE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "transfers_immutable_truncate"
  BEFORE TRUNCATE ON "transfers"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Un transfert et son écriture vont ensemble. Vérifié à la validation de la transaction :
-- l'écriture désignée est de type « transfer.internal », et se compose de deux lignes — l'une
-- débite les fonds disponibles de l'émetteur, l'autre crédite ceux du destinataire, du
-- montant du transfert, dans son actif. Chaque ligne est vérifiée pour elle-même : la règle ne
-- s'en remet pas à l'équilibre de l'écriture, que le grand livre vérifie de son côté.
CREATE FUNCTION "mgx_check_transfer_entry"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_kind text;
  lines integer;
BEGIN
  SELECT e."kind" INTO entry_kind FROM "ledger_entries" AS e WHERE e."id" = NEW."entry_id";
  SELECT count(*) INTO lines FROM "ledger_postings" AS p WHERE p."entry_id" = NEW."entry_id";

  IF entry_kind IS DISTINCT FROM 'transfer.internal'
     OR lines <> 2
     OR NOT EXISTS (
       SELECT 1
       FROM "ledger_postings" AS p
       JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
       WHERE p."entry_id" = NEW."entry_id"
         AND p."side" = 'DEBIT'
         AND p."amount" = NEW."amount"
         AND p."asset_code" = NEW."asset_code"
         AND a."type_key" = 'user_available'
         AND a."user_id" = NEW."sender_id"
     )
     OR NOT EXISTS (
       SELECT 1
       FROM "ledger_postings" AS p
       JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
       WHERE p."entry_id" = NEW."entry_id"
         AND p."side" = 'CREDIT'
         AND p."amount" = NEW."amount"
         AND p."asset_code" = NEW."asset_code"
         AND a."type_key" = 'user_available'
         AND a."user_id" = NEW."recipient_id"
     )
  THEN
    RAISE EXCEPTION 'ledger entry % is not the one of transfer %', NEW."entry_id", NEW."id"
      USING ERRCODE = 'MGX10';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "transfers_entry_matches"
  AFTER INSERT ON "transfers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_transfer_entry"();

-- --- ledger_entries --------------------------------------------------------------------------
-- Réciproquement : une écriture de type « transfer.internal » n'existe pas sans son transfert —
-- aucun mouvement de ce type n'échappe donc aux plafonds.
CREATE FUNCTION "mgx_check_transfer_recorded"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "transfers" AS t WHERE t."entry_id" = NEW."id") THEN
    RAISE EXCEPTION 'ledger entry % is a transfer entry without a transfer', NEW."id"
      USING ERRCODE = 'MGX10';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_transfer_recorded"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."kind" = 'transfer.internal')
  EXECUTE FUNCTION "mgx_check_transfer_recorded"();

-- --- Robustesse des fonctions ----------------------------------------------------------------
-- Les règles ne résolvent les noms que dans le schéma de l'application (voir la migration
-- « ledger »).
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_verified_level"(uuid)',
    '"mgx_enforce_transfer_limit"()',
    '"mgx_transfer_usage"(uuid, varchar)',
    '"mgx_enforce_transfer"()',
    '"mgx_check_transfer_entry"()',
    '"mgx_check_transfer_recorded"()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', signature, current_schema());
  END LOOP;
END
$$;

-- --- Privilèges ----------------------------------------------------------------------------
-- Défense en profondeur : en plus des déclencheurs, le rôle applicatif perd les privilèges
-- dont il n'a pas l'usage.
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
      AND grants.table_name IN ('transfer_limits', 'transfers')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE "transfer_limits" FROM %I', grantee_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "transfers" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions -------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('transfer_limits.read', 'View the transfer limits of each verification level.'),
  ('transfer_limits.write', 'Set the transfer limits of each verification level.');

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
