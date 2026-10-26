// As migrações de schema: o que o `CREATE TABLE IF NOT EXISTS` não cobre.
//
// O `CREATE TABLE IF NOT EXISTS` não acrescenta colunas a uma tabela que já
// existe; sem a migração, o seed falhava ao escrever numa coluna em falta.
// Estes testes garantem que:
//
//   - a migração acrescenta a coluna em falta a uma tabela sem ela;
//   - é idempotente (corre todas as vezes, no arranque);
//   - não mexe em tabelas que ainda não existem (numa BD nova, o schema
//     cria-as já com as colunas);
//   - a lista de colunas continua a bater certo com o schema (as duas
//     variantes), para ninguém se esquecer de actualizar uma das partes.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// db.js lê o DB_PATH no arranque (módulo), por isso tem de estar definido
// ANTES de o importar — daí os imports dinâmicos.
const dir = mkdtempSync(path.join(tmpdir(), 'ceme-migrate-'));
process.env.DB_PATH = path.join(dir, 'migrate.db');

const { query, run } = await import('../src/db.js');
const { migrateAddedColumns, migrateOmieTables, ADDED_COLUMNS } = await import('../src/db/migrate.js');

const colsOf = async (table) => (await query(`PRAGMA table_info(${table})`)).map(r => r.name);

// Uma `price_component` sem as colunas da separação energia + TAR.
const PRICE_COMPONENT_ANTIGO = `CREATE TABLE price_component (
  tariff_version_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  PRIMARY KEY (tariff_version_id, period)
)`;

describe('migração: colunas novas em tabelas que já existem', () => {
  it('acrescenta a coluna em falta à tabela com a forma antiga', async () => {
    await run(PRICE_COMPONENT_ANTIGO);
    assert.deepEqual(
      (await colsOf('price_component')).includes('energy_only_eur_kwh'),
      false,
      'a tabela de teste começa sem a coluna (como em produção)'
    );

    const notes = await migrateAddedColumns();

    const cols = await colsOf('price_component');
    assert.ok(cols.includes('energy_only_eur_kwh'), 'energy_only_eur_kwh tem de existir');
    assert.ok(cols.includes('tar_eur_kwh'), 'tar_eur_kwh tem de existir');
    // As colunas de sempre ficam como estavam.
    assert.ok(cols.includes('energy_eur_kwh'));
    assert.ok(cols.includes('iec_eur_kwh'));
    assert.equal(notes.length, 2, `duas colunas acrescentadas: ${notes.join(', ')}`);
  });

  it('é idempotente: correr outra vez não faz nada e não rebenta', async () => {
    const notes = await migrateAddedColumns();
    assert.deepEqual(notes, [], 'a segunda passagem não tem nada a fazer');
    const cols = await colsOf('price_component');
    assert.equal(cols.filter(c => c === 'energy_only_eur_kwh').length, 1, 'a coluna não pode duplicar');
  });

  it('não toca em tabelas que ainda não existem', async () => {
    await run('DROP TABLE IF EXISTS price_component');
    const notes = await migrateAddedColumns();
    assert.deepEqual(notes, [], 'sem tabela, nada a acrescentar');
  });

  it('a coluna nova nasce nula — não inventa valores para as linhas que já lá estão', async () => {
    await run(PRICE_COMPONENT_ANTIGO);
    await run(`INSERT INTO price_component (tariff_version_id, period, energy_eur_kwh)
               VALUES (1, 'VAZIO', 0.12)`);
    await migrateAddedColumns();
    const row = await query(`SELECT energy_only_eur_kwh, tar_eur_kwh, energy_eur_kwh
                               FROM price_component WHERE tariff_version_id = 1`);
    assert.equal(row[0].energy_only_eur_kwh, null, 'a energia separada é NULL até haver fonte');
    assert.equal(row[0].tar_eur_kwh, null);
    assert.equal(row[0].energy_eur_kwh, 0.12, 'o preço final não é tocado');
  });
});

// As colunas declaradas no schema, para comparar com a lista da migração.
function schemaColumns(sql, table) {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!m) return null;
  const body = m[1];
  // Separar por vírgulas de topo (fora de parênteses).
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts
    .map(p => p.trim())
    .filter(p => p && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(p))
    .map(p => p.split(/[\s(]+/)[0]);
}

describe('migração: a lista bate certo com o schema', () => {
  const read = (f) => readFileSync(new URL(`../src/db/${f}`, import.meta.url), 'utf8');

  it('toda a coluna da migração está declarada no schema (SQLite e Postgres)', () => {
    for (const f of ['schema.sql', 'schema.postgres.sql']) {
      const sql = read(f);
      for (const [table, column] of ADDED_COLUMNS) {
        const cols = schemaColumns(sql, table);
        assert.ok(cols, `${f}: a tabela ${table} não está no schema`);
        assert.ok(cols.includes(column), `${f}: ${table}.${column} não está no schema`);
      }
    }
  });

  it('toda a coluna nova do schema está na lista da migração', () => {
    // Uma coluna declarada no schema e ausente da migração é uma coluna que
    // a produção não vai ter (a tabela já existe lá).
    const declaradas = new Set(ADDED_COLUMNS.map(([, c]) => c));
    for (const f of ['schema.sql', 'schema.postgres.sql']) {
      const sql = read(f);
      const cols = schemaColumns(sql, 'price_component') || [];
      for (const c of cols) {
        if (c === 'energy_only_eur_kwh' || c === 'tar_eur_kwh') {
          assert.ok(declaradas.has(c), `${c} tem de estar na migração`);
        }
      }
    }
  });
});

describe('migração: as tabelas do OMIE com a forma antiga', () => {
  it('a forma antiga (hora local) é deitada fora', async () => {
    await run(`CREATE TABLE omie_spot (
      ts_lisbon TEXT PRIMARY KEY, market_day TEXT, market_period INTEGER,
      price_pt_eur_mwh REAL NOT NULL, source TEXT NOT NULL)`);
    const notes = await migrateOmieTables();
    assert.ok(notes.some(n => n.includes('omie_spot')), `notas: ${notes.join(', ')}`);
    const tables = (await query(`SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);
    assert.ok(!tables.includes('omie_spot'), 'a tabela antiga tem de ir embora');
  });

  it('uma forma inesperada COM dados não é apagada (ex. um rollback) — fica a nota', async () => {
    await run('DROP TABLE IF EXISTS omie_spot');
    await run(`CREATE TABLE omie_spot (ts_lisbon TEXT PRIMARY KEY, price_pt_eur_mwh REAL NOT NULL, source TEXT NOT NULL)`);
    await run(`INSERT INTO omie_spot VALUES ('2026-07-02T00:00', 80, 'OMIE_ES')`);
    const notes = await migrateOmieTables();
    assert.ok(notes.some(n => /NÃO apagada/.test(n)), `notas: ${notes.join(', ')}`);
    assert.equal((await query('SELECT COUNT(*) AS n FROM omie_spot'))[0].n, 1, 'a linha continua lá');
  });

  it('day_utc/min_utc (nomes antigos, valores de Lisboa) são renomeadas sem perder linhas', async () => {
    await run('DROP TABLE IF EXISTS omie_spot');
    await run(`CREATE TABLE omie_spot (
      ts_utc TEXT NOT NULL, day_utc TEXT NOT NULL, min_utc INTEGER NOT NULL,
      price_pt_eur_mwh REAL NOT NULL, price_es_eur_mwh REAL, bd TEXT, bs TEXT,
      source TEXT NOT NULL, flags TEXT, ingested_at TEXT,
      PRIMARY KEY (ts_utc, source))`);
    await run(`INSERT INTO omie_spot (ts_utc, day_utc, min_utc, price_pt_eur_mwh, source)
               VALUES ('2026-07-01T23:00:00.000Z', '2026-07-02', 0, 80, 'OMIE_ES')`);
    const notes = await migrateOmieTables();
    assert.ok(notes.some(n => n.includes('day_lisbon')), `notas: ${notes.join(', ')}`);
    const cols = await colsOf('omie_spot');
    assert.ok(cols.includes('day_lisbon') && cols.includes('min_lisbon'));
    assert.ok(!cols.includes('day_utc') && !cols.includes('min_utc'));
    const rows = await query('SELECT day_lisbon, min_lisbon FROM omie_spot');
    assert.deepEqual(rows.map(r => [r.day_lisbon, r.min_lisbon]), [['2026-07-02', 0]], 'a linha sobrevive');
    assert.deepEqual(await migrateOmieTables(), [], 'segunda passagem: nada a fazer');
  });
});
