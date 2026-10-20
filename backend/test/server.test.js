// Testes de rede do servidor POC: arranca uma instância lançada como
// subprocesso (como o smoke manual fazia, mas agora no suite). Cobrem o
// hardening da API: rate limit (com teto no mapa de buckets), validação do
// /v1/simulate, 413, 405 e nosniff. A BD fica num directório temporário.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'ceme-server-test-'));
const PORT = 30000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let child, token;

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    // backend/ é a cwd normal de `npm start`
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-secret-server-tests', DB_PATH: path.join(dir, 'ceme.db') },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/`); up = true; break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('servidor de teste não arrancou em 10s');
});

after(() => { if (child) child.kill('SIGTERM'); });

describe('server POC: hardening HTTP', () => {
  it('sessão web: token minted e simulação 200 com nosniff + headers de rate limit', async () => {
    const s = await fetch(`${BASE}/v1/session`, { method: 'POST' });
    assert.equal(s.status, 200);
    token = (await s.json()).token;
    const r = await fetch(`${BASE}/v1/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kwh: 40 }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-ratelimit-limit'), '60');
    assert.ok(r.headers.get('x-ratelimit-reset'));
    const j = await r.json();
    assert.ok(j.data.length > 100, `simulação devolve tarifários (${j.data?.length})`);
  });

  it('HTML também leva nosniff', async () => {
    assert.equal((await fetch(`${BASE}/`)).headers.get('x-content-type-options'), 'nosniff');
  });

  it('401 sem auth', async () => {
    assert.equal((await fetch(`${BASE}/v1/cemes`)).status, 401);
  });

  it('405 com allow e nosniff', async () => {
    const r = await fetch(`${BASE}/v1/cemes`, { method: 'DELETE' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  describe('/v1/simulate: validação de input hostil', () => {
    const post = (body, extra = {}) => fetch(`${BASE}/v1/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    it('JSON inválido → 400', async () => {
      assert.equal((await post('não sou json')).status, 400);
    });
    it('JSON não-objecto (array/null) → 400', async () => {
      assert.equal((await post([1, 2])).status, 400);
    });
    it('kwh negativo/não-numérico → 400', async () => {
      assert.match((await (await post({ kwh: -5 })).json()).error.code, /bad_kwh/);
      assert.equal((await post({ kwh: 'quarenta' })).status, 400);
      assert.equal((await post({ kwh: 1001 })).status, 400);
    });
    it('at inválido → 400', async () => {
      assert.equal((await post({ at: 'amanhã depois do almoço' })).status, 400);
    });
    it('omie negativo/string → 400', async () => {
      assert.equal((await post({ omie: -0.2 })).status, 400);
      assert.equal((await post({ omieVazio: 'caro' })).status, 400);
    });
    it('corpo > 64 KB → 413 com resposta (não socket reset)', async () => {
      const r = await post({ kwh: 40, lixo: 'x'.repeat(70 * 1024) });
      assert.equal(r.status, 413);
      assert.equal((await r.json()).error.code, 'payload_too_large');
    });
  });

  it('fim da janela: /v1/session limitado por IP (10/min) → 429 com Retry-After', async () => {
    // o primeiro teste consumiu 1; faltam 9 para o teto
    for (let i = 0; i < 9; i++) {
      const r = await fetch(`${BASE}/v1/session`, { method: 'POST' });
      assert.equal(r.status, 200);
    }
    const r = await fetch(`${BASE}/v1/session`, { method: 'POST' });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-ratelimit-limit'), '10');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await r.json()).error.code, 'rate_limited');
  });

  it('a API autenticada continua a responder depois do teto do /v1/session (buckets separados)', async () => {
    const r = await fetch(`${BASE}/v1/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
  });
});
