// Testes do modo PostgreSQL que NÃO precisam de um servidor a correr.
//
// Contexto: a migração SQLite→pg passou 107/107 sem que nada exercitasse o
// caminho pg, e por isso escapou uma regressão silenciosa — o driver pg
// convertia colunas DATE em `Date` e o JSON saía como
// '2026-10-14T23:00:00.000Z' (dia anterior, dependente do fuso) onde o
// SQLite devolvia '2026-10-15'. Estes testes fixam esse contrato.
//
// Um teste end-to-end contra um Postgres real continua a faltar (ver
// docs/08, Passo 6): aqui só se garante o que se consegue garantir sem
// servidor — o comportamento do cliente (parsers de tipo) e a paridade da
// semântica SQL entre os dois dialetos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { types } from 'pg';

// Importar pg.js é o que regista os parsers de tipo (efeito de módulo).
await import('../src/db/pg.js');

test('pg: DATE não passa a Date/ISO (equivalência com o texto do SQLite)', () => {
  const parseDate = types.getTypeParser(1082);
  const out = parseDate('2026-10-15');
  assert.equal(out, '2026-10-15', 'DATE tem de manter a forma YYYY-MM-DD');

  // O que a regressão produzia: dia anterior, em UTC.
  const viaJson = JSON.parse(JSON.stringify({ valid_from: out }));
  assert.equal(viaJson.valid_from, '2026-10-15');
  assert.ok(!viaJson.valid_from.includes('T'), 'não pode ter componente de tempo');
});

test('pg: TIMESTAMP não passa a Date (consistência com o DATE)', () => {
  const parseTs = types.getTypeParser(1114);
  assert.equal(parseTs('2026-10-15 23:00:00'), '2026-10-15 23:00:00');
});

test('pg: a parser de DATE é a mesma em todos os casos-limite', () => {
  const parseDate = types.getTypeParser(1082);
  // viragem de ano, mês de 1 dígito, 29 de fevereiro bissexto
  for (const d of ['2026-01-01', '2026-12-31', '2026-02-29', '2026-03-01']) {
    assert.equal(parseDate(d), d);
  }
});

test('pg: CURRENT_TIMESTAMP existe em ambos os dialetos (expires_at)', async () => {
  // A semântica de expiração passou a usar CURRENT_TIMESTAMP (instante) em
  // vez de CURRENT_DATE (dia inteiro). Verifica-se no motor que temos
  // disponível que a chave expirada sai e a válida fica; o SQL é comum aos
  // dois dialetos, portanto o mesmo predicado aplica-se ao pg.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE k (expires_at TEXT)');
  db.prepare('INSERT INTO k VALUES (?)').run('2000-01-01 00:00:00');
  db.prepare('INSERT INTO k VALUES (?)').run('2999-01-01 00:00:00');

  const alive = db
    .prepare('SELECT expires_at FROM k WHERE expires_at > CURRENT_TIMESTAMP')
    .all()
    .map((r) => r.expires_at);

  assert.deepEqual(alive, ['2999-01-01 00:00:00'], 'só a chave não expirada deve sobreviver');
  db.close();
});
