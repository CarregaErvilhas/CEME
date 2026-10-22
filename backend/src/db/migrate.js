// Migrações de schema que o `CREATE TABLE IF NOT EXISTS` não cobre.
//
// Duas coisas vivem aqui:
//
// 1. **Tabelas cuja forma mudou** — as do OMIE passaram a ser indexadas
//    pelo instante em UTC (a chave antiga era a hora local, que se repete na
//    mudança de hora). A tabela antiga está vazia — nunca foi usada — por
//    isso pode ser deitada fora e recriada com a forma nova. Corre ANTES do
//    schema: drop + o schema recria.
//
// 2. **Colunas novas em tabelas que já existem** — `CREATE TABLE IF NOT
//    EXISTS` cria a tabela se não existe, mas NUNCA acrescenta colunas a uma
//    tabela que já existe. Foi o que rebentou a produção: a `price_component`
//    ficou com a forma antiga e o seed foi à vida com
//    `column "energy_only_eur_kwh" of relation "price_component" does not
//    exist`, em loop de crash, com o site em 502.
//
// A forma de uma tabela é da BD, não do seed: por isso a migração vive aqui
// e serve para os dois dialetos (SQLite e Postgres) e para o seed corrido à
// mão (`node src/db/seed.postgres.js`).
import { query, run } from '../db.js';

const USE_PG = !!process.env.DATABASE_URL;

// As colunas de uma tabela, nos dois dialects.
//
// No Postgres usa-se `to_regclass`: resolve o nome pelo search_path —
// exactamente o mesmo pelo qual as queries do servidor acedem às tabelas
// (nomes sem qualifying). Assim a migração vê a MESMA tabela que o seed
// vai escrever, mesmo que o search_path aponte para outro schema. Se a
// tabela não existir, `to_regclass` devolve NULL e a lista vem vazia (sem
// erro).
async function columns(table) {
  if (USE_PG) {
    const rows = await query(
      `SELECT a.attname AS name
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1::text)
          AND a.attnum > 0
          AND NOT a.attisdropped`,
      [table]
    );
    return rows.map(r => r.name);
  }
  const rows = await query(`PRAGMA table_info(${table})`);
  return rows.map(r => r.name);
}

async function tableExists(table) {
  if (USE_PG) {
    const rows = await query(`SELECT to_regclass($1::text) IS NOT NULL AS ok`, [table]);
    return rows.length > 0 && rows[0].ok === true;
  }
  const rows = await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`, [table]);
  return rows.length > 0;
}

// A forma que o omie_spot deve ter: indexada pelo instante UTC.
const SPOT_COLS = ['ts_utc', 'day_utc', 'min_utc', 'price_pt_eur_mwh', 'source'];
const DAILY_COLS = ['date', 'bd_v', 'bd_f', 'bs_v', 'bs_f'];

export async function migrateOmieTables() {
  const notes = [];

  if (await tableExists('omie_spot')) {
    const cols = await columns('omie_spot');
    if (cols.length && !SPOT_COLS.every(c => cols.includes(c))) {
      await query('DROP TABLE omie_spot');
      notes.push('omie_spot: forma antiga (hora local) deitada fora');
    }
  }
  if (await tableExists('omie_daily')) {
    const cols = await columns('omie_daily');
    if (cols.length && !DAILY_COLS.every(c => cols.includes(c))) {
      await query('DROP TABLE omie_daily');
      notes.push('omie_daily: forma antiga deitada fora');
    }
  }
  return notes;
}

// Colunas que passaram a existir depois de as tabelas já estarem criadas.
// `[tabela, coluna, tipo]`. O tipo é o do schema (REAL nos dois dialetos).
//
// Quando se acrescenta uma coluna a esta lista, acrescentá-la também ao
// schema (as duas variantes) — o teste `migrate.test.js` verifica que as
// duas coisas batem certo.
export const ADDED_COLUMNS = [
  // A decomposição do preço em energia + TAR (só onde a folha a tinha).
  ['price_component', 'energy_only_eur_kwh', 'REAL'],
  ['price_component', 'tar_eur_kwh', 'REAL'],
];

export async function migrateAddedColumns() {
  const notes = [];

  for (const [table, column, type] of ADDED_COLUMNS) {
    // A tabela ainda não existe: o schema cria-a já com a coluna.
    if (!(await tableExists(table))) continue;
    const cols = await columns(table);
    if (cols.includes(column)) continue;
    // Sem NOT NULL e sem DEFAULT: a coluna nasce nula, sem inventar valor
    // para as linhas que já lá estão. O seed (que é um upsert) preenche
    // depois o que sabe.
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    notes.push(`${table}.${column} acrescentada`);
  }
  return notes;
}
