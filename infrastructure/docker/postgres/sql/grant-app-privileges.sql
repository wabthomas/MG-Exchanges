-- Séparation des privilèges PostgreSQL — à exécuter une fois par base, en superutilisateur.
--
--   rôle « propriétaire » : possède les objets du schéma et exécute les migrations Prisma ;
--   rôle « applicatif »   : utilisé par l'API à l'exécution ; lecture/écriture des données
--                           uniquement — aucun DDL, aucun TRUNCATE, aucune désactivation
--                           de déclencheur.
--
-- Les deux noms de rôle sont lus dans des paramètres de session, ce qui permet d'exécuter
-- ce fichier à l'identique depuis l'initialisation Docker et depuis les tests automatisés :
--
--   SET mgx.owner_role = '<rôle propriétaire>';
--   SET mgx.app_role   = '<rôle applicatif>';
--
-- Voir docs/DATABASE.md, section « Rôles et privilèges ».
DO $$
DECLARE
  owner_role text := current_setting('mgx.owner_role');
  app_role   text := current_setting('mgx.app_role');
BEGIN
  IF owner_role = app_role THEN
    RAISE EXCEPTION 'mgx.owner_role and mgx.app_role must be two distinct roles';
  END IF;

  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), app_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);

  -- Tout objet créé ultérieurement par le propriétaire (donc par une migration) est
  -- automatiquement accessible à l'application, en lecture/écriture de données seulement.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    owner_role, app_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    owner_role, app_role);
END
$$;
