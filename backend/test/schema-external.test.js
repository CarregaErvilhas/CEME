// O schema tratado fora do processo (CEME_SCHEMA_EXTERNAL=1): schemaProblems()
// diz o que falta, e o arranque (boot.js) recusa-se a continuar se faltar
// alguma coisa. Corre em SQLite; o caminho Postgres usa o mesmo código
// (tableExists/columns de db/migrate.js), mas o arranque em si exige Postgres.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(path.join(tmpdir(), 'ceme-ext-'));
process.env.DB_PATH = path.join(dir, 'ext.db');

const { run } = await import('../src/db.js');
const { applySchema, schemaProblems } = await import('../src/db/migrate.js');
const { migrateUrl, runtimeUrl } = await import('../src/db/url.js');

describe('schema externo', () => {
  it('numa BD vazia, diz o que falta', async () => {
    assert.ok((await schemaProblems()).includes('tabela tariff'));
  });

  it('com o schema aplicado por fora, não falta nada', async () => {
    await applySchema();
    assert.deepEqual(await schemaProblems(), []);
  });

  it('detecta uma coluna nova em falta', async () => {
    await run('ALTER TABLE price_component DROP COLUMN tar_eur_kwh');
    assert.deepEqual(await schemaProblems(), ['coluna price_component.tar_eur_kwh']);
  });
});

describe('que ligação cada parte usa', () => {
  it('runtime: DATABASE_APP_URL manda; sem ela, DATABASE_URL', () => {
    assert.equal(runtimeUrl({ DATABASE_APP_URL: 'app', DATABASE_URL: 'main' }), 'app');
    assert.equal(runtimeUrl({ DATABASE_URL: 'main' }), 'main');
    assert.equal(runtimeUrl({}), '');
  });

  it('migrações: DATABASE_MIGRATE_URL manda; sem ela, DATABASE_URL; sem nenhuma, vazio', () => {
    assert.equal(migrateUrl({ DATABASE_MIGRATE_URL: 'a', DATABASE_URL: 'b' }), 'a');
    assert.equal(migrateUrl({ DATABASE_URL: 'b' }), 'b');
    assert.equal(migrateUrl({}), '');
  });
});

describe('schema externo sem Postgres', () => {
  it('recusa: um SQLite vazio não é "schema feito por fora"', () => {
    const r = spawnSync(process.execPath, ['-e', "const {boot}=await import('./src/boot.js'); await boot()"], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, CEME_SCHEMA_EXTERNAL: '1', DB_PATH: path.join(dir, 'x.db') },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /pede PostgreSQL/);
  });
});
