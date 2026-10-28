// Os scripts de privilégios do Postgres (sem servidor): a role do runtime não
// pode ter mais do que o código usa, e nenhuma tabela pode ficar esquecida.
// O efeito real nos privilégios só se vê num Postgres a sério (docs/08).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../src/db/${f}`, import.meta.url), 'utf8');
const schema = read('schema.postgres.sql');
const grants = read('grants.postgres.sql');
const role = read('role.postgres.sql');
const code = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

// Tabelas que a API não toca (ficam sem qualquer privilégio).
const SEM_ACESSO = ['ceme_contact', 'suggestion', 'audit_log'];

const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

describe('grants.postgres.sql', () => {
  const granted = new Set();
  for (const m of code(grants).matchAll(/GRANT SELECT, INSERT, UPDATE ON\s+([\s\S]*?)\s+TO ceme_app;/g)) {
    for (const t of m[1].split(',')) granted.add(t.trim());
  }

  it('cada tabela do schema ou tem privilégios ou está em SEM_ACESSO', () => {
    for (const t of tables) {
      assert.ok(granted.has(t) !== SEM_ACESSO.includes(t), `${t}: decide se a API a usa (grants.postgres.sql)`);
    }
  });

  it('não dá privilégios a tabelas que não existem', () => {
    for (const t of granted) assert.ok(tables.includes(t), t);
  });

  it('nada de ALL, TRUNCATE, REFERENCES, TRIGGER, nem CREATE', () => {
    const c = code(grants);
    assert.ok(!/GRANT\s+ALL/i.test(c));
    assert.ok(!/TRUNCATE|REFERENCES|TRIGGER|\bCREATE\b/i.test(c));
  });

  it('DELETE só em omie_meta', () => {
    const dels = [...code(grants).matchAll(/GRANT DELETE ON (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(dels, ['omie_meta']);
  });

  it('o único sequence é o do SERIAL usado (tariff_version)', () => {
    const seqs = [...code(grants).matchAll(/ON SEQUENCE (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(seqs, ['tariff_version_id_seq']);
    assert.match(schema, /tariff_version \(\s*\n?\s*id SERIAL/);
  });
});

describe('role.postgres.sql', () => {
  const c = code(role);
  it('a role não é super, não cria roles nem BDs', () => {
    assert.match(c, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    assert.ok(!/(?<!NO)(SUPERUSER|CREATEDB|CREATEROLE|REPLICATION|BYPASSRLS)/.test(c));
  });
  it('tem de ficar sem CREATE no schema', () => {
    assert.match(c, /REVOKE CREATE ON SCHEMA public FROM ceme_app/);
  });
  it('a palavra-passe vem por variável do psql, nunca escrita no ficheiro', () => {
    assert.match(c, /:'app_pw'/);
  });
});
