-- CreateEnum
CREATE TYPE "kyc_case_status" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "kyc_identity_document_type" AS ENUM ('NATIONAL_ID_CARD', 'VOTER_CARD', 'PASSPORT', 'DRIVING_LICENCE');

-- CreateEnum
CREATE TYPE "kyc_address_proof_type" AS ENUM ('UTILITY_BILL', 'BANK_STATEMENT', 'RESIDENCE_CERTIFICATE', 'LEASE_AGREEMENT', 'TAX_DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "kyc_funds_source" AS ENUM ('EMPLOYMENT', 'BUSINESS', 'SAVINGS', 'INVESTMENTS', 'INHERITANCE', 'SALE_OF_PROPERTY', 'FAMILY_SUPPORT', 'PENSION', 'OTHER');

-- CreateEnum
CREATE TYPE "kyc_rejection_reason" AS ENUM ('DOCUMENT_UNREADABLE', 'DOCUMENT_EXPIRED', 'DOCUMENT_NOT_ACCEPTED', 'DOCUMENT_INCOMPLETE', 'INFORMATION_MISMATCH', 'SELFIE_UNUSABLE', 'SELFIE_MISMATCH', 'PROOF_TOO_OLD', 'INSUFFICIENT_EVIDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "kyc_document_kind" AS ENUM ('IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE', 'PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS');

-- CreateTable
CREATE TABLE "kyc_cases" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "status" "kyc_case_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "rejection_reasons" "kyc_rejection_reason"[] DEFAULT ARRAY[]::"kyc_rejection_reason"[],
    "decision_note" VARCHAR(500),
    "ended_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "revocation_reason" VARCHAR(500),
    "given_name" VARCHAR(100),
    "family_name" VARCHAR(100),
    "additional_name" VARCHAR(100),
    "date_of_birth" DATE,
    "place_of_birth" VARCHAR(100),
    "nationality" CHAR(2),
    "document_type" "kyc_identity_document_type",
    "document_number_encrypted" BYTEA,
    "document_number_digest" BYTEA,
    "document_issuing_country" CHAR(2),
    "document_issued_on" DATE,
    "document_issued_at" VARCHAR(100),
    "document_expires_on" DATE,
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100),
    "region" VARCHAR(100),
    "postal_code" VARCHAR(20),
    "address_country" CHAR(2),
    "address_proof_type" "kyc_address_proof_type",
    "address_proof_issued_on" DATE,
    "funds_sources" "kyc_funds_source"[] DEFAULT ARRAY[]::"kyc_funds_source"[],
    "occupation" VARCHAR(100),
    "employer_name" VARCHAR(200),
    "funds_explanation" VARCHAR(1000),

    CONSTRAINT "kyc_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" "kyc_document_kind" NOT NULL,
    "content_type" VARCHAR(32) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" BYTEA NOT NULL,
    "storage_key" VARCHAR(128) NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_cases_status_submitted_at_id_idx" ON "kyc_cases"("status", "submitted_at", "id");

-- CreateIndex
CREATE INDEX "kyc_cases_user_id_level_idx" ON "kyc_cases"("user_id", "level");

-- CreateIndex
CREATE INDEX "kyc_cases_document_number_digest_idx" ON "kyc_cases"("document_number_digest");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_documents_storage_key_key" ON "kyc_documents"("storage_key");

-- CreateIndex
CREATE INDEX "kyc_documents_case_id_idx" ON "kyc_documents"("case_id");

-- CreateIndex
CREATE INDEX "kyc_documents_sha256_idx" ON "kyc_documents"("sha256");

-- AddForeignKey
ALTER TABLE "kyc_cases" ADD CONSTRAINT "kyc_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_cases" ADD CONSTRAINT "kyc_cases_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_cases" ADD CONSTRAINT "kyc_cases_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "kyc_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/kyc-schema.spec.ts.
-- =======================================================================================

-- --- kyc_cases ---------------------------------------------------------------------------
ALTER TABLE "kyc_cases"
  ADD CONSTRAINT "kyc_cases_level_check"
    CHECK ("level" BETWEEN 1 AND 3),
  -- Une liste est toujours renseignée, éventuellement vide.
  ADD CONSTRAINT "kyc_cases_lists_not_null_check"
    CHECK ("rejection_reasons" IS NOT NULL AND "funds_sources" IS NOT NULL),
  -- À chaque statut ses dates et ses acteurs.
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
      OR ("status" = 'SUPERSEDED'
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
        AND "ended_at" IS NOT NULL AND "revoked_by" IS NULL)
      OR ("status" = 'REVOKED'
        AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
        AND "ended_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
    ),
  -- Un refus est motivé : au moins un motif (communiqué au titulaire) et une note interne.
  -- Aucun autre statut ne porte de motif de refus.
  ADD CONSTRAINT "kyc_cases_rejection_check"
    CHECK (
      ("status" = 'REJECTED'
        AND cardinality("rejection_reasons") BETWEEN 1 AND 5
        AND "decision_note" IS NOT NULL)
      OR ("status" <> 'REJECTED' AND cardinality("rejection_reasons") = 0)
    ),
  ADD CONSTRAINT "kyc_cases_decision_note_check"
    CHECK (
      "decision_note" IS NULL
      OR ("decided_at" IS NOT NULL AND btrim("decision_note") <> '')
    ),
  -- Un retrait est motivé ; seul un retrait porte un motif de retrait.
  ADD CONSTRAINT "kyc_cases_revocation_reason_check"
    CHECK (
      ("status" = 'REVOKED' AND "revocation_reason" IS NOT NULL
        AND btrim("revocation_reason") <> '')
      OR ("status" <> 'REVOKED' AND "revocation_reason" IS NULL)
    ),
  -- Nul ne décide de sa propre vérification, ni ne la retire.
  ADD CONSTRAINT "kyc_cases_not_self_decided_check"
    CHECK ("decided_by" <> "user_id"),
  ADD CONSTRAINT "kyc_cases_not_self_revoked_check"
    CHECK ("revoked_by" <> "user_id"),
  -- Niveau 1 : l'identité déclarée et la pièce présentée sont complètes dès l'enregistrement ;
  -- les autres niveaux n'en portent aucune.
  ADD CONSTRAINT "kyc_cases_identity_fields_check"
    CHECK (
      CASE WHEN "level" = 1 THEN
        "given_name" IS NOT NULL AND btrim("given_name") <> ''
        AND "family_name" IS NOT NULL AND btrim("family_name") <> ''
        AND ("additional_name" IS NULL OR btrim("additional_name") <> '')
        AND "date_of_birth" IS NOT NULL AND "date_of_birth" >= DATE '1900-01-01'
        AND "place_of_birth" IS NOT NULL AND btrim("place_of_birth") <> ''
        AND "nationality" IS NOT NULL AND "nationality" ~ '^[A-Z]{2}$'
        AND "document_type" IS NOT NULL
        AND "document_number_encrypted" IS NOT NULL
        AND "document_number_digest" IS NOT NULL
        AND octet_length("document_number_digest") = 32
        AND "document_issuing_country" IS NOT NULL AND "document_issuing_country" ~ '^[A-Z]{2}$'
        AND "document_issued_on" IS NOT NULL AND "document_issued_on" >= "date_of_birth"
        AND "document_issued_at" IS NOT NULL AND btrim("document_issued_at") <> ''
        AND ("document_expires_on" IS NULL OR "document_expires_on" > "document_issued_on")
      ELSE
        "given_name" IS NULL AND "family_name" IS NULL AND "additional_name" IS NULL
        AND "date_of_birth" IS NULL AND "place_of_birth" IS NULL AND "nationality" IS NULL
        AND "document_type" IS NULL AND "document_number_encrypted" IS NULL
        AND "document_number_digest" IS NULL AND "document_issuing_country" IS NULL
        AND "document_issued_on" IS NULL AND "document_issued_at" IS NULL
        AND "document_expires_on" IS NULL
      END
    ),
  -- Niveau 2 : adresse déclarée et justificatif.
  ADD CONSTRAINT "kyc_cases_address_fields_check"
    CHECK (
      CASE WHEN "level" = 2 THEN
        "address_line1" IS NOT NULL AND btrim("address_line1") <> ''
        AND ("address_line2" IS NULL OR btrim("address_line2") <> '')
        AND "city" IS NOT NULL AND btrim("city") <> ''
        AND ("region" IS NULL OR btrim("region") <> '')
        AND ("postal_code" IS NULL OR btrim("postal_code") <> '')
        AND "address_country" IS NOT NULL AND "address_country" ~ '^[A-Z]{2}$'
        AND "address_proof_type" IS NOT NULL
        AND "address_proof_issued_on" IS NOT NULL
      ELSE
        "address_line1" IS NULL AND "address_line2" IS NULL AND "city" IS NULL
        AND "region" IS NULL AND "postal_code" IS NULL AND "address_country" IS NULL
        AND "address_proof_type" IS NULL AND "address_proof_issued_on" IS NULL
      END
    ),
  -- Niveau 3 : origine des fonds.
  ADD CONSTRAINT "kyc_cases_funds_fields_check"
    CHECK (
      CASE WHEN "level" = 3 THEN
        cardinality("funds_sources") >= 1
        AND "occupation" IS NOT NULL AND btrim("occupation") <> ''
        AND ("employer_name" IS NULL OR btrim("employer_name") <> '')
        AND "funds_explanation" IS NOT NULL AND btrim("funds_explanation") <> ''
      ELSE
        cardinality("funds_sources") = 0 AND "occupation" IS NULL
        AND "employer_name" IS NULL AND "funds_explanation" IS NULL
      END
    );

-- Un seul dossier ouvert (en préparation ou déposé) par compte et par niveau.
CREATE UNIQUE INDEX "kyc_cases_open_key"
  ON "kyc_cases" ("user_id", "level")
  WHERE "status" IN ('DRAFT', 'SUBMITTED');

-- Un seul dossier accepté par compte et par niveau : le niveau vérifié d'un compte se lit
-- sur ses dossiers acceptés.
CREATE UNIQUE INDEX "kyc_cases_approved_key"
  ON "kyc_cases" ("user_id", "level")
  WHERE "status" = 'APPROVED';

-- Une même pièce d'identité ne vérifie qu'un seul compte.
CREATE UNIQUE INDEX "kyc_cases_verified_document_key"
  ON "kyc_cases" ("document_type", "document_issuing_country", "document_number_digest")
  WHERE "status" = 'APPROVED' AND "level" = 1;

-- Parcours d'un dossier. La base impose elle-même, quel que soit le code qui écrit :
--   * un dossier naît en préparation ; son titulaire et son niveau ne changent jamais ;
--   * il n'est déposé qu'avec ses pièces obligatoires, et — au-delà du niveau 1 — que si le
--     niveau précédent est vérifié ;
--   * déposé, il est une preuve : rien de ce qui a été déclaré ne change plus, seule la
--     décision s'y ajoute ;
--   * la décision vient d'un compte actif détenant la permission "kyc.review" (qu'il ne soit
--     pas le titulaire est garanti par une contrainte ci-dessus) ;
--   * l'acceptation remplace le dossier accepté précédent du même niveau — et ce remplacement
--     ne peut venir que d'elle ;
--   * un dossier accepté n'est retiré que par un compte actif détenant "kyc.revoke" ;
--   * un dossier refusé, remplacé ou retiré ne change plus ;
--   * seul un dossier en préparation s'efface.
-- Une règle enfreinte lève l'erreur MGX03 et annule la transaction.
CREATE FUNCTION "mgx_enforce_kyc_case"() RETURNS trigger
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
    IF OLD."status" <> 'DRAFT' THEN
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
    RAISE EXCEPTION 'an approved verification case can only be superseded or revoked'
      USING ERRCODE = 'MGX03';
  END IF;

  RAISE EXCEPTION 'verification case % is closed (%): it cannot be modified',
    OLD."id", OLD."status"
    USING ERRCODE = 'MGX03';
END;
$$;

CREATE TRIGGER "kyc_cases_enforce"
  BEFORE INSERT OR UPDATE OR DELETE ON "kyc_cases"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_kyc_case"();

CREATE TRIGGER "kyc_cases_no_truncate"
  BEFORE TRUNCATE ON "kyc_cases"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- kyc_documents -----------------------------------------------------------------------
ALTER TABLE "kyc_documents"
  ADD CONSTRAINT "kyc_documents_content_type_check"
    CHECK ("content_type" IN ('image/jpeg', 'image/png', 'application/pdf')),
  -- Un autoportrait est une image.
  ADD CONSTRAINT "kyc_documents_selfie_is_image_check"
    CHECK ("kind" <> 'SELFIE' OR "content_type" <> 'application/pdf'),
  -- Borne haute de la base : 10 Mio. L'API applique sa propre limite, plus basse.
  ADD CONSTRAINT "kyc_documents_byte_size_check"
    CHECK ("byte_size" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT "kyc_documents_sha256_check"
    CHECK (octet_length("sha256") = 32),
  ADD CONSTRAINT "kyc_documents_wrapped_key_check"
    CHECK (octet_length("wrapped_key") BETWEEN 48 AND 256),
  ADD CONSTRAINT "kyc_documents_storage_key_check"
    CHECK ("storage_key" ~ '^[a-z0-9][a-z0-9/-]*$');

-- Recto, verso et autoportrait : une seule pièce de chaque par dossier.
CREATE UNIQUE INDEX "kyc_documents_single_kind_key"
  ON "kyc_documents" ("case_id", "kind")
  WHERE "kind" IN ('IDENTITY_FRONT', 'IDENTITY_BACK', 'SELFIE');

-- Une pièce ne s'ajoute et ne se retire que d'un dossier en préparation, et ne se modifie
-- jamais. Le verrou pris sur le dossier fait attendre un dépôt simultané : soit la pièce est
-- enregistrée avant le dépôt, soit elle est refusée — jamais ajoutée à un dossier déjà déposé.
CREATE FUNCTION "mgx_enforce_kyc_document"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_case uuid;
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

  SELECT c."status", c."level" INTO case_status, case_level
  FROM "kyc_cases" AS c
  WHERE c."id" = target_case
  FOR SHARE;

  IF case_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'documents can only be added to or removed from a draft verification case'
      USING ERRCODE = 'MGX03';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
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

CREATE TRIGGER "kyc_documents_enforce"
  BEFORE INSERT OR UPDATE OR DELETE ON "kyc_documents"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_kyc_document"();

CREATE TRIGGER "kyc_documents_no_truncate"
  BEFORE TRUNCATE ON "kyc_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Les deux fonctions ne résolvent les noms que dans le schéma de l'application, quel que soit
-- le chemin de recherche de la session qui écrit.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION "mgx_enforce_kyc_case"() SET search_path = %I, pg_temp', current_schema());
  EXECUTE format(
    'ALTER FUNCTION "mgx_enforce_kyc_document"() SET search_path = %I, pg_temp',
    current_schema());
END
$$;

-- Défense en profondeur : en plus des déclencheurs, les privilèges inutiles sont retirés à
-- tout rôle non propriétaire (rôle applicatif). Un dossier ne se vide pas en bloc ; une pièce
-- ne se modifie pas.
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
      AND grants.table_name IN ('kyc_cases', 'kyc_documents')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('REVOKE TRUNCATE ON TABLE "kyc_cases" FROM %I', grantee_name);
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON TABLE "kyc_documents" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions et rôles système ---------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('kyc.read', 'View identity verification cases and the documents attached to them.'),
  ('kyc.review', 'Approve or reject identity verification cases.'),
  ('kyc.revoke', 'Withdraw an identity verification that was approved.');

INSERT INTO "roles" ("key", "name", "description", "is_system") VALUES
  ('compliance', 'Compliance officer',
   'Reviews identity verification cases and withdraws verifications.', true);

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "granted"."key"
FROM "roles"
CROSS JOIN (VALUES ('users.read'), ('kyc.read'), ('kyc.review'), ('kyc.revoke')) AS "granted" ("key")
WHERE "roles"."key" = 'compliance';
