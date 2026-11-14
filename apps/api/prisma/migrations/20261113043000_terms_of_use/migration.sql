-- AlterTable
-- La colonne datait la demande d'inscription — c'est ce que la purge des inscriptions jamais
-- vérifiées y lit. Elle prend ce nom, sans perte de données : les conditions d'utilisation
-- acceptées ont désormais leur table. (Prisma proposerait de la supprimer puis de la recréer.)
ALTER TABLE "users" RENAME COLUMN "terms_accepted_at" TO "registered_at";

-- CreateTable
CREATE TABLE "terms_versions" (
    "number" INTEGER NOT NULL,
    "requires_acceptance" BOOLEAN NOT NULL,
    "summary_fr" TEXT NOT NULL,
    "body_fr" TEXT NOT NULL,
    "body_fr_sha256" CHAR(64) NOT NULL,
    "summary_en" TEXT,
    "body_en" TEXT,
    "body_en_sha256" CHAR(64),
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "user_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("user_id","version_number")
);

-- CreateIndex
CREATE INDEX "terms_acceptances_version_number_idx" ON "terms_acceptances"("version_number");

-- AddForeignKey
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_version_number_fkey" FOREIGN KEY ("version_number") REFERENCES "terms_versions"("number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/terms-schema.spec.ts.
--
-- Conditions d'utilisation. La base impose elle-même, quel que soit le code qui écrit :
--   * les versions se numérotent 1, 2, 3… sans trou ni doublon, et une version publiée ne se
--     modifie ni ne se retire ;
--   * l'heure d'une publication et celle d'une acceptation sont lues à son horloge ;
--   * l'empreinte conservée d'un texte est bien celle de ce texte ;
--   * seul publie un membre du personnel actif qui détient « terms.publish » — ou l'outil
--     d'exploitation, connecté avec le rôle propriétaire ;
--   * on n'accepte que la version en vigueur ; une acceptation ne se modifie pas, et ne
--     s'efface qu'avec le compte (inscription jamais vérifiée, clôture) ;
--   * un compte clôturé ne garde aucune acceptation.
-- Une règle enfreinte lève l'erreur MGX06 ; un numéro de version qui n'est pas — ou plus —
-- celui attendu (publication : la suivante ; acceptation : celle en vigueur) lève MGX07.
-- =======================================================================================

-- Vrai si « value » est un texte publiable : borné, non vide, sans caractère de contrôle autre
-- que le saut de ligne, le retour chariot et la tabulation, et sans marque d'ordre des octets
-- en tête. Mêmes règles que le contrat de publication (@mgx/contracts), dont les bornes sont
-- recopiées dans les contraintes ci-dessous.
CREATE FUNCTION "mgx_is_terms_text"(value text, max_length integer) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT char_length(value) <= max_length
     AND value ~ '\S'
     AND value !~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]'
     AND value !~ '^\uFEFF';
$$;

-- --- terms_versions ------------------------------------------------------------------------
ALTER TABLE "terms_versions"
  ADD CONSTRAINT "terms_versions_number_check" CHECK ("number" >= 1),
  -- Nul n'a pu accepter un texte qui n'existait pas : la première version s'impose à tous.
  ADD CONSTRAINT "terms_versions_first_requires_acceptance_check"
    CHECK ("number" > 1 OR "requires_acceptance"),
  ADD CONSTRAINT "terms_versions_fr_text_check"
    CHECK ("mgx_is_terms_text"("summary_fr", 1000) AND "mgx_is_terms_text"("body_fr", 200000)),
  -- La traduction est entière ou absente.
  ADD CONSTRAINT "terms_versions_en_text_check"
    CHECK (
      ("summary_en" IS NULL AND "body_en" IS NULL AND "body_en_sha256" IS NULL)
      OR ("summary_en" IS NOT NULL AND "body_en" IS NOT NULL AND "body_en_sha256" IS NOT NULL
          AND "mgx_is_terms_text"("summary_en", 1000)
          AND "mgx_is_terms_text"("body_en", 200000))
    ),
  -- L'empreinte conservée est celle du texte conservé : un texte altéré en chemin ne se
  -- publie pas.
  ADD CONSTRAINT "terms_versions_fr_digest_check"
    CHECK ("body_fr_sha256" = encode(sha256(convert_to("body_fr", 'UTF8')), 'hex')),
  ADD CONSTRAINT "terms_versions_en_digest_check"
    CHECK ("body_en_sha256" IS NULL
           OR "body_en_sha256" = encode(sha256(convert_to("body_en", 'UTF8')), 'hex'));

CREATE FUNCTION "mgx_enforce_terms_version"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest integer;
BEGIN
  -- Une publication à la fois. Le verrou est tenu jusqu'à la fin de la transaction ; la
  -- lecture qui suit voit donc ce que la publication précédente a validé.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('terms:publication', 0));

  SELECT max(v."number") INTO latest FROM "terms_versions" AS v;
  IF NEW."number" IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'terms version % cannot be published: the next version is %',
      NEW."number", coalesce(latest, 0) + 1
      USING ERRCODE = 'MGX07';
  END IF;

  IF NEW."published_by" IS NULL THEN
    -- Sans auteur : réservé à l'outil d'exploitation, qui se connecte avec le rôle
    -- propriétaire. L'API, elle, se connecte avec le rôle applicatif.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_tables AS t
      WHERE t.schemaname = TG_TABLE_SCHEMA
        AND t.tablename = TG_TABLE_NAME
        AND t.tableowner = current_user
    ) THEN
      RAISE EXCEPTION 'a terms version without a publisher can only be installed by the owner role'
        USING ERRCODE = 'MGX06';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "users" AS u
    JOIN "user_roles" AS ur ON ur."user_id" = u."id"
    JOIN "role_permissions" AS rp ON rp."role_id" = ur."role_id"
    WHERE u."id" = NEW."published_by"
      AND u."status" = 'ACTIVE'
      AND rp."permission_key" = 'terms.publish'
  ) THEN
    RAISE EXCEPTION 'account % is not entitled to publish terms of use', NEW."published_by"
      USING ERRCODE = 'MGX06';
  END IF;

  -- L'heure est lue après le verrou : elle croît avec le numéro.
  NEW."published_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "terms_versions_enforce"
  BEFORE INSERT ON "terms_versions"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_terms_version"();

-- Une version publiée ne change plus : ce qu'un titulaire a accepté reste ce qu'il a lu.
CREATE TRIGGER "terms_versions_immutable_row"
  BEFORE UPDATE OR DELETE ON "terms_versions"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "terms_versions_immutable_truncate"
  BEFORE TRUNCATE ON "terms_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- terms_acceptances ---------------------------------------------------------------------
CREATE FUNCTION "mgx_enforce_terms_acceptance"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  holder_status "user_status";
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT u."status" INTO holder_status FROM "users" AS u WHERE u."id" = OLD."user_id";
    -- Une acceptation est une preuve. Elle ne s'efface qu'avec le compte : inscription jamais
    -- vérifiée — purgée, ou remplacée par une nouvelle inscription —, ou clôture en cours (la
    -- trace de la clôture est écrite avant tout le reste).
    IF FOUND AND holder_status <> 'PENDING_VERIFICATION'
       AND NOT EXISTS (
         SELECT 1 FROM "account_closures" AS c WHERE c."user_id" = OLD."user_id"
       ) THEN
      RAISE EXCEPTION 'the acceptance of terms version % by account % is evidence: it cannot be deleted',
        OLD."version_number", OLD."user_id"
        USING ERRCODE = 'MGX06';
    END IF;
    RETURN OLD;
  END IF;

  -- Un compte inconnu est laissé à la clé étrangère, qui le signale ; un compte clôturé, au
  -- déclencheur « terms_acceptances_account_open », exécuté avant celui-ci.
  SELECT u."status" INTO holder_status FROM "users" AS u WHERE u."id" = NEW."user_id";
  IF FOUND AND holder_status NOT IN ('PENDING_VERIFICATION', 'ACTIVE') THEN
    RAISE EXCEPTION 'account % cannot accept terms of use: it is %',
      NEW."user_id", lower(holder_status::text)
      USING ERRCODE = 'MGX06';
  END IF;

  -- On n'accepte que le texte en vigueur : celui qu'on a pu lire.
  IF NEW."version_number" IS DISTINCT FROM (SELECT max(v."number") FROM "terms_versions" AS v) THEN
    RAISE EXCEPTION 'terms version % is not the version in force', NEW."version_number"
      USING ERRCODE = 'MGX07';
  END IF;

  NEW."accepted_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Rien ne s'ajoute à un compte clôturé (MGX05) : même déclencheur que pour ses autres lignes.
-- Son nom le fait s'exécuter avant « terms_acceptances_enforce ».
CREATE TRIGGER "terms_acceptances_account_open"
  BEFORE INSERT ON "terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_closed_account_rows"();

CREATE TRIGGER "terms_acceptances_enforce"
  BEFORE INSERT OR DELETE ON "terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "mgx_enforce_terms_acceptance"();

CREATE TRIGGER "terms_acceptances_no_update"
  BEFORE UPDATE ON "terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "terms_acceptances_no_truncate"
  BEFORE TRUNCATE ON "terms_acceptances"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- --- users ---------------------------------------------------------------------------------
-- Un compte clôturé ne garde aucune acceptation : comme son profil ou ses sessions, elles sont
-- effacées par la clôture, qui échoue sinon. La trace de chaque acceptation reste dans le
-- journal d'audit.
CREATE FUNCTION "mgx_forbid_closure_with_terms_acceptance"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "terms_acceptances" AS a WHERE a."user_id" = NEW."id") THEN
    RAISE EXCEPTION 'account % still holds an acceptance of terms of use: it cannot be closed',
      NEW."id"
      USING ERRCODE = 'MGX04';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_closure_leaves_no_terms_acceptance"
  BEFORE UPDATE ON "users"
  FOR EACH ROW
  WHEN (NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED')
  EXECUTE FUNCTION "mgx_forbid_closure_with_terms_acceptance"();

-- --- Robustesse des fonctions ----------------------------------------------------------------
-- Les règles ne doivent résoudre les noms que dans le schéma de l'application : sans cela, une
-- table temporaire homonyme (« users », « terms_versions »…) placée par la session sur son
-- chemin de recherche répondrait à leur place. Leur chemin de recherche est figé sur le schéma
-- dans lequel la migration s'exécute.
DO $$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    '"mgx_is_terms_text"(text, integer)',
    '"mgx_enforce_terms_version"()',
    '"mgx_enforce_terms_acceptance"()',
    '"mgx_forbid_closure_with_terms_acceptance"()'
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
      AND grants.table_name IN ('terms_versions', 'terms_acceptances')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "terms_versions" FROM %I', grantee_name);
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON TABLE "terms_acceptances" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- Catalogue des permissions -------------------------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('terms.publish', 'Publish a new version of the terms of use and follow its acceptance.');

-- super_admin détient toutes les permissions du catalogue, y compris les nouvelles.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
