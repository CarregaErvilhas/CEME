// Testes do modo PostgreSQL que NÃO precisam de um servidor a correr.
//
// Por omissão o driver pg converte colunas DATE em `Date`, e o JSON sairia
// '2026-10-14T23:00:00.000Z' (dia anterior, conforme o fuso) onde o SQLite
// devolve '2026-10-15'. Estes testes garantem que os dois devolvem o mesmo.
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

  // Passado por JSON, continua a ser o mesmo dia.
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
  // A expiração das chaves compara com CURRENT_TIMESTAMP (um instante), não
  // com CURRENT_DATE (um dia inteiro). Verifica-se no motor que temos
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
