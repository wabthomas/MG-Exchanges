-- CreateEnum
CREATE TYPE "ledger_adjustment_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ledger_adjustments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "direction" "ledger_side" NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ledger_adjustment_status" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(500),
    "entry_id" UUID,

    CONSTRAINT "ledger_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_freezes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "frozen_by" UUID NOT NULL,
    "frozen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_by" UUID,
    "lifted_at" TIMESTAMPTZ(6),
    "lift_reason" VARCHAR(500),

    CONSTRAINT "wallet_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_adjustments_entry_id_key" ON "ledger_adjustments"("entry_id");

-- CreateIndex
CREATE INDEX "ledger_adjustments_status_id_idx" ON "ledger_adjustments"("status", "id");

-- CreateIndex
CREATE INDEX "ledger_adjustments_user_id_id_idx" ON "ledger_adjustments"("user_id", "id");

-- CreateIndex
CREATE INDEX "wallet_freezes_user_id_id_idx" ON "wallet_freezes"("user_id", "id");

-- AddForeignKey
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_freezes" ADD CONSTRAINT "wallet_freezes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_freezes" ADD CONSTRAINT "wallet_freezes_asset_code_fkey" FOREIGN KEY ("asset_code") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_freezes" ADD CONSTRAINT "wallet_freezes_frozen_by_fkey" FOREIGN KEY ("frozen_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_freezes" ADD CONSTRAINT "wallet_freezes_lifted_by_fkey" FOREIGN KEY ("lifted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par
-- test/integration/staff-operations-schema.spec.ts.
--
-- Opérations du personnel sur les portefeuilles. La base impose elle-même, quel que soit le
-- code qui écrit :
--   * un ajustement manuel — crédit ou débit d'un portefeuille — est demandé par un membre du
--     personnel actif qui détient « adjustments.request », pour un autre compte que le sien ;
--     l'heure de la demande et son échéance (72 heures) sont celles de la base ;
--   * il est décidé une seule fois, et ses termes ne changent pas ; l'approuver ou le refuser
--     revient à un second membre du personnel, actif, détenteur de « adjustments.approve »,
--     qui n'est ni l'auteur de la demande, ni le titulaire ; seul son auteur le retire ; il
--     n'échoit qu'une fois son échéance passée ;
--   * à l'approbation, la demande n'est pas échue et son auteur détient toujours sa
--     permission ; à la validation de la transaction, l'écriture désignée est la sienne : de
--     type « adjustment.credit » ou « adjustment.debit », deux lignes — l'une sur les fonds
--     disponibles du titulaire, dans le sens de l'ajustement, l'autre, de sens inverse, sur le
--     compte de conservation de la plateforme, du même montant dans le même actif ; et toute
--     écriture de ce type a son ajustement approuvé ;
--   * un portefeuille est gelé par un membre du personnel actif qui détient
--     « wallet_freezes.create », jamais le sien ; le gel attend l'écriture en cours sur ce
--     portefeuille, et toute écriture qui le suit le voit ; il est levé une seule fois, par un
--     détenteur de « wallet_freezes.lift » ; un seul gel en vigueur par portefeuille ;
--   * tant qu'un portefeuille est gelé, aucune ligne ne passe sur les comptes de son titulaire
--     dans cet actif — hors les écritures d'ajustement ;
--   * un compte dont un portefeuille est gelé ne se clôt pas ;
--   * ni une demande d'ajustement, ni un gel ne s'effacent.
-- Une règle enfreinte lève l'erreur MGX11 ; une ligne passée sur un portefeuille gelé, MGX12 ;
-- une règle de clôture, MGX04 ; une demande ou un gel visant un compte clôturé, MGX05 ; la
-- suppression d'une ligne, MGX01.
-- =======================================================================================

-- --- Qualité d'un membre du personnel ----------------------------------------------------------
-- Vrai si le compte est actif et détient la permission, à cet instant. La fonction n'est pas
-- déclarée STABLE : chacune de ses lectures voit ce qui a été validé jusque-là, y compris
-- pendant que l'instruction appelante attendait un verrou.
CREATE FUNCTION "mgx_holds_permission"(uuid, text) RETURNS boolean
LANGUAGE sql
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "users" AS u
    JOIN "user_roles" AS ur ON ur."user_id" = u."id"
    JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
    WHERE u."id" = $1
      AND u."status" = 'ACTIVE'
      AND rp."permission_key" = $2
  );
$$;

-- --- ledger_adjustments ----------------------------------------------------------------------
ALTER TABLE "ledger_adjustments"
  ADD CONSTRAINT "ledger_adjustments_amount_check"
    CHECK ("amount" > 0),
  ADD CONSTRAINT "ledger_adjustments_reason_not_blank_check"
    CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "ledger_adjustments_decision_note_not_blank_check"
    CHECK ("decision_note" IS NULL OR btrim("decision_note") <> ''),
  ADD CONSTRAINT "ledger_adjustments_expiry_check"
    CHECK ("expires_at" > "requested_at"),
  -- Nul ne prend part à un ajustement de son propre portefeuille : ni pour le demander…
  ADD CONSTRAINT "ledger_adjustments_not_self_requested_check"
    CHECK ("requested_by" <> "user_id"),
  -- Une demande en attente n'a ni décision, ni écriture ; une demande échue n'a été décidée
  -- par personne ; seule une demande approuvée a son écriture.
  ADD CONSTRAINT "ledger_adjustments_decision_check"
    CHECK (
      ("status" = 'PENDING'
        AND "decided_at" IS NULL AND "decided_by" IS NULL AND "decision_note" IS NULL
        AND "entry_id" IS NULL)
      OR ("status" = 'EXPIRED'
        AND "decided_at" IS NOT NULL AND "decided_by" IS NULL AND "entry_id" IS NULL)
      OR ("status" IN ('REJECTED', 'CANCELLED')
        AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "entry_id" IS NULL)
      OR ("status" = 'APPROVED'
        AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "entry_id" IS NOT NULL)
    ),
  -- …ni pour le décider. Double validation : la décision vient d'une autre personne que
  -- l'auteur de la demande.
  ADD CONSTRAINT "ledger_adjustments_four_eyes_check"
    CHECK (
      "status" NOT IN ('APPROVED', 'REJECTED')
      OR ("decided_by" <> "requested_by" AND "decided_by" <> "user_id")
    ),
  -- Seul l'auteur d'une demande la retire.
  ADD CONSTRAINT "ledger_adjustments_cancelled_by_requester_check"
    CHECK ("status" <> 'CANCELLED' OR "decided_by" = "requested_by"),
  -- Un refus est motivé.
  ADD CONSTRAINT "ledger_adjustments_rejection_note_check"
    CHECK ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL);

-- Une seule demande identique en attente : même portefeuille, même sens, même montant. Une
-- demande renvoyée par erreur ne peut donc pas être approuvée deux fois.
CREATE UNIQUE INDEX "ledger_adjustments_pending_key"
  ON "ledger_adjustments" ("user_id", "asset_code", "direction", "amount")
  WHERE "status" = 'PENDING';

CREATE FUNCTION "mgx_enforce_ledger_adjustment"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  holder_status "user_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'a ledger adjustment is created pending'
        USING ERRCODE = 'MGX11';
    END IF;
    -- Un compte inconnu est laissé à la clé étrangère, qui le signale ; un compte clôturé, au
    -- déclencheur « ledger_adjustments_account_open », exécuté avant celui-ci. Reste
    -- l'inscription jamais vérifiée : elle ne détient pas de fonds.
    SELECT u."status" INTO holder_status FROM "users" AS u WHERE u."id" = NEW."user_id";
    IF FOUND AND holder_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
      RAISE EXCEPTION 'account % has no wallet to adjust: it is %',
        NEW."user_id", lower(holder_status::text)
        USING ERRCODE = 'MGX11';
    END IF;
    IF NOT "mgx_holds_permission"(NEW."requested_by", 'adjustments.request') THEN
      RAISE EXCEPTION 'account % is not entitled to request a ledger adjustment',
        NEW."requested_by"
        USING ERRCODE = 'MGX11';
    END IF;
    -- L'heure de la demande et son échéance sont lues à l'horloge de la base, jamais à celle
    -- de l'application.
    NEW."requested_at" := clock_timestamp();
    NEW."expires_at" := NEW."requested_at" + INTERVAL '72 hours';
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'ledger adjustment % is already decided (%)', OLD."id", OLD."status"
      USING ERRCODE = 'MGX11';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'a pending ledger adjustment can only be decided'
      USING ERRCODE = 'MGX11';
  END IF;
  IF (NEW."id", NEW."user_id", NEW."asset_code", NEW."direction", NEW."amount", NEW."reason",
      NEW."requested_by", NEW."requested_at", NEW."expires_at")
     IS DISTINCT FROM
     (OLD."id", OLD."user_id", OLD."asset_code", OLD."direction", OLD."amount", OLD."reason",
      OLD."requested_by", OLD."requested_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'the terms of a ledger adjustment cannot be modified'
      USING ERRCODE = 'MGX11';
  END IF;

  -- L'heure de la décision est celle de la base.
  NEW."decided_at" := clock_timestamp();

  IF NEW."status" = 'EXPIRED' THEN
    IF OLD."expires_at" > NEW."decided_at" THEN
      RAISE EXCEPTION 'ledger adjustment % has not expired yet', OLD."id"
        USING ERRCODE = 'MGX11';
    END IF;
    RETURN NEW;
  END IF;

  -- Retrait par son auteur : la contrainte « cancelled_by_requester » dit qui.
  IF NEW."status" = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  -- Approbation ou refus : la décision d'un membre du personnel actif et habilité (qu'il soit
  -- un autre que l'auteur et que le titulaire est garanti par la contrainte « four_eyes » ;
  -- une décision sans auteur, par la contrainte « decision »).
  IF NEW."decided_by" IS NOT NULL
     AND NOT "mgx_holds_permission"(NEW."decided_by", 'adjustments.approve') THEN
    RAISE EXCEPTION 'account % is not entitled to decide on a ledger adjustment',
      NEW."decided_by"
      USING ERRCODE = 'MGX11';
  END IF;
  IF NEW."status" = 'REJECTED' THEN
    RETURN NEW;
  END IF;

  IF OLD."expires_at" <= NEW."decided_at" THEN
    RAISE EXCEPTION 'ledger adjustment % has expired', OLD."id"
      USING ERRCODE = 'MGX11';
  END IF;
  -- L'auteur de la demande a toujours qualité pour la faire : une demande déposée par un
  -- compte suspendu depuis, ou privé de sa permission, ne s'approuve plus.
  IF NOT "mgx_holds_permission"(NEW."requested_by", 'adjustments.request') THEN
    RAISE EXCEPTION 'account % is no longer entitled to request a ledger adjustment',
      NEW."requested_by"
      USING ERRCODE = 'MGX11';
  END IF;
  RETURN NEW;
END;
$$;

-- Rien ne s'ajoute à un compte clôturé (MGX05) : même déclencheur que pour ses autres lignes.
-- Son nom le fait s'exécuter avant « ledger_adjustments_enforce ».
CREATE TRIGGER "ledger_adjustments_account_open"
  BEFORE INSERT ON "ledger_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();

CREATE TRIGGER "ledger_adjustments_enforce"
  BEFORE INSERT OR UPDATE ON "ledger_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_ledger_adjustment"();

-- Une demande ne s'efface pas : elle est la trace de la décision.
CREATE TRIGGER "ledger_adjustments_no_delete"
  BEFORE DELETE ON "ledger_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "ledger_adjustments_no_truncate"
  BEFORE TRUNCATE ON "ledger_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Un ajustement approuvé et son écriture vont ensemble. Vérifié à la validation de la
-- transaction : l'écriture désignée est du type de l'ajustement, et se compose de deux lignes —
-- l'une sur les fonds disponibles du titulaire, dans le sens de l'ajustement ; l'autre, de sens
-- inverse, sur le compte de conservation de la plateforme ; toutes deux de son montant, dans
-- son actif. Chaque ligne est vérifiée pour elle-même, quel que soit leur ordre.
CREATE FUNCTION "mgx_check_adjustment_entry"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_kind text;
  lines integer;
BEGIN
  SELECT e."kind" INTO entry_kind FROM "ledger_entries" AS e WHERE e."id" = NEW."entry_id";
  SELECT count(*) INTO lines FROM "ledger_postings" AS p WHERE p."entry_id" = NEW."entry_id";

  IF entry_kind IS DISTINCT FROM
       (CASE NEW."direction" WHEN 'CREDIT' THEN 'adjustment.credit' ELSE 'adjustment.debit' END)
     OR lines <> 2
     OR NOT EXISTS (
       SELECT 1
       FROM "ledger_postings" AS p
       JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
       WHERE p."entry_id" = NEW."entry_id"
         AND p."side" = NEW."direction"
         AND p."amount" = NEW."amount"
         AND p."asset_code" = NEW."asset_code"
         AND a."type_key" = 'user_available'
         AND a."user_id" = NEW."user_id"
     )
     OR NOT EXISTS (
       SELECT 1
       FROM "ledger_postings" AS p
       JOIN "ledger_accounts" AS a ON a."id" = p."account_id"
       WHERE p."entry_id" = NEW."entry_id"
         AND p."side" <> NEW."direction"
         AND p."amount" = NEW."amount"
         AND p."asset_code" = NEW."asset_code"
         AND a."type_key" = 'platform_custody'
         AND a."user_id" IS NULL
     )
  THEN
    RAISE EXCEPTION 'ledger entry % is not the one of ledger adjustment %',
      NEW."entry_id", NEW."id"
      USING ERRCODE = 'MGX11';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_adjustments_entry_matches"
  AFTER UPDATE ON "ledger_adjustments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."status" = 'APPROVED')
  EXECUTE FUNCTION "mgx_check_adjustment_entry"();

-- --- ledger_entries --------------------------------------------------------------------------
-- Réciproquement : une écriture d'ajustement n'existe pas sans son ajustement approuvé — aucun
-- crédit, aucun débit de ce type n'échappe donc à la double validation.
CREATE FUNCTION "mgx_check_adjustment_recorded"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ledger_adjustments" AS j
    WHERE j."entry_id" = NEW."id" AND j."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'ledger entry % is an adjustment entry without an approved adjustment',
      NEW."id"
      USING ERRCODE = 'MGX11';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_entries_adjustment_recorded"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."kind" IN ('adjustment.credit', 'adjustment.debit'))
  EXECUTE FUNCTION "mgx_check_adjustment_recorded"();

-- --- wallet_freezes --------------------------------------------------------------------------
ALTER TABLE "wallet_freezes"
  ADD CONSTRAINT "wallet_freezes_reason_not_blank_check"
    CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "wallet_freezes_lift_reason_not_blank_check"
    CHECK ("lift_reason" IS NULL OR btrim("lift_reason") <> ''),
  -- Nul ne gèle son propre portefeuille, ni n'en lève le gel.
  ADD CONSTRAINT "wallet_freezes_not_self_frozen_check"
    CHECK ("frozen_by" <> "user_id"),
  ADD CONSTRAINT "wallet_freezes_not_self_lifted_check"
    CHECK ("lifted_by" IS NULL OR "lifted_by" <> "user_id"),
  -- Un gel en vigueur n'a pas de levée ; un gel levé en a une, entière : son auteur, son
  -- heure, sa raison.
  ADD CONSTRAINT "wallet_freezes_lift_check"
    CHECK (
      ("lifted_at" IS NULL AND "lifted_by" IS NULL AND "lift_reason" IS NULL)
      OR ("lifted_at" IS NOT NULL AND "lifted_by" IS NOT NULL AND "lift_reason" IS NOT NULL
          AND "lifted_at" >= "frozen_at")
    );

-- Un seul gel en vigueur par portefeuille. C'est aussi l'index par lequel chaque ligne
-- d'écriture cherche le gel de son portefeuille.
CREATE UNIQUE INDEX "wallet_freezes_in_force_key"
  ON "wallet_freezes" ("user_id", "asset_code")
  WHERE "lifted_at" IS NULL;

CREATE FUNCTION "mgx_enforce_wallet_freeze"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  holder_status "user_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."lifted_at" IS NOT NULL OR NEW."lifted_by" IS NOT NULL
       OR NEW."lift_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'a wallet freeze is created in force'
        USING ERRCODE = 'MGX11';
    END IF;

    -- Le titulaire d'abord — même verrou que celui d'un transfert sur son émetteur : le
    -- transfert qu'il a en cours s'achève avant le gel, et le suivant le voit. Un compte
    -- inconnu est laissé à la clé étrangère, qui le signale ; un compte clôturé, au déclencheur
    -- « wallet_freezes_account_open », exécuté avant celui-ci.
    SELECT u."status" INTO holder_status
    FROM "users" AS u WHERE u."id" = NEW."user_id"
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF holder_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
      RAISE EXCEPTION 'account % has no wallet to freeze: it is %',
        NEW."user_id", lower(holder_status::text)
        USING ERRCODE = 'MGX11';
    END IF;
    IF NOT "mgx_holds_permission"(NEW."frozen_by", 'wallet_freezes.create') THEN
      RAISE EXCEPTION 'account % is not entitled to freeze a wallet', NEW."frozen_by"
        USING ERRCODE = 'MGX11';
    END IF;

    -- Puis ses comptes dans l'actif — l'ordre des verrous d'une écriture : les titulaires, les
    -- comptes. Le compte « fonds disponibles » est ouvert s'il ne l'était pas : il y a ainsi
    -- toujours un verrou à prendre. Toute ligne en cours sur le portefeuille s'achève avant le
    -- gel ; toute ligne qui le suit attend, puis le voit (« mgx_forbid_frozen_wallet_posting »).
    -- Un actif inconnu est laissé à la clé étrangère de la table.
    IF EXISTS (SELECT 1 FROM "assets" AS x WHERE x."code" = NEW."asset_code") THEN
      INSERT INTO "ledger_accounts" ("type_key", "asset_code", "user_id")
      VALUES ('user_available', NEW."asset_code", NEW."user_id")
      ON CONFLICT ("user_id", "asset_code", "type_key") WHERE "user_id" IS NOT NULL
      DO NOTHING;
      PERFORM 1
      FROM "ledger_accounts" AS a
      WHERE a."user_id" = NEW."user_id" AND a."asset_code" = NEW."asset_code"
      ORDER BY a."id"
      FOR UPDATE;
    END IF;

    -- L'heure du gel est lue à l'horloge de la base, une fois ces verrous obtenus.
    NEW."frozen_at" := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD."lifted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'wallet freeze % is already lifted', OLD."id"
      USING ERRCODE = 'MGX11';
  END IF;
  IF (NEW."id", NEW."user_id", NEW."asset_code", NEW."reason", NEW."frozen_by", NEW."frozen_at")
     IS DISTINCT FROM
     (OLD."id", OLD."user_id", OLD."asset_code", OLD."reason", OLD."frozen_by", OLD."frozen_at")
  THEN
    RAISE EXCEPTION 'the terms of a wallet freeze cannot be modified'
      USING ERRCODE = 'MGX11';
  END IF;
  IF NEW."lifted_by" IS NULL THEN
    RAISE EXCEPTION 'a wallet freeze in force can only be lifted'
      USING ERRCODE = 'MGX11';
  END IF;
  IF NOT "mgx_holds_permission"(NEW."lifted_by", 'wallet_freezes.lift') THEN
    RAISE EXCEPTION 'account % is not entitled to lift a wallet freeze', NEW."lifted_by"
      USING ERRCODE = 'MGX11';
  END IF;
  NEW."lifted_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Rien ne s'ajoute à un compte clôturé (MGX05). Son nom le fait s'exécuter avant
-- « wallet_freezes_enforce ».
CREATE TRIGGER "wallet_freezes_account_open"
  BEFORE INSERT ON "wallet_freezes"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();

CREATE TRIGGER "wallet_freezes_enforce"
  BEFORE INSERT OR UPDATE ON "wallet_freezes"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_wallet_freeze"();

-- Un gel ne s'efface pas : levé, il reste la trace de ce qui a été décidé.
CREATE TRIGGER "wallet_freezes_no_delete"
  BEFORE DELETE ON "wallet_freezes"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "wallet_freezes_no_truncate"
  BEFORE TRUNCATE ON "wallet_freezes"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- ledger_postings -------------------------------------------------------------------------
-- Tant qu'un portefeuille est gelé, aucune ligne ne passe sur les comptes de son titulaire
-- dans cet actif — quelle que soit l'opération, y compris celles qui restent à écrire. Seules
-- passent les écritures d'ajustement : c'est par elles, sous double validation, que des fonds
-- quittent un portefeuille gelé.
--
-- Son nom le fait s'exécuter après « ledger_postings_apply », donc sous le verrou du compte —
-- celui qu'un gel prend lui aussi : le gel validé pendant que la ligne attendait est vu.
CREATE FUNCTION "mgx_forbid_frozen_wallet_posting"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  holder uuid;
  asset text;
  entry_kind text;
BEGIN
  SELECT a."user_id", a."asset_code" INTO holder, asset
  FROM "ledger_accounts" AS a WHERE a."id" = NEW."account_id";
  IF holder IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "wallet_freezes" AS f
    WHERE f."user_id" = holder AND f."asset_code" = asset AND f."lifted_at" IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT e."kind" INTO entry_kind FROM "ledger_entries" AS e WHERE e."id" = NEW."entry_id";
  IF entry_kind IS NULL OR entry_kind NOT IN ('adjustment.credit', 'adjustment.debit') THEN
    RAISE EXCEPTION 'the % wallet of account % is frozen: nothing can be posted to it',
      asset, holder
      USING ERRCODE = 'MGX12';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ledger_postings_frozen_wallet"
  BEFORE INSERT ON "ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_frozen_wallet_posting"();

-- --- users -----------------------------------------------------------------------------------
-- Un compte dont un portefeuille est gelé ne se clôt pas : le gel est d'abord levé. Le gel
-- et la clôture verrouillent tous deux le compte : ce contrôle voit tout gel posé avant elle.
CREATE FUNCTION "mgx_forbid_closure_with_frozen_wallet"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "wallet_freezes" AS f WHERE f."user_id" = NEW."id" AND f."lifted_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'account % has a frozen wallet: it cannot be closed', NEW."id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_closure_leaves_no_freeze"
  BEFORE UPDATE ON "users"
  FOR EACH ROW
  WHEN (NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED')
  EXECUTE FUNCTION "mgx_forbid_closure_with_frozen_wallet"();

-- --- Robustesse des fonctions ----------------------------------------------------------------
-- Les règles ne résolvent les noms que dans le schéma de l'application (voir la migration
-- « ledger »).
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_holds_permission"(uuid, text)',
    '"mgx_enforce_ledger_adjustment"()',
    '"mgx_check_adjustment_entry"()',
    '"mgx_check_adjustment_recorded"()',
    '"mgx_enforce_wallet_freeze"()',
    '"mgx_forbid_frozen_wallet_posting"()',
    '"mgx_forbid_closure_with_frozen_wallet"()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', signature, current_schema());
  END LOOP;
END
$$;

-- --- Privilèges ----------------------------------------------------------------------------
-- Défense en profondeur : en plus des déclencheurs, le rôle applicatif perd les privilèges
-- dont il n'a pas l'usage. Il garde UPDATE sur les deux tables : décider d'une demande, lever
-- un gel.
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
      AND grants.table_name IN ('ledger_adjustments', 'wallet_freezes')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE "ledger_adjustments" FROM %I', grantee_name);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE "wallet_freezes" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions -------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('adjustments.read', 'View the manual adjustments of wallets and the decisions taken on them.'),
  ('adjustments.request', 'Request the manual credit or debit of a wallet.'),
  ('adjustments.approve',
   'Approve or reject a manual adjustment of a wallet requested by someone else.'),
  ('wallet_freezes.read', 'View the freezes of wallets.'),
  ('wallet_freezes.create', 'Freeze a wallet.'),
  ('wallet_freezes.lift', 'Lift the freeze of a wallet.');

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

-- La conformité gèle un portefeuille et consulte les gels ; lever un gel reste réservé.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "granted"."key"
FROM "roles"
CROSS JOIN (VALUES ('wallet_freezes.read'), ('wallet_freezes.create')) AS "granted" ("key")
WHERE "roles"."key" = 'compliance';
