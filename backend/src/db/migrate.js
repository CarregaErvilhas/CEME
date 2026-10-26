// Ajustes ao schema que o `CREATE TABLE IF NOT EXISTS` não faz.
//
// O schema (schema.sql / schema.postgres.sql) corre em cada arranque com
// `CREATE TABLE IF NOT EXISTS`. Isso cria tabelas que faltam, mas não mexe em
// tabelas que já existem. Este ficheiro trata desses casos, nos dois
// dialectos (SQLite e Postgres):
//
// 1. migrateOmieTables() — corre ANTES do schema. Garante que as tabelas do
//    OMIE têm as colunas esperadas: renomeia colunas com nome antigo e, se
//    uma tabela vazia tiver uma forma que não reconhece, apaga-a para o
//    schema a recriar. Uma tabela com dados nunca é apagada.
//
// 2. migrateAddedColumns() — corre DEPOIS do schema e ANTES do seed.
//    Acrescenta as colunas de ADDED_COLUMNS que faltem em tabelas existentes.
//    Sem isto, o seed escrevia numa coluna que não existe e o arranque
//    falhava.
import { query, run } from '../db.js';

const USE_PG = !!process.env.DATABASE_URL;

// Os nomes das colunas de uma tabela (lista vazia se a tabela não existir).
//
// No Postgres usa-se `to_regclass`, que encontra a tabela pelo mesmo
// caminho (search_path) que as queries normais usam. Assim vês exactamente a
// tabela onde o seed vai escrever.
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

const hasRows = async (table) => (await query(`SELECT 1 FROM ${table} LIMIT 1`)).length > 0;

// Colunas que o omie_spot e o omie_daily têm de ter (vê o schema).
const SPOT_COLS = ['ts_utc', 'day_lisbon', 'min_lisbon', 'price_pt_eur_mwh', 'source'];
const DAILY_COLS = ['date', 'bd_v', 'bd_f', 'bs_v', 'bs_f'];

// Renomeações [nome antigo, nome actual]. RENAME mantém os dados, e corre
// antes da verificação de forma para uma tabela com dados não parecer
// estranha.
const SPOT_RENAMES = [['day_utc', 'day_lisbon'], ['min_utc', 'min_lisbon']];

// Depois de apagar uma tabela do OMIE, o `omie_meta` ainda diz que os dados
// estão frescos e ninguém os ia buscar outra vez. Limpar `last_refresh` e
// `stats` obriga a nova ingestão no pedido seguinte.
async function forgetOmieFreshness(notes) {
  if (!(await tableExists('omie_meta'))) return;
  await run(`DELETE FROM omie_meta WHERE key IN ('last_refresh', 'stats')`);
  notes.push('omie_meta: last_refresh e stats limpos (forçam reingestão)');
}

export async function migrateOmieTables() {
  const notes = [];

  if (await tableExists('omie_spot')) {
    let cols = await columns('omie_spot');
    for (const [from, to] of SPOT_RENAMES) {
      if (cols.includes(from) && !cols.includes(to)) {
        await run(`ALTER TABLE omie_spot RENAME COLUMN ${from} TO ${to}`);
        notes.push(`omie_spot.${from} renomeada para ${to}`);
      }
    }
    cols = await columns('omie_spot');
    if (cols.length && !SPOT_COLS.every(c => cols.includes(c))) {
      // Só se apaga uma tabela VAZIA. Com dados, uma forma inesperada pede
      // olhos humanos (pode ser um rollback de código): fica um aviso no log,
      // a tabela fica como está e o arranque continua.
      if (await hasRows('omie_spot')) {
        notes.push(`omie_spot: forma inesperada COM dados (colunas: ${cols.join(', ')}) — NÃO apagada; resolver à mão`);
      } else {
        await query('DROP TABLE omie_spot');
        notes.push('omie_spot: forma antiga (hora local) deitada fora');
        await forgetOmieFreshness(notes);
      }
    }
  }
  if (await tableExists('omie_daily')) {
    const cols = await columns('omie_daily');
    if (cols.length && !DAILY_COLS.every(c => cols.includes(c))) {
      if (await hasRows('omie_daily')) {
        notes.push(`omie_daily: forma inesperada COM dados (colunas: ${cols.join(', ')}) — NÃO apagada; resolver à mão`);
      } else {
        await query('DROP TABLE omie_daily');
        notes.push('omie_daily: forma antiga deitada fora');
        await forgetOmieFreshness(notes);
      }
    }
  }
  return notes;
}

// Colunas acrescentadas a tabelas que já existem: [tabela, coluna, tipo].
//
// Para acrescentares uma coluna a uma tabela existente:
//   1. põe-na nos dois schemas (schema.sql e schema.postgres.sql);
//   2. põe-na nesta lista;
//   3. põe-na na verificação de test/migrate.test.js.
export const ADDED_COLUMNS = [
  // A separação do preço em energia + TAR (quando o CEME a publica).
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
    // A coluna nasce sem valor (NULL) nas linhas existentes; o seed preenche
    // a seguir o que souber.
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    notes.push(`${table}.${column} acrescentada`);
  }
  return notes;
}
