// Schema e migrações fora do processo da API, com a role dona da BD.
//
//   node src/db/migrate-cli.js
//
// A API corre com uma role só com DML (db/grants.postgres.sql) e não faz DDL;
// quem cria tabelas e acrescenta colunas é este script, que o Zerops corre no
// arranque do container (`initCommands`, vê infra.md) com a role dona.
//
// A ligação vem de DATABASE_MIGRATE_URL; sem ela usa a DATABASE_URL (é o caso
// antes de a role do runtime existir). Sem nenhuma, é SQLite local.
//
// Depois do schema, no Postgres, aplica os privilégios da role do runtime
// (se a role já existir), para uma tabela nova ficar acessível no mesmo
// deploy em que nasce.
import { readFile } from 'node:fs/promises';
import { migrateUrl } from './url.js';

export const APP_ROLE = 'ceme_app';


const url = migrateUrl(process.env);
// db.js lê a URL ao ser importado, por isso fixa-se antes (e só neste
// processo, que acaba logo a seguir). A DATABASE_APP_URL sai, senão ganhava.
if (url) process.env.DATABASE_URL = url; else delete process.env.DATABASE_URL;
delete process.env.DATABASE_APP_URL;
delete process.env.DATABASE_MIGRATE_URL;

const { get, exec, close, USE_PG } = await import('../db.js');
const { applySchema } = await import('./migrate.js');

try {
  for (const n of await applySchema()) console.warn(`[ceme-v2] migração: ${n}`);
  if (USE_PG) {
    const role = await get(`SELECT 1 AS ok FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    if (role) {
      await exec(await readFile(new URL('./grants.postgres.sql', import.meta.url), 'utf8'));
      console.warn(`[ceme-v2] privilégios de ${APP_ROLE} aplicados`);
    } else {
      console.warn(`[ceme-v2] role ${APP_ROLE} ainda não existe: privilégios por aplicar`);
    }
  }
} catch (e) {
  console.error('[ceme-v2] migrate-cli falhou:', e.message);
  process.exitCode = 1;
} finally {
  await close();
}
