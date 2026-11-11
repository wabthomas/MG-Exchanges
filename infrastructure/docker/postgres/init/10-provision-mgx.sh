#!/bin/sh
# Initialisation du PostgreSQL local (exécuté une seule fois, au premier démarrage du volume,
# par l'image officielle `postgres` via /docker-entrypoint-initdb.d).
#
# Crée les deux rôles (propriétaire des migrations / applicatif), la base MG-Exchange et la
# base « fantôme » de Prisma Migrate (<base>_shadow).
# Les mots de passe proviennent exclusivement de l'environnement du conteneur.
set -eu

: "${MGX_DB_NAME:?variable requise}"
: "${MGX_DB_OWNER_USER:?variable requise}"
: "${MGX_DB_OWNER_PASSWORD:?variable requise}"
: "${MGX_DB_APP_USER:?variable requise}"
: "${MGX_DB_APP_PASSWORD:?variable requise}"

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set owner="$MGX_DB_OWNER_USER" --set owner_password="$MGX_DB_OWNER_PASSWORD" \
  --set app="$MGX_DB_APP_USER" --set app_password="$MGX_DB_APP_PASSWORD" \
  --set db="$MGX_DB_NAME" --set shadow="${MGX_DB_NAME}_shadow" <<'SQL'
-- CREATEDB : permet à `prisma migrate dev` de créer une base fantôme temporaire lorsque
-- SHADOW_DATABASE_URL n'est pas définie.
CREATE ROLE :"owner" LOGIN CREATEDB PASSWORD :'owner_password';
CREATE ROLE :"app" LOGIN PASSWORD :'app_password';
-- TEMPLATE template0 : seul modèle qui garantit l'encodage UTF-8 quel que soit celui du serveur.
CREATE DATABASE :"db" OWNER :"owner" TEMPLATE template0 ENCODING 'UTF8';

-- Base fantôme : Prisma Migrate la vide puis y rejoue les migrations pour les comparer au
-- schéma (`pnpm db:check-drift`). Elle ne contient jamais de données ; seul le rôle
-- propriétaire peut s'y connecter.
CREATE DATABASE :"shadow" OWNER :"owner" TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE :"shadow" FROM PUBLIC;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$MGX_DB_NAME" \
  --set owner="$MGX_DB_OWNER_USER" --set app="$MGX_DB_APP_USER" <<'SQL'
SET mgx.owner_role = :'owner';
SET mgx.app_role = :'app';
\ir /mgx/sql/grant-app-privileges.sql
SQL
