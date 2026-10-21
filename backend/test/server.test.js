// Testes de rede do servidor POC: arranca uma instância como subprocesso
// (como o smoke manual fazia, mas agora no suite). Cobrem o hardening da
// API: rate limit (com teto no mapa de buckets), validação do /v1/simulate,
// 413, 405, nosniff, quarentena de tarifário mau e a secret de dev sem
// emitir tokens em produção. A BD fica num directório temporário.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'ceme-server-test-'));
const PORT = 30000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const BACKEND = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Espera o arranque do subprocesso (polling em /): dev/CI não têm portas
// certeiras, e o server só responde depois do seed.
const waitUp = async (url) => {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`servidor de teste não arrancou em 10s: ${url}`);
};

const spawnServer = (envOverride, port) => {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND, // backend/ é a cwd normal de `npm start`
    env: { ...envOverride, PORT: String(port), DB_PATH: path.join(dir, `ceme-${port}.db`) },
    stdio: 'ignore',
  });
};

describe('server POC: hardening HTTP', () => {
  let proc, token;

  before(async () => {
    proc = spawnServer({ ...process.env, JWT_SECRET: 'test-secret-server-tests' }, PORT);
    await waitUp(`${BASE}/`);
  });
  after(() => { if (proc) proc.kill('SIGTERM'); });

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
    // EGME publicada vs legal: o seed fica com o publicado (0,1572 na maior
    // parte), por isso tem de haver flags `activation_stale` — e o legal
    // referenciado em todos
    assert.equal(j.data[0].egme_legal, 0.1088);
    assert.ok(j.data.some(q => q.activation_stale === true), 'CEMEs com o EGME de 2025 ainda acima do legal 2026');
    assert.ok(j.data.every(q => typeof q.activation_stale === 'boolean'));
  });

  it('HTML também leva nosniff', async () => {
    assert.equal((await fetch(`${BASE}/`)).headers.get('x-content-type-options'), 'nosniff');
  });

  describe('duas interfaces: o cookie ceme_ui escolhe a página', () => {
    // Marca visual de cada página: a cena animada só existe no assistente, o
    // hero só no simulador completo.
    const MARCA = { assistente: 'class="scene"', completo: 'class="hero"' };
    const abrir = async (caminho, headers = {}, opts = {}) => {
      const r = await fetch(`${BASE}${caminho}`, { headers, ...opts });
      return { status: r.status, html: await r.text(), cookie: r.headers.get('set-cookie') || '', r };
    };

    it('sem cookie, / serve o assistente e não grava nada (primeira visita)', async () => {
      const { status, html, cookie } = await abrir('/');
      assert.equal(status, 200);
      assert.ok(html.includes(MARCA.assistente), 'a primeira visita devia ver o assistente');
      assert.ok(!html.includes(MARCA.completo), 'a página do simulador não pode vir junto');
      assert.equal(cookie, '', '/ não pode escrever o cookie: a primeira visita é sempre o assistente');
    });

    it('cookie ceme_ui=completo faz / servir o simulador', async () => {
      const { status, html, cookie } = await abrir('/', { cookie: 'ceme_ui=completo' });
      assert.equal(status, 200);
      assert.ok(html.includes(MARCA.completo), 'com o cookie devia vir o simulador completo');
      assert.equal(cookie, '', '/ só lê o cookie, não o reescreve');
    });

    it('cookie estragado cai no assistente em vez de rebentar', async () => {
      for (const c of ['ceme_ui=%%%', 'ceme_ui=;', 'outro=1', 'CEEME_UI=completo']) {
        const { status, html } = await abrir('/', { cookie: c });
        assert.equal(status, 200, c);
        assert.ok(html.includes(MARCA.assistente), `cookie "${c}" devia cair no assistente`);
      }
    });

    it('/assistente serve a página leve e grava a escolha (1 ano, SameSite)', async () => {
      const { status, html, cookie } = await abrir('/assistente');
      assert.equal(status, 200);
      assert.ok(html.includes(MARCA.assistente));
      assert.match(cookie, /^ceme_ui=assistente;/);
      assert.match(cookie, /Path=\//);
      assert.match(cookie, /Max-Age=31536000/);
      assert.match(cookie, /SameSite=Lax/);
    });

    it('/simulador serve o simulador completo e grava a escolha', async () => {
      const { status, html, cookie } = await abrir('/simulador');
      assert.equal(status, 200);
      assert.ok(html.includes(MARCA.completo));
      assert.match(cookie, /^ceme_ui=completo;/);
    });

    it('/index.html continua a funcionar e segue o cookie', async () => {
      assert.ok((await abrir('/index.html')).html.includes(MARCA.assistente));
      assert.ok((await abrir('/index.html', { cookie: 'ceme_ui=completo' })).html.includes(MARCA.completo));
    });

    it('HEAD nas duas rotas: 200 com o mesmo set-cookie, corpo vazio', async () => {
      const r = await fetch(`${BASE}/simulador`, { method: 'HEAD' });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie') || '', /ceme_ui=completo/);
      assert.equal(await r.text(), '');
    });

    it('/strings.js é servido como JS e sem cache', async () => {
      const r = await fetch(`${BASE}/strings.js`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/javascript/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      const js = await r.text();
      assert.match(js, /CEME_I18N/);
      assert.match(js, /CEME_STR/);
    });

    it('a língua negociada é injectada nas duas páginas', async () => {
      for (const caminho of ['/assistente', '/simulador']) {
        const { html, r } = await abrir(caminho, { 'accept-language': 'en-GB,en;q=0.9' });
        assert.ok(html.includes('<html lang="en">'), `${caminho}: <html lang> não negociado`);
        assert.ok(html.includes('window.__LANG__="en"'), `${caminho}: __LANG__ não injectado`);
        assert.match(r.headers.get('vary') || '', /Cookie/, `${caminho}: resposta depende do cookie, tem de ir no Vary`);
      }
      const pt = await abrir('/assistente', { 'accept-language': 'pt-PT' });
      assert.ok(pt.html.includes('<html lang="pt-PT">'));
      assert.ok(pt.html.includes('window.__LANG__="pt"'));
    });
  });

  // Sobre e Contactos: páginas estáticas do site, sem cookie (a escolha do
  // cookie é só da interface) e com a mesma negociação de língua.
  describe('páginas institucionais: Sobre e Contactos', () => {
    const abrir = async (caminho, headers = {}) => {
      const r = await fetch(`${BASE}${caminho}`, { headers });
      return { status: r.status, html: await r.text(), cookie: r.headers.get('set-cookie') || '', r };
    };

    it('/sobre e /about servem a mesma página', async () => {
      for (const caminho of ['/sobre', '/about']) {
        const { status, html, cookie } = await abrir(caminho);
        assert.equal(status, 200, caminho);
        // O texto vem do dicionário em runtime; no HTML servido verifica-se o
        // <title> e o namespace pedido.
        assert.ok(html.includes('<title>Sobre o Comparador CEME</title>'), `${caminho}: título em falta`);
        assert.ok(html.includes("CEME_STR('about')"), `${caminho}: não pede o namespace certo`);
        assert.equal(cookie, '', `${caminho}: não deve gravar cookie`);
      }
    });

    it('/contactos e /contact servem a mesma página', async () => {
      for (const caminho of ['/contactos', '/contact']) {
        const { status, html, cookie } = await abrir(caminho);
        assert.equal(status, 200, caminho);
        assert.ok(html.includes('<title>Contactos — Comparador CEME</title>'), `${caminho}: título em falta`);
        assert.ok(html.includes("CEME_STR('contact')"), `${caminho}: não pede o namespace certo`);
        assert.equal(cookie, '', `${caminho}: não deve gravar cookie`);
      }
    });

    it('a língua negociada é injectada também nestas páginas', async () => {
      for (const caminho of ['/sobre', '/contactos']) {
        const { html, r } = await abrir(caminho, { 'accept-language': 'en-GB,en;q=0.9' });
        assert.ok(html.includes('<html lang="en">'), `${caminho}: <html lang> não negociado`);
        assert.ok(html.includes('window.__LANG__="en"'), `${caminho}: __LANG__ não injectado`);
        assert.match(r.headers.get('vary') || '', /Accept-Language/, `${caminho}: falta o Vary`);
      }
    });

    it('/pages.css é servido como CSS e sem cache', async () => {
      const r = await fetch(`${BASE}/pages.css`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/css/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });
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

  it('quarentena: um tarifário com componentes divergentes não derruba os 128', async () => {
    // corrompe UM período de UM tarifário na BD do servidor (a cena do bot:
    // activation 0,11 → 0,12 muda um período só do atlante MT)
    const db = new DatabaseSync(path.join(dir, `ceme-${PORT}.db`));
    db.prepare(`UPDATE price_component SET activation_eur=0.99 WHERE tariff_version_id=(
      SELECT v.id FROM tariff_version v JOIN tariff t ON t.id=v.tariff_id
      WHERE t.id='atlante-mt-myatlanteac' ORDER BY v.id DESC LIMIT 1) AND period='FORA_VAZIO'`).run();
    db.close();
    const r = await fetch(`${BASE}/v1/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kwh: 40 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // 128 menos o myAtlanteMT em quarentena
    assert.ok(j.data.length >= 100 && j.data.length < 128, `ranking continua (${j.data.length})`);
    assert.ok(!j.data.find(x => x.id === 'atlante-mt-myatlanteac'), 'o corrompido sai do ranking');
  });
});

// Segunda instância: NODE_ENV=production SEM JWT_SECRET — a secret de dev não
// pode emitir bilhetes de sessão (503 no POST /v1/session).
describe('server POC: secret de dev não emite tokens em produção', () => {
  let proc;

  before(async () => {
    // JWT_SECRET deliberadamente ausente (o spread do pai não pode levar uma)
    const { JWT_SECRET, ...semSecret } = process.env;
    proc = spawnServer({ ...semSecret, NODE_ENV: 'production' }, PORT + 1);
    await waitUp(`http://127.0.0.1:${PORT + 1}/`);
  });
  after(() => { if (proc) proc.kill('SIGTERM'); });

  it('POST /v1/session → 503 no_secret', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT + 1}/v1/session`, { method: 'POST' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'no_secret');
  });
});
