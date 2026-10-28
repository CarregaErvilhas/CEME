-- Cria (ou actualiza) a role do runtime da API. Corre UMA vez, à mão, como
-- utilizador principal do serviço `db` (infra.md, «Privilégios da base de
-- dados»); as tabelas ficam por conta de grants.postgres.sql.
--
--   psql "$MAIN_URL" -v ON_ERROR_STOP=1 -v app_pw="$APP_PW" -f role.postgres.sql
--
-- Sem SUPERUSER, CREATEDB, CREATEROLE, REPLICATION nem BYPASSRLS, e sem
-- CREATE no schema public: não consegue criar nem alterar tabelas, nem criar
-- roles.
SELECT current_database() AS dbname, current_user AS owner \gset

SELECT format('CREATE ROLE ceme_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ceme_app') \gexec

-- Se a role já existia, isto roda-lhe a palavra-passe.
SELECT format('ALTER ROLE ceme_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_pw') \gexec

GRANT CONNECT ON DATABASE :"dbname" TO ceme_app;
GRANT USAGE ON SCHEMA public TO ceme_app;
REVOKE CREATE ON SCHEMA public FROM ceme_app;

-- A BD não tem outras roles de aplicação, mas por precaução: a role não
-- herda nada além do que lhe é dado aqui.
ALTER ROLE ceme_app SET timezone = 'UTC';
