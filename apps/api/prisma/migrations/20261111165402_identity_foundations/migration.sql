-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "challenge_purpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "session_revocation_reason" AS ENUM ('LOGOUT', 'USER_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'TOKEN_REUSE', 'ACCOUNT_DISABLED', 'ADMIN_REVOKED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_type" "account_type" NOT NULL DEFAULT 'INDIVIDUAL',
    "status" "user_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email" VARCHAR(254) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "phone" VARCHAR(16),
    "phone_verified_at" TIMESTAMPTZ(6),
    "country_code" CHAR(2) NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'fr',
    "terms_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credentials" (
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" VARCHAR(96) NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" VARCHAR(96) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "verification_challenges" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "purpose" "challenge_purpose" NOT NULL,
    "target" VARCHAR(254) NOT NULL,
    "code_hash" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "invalidated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" "session_revocation_reason",
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "device_name" VARCHAR(64),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "session_id" UUID NOT NULL,
    "access_token_hash" BYTEA NOT NULL,
    "access_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "refresh_token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "session_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "verification_challenges_user_id_purpose_idx" ON "verification_challenges"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_tokens_access_token_hash_key" ON "session_tokens"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "session_tokens_refresh_token_hash_key" ON "session_tokens"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "session_tokens_session_id_idx" ON "session_tokens"("session_id");

-- AddForeignKey
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_tokens" ADD CONSTRAINT "session_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/identity-schema.spec.ts.
-- =======================================================================================

-- --- users -------------------------------------------------------------------------------
ALTER TABLE "users"
  -- L'adresse e-mail est l'identifiant de connexion : stockée normalisée, sans exception.
  ADD CONSTRAINT "users_email_normalized_check"
    CHECK ("email" = lower(btrim("email"))
           AND "email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  ADD CONSTRAINT "users_phone_format_check"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "users_country_code_check"
    CHECK ("country_code" ~ '^[A-Z]{2}$'),
  -- Un compte actif a toujours une adresse e-mail vérifiée.
  ADD CONSTRAINT "users_active_requires_verified_email_check"
    CHECK ("status" <> 'ACTIVE' OR "email_verified_at" IS NOT NULL),
  ADD CONSTRAINT "users_phone_verified_requires_phone_check"
    CHECK ("phone_verified_at" IS NULL OR "phone" IS NOT NULL);

-- Un numéro de téléphone vérifié n'appartient qu'à un seul compte.
CREATE UNIQUE INDEX "users_verified_phone_key"
  ON "users" ("phone")
  WHERE "phone_verified_at" IS NOT NULL;

-- --- user_credentials ----------------------------------------------------------------------
-- Seule une empreinte Argon2id peut être enregistrée : jamais un mot de passe en clair.
ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_password_hash_format_check"
    CHECK ("password_hash" LIKE '$argon2id$v=19$%');

-- --- permissions, roles --------------------------------------------------------------------
ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_key_format_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$');

ALTER TABLE "roles"
  ADD CONSTRAINT "roles_key_format_check"
    CHECK ("key" ~ '^[a-z][a-z0-9_]*$');

-- --- verification_challenges ---------------------------------------------------------------
ALTER TABLE "verification_challenges"
  -- Le nombre d'essais est borné par la base elle-même.
  ADD CONSTRAINT "verification_challenges_attempts_check"
    CHECK ("max_attempts" > 0 AND "attempts" >= 0 AND "attempts" <= "max_attempts"),
  ADD CONSTRAINT "verification_challenges_code_hash_length_check"
    CHECK ("code_hash" IS NULL OR octet_length("code_hash") = 32),
  ADD CONSTRAINT "verification_challenges_single_outcome_check"
    CHECK ("consumed_at" IS NULL OR "invalidated_at" IS NULL),
  ADD CONSTRAINT "verification_challenges_expiry_check"
    CHECK ("expires_at" > "created_at");

-- Un seul code en cours par compte et par usage : en demander un nouveau annule le précédent.
CREATE UNIQUE INDEX "verification_challenges_active_key"
  ON "verification_challenges" ("user_id", "purpose")
  WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;

-- --- user_sessions, session_tokens ---------------------------------------------------------
ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_revocation_check"
    CHECK (("revoked_at" IS NULL) = ("revocation_reason" IS NULL)),
  ADD CONSTRAINT "user_sessions_expiry_check"
    CHECK ("idle_expires_at" <= "expires_at" AND "expires_at" > "created_at");

-- Seules des empreintes SHA-256 (32 octets) sont stockées : jamais un jeton.
ALTER TABLE "session_tokens"
  ADD CONSTRAINT "session_tokens_hash_length_check"
    CHECK (octet_length("access_token_hash") = 32 AND octet_length("refresh_token_hash") = 32);

-- --- Catalogue des permissions et rôles système ---------------------------------------------
-- Copie du catalogue de @mgx/contracts : un test vérifie que les deux sont identiques.
INSERT INTO "permissions" ("key", "description") VALUES
  ('system_settings.read', 'View platform settings (maintenance mode, feature availability).'),
  ('system_settings.write', 'Change platform settings: maintenance mode and opening of features.');

INSERT INTO "roles" ("key", "name", "description", "is_system") VALUES
  ('super_admin', 'Super administrator', 'Holds every permission of the catalogue.', true);

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "permissions"."key"
FROM "roles" CROSS JOIN "permissions"
WHERE "roles"."key" = 'super_admin';

-- --- Privilèges ----------------------------------------------------------------------------
-- Rôles, permissions et attributions ne changent que par migration ou par l'outil d'amorçage,
-- exécutés avec le rôle propriétaire. Le rôle applicatif ne fait que les lire : une API
-- compromise ne peut pas s'attribuer de droits d'administration.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT DISTINCT grants.table_name, grants.grantee
    FROM information_schema.role_table_grants AS grants
    JOIN pg_tables AS tables
      ON tables.schemaname = grants.table_schema AND tables.tablename = grants.table_name
    WHERE grants.table_schema = current_schema()
      AND grants.table_name IN ('permissions', 'roles', 'role_permissions', 'user_roles')
      AND grants.grantee <> tables.tableowner
      AND grants.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I FROM %I',
      target.table_name, target.grantee);
  END LOOP;
END
$$;
