-- CreateEnum
CREATE TYPE "account_closure_origin" AS ENUM ('HOLDER', 'STAFF');

-- CreateTable
CREATE TABLE "account_closures" (
    "user_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL,
    "origin" "account_closure_origin" NOT NULL,
    "closed_by" UUID NOT NULL,
    "email" VARCHAR(254),
    "phone" VARCHAR(16),
    "legal_retention_until" TIMESTAMPTZ(6),
    "erasure_due_at" TIMESTAMPTZ(6) NOT NULL,
    "erased_at" TIMESTAMPTZ(6),

    CONSTRAINT "account_closures_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "account_closures_email_idx" ON "account_closures"("email");

-- CreateIndex
CREATE INDEX "account_closures_phone_idx" ON "account_closures"("phone");

-- CreateIndex
CREATE INDEX "account_closures_erasure_due_at_idx" ON "account_closures"("erasure_due_at");

-- AddForeignKey
ALTER TABLE "account_closures" ADD CONSTRAINT "account_closures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_closures" ADD CONSTRAINT "account_closures_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/account-closure-schema.spec.ts
-- et test/integration/kyc-schema.spec.ts.
--
-- Clôture d'un compte. La base impose elle-même, quel que soit le code qui écrit :
--   * un compte ne se clôt qu'avec sa trace (« account_closures »), qui garde l'adresse et le
--     numéro qu'il portait ; clôturé, il ne porte plus d'identifiant, ni secret, ni session,
--     ni profil, ni rôle — et ne change plus jamais ;
--   * rien ne s'ajoute à un compte clôturé ;
--   * un membre du personnel ne clôt un compte que s'il est actif et détient « users.close » ;
--   * les dossiers de vérification sur lesquels une décision a été prise sont conservés dix
--     ans après la clôture : avant ce terme, lu à l'horloge de la base, ni eux ni la trace de
--     la clôture ne s'effacent.
-- Une règle enfreinte lève l'erreur MGX04 (MGX03 pour les dossiers de vérification) ; une
-- écriture qui vise un compte déjà clôturé — une ligne qu'on lui ajoute, ou le compte lui-même
-- qu'on modifie — lève MGX05.
-- =======================================================================================

-- --- users -------------------------------------------------------------------------------
ALTER TABLE "users"
  -- Un compte clôturé ne porte plus d'identifiant : son adresse est une adresse factice,
  -- dérivée de son identifiant, dans un domaine qui ne peut pas exister (RFC 2606).
  ADD CONSTRAINT "users_closed_is_anonymous_check"
    CHECK (
      "status" <> 'CLOSED'
      OR ("email" = 'closed-' || "id"::text || '@closed.invalid'
          AND "email_verified_at" IS NULL
          AND "phone" IS NULL AND "phone_verified_at" IS NULL)
    ),
  -- Ce domaine est réservé aux comptes clôturés : nul ne s'y inscrit, et l'adresse factice
  -- d'un compte ne peut donc pas être prise d'avance par un autre.
  ADD CONSTRAINT "users_reserved_email_domain_check"
    CHECK ("status" = 'CLOSED' OR "email" NOT LIKE '%@closed.invalid');

CREATE FUNCTION "mgx_enforce_user_closure"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'CLOSED' THEN
      RAISE EXCEPTION 'an account is not created closed'
        USING ERRCODE = 'MGX04';
    END IF;
    RETURN NEW;
  END IF;

  -- Un compte clôturé ne change plus jamais. Comme pour une ligne qu'on lui ajouterait, c'est
  -- le plus souvent une requête en cours au moment de la clôture : même erreur (MGX05).
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'account % is closed: it cannot be modified', OLD."id"
      USING ERRCODE = 'MGX05';
  END IF;

  IF NEW."status" = 'CLOSED' THEN
    IF OLD."status" NOT IN ('ACTIVE', 'SUSPENDED') THEN
      RAISE EXCEPTION 'only an active or suspended account can be closed'
        USING ERRCODE = 'MGX04';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "account_closures" AS c WHERE c."user_id" = NEW."id") THEN
      RAISE EXCEPTION 'account % cannot be closed without its closure record', NEW."id"
        USING ERRCODE = 'MGX04';
    END IF;
    IF EXISTS (SELECT 1 FROM "user_roles" AS r WHERE r."user_id" = NEW."id") THEN
      RAISE EXCEPTION 'account % holds a role: it cannot be closed', NEW."id"
        USING ERRCODE = 'MGX04';
    END IF;
    IF EXISTS (SELECT 1 FROM "user_credentials" AS x WHERE x."user_id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "user_totp_credentials" AS x WHERE x."user_id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "user_recovery_codes" AS x WHERE x."user_id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "user_sessions" AS x WHERE x."user_id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "verification_challenges" AS x WHERE x."user_id" = NEW."id")
       OR EXISTS (SELECT 1 FROM "user_profiles" AS x WHERE x."user_id" = NEW."id") THEN
      RAISE EXCEPTION
        'account % still holds a secret, a session, a code or a profile: it cannot be closed',
        NEW."id"
        USING ERRCODE = 'MGX04';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_enforce_closure"
  BEFORE INSERT OR UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_user_closure"();

-- Rien ne s'ajoute à un compte clôturé. Le verrou pris sur le compte et celui que prend la
-- clôture (FOR UPDATE, à l'écriture de sa trace) s'excluent : soit la ligne est écrite avant la
-- clôture — qui l'efface, ou échoue —, soit elle attend la clôture et est refusée. Jamais une
-- session, un code ou un dossier ne naît sur un compte clos.
-- Le verrou est le plus faible qui convienne (FOR KEY SHARE, celui que prend déjà la clé
-- étrangère) : il ne gêne aucune autre écriture du compte, et ne peut donc pas créer
-- d'interblocage entre deux transactions qui ajoutent une ligne puis modifient le compte.
CREATE FUNCTION "mgx_forbid_closed_account_rows"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM "users" AS u
  WHERE u."id" = NEW."user_id" AND u."status" <> 'CLOSED'
  FOR KEY SHARE;
  -- Un compte inconnu est laissé à la clé étrangère, qui le signale.
  IF NOT FOUND AND EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = NEW."user_id") THEN
    RAISE EXCEPTION 'account % is closed: nothing can be added to it (%)',
      NEW."user_id", TG_TABLE_NAME
      USING ERRCODE = 'MGX05';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_credentials_account_open"
  BEFORE INSERT ON "user_credentials"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "user_totp_credentials_account_open"
  BEFORE INSERT ON "user_totp_credentials"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "user_recovery_codes_account_open"
  BEFORE INSERT ON "user_recovery_codes"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "user_sessions_account_open"
  BEFORE INSERT ON "user_sessions"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "verification_challenges_account_open"
  BEFORE INSERT ON "verification_challenges"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "user_profiles_account_open"
  BEFORE INSERT ON "user_profiles"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "user_roles_account_open"
  BEFORE INSERT ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();
CREATE TRIGGER "kyc_cases_account_open"
  BEFORE INSERT ON "kyc_cases"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();

-- --- account_closures --------------------------------------------------------------------
ALTER TABLE "account_closures"
  -- Le titulaire clôt son propre compte ; un membre du personnel, celui d'un autre.
  ADD CONSTRAINT "account_closures_author_check"
    CHECK (("origin" = 'HOLDER') = ("closed_by" = "user_id")),
  ADD CONSTRAINT "account_closures_email_check"
    CHECK ("email" IS NULL
           OR ("email" = lower(btrim("email"))
               AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ADD CONSTRAINT "account_closures_phone_check"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$'),
  -- L'effacement suit la clôture, et jamais avant le terme de la conservation légale.
  ADD CONSTRAINT "account_closures_schedule_check"
    CHECK ("erasure_due_at" > "closed_at"
           AND ("legal_retention_until" IS NULL
                OR "erasure_due_at" >= "legal_retention_until")),
  -- Jusqu'à l'effacement, la trace garde l'adresse du compte ; ensuite, plus aucun identifiant.
  ADD CONSTRAINT "account_closures_erasure_check"
    CHECK (
      ("erased_at" IS NULL AND "email" IS NOT NULL)
      OR ("erased_at" IS NOT NULL AND "erased_at" >= "closed_at"
          AND "email" IS NULL AND "phone" IS NULL)
    );

-- Vrai si un dossier de vérification peut être effacé :
--   * en préparation : toujours (son titulaire peut l'abandonner) ;
--   * sinon, seulement si le compte est clôturé — un dossier déposé mais jamais examiné l'est
--     aussitôt ; un dossier sur lequel une décision a été prise, une fois écoulée la
--     conservation légale inscrite à la clôture. L'heure est celle de la base.
CREATE FUNCTION "mgx_kyc_case_erasable"(holder uuid, case_status "kyc_case_status")
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  retained_until timestamptz;
BEGIN
  IF case_status = 'DRAFT' THEN
    RETURN true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = holder AND u."status" = 'CLOSED') THEN
    RETURN false;
  END IF;
  IF case_status = 'SUBMITTED' THEN
    RETURN true;
  END IF;
  SELECT c."legal_retention_until" INTO retained_until
  FROM "account_closures" AS c
  WHERE c."user_id" = holder;
  RETURN retained_until IS NOT NULL AND retained_until <= now();
END;
$$;

CREATE FUNCTION "mgx_enforce_account_closure"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account "users"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the closure record of account % cannot be deleted', OLD."user_id"
      USING ERRCODE = 'MGX04';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT u.* INTO account FROM "users" AS u WHERE u."id" = NEW."user_id" FOR UPDATE;
    IF NOT FOUND OR account."status" NOT IN ('ACTIVE', 'SUSPENDED') THEN
      RAISE EXCEPTION 'only an active or suspended account can be closed'
        USING ERRCODE = 'MGX04';
    END IF;
    IF NEW."erased_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a closure record is written before anything is erased'
        USING ERRCODE = 'MGX04';
    END IF;
    IF NEW."email" IS DISTINCT FROM account."email"
       OR NEW."phone" IS DISTINCT FROM account."phone" THEN
      RAISE EXCEPTION
        'the closure record of account % must carry its e-mail address and phone number',
        NEW."user_id"
        USING ERRCODE = 'MGX04';
    END IF;
    -- Une clôture antidatée avancerait d'autant le terme de la conservation légale.
    IF NEW."closed_at" < now() - INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'a closure cannot be backdated'
        USING ERRCODE = 'MGX04';
    END IF;
    IF NEW."origin" = 'STAFF' AND NOT EXISTS (
      SELECT 1
      FROM "users" AS u
      JOIN "user_roles" AS ur ON ur."user_id" = u."id"
      JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
      WHERE u."id" = NEW."closed_by"
        AND u."status" = 'ACTIVE'
        AND rp."permission_key" = 'users.close'
    ) THEN
      RAISE EXCEPTION 'account % is not entitled to close an account', NEW."closed_by"
        USING ERRCODE = 'MGX04';
    END IF;
    -- Conservation légale : dix ans après la clôture, dès lors qu'une décision a été prise
    -- sur un dossier de vérification du compte (loi n° 22/068 — voir l'ADR 0023). Les dix
    -- ans se comptent en UTC, comme le fait l'application : comptés dans le fuseau de la
    -- session, ils différeraient d'une heure autour d'un changement d'heure.
    IF EXISTS (
      SELECT 1 FROM "kyc_cases" AS k
      WHERE k."user_id" = NEW."user_id" AND k."status" NOT IN ('DRAFT', 'SUBMITTED')
    ) AND (NEW."legal_retention_until" IS NULL
           OR NEW."legal_retention_until"
              < ((NEW."closed_at" AT TIME ZONE 'UTC') + INTERVAL '10 years') AT TIME ZONE 'UTC')
    THEN
      RAISE EXCEPTION
        'the verification records of account % must be retained for ten years after its closure',
        NEW."user_id"
        USING ERRCODE = 'MGX04';
    END IF;
    RETURN NEW;
  END IF;

  -- Une trace de clôture ne change qu'une fois, pour constater l'effacement.
  IF OLD."erased_at" IS NOT NULL OR NEW."erased_at" IS NULL
     OR (NEW."user_id", NEW."closed_at", NEW."origin", NEW."closed_by",
         NEW."legal_retention_until", NEW."erasure_due_at")
        IS DISTINCT FROM
        (OLD."user_id", OLD."closed_at", OLD."origin", OLD."closed_by",
         OLD."legal_retention_until", OLD."erasure_due_at") THEN
    RAISE EXCEPTION 'the closure record of account % can only be marked as erased, once',
      OLD."user_id"
      USING ERRCODE = 'MGX04';
  END IF;
  IF OLD."legal_retention_until" IS NOT NULL AND OLD."legal_retention_until" > now() THEN
    RAISE EXCEPTION 'the records of account % are retained by law until %',
      OLD."user_id", OLD."legal_retention_until"
      USING ERRCODE = 'MGX04';
  END IF;
  IF EXISTS (SELECT 1 FROM "kyc_cases" AS k WHERE k."user_id" = OLD."user_id") THEN
    RAISE EXCEPTION 'the verification records of account % have not been erased', OLD."user_id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "account_closures_enforce"
  BEFORE INSERT OR UPDATE OR DELETE ON "account_closures"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_account_closure"();

CREATE TRIGGER "account_closures_no_truncate"
  BEFORE TRUNCATE ON "account_closures"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Une clôture est entière ou n'est pas. Vérifié à la validation de la transaction — la trace
-- est écrite avant que le compte ne change de statut, et ses dossiers de vérification ne se
-- closent qu'ensuite :
--   * une trace de clôture n'existe que pour un compte clôturé ;
--   * un compte clôturé n'a plus de dossier en préparation, en attente d'examen ou en vigueur
--     (sans quoi sa pièce d'identité resterait retenue, et un dossier attendrait une décision
--     qui ne peut plus rien établir).
CREATE FUNCTION "mgx_check_closure_applied"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "users" AS u WHERE u."id" = NEW."user_id" AND u."status" = 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'account % has a closure record but was not closed', NEW."user_id"
      USING ERRCODE = 'MGX04';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "kyc_cases" AS k
    WHERE k."user_id" = NEW."user_id" AND k."status" IN ('DRAFT', 'SUBMITTED', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'account % is closed but one of its verification cases is still open',
      NEW."user_id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "account_closures_applied"
  AFTER INSERT ON "account_closures"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "mgx_check_closure_applied"();

-- --- kyc_cases, kyc_documents --------------------------------------------------------------
-- À chaque statut ses dates et ses acteurs : la vérification qui prend fin avec le compte
-- porte, comme un dossier remplacé, sa date de fin.
ALTER TABLE "kyc_cases" DROP CONSTRAINT "kyc_cases_lifecycle_check";
ALTER TABLE "kyc_cases"
  ADD CONSTRAINT "kyc_cases_lifecycle_check"
    CHECK (
      ("status" = 'DRAFT'
        AND "submitted_at" IS NULL AND "decided_at" IS NULL AND "decided_by" IS NULL
        AND "ended_at" IS NULL AND "revoked_by" IS NULL)
      OR ("status" = 'SUBMITTED'
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NULL AND "decided_by" IS NULL
        AND "ended_at" IS NULL AND "revoked_by" IS NULL)
      OR ("status" IN ('APPROVED', 'REJECTED')
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
        AND "ended_at" IS NULL AND "revoked_by" IS NULL)
      OR ("status" IN ('SUPERSEDED', 'ACCOUNT_CLOSED')
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
        AND "ended_at" IS NOT NULL AND "revoked_by" IS NULL)
      OR ("status" = 'REVOKED'
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
        AND "ended_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
    );

-- Parcours d'un dossier : la fonction de la migration « kyc » est reprise à l'identique, à
-- deux règles près —
--   * un dossier accepté prend fin avec le compte (ACCOUNT_CLOSED), et seulement si le compte
--     est clôturé ;
--   * l'effacement n'est plus réservé au dossier en préparation : voir "mgx_kyc_case_erasable".
CREATE OR REPLACE FUNCTION "mgx_enforce_kyc_case"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  decision_columns CONSTANT text[] := ARRAY[
    'status', 'updated_at', 'decided_by', 'decided_at', 'rejection_reasons', 'decision_note'];
  closing_columns CONSTANT text[] := ARRAY[
    'status', 'updated_at', 'ended_at', 'revoked_by', 'revocation_reason'];
  required_kind "kyc_document_kind";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT "mgx_kyc_case_erasable"(OLD."user_id", OLD."status") THEN
      RAISE EXCEPTION 'verification case % is evidence (%): it cannot be deleted',
        OLD."id", OLD."status"
        USING ERRCODE = 'MGX03';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'a verification case is created as a draft'
        USING ERRCODE = 'MGX03';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."user_id", NEW."level", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."level", OLD."created_at") THEN
    RAISE EXCEPTION 'the holder and the level of a verification case cannot change'
      USING ERRCODE = 'MGX03';
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      RETURN NEW;
    END IF;
    IF NEW."status" <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'a draft verification case can only be submitted'
        USING ERRCODE = 'MGX03';
    END IF;
    IF NEW."level" > 1 AND NOT EXISTS (
      SELECT 1 FROM "kyc_cases" AS previous
      WHERE previous."user_id" = NEW."user_id"
        AND previous."level" = NEW."level" - 1
        AND previous."status" = 'APPROVED'
    ) THEN
      RAISE EXCEPTION 'level % cannot be submitted before level % is verified',
        NEW."level", NEW."level" - 1
        USING ERRCODE = 'MGX03';
    END IF;
    FOREACH required_kind IN ARRAY
      CASE NEW."level"
        WHEN 1 THEN ARRAY['IDENTITY_FRONT', 'SELFIE']::"kyc_document_kind"[]
        WHEN 2 THEN ARRAY['PROOF_OF_ADDRESS']::"kyc_document_kind"[]
        ELSE ARRAY['SOURCE_OF_FUNDS']::"kyc_document_kind"[]
      END
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM "kyc_documents" AS document
        WHERE document."case_id" = NEW."id" AND document."kind" = required_kind
      ) THEN
        RAISE EXCEPTION 'a level % case cannot be submitted without a % document',
          NEW."level", required_kind
          USING ERRCODE = 'MGX03';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'SUBMITTED' THEN
    IF NEW."status" NOT IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'a submitted verification case can only be approved or rejected'
        USING ERRCODE = 'MGX03';
    END IF;
    IF (to_jsonb(NEW) - decision_columns) IS DISTINCT FROM (to_jsonb(OLD) - decision_columns) THEN
      RAISE EXCEPTION 'a submitted verification case is evidence: it cannot be modified'
        USING ERRCODE = 'MGX03';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "users" AS u
      JOIN "user_roles" AS ur ON ur."user_id" = u."id"
      JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
      WHERE u."id" = NEW."decided_by"
        AND u."status" = 'ACTIVE'
        AND rp."permission_key" = 'kyc.review'
    ) THEN
      RAISE EXCEPTION 'account % is not entitled to decide on a verification case',
        NEW."decided_by"
        USING ERRCODE = 'MGX03';
    END IF;
    IF NEW."status" = 'APPROVED' THEN
      IF NEW."level" > 1 AND NOT EXISTS (
        SELECT 1 FROM "kyc_cases" AS previous
        WHERE previous."user_id" = NEW."user_id"
          AND previous."level" = NEW."level" - 1
          AND previous."status" = 'APPROVED'
      ) THEN
        RAISE EXCEPTION 'level % cannot be approved while level % is not verified',
          NEW."level", NEW."level" - 1
          USING ERRCODE = 'MGX03';
      END IF;
      -- Le dossier accepté précédent du même niveau est remplacé. Cette écriture relance la
      -- présente fonction, un niveau de déclencheur plus bas (voir ci-dessous).
      UPDATE "kyc_cases"
      SET "status" = 'SUPERSEDED', "ended_at" = NEW."decided_at", "updated_at" = NEW."decided_at"
      WHERE "user_id" = NEW."user_id" AND "level" = NEW."level" AND "status" = 'APPROVED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'APPROVED' THEN
    IF (to_jsonb(NEW) - closing_columns) IS DISTINCT FROM (to_jsonb(OLD) - closing_columns) THEN
      RAISE EXCEPTION 'an approved verification case is evidence: it cannot be modified'
        USING ERRCODE = 'MGX03';
    END IF;
    IF NEW."status" = 'SUPERSEDED' THEN
      -- Ne résulte que de l'acceptation d'un dossier plus récent, faite par cette fonction :
      -- une écriture directe (profondeur 1) est refusée.
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'a verification case is superseded only by the approval of a newer one'
          USING ERRCODE = 'MGX03';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."status" = 'REVOKED' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM "users" AS u
        JOIN "user_roles" AS ur ON ur."user_id" = u."id"
        JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
        WHERE u."id" = NEW."revoked_by"
          AND u."status" = 'ACTIVE'
          AND rp."permission_key" = 'kyc.revoke'
      ) THEN
        RAISE EXCEPTION 'account % is not entitled to revoke a verification', NEW."revoked_by"
          USING ERRCODE = 'MGX03';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."status" = 'ACCOUNT_CLOSED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "users" AS u WHERE u."id" = NEW."user_id" AND u."status" = 'CLOSED'
      ) THEN
        RAISE EXCEPTION 'a verification ends with its account only once the account is closed'
          USING ERRCODE = 'MGX03';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'an approved verification case can only be superseded, revoked or closed'
      USING ERRCODE = 'MGX03';
  END IF;

  RAISE EXCEPTION 'verification case % is closed (%): it cannot be modified',
    OLD."id", OLD."status"
    USING ERRCODE = 'MGX03';
END;
$$;

-- Pièces : comme avant, une pièce ne s'ajoute qu'à un dossier en préparation et ne se modifie
-- jamais ; elle s'efface avec son dossier, lorsque celui-ci peut l'être.
CREATE OR REPLACE FUNCTION "mgx_enforce_kyc_document"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_case uuid;
  case_holder uuid;
  case_status "kyc_case_status";
  case_level smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a verification document cannot be modified'
      USING ERRCODE = 'MGX03';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_case := OLD."case_id";
  ELSE
    target_case := NEW."case_id";
  END IF;

  SELECT c."user_id", c."status", c."level" INTO case_holder, case_status, case_level
  FROM "kyc_cases" AS c
  WHERE c."id" = target_case
  FOR SHARE;

  IF TG_OP = 'DELETE' THEN
    -- Une pièce s'efface avec son dossier, et seulement s'il peut l'être.
    IF case_status IS NULL OR NOT "mgx_kyc_case_erasable"(case_holder, case_status) THEN
      RAISE EXCEPTION 'the documents of verification case % cannot be removed', target_case
        USING ERRCODE = 'MGX03';
    END IF;
    RETURN OLD;
  END IF;

  IF case_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'documents can only be added to a draft verification case'
      USING ERRCODE = 'MGX03';
  END IF;

  IF NOT (
    (case_level = 1 AND NEW."kind" IN ('IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE'))
    OR (case_level = 2 AND NEW."kind" = 'PROOF_OF_ADDRESS')
    OR (case_level = 3 AND NEW."kind" = 'SOURCE_OF_FUNDS')
  ) THEN
    RAISE EXCEPTION 'a % document does not belong to a level % case', NEW."kind", case_level
      USING ERRCODE = 'MGX03';
  END IF;
  RETURN NEW;
END;
$$;

-- Les fonctions ne résolvent les noms que dans le schéma de l'application, quel que soit le
-- chemin de recherche de la session qui écrit. (Remplacer une fonction lui fait perdre ce
-- réglage : il est donc reposé sur les deux fonctions reprises ci-dessus.)
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_enforce_user_closure"()',
    '"mgx_forbid_closed_account_rows"()',
    '"mgx_kyc_case_erasable"(uuid, "kyc_case_status")',
    '"mgx_enforce_account_closure"()',
    '"mgx_check_closure_applied"()',
    '"mgx_enforce_kyc_case"()',
    '"mgx_enforce_kyc_document"()'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', signature, current_schema());
  END LOOP;
END
$$;

-- Défense en profondeur : une trace de clôture ne s'efface ni ne se vide, quel que soit le
-- rôle non propriétaire qui écrit.
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
      AND grants.table_name = 'account_closures'
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE "account_closures" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions et rôles système ---------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('users.close', 'Close an account permanently, at the request of its holder or by decision of the platform.');

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", 'users.close'
FROM "roles"
WHERE "roles"."key" = 'compliance';

UPDATE "roles"
SET "description" = 'Reviews identity verification cases, withdraws verifications and closes accounts.',
    "updated_at" = now()
WHERE "key" = 'compliance';
