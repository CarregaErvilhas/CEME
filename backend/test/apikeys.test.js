// As API keys geridas pelo tools/api-key.mjs: o que fica na BD tem de ser o
// que o http/auth.js procura (hash sha256, kind THIRD_PARTY), e a linha
// env-key, que é da variável CEME_API_KEY, fica intocável.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sqliteApi } from '../src/db/sqlite.js';
import { hashKey } from '../src/auth/tokens.js';
import { createClient, rotateKey, revoke, setLimit, list } from '../src/auth/apikeys.js';

const SCHEMA = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

// A mesma pergunta que o http/auth.js faz por cada X-API-Key.
const lookup = (db, key) => db.get(`
  SELECT c.id AS client, c.kind, c.rate_limit FROM api_key k JOIN api_client c ON c.id = k.client_id
   WHERE k.hash = $1 AND k.revoked_at IS NULL`, [hashKey(key)]);

describe('apikeys', () => {
  let db;
  beforeEach(async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(SCHEMA);
    db = sqliteApi(raw);
    await db.run(`INSERT INTO api_client (id, name, kind, rate_limit) VALUES ('env-key', 'chave da env', 'THIRD_PARTY', 60)`);
    await db.run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', 'h', 'p')`);
  });

  it('create: a chave entra pela mesma pergunta do auth, como THIRD_PARTY e com o limite pedido', async () => {
    const k = await createClient(db, 'plan2charge', { limit: 120 });
    assert.match(k.key, /^[0-9a-f]{64}$/);
    assert.equal(k.prefix, k.key.slice(0, 8));
    assert.deepEqual({ ...(await lookup(db, k.key)) }, { client: 'plan2charge', kind: 'THIRD_PARTY', rate_limit: 120 });
    assert.ok(!(await list(db)).some(r => 'hash' in r), 'list nunca devolve o hash');
  });

  it('create recusa cliente repetido, env-key, nomes estranhos e limites inválidos', async () => {
    await createClient(db, 'p2c');
    await assert.rejects(createClient(db, 'p2c'), /já existe/);
    await assert.rejects(createClient(db, 'env-key'), /CEME_API_KEY/);
    await assert.rejects(createClient(db, 'Plan 2'), /cliente inválido/);
    for (const limit of [0, -1, 1.5, 'x']) await assert.rejects(createClient(db, 'outro', { limit }), /limite inválido/);
  });

  it('rotate: a chave nova entra e a antiga continua até ser revogada', async () => {
    const a = await createClient(db, 'p2c');
    const b = await rotateKey(db, 'p2c');
    assert.ok(await lookup(db, a.key));
    assert.ok(await lookup(db, b.key));
    assert.equal(await revoke(db, a.id), 1);
    assert.equal(await lookup(db, a.key), null);
    assert.ok(await lookup(db, b.key));
    await assert.rejects(rotateKey(db, 'nao-existe'), /não existe/);
  });

  it('revoke pelo cliente revoga todas as activas e não toca na env-key', async () => {
    const a = await createClient(db, 'p2c');
    const b = await rotateKey(db, 'p2c');
    assert.equal(await revoke(db, 'p2c'), 2);
    assert.equal(await lookup(db, a.key), null);
    assert.equal(await lookup(db, b.key), null);
    assert.equal(await revoke(db, 'p2c'), 0);
    await assert.rejects(revoke(db, 'env-key'), /CEME_API_KEY/);
    assert.equal((await db.get(`SELECT revoked_at FROM api_key WHERE id = 'env-key'`)).revoked_at, null);
  });

  it('limit muda o rate_limit do cliente e recusa clientes que não existem', async () => {
    const k = await createClient(db, 'p2c');
    assert.equal(await setLimit(db, 'p2c', '300'), 300);
    assert.equal((await lookup(db, k.key)).rate_limit, 300);
    await assert.rejects(setLimit(db, 'nao-existe', 10), /não existe/);
    await assert.rejects(setLimit(db, 'env-key', 10), /CEME_API_KEY/);
  });
});

describe('tools/api-key.mjs', () => {
  it('sem URL da BD recusa-se a correr em vez de escrever no SQLite local', () => {
    const { DATABASE_URL, DATABASE_APP_URL, ...env } = process.env;
    void DATABASE_URL; void DATABASE_APP_URL;
    const r = spawnSync(process.execPath, [new URL('../tools/api-key.mjs', import.meta.url).pathname, 'list'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SQLite local/);
  });
});
