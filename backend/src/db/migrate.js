// Ajustes ao schema que o `CREATE TABLE IF NOT EXISTS` não faz.
//
// O schema (schema.sql / schema.postgres.sql) corre em cada arranque com
// `CREATE TABLE IF NOT EXISTS`. Isso cria tabelas que faltam, mas não mexe em
// tabelas que já existem: uma coluna nova numa tabela que já existe nunca
// apareceria.
//
// migrateAddedColumns() corre DEPOIS do schema e ANTES do seed, nos dois
// dialectos (SQLite e Postgres), e acrescenta as colunas de ADDED_COLUMNS
// que faltem. Sem isto, o seed escrevia numa coluna que não existe e o
// arranque falhava.
import { readFile } from 'node:fs/promises';
import { query, run, exec, USE_PG } from '../db.js';
import { RETIRED_TARIFFS, RETIRED_CEMES } from './seed-data.js';

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
  // O número do tarifário na folha original (vê LEGACY_IDS).
  ['tariff', 'legacy_id', 'INTEGER'],
  // Tarifários só para quem adere ao CEME (vê `newCustomers` em TARIFFS).
  ['tariff', 'new_customers', 'INTEGER DEFAULT 0'],
  // Tarifários só para um público (vê `audience` em TARIFFS).
  ['tariff', 'audience', 'TEXT'],
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

// O ficheiro de schema do dialecto em uso.
const schemaUrl = () => new URL(USE_PG ? './schema.postgres.sql' : './schema.sql', import.meta.url);

// O schema inteiro: `CREATE TABLE IF NOT EXISTS` e depois as colunas novas.
// Precisa de DDL, por isso em produção corre com a role dona
// (db/migrate-cli.js), não com a do runtime. Devolve as notas da migração.
export async function applySchema() {
  await exec(await readFile(schemaUrl(), 'utf8'));
  return [...await migrateAddedColumns(), ...await removeRetired()];
}

// Apaga os tarifários de RETIRED_TARIFFS (com as versões e os preços) e os
// CEME de RETIRED_CEMES. O seed só faz upsert, por isso sem isto ficavam na
// BD para sempre. Precisa de DELETE, que a role do runtime não tem: corre
// aqui, com a role dona. Idempotente: numa BD sem eles não faz nada.
//
// Um CEME com contactos em `ceme_contact` fica: esses dados não vêm do seed
// e não se apagam às escondidas. A nota diz qual ficou.
export async function removeRetired() {
  const notes = [];
  if (!(await tableExists('tariff'))) return notes;
  for (const id of RETIRED_TARIFFS) {
    if (!(await query('SELECT 1 FROM tariff WHERE id = $1', [id])).length) continue;
    const versions = 'SELECT id FROM tariff_version WHERE tariff_id = $1';
    await run(`DELETE FROM price_component_region WHERE tariff_version_id IN (${versions})`, [id]);
    await run(`DELETE FROM price_component WHERE tariff_version_id IN (${versions})`, [id]);
    await run('DELETE FROM tariff_version WHERE tariff_id = $1', [id]);
    await run('DELETE FROM tariff WHERE id = $1', [id]);
    notes.push(`tarifário ${id} apagado`);
  }
  for (const id of RETIRED_CEMES) {
    if (!(await query('SELECT 1 FROM ceme WHERE id = $1', [id])).length) continue;
    const refs = [];
    for (const table of ['tariff', 'promo', 'ceme_contact']) {
      if ((await query(`SELECT 1 FROM ${table} WHERE ceme_id = $1 LIMIT 1`, [id])).length) refs.push(table);
    }
    if (refs.length) { notes.push(`CEME ${id} fica: ainda tem linhas em ${refs.join(', ')}`); continue; }
    await run('DELETE FROM ceme WHERE id = $1', [id]);
    notes.push(`CEME ${id} apagado`);
  }
  return notes;
}

// Com o schema tratado fora do processo (CEME_SCHEMA_EXTERNAL=1), o arranque
// só confirma que ele lá está: cada tabela do schema e cada coluna de
// ADDED_COLUMNS. Devolve o que falta (lista vazia = tudo bem), para falhar
// já com uma mensagem clara em vez de um erro obscuro a meio do seed.
export async function schemaProblems() {
  const sql = await readFile(schemaUrl(), 'utf8');
  const problems = [];
  for (const [, table] of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
    if (!(await tableExists(table))) problems.push(`tabela ${table}`);
  }
  for (const [table, column] of ADDED_COLUMNS) {
    if (!(await tableExists(table))) continue;
    if (!(await columns(table)).includes(column)) problems.push(`coluna ${table}.${column}`);
  }
  return problems;
}
