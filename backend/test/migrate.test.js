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
const { migrateAddedColumns, ADDED_COLUMNS } = await import('../src/db/migrate.js');

const colsOf = async (table) => (await query(`PRAGMA table_info(${table})`)).map(r => r.name);

// Uma `price_component` sem as colunas da separação energia + TAR.
const PRICE_COMPONENT_SEM_COLUNAS = `CREATE TABLE price_component (
  tariff_version_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  energy_eur_kwh REAL, activation_eur REAL DEFAULT 0,
  support_eur REAL DEFAULT 0, iec_eur_kwh REAL DEFAULT 0,
  PRIMARY KEY (tariff_version_id, period)
)`;

describe('migração: colunas novas em tabelas que já existem', () => {
  it('acrescenta a coluna em falta a uma tabela que não a tem', async () => {
    await run(PRICE_COMPONENT_SEM_COLUNAS);
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
    await run(PRICE_COMPONENT_SEM_COLUNAS);
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
