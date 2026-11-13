-- AlterEnum
ALTER TYPE "challenge_purpose" ADD VALUE 'PHONE_VERIFICATION';

-- AlterEnum
ALTER TYPE "session_revocation_reason" ADD VALUE 'SECOND_FACTOR_CHANGED';

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "device_fingerprint" BYTEA;

-- CreateTable
CREATE TABLE "user_profiles" (
    "user_id" UUID NOT NULL,
    "given_name" VARCHAR(100),
    "family_name" VARCHAR(100),
    "additional_name" VARCHAR(100),
    "date_of_birth" DATE,
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "city" VARCHAR(100),
    "region" VARCHAR(100),
    "postal_code" VARCHAR(20),
    "time_zone" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_totp_credentials" (
    "user_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "last_used_step" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_totp_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_recovery_codes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_recovery_codes_user_id_code_hash_key" ON "user_recovery_codes"("user_id", "code_hash");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_totp_credentials" ADD CONSTRAINT "user_totp_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =======================================================================================
-- Compléments écrits à la main (non modélisables dans schema.prisma).
-- Recensés dans docs/DATABASE.md ; vérifiés par test/integration/account-security-schema.spec.ts.
-- =======================================================================================

-- --- user_totp_credentials -------------------------------------------------------------------
ALTER TABLE "user_totp_credentials"
  -- Seul un secret chiffré peut être enregistré, jamais un secret en clair (20 octets) :
  -- version (1 octet, valeur 1) ‖ nonce (12) ‖ secret chiffré (20) ‖ étiquette (16).
  ADD CONSTRAINT "user_totp_credentials_ciphertext_format_check"
    CHECK (octet_length("secret_ciphertext") = 49 AND get_byte("secret_ciphertext", 0) = 1),
  -- Un code n'est accepté qu'une fois l'enrôlement confirmé.
  ADD CONSTRAINT "user_totp_credentials_last_used_step_check"
    CHECK ("last_used_step" IS NULL OR ("last_used_step" >= 0 AND "confirmed_at" IS NOT NULL));

-- --- user_recovery_codes ---------------------------------------------------------------------
-- Seule une empreinte HMAC-SHA-256 (32 octets) est stockée : jamais un code.
ALTER TABLE "user_recovery_codes"
  ADD CONSTRAINT "user_recovery_codes_hash_length_check"
    CHECK (octet_length("code_hash") = 32);

-- --- user_profiles ---------------------------------------------------------------------------
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_names_not_blank_check"
    CHECK (("given_name" IS NULL OR btrim("given_name") <> '')
       AND ("family_name" IS NULL OR btrim("family_name") <> '')
       AND ("additional_name" IS NULL OR btrim("additional_name") <> '')),
  ADD CONSTRAINT "user_profiles_date_of_birth_check"
    CHECK ("date_of_birth" IS NULL OR "date_of_birth" >= DATE '1900-01-01');

-- --- user_sessions ---------------------------------------------------------------------------
-- Empreinte SHA-256 (32 octets) : jamais l'identifiant d'appareil lui-même.
ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_device_fingerprint_length_check"
    CHECK ("device_fingerprint" IS NULL OR octet_length("device_fingerprint") = 32);
