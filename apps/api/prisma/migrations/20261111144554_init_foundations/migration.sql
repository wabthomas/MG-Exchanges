-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'SERVICE');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED', 'DEAD');

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" VARCHAR(64),
    "action" VARCHAR(128) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(128),
    "outcome" "audit_outcome" NOT NULL,
    "request_id" VARCHAR(128),
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1024),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_occurred_at_idx" ON "audit_logs"("actor_type", "actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_occurred_at_idx" ON "audit_logs"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/database-constraints.spec.ts.
-- =======================================================================================

-- --- system_settings ---------------------------------------------------------------------
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_key_format_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  ADD CONSTRAINT "system_settings_version_check"
    CHECK ("version" >= 1);

-- --- audit_logs --------------------------------------------------------------------------
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_id_check"
    CHECK (("actor_type" = 'SYSTEM') = ("actor_id" IS NULL)),
  ADD CONSTRAINT "audit_logs_action_format_check"
    CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "audit_logs_metadata_is_object_check"
    CHECK (jsonb_typeof("metadata") = 'object');

-- Tables en ajout seul : la base refuse elle-même toute modification ou suppression,
-- quel que soit le rôle connecté (SQLSTATE dédié : MGX01).
CREATE FUNCTION "mgx_forbid_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'MGX01';
END;
$$;

CREATE TRIGGER "audit_logs_append_only_row"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "mgx_forbid_mutation"();

CREATE TRIGGER "audit_logs_append_only_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "mgx_forbid_mutation"();

-- Défense en profondeur : en plus des déclencheurs, les privilèges UPDATE / DELETE / TRUNCATE
-- sont retirés à tout rôle non propriétaire qui les aurait reçus par privilèges par défaut
-- (rôle applicatif — voir infrastructure/docker/postgres/sql/grant-app-privileges.sql).
DO $$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name = 'audit_logs'
      AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_logs" FROM %I', grantee_name);
  END LOOP;
END
$$;

-- --- outbox_events -----------------------------------------------------------------------
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_attempts_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "outbox_events_published_at_check"
    CHECK (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL)),
  ADD CONSTRAINT "outbox_events_event_type_format_check"
    CHECK ("event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- File d'attente du relais : seuls les événements en attente sont indexés.
CREATE INDEX "outbox_events_pending_idx"
  ON "outbox_events" ("available_at", "id")
  WHERE "status" = 'PENDING';

-- --- Historique des migrations (_prisma_migrations) --------------------------------------
-- Prisma Migrate crée cette table avant d'appliquer la première migration : elle reçoit donc,
-- comme toute table du propriétaire, les privilèges par défaut du rôle applicatif. Or ce
-- n'est pas une donnée applicative : qui peut l'écrire peut faire rejouer ou ignorer une
-- migration au déploiement suivant. Seul son propriétaire y conserve un accès.
-- (Dans une base fantôme, Prisma rejoue les migrations sans cette table : la boucle est vide.)
DO $$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grants.grantee
    FROM information_schema.role_table_grants AS grants
    JOIN pg_tables AS history
      ON history.schemaname = grants.table_schema AND history.tablename = grants.table_name
    WHERE grants.table_schema = current_schema()
      AND grants.table_name = '_prisma_migrations'
      AND grants.grantee <> history.tableowner
  LOOP
    IF grantee_name = 'PUBLIC' THEN
      EXECUTE 'REVOKE ALL ON TABLE "_prisma_migrations" FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE "_prisma_migrations" FROM %I', grantee_name);
    END IF;
  END LOOP;
END
$$;
