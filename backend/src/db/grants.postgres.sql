-- Privilégios da role do runtime (ceme_app) sobre as tabelas. Corre em cada
-- arranque, depois do schema, com a role dona (db/migrate-cli.js), por isso é
-- idempotente e uma tabela nova fica acessível no deploy em que nasce.
--
-- O mínimo que o código usa (grep a INSERT/UPDATE/DELETE em backend/src):
--   - SELECT + INSERT + UPDATE nas tabelas que o arranque, o OMIE e a API
--     escrevem (todas fazem upsert, que precisa dos três);
--   - DELETE só em omie_meta (liberta o lock da actualização do OMIE);
--   - nada em ceme_contact, suggestion, audit_log: a API não as lê nem
--     escreve (ceme_contact tem contactos internos).
-- Sem TRUNCATE, REFERENCES nem TRIGGER, e sem CREATE no schema.
--
-- Uma tabela nova nos schemas tem de aparecer aqui (ou na lista «sem
-- acesso» do test/grants.test.js); o teste falha se ficar de fora.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ceme_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ceme_app;

GRANT SELECT, INSERT, UPDATE ON
  ceme, tariff, tariff_version, price_component, price_component_region, promo, tar,
  omie_spot, omie_daily, omie_meta, api_client, api_key
  TO ceme_app;

GRANT DELETE ON omie_meta TO ceme_app;

-- tariff_version.id é SERIAL: o INSERT precisa do nextval.
GRANT USAGE ON SEQUENCE tariff_version_id_seq TO ceme_app;
