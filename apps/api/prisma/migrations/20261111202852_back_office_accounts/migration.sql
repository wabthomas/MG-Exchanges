-- CreateEnum
CREATE TYPE "role_change_action" AS ENUM ('GRANT', 'REVOKE');

-- CreateEnum
CREATE TYPE "role_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "role_change_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "action" "role_change_action" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "role_change_status" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" VARCHAR(500),

    CONSTRAINT "role_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_change_requests_status_id_idx" ON "role_change_requests"("status", "id");

-- CreateIndex
CREATE INDEX "role_change_requests_user_id_idx" ON "role_change_requests"("user_id");

-- CreateIndex
CREATE INDEX "user_sessions_idle_expires_at_idx" ON "user_sessions"("idle_expires_at");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "verification_challenges_expires_at_idx" ON "verification_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_requests" ADD CONSTRAINT "role_change_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/back-office-schema.spec.ts.
-- =======================================================================================

-- --- users -------------------------------------------------------------------------------
-- Purge des inscriptions jamais vérifiées : seules ces lignes sont indexées.
CREATE INDEX "users_pending_registration_idx"
  ON "users" ("terms_accepted_at")
  WHERE "status" = 'PENDING_VERIFICATION';

-- --- role_change_requests ----------------------------------------------------------------
ALTER TABLE "role_change_requests"
  ADD CONSTRAINT "role_change_requests_reason_not_blank_check"
    CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "role_change_requests_expiry_check"
    CHECK ("expires_at" > "requested_at"),
  -- Nul ne prend part à un changement de ses propres rôles : ni pour le demander…
  ADD CONSTRAINT "role_change_requests_not_self_requested_check"
    CHECK ("requested_by" <> "user_id"),
  -- Une demande en attente n'a pas de décision ; une demande décidée en a une, datée ; une
  -- demande échue n'a été décidée par personne.
  ADD CONSTRAINT "role_change_requests_decision_check"
    CHECK (
      ("status" = 'PENDING'
        AND "decided_at" IS NULL AND "decided_by" IS NULL AND "decision_note" IS NULL)
      OR ("status" = 'EXPIRED' AND "decided_at" IS NOT NULL AND "decided_by" IS NULL)
      OR ("status" IN ('APPROVED', 'REJECTED', 'CANCELLED')
        AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
    ),
  -- …ni pour le décider. Double validation : la décision vient d'une autre personne que
  -- l'auteur de la demande.
  ADD CONSTRAINT "role_change_requests_four_eyes_check"
    CHECK (
      "status" NOT IN ('APPROVED', 'REJECTED')
      OR ("decided_by" <> "requested_by" AND "decided_by" <> "user_id")
    ),
  -- Seul l'auteur d'une demande la retire.
  ADD CONSTRAINT "role_change_requests_cancelled_by_requester_check"
    CHECK ("status" <> 'CANCELLED' OR "decided_by" = "requested_by");

-- Une seule demande en attente par compte et par rôle.
CREATE UNIQUE INDEX "role_change_requests_pending_key"
  ON "role_change_requests" ("user_id", "role_id")
  WHERE "status" = 'PENDING';

-- Application d'une demande approuvée.
--
-- Le rôle applicatif n'a aucun droit d'écriture sur "user_roles" (voir la migration
-- identity_foundations) : une attribution ou un retrait de rôle ne peut résulter que de
-- l'approbation d'une demande, et c'est cette fonction — exécutée avec les droits du
-- propriétaire (SECURITY DEFINER) — qui l'applique, après avoir vérifié elle-même :
--   * que la demande était en attente et n'est pas échue ;
--   * que ses termes n'ont pas été modifiés ;
--   * que son auteur et celui qui l'approuve sont, au moment de l'approbation, deux comptes
--     actifs détenant la permission "roles.manage" (qu'ils soient distincts, et distincts du
--     compte concerné, est garanti par les contraintes ci-dessus) ;
--   * qu'un rôle n'est attribué qu'à un compte actif.
-- Les approbations sont sérialisées (verrou consultatif) : ces vérifications portent sur un
-- état qu'aucune autre approbation n'est en train de modifier.
-- Une règle enfreinte lève l'erreur MGX02 et annule la transaction.
CREATE FUNCTION "mgx_enforce_role_change"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  required_permission CONSTANT text := 'roles.manage';
  party uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'a role change request is created pending'
        USING ERRCODE = 'MGX02';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'role change request % is already decided (%)', OLD."id", OLD."status"
      USING ERRCODE = 'MGX02';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'a pending role change request can only be decided'
      USING ERRCODE = 'MGX02';
  END IF;
  IF (NEW."id", NEW."user_id", NEW."role_id", NEW."action", NEW."reason",
      NEW."requested_by", NEW."requested_at", NEW."expires_at")
     IS DISTINCT FROM
     (OLD."id", OLD."user_id", OLD."role_id", OLD."action", OLD."reason",
      OLD."requested_by", OLD."requested_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'the terms of a role change request cannot be modified'
      USING ERRCODE = 'MGX02';
  END IF;

  IF NEW."status" <> 'APPROVED' THEN
    RETURN NEW;
  END IF;

  -- Les approbations sont appliquées une à une. Chacune vérifie la qualité de ses deux
  -- acteurs ; vérifiées sur le même état de départ, deux approbations simultanées qui se
  -- retirent mutuellement un acteur passeraient toutes les deux. Le verrou est tenu jusqu'à
  -- la fin de la transaction ; les lectures qui suivent voient ce que la précédente a validé.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('role_change:approval', 0));

  IF OLD."expires_at" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'role change request % has expired', OLD."id"
      USING ERRCODE = 'MGX02';
  END IF;

  FOREACH party IN ARRAY ARRAY[NEW."requested_by", NEW."decided_by"] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM "users" AS u
      JOIN "user_roles" AS ur ON ur."user_id" = u."id"
      JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
      WHERE u."id" = party
        AND u."status" = 'ACTIVE'
        AND rp."permission_key" = required_permission
    ) THEN
      RAISE EXCEPTION 'account % is not entitled to take part in a role change', party
        USING ERRCODE = 'MGX02';
    END IF;
  END LOOP;

  IF NEW."action" = 'GRANT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "users" AS u WHERE u."id" = NEW."user_id" AND u."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'a role can only be granted to an active account'
        USING ERRCODE = 'MGX02';
    END IF;
    INSERT INTO "user_roles" ("user_id", "role_id", "granted_by")
    VALUES (NEW."user_id", NEW."role_id", NEW."requested_by")
    ON CONFLICT ("user_id", "role_id") DO NOTHING;
  ELSE
    DELETE FROM "user_roles"
    WHERE "user_id" = NEW."user_id" AND "role_id" = NEW."role_id";
  END IF;

  RETURN NEW;
END;
$$;

-- Une fonction SECURITY DEFINER ne doit résoudre les noms que dans le schéma de l'application :
-- son chemin de recherche est figé sur le schéma dans lequel la migration s'exécute.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION "mgx_enforce_role_change"() SET search_path = %I, pg_temp',
    current_schema());
END
$$;

REVOKE ALL ON FUNCTION "mgx_enforce_role_change"() FROM PUBLIC;

CREATE TRIGGER "role_change_requests_enforce"
  BEFORE INSERT OR UPDATE ON "role_change_requests"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_role_change"();

-- Une demande ne s'efface pas : elle est la trace de la décision.
CREATE TRIGGER "role_change_requests_no_delete"
  BEFORE DELETE ON "role_change_requests"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "role_change_requests_no_truncate"
  BEFORE TRUNCATE ON "role_change_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

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
      AND grants.table_name = 'role_change_requests'
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'REVOKE DELETE, TRUNCATE ON TABLE "role_change_requests" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions et rôles système ---------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('users.read', 'Search accounts and view their details.'),
  ('users.suspend', 'Suspend and reactivate accounts.'),
  ('users.revoke_sessions', 'Sign an account out of all its devices.'),
  ('users.reset_mfa', 'Remove the two-step verification of an account that lost its authenticator.'),
  ('roles.read', 'View roles, their holders and role change requests.'),
  ('roles.manage', 'Request, approve or reject role changes, and act on staff accounts.');

INSERT INTO "roles" ("key", "name", "description", "is_system") VALUES
  ('support', 'Customer support', 'Finds accounts, signs them out and suspends them.', true);

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "granted"."key"
FROM "roles"
CROSS JOIN (VALUES ('users.read'), ('users.suspend'), ('users.revoke_sessions')) AS "granted" ("key")
WHERE "roles"."key" = 'support';
