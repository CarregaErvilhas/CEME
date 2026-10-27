// Testes de rede do servidor: arranca uma instância a sério, como
// subprocesso, e fala com ela por HTTP. Cobrem o hardening da API: rate limit (com teto no mapa de buckets), validação do /v1/simulate,
// 413, 405, nosniff, quarentena de tarifário mau e a secret de dev sem
// emitir tokens em produção. A BD fica num directório temporário.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { signJwt } from '../src/auth/tokens.js';

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

describe('servidor: hardening HTTP', () => {
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

  it('indexados: cada um usa o OMIE do SEU ciclo (omieCycles) e a TAR da região', async () => {
    const sim = async (body) => (await (await fetch(`${BASE}/v1/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kwh: 40, at: '2026-10-21T12:00:00Z', ...body }),
    })).json()).data;
    const cycles = { DIARIO: { vazio: 0.05, fora: 0.10 }, SEMANAL: { vazio: 0.07, fora: 0.12 } };
    const d = await sim({ omie: 0.2, omieCycles: cycles });
    const sem = d.find(q => q.id === 'luzigas-ceme-bt');
    const dia = d.find(q => q.id === 'meo-dinamica-bt');
    assert.equal(sem.cycle, 'SEMANAL');
    assert.equal(dia.cycle, 'DIARIO');
    assert.equal(sem.omieRef, 0.07, 'o semanal usa o vazio semanal');
    assert.equal(dia.omieRef, 0.05, 'o diário usa o vazio diário');
    // A TAR das ilhas existe (é a mesma tabela da ERSE): nas ilhas o
    // indexado cota, com a TAR da região, e o aviso é só o do OMIE.
    const az = (await sim({ region: 'AZO', omieCycles: cycles })).find(q => q.id === 'meo-dinamica-bt');
    assert.ok(az, 'indexado cotado nos Açores (não foi para a quarentena)');
    assert.equal(az.warning, 'OMIE_CONT_REF');
    assert.equal(az.split.VAZIO.tar, 0.0266);
    // Um dia anterior à primeira captura não esvazia o ranking: usa a versão
    // de hoje (e a TAR mais antiga que há).
    const antes = await sim({ at: '2025-12-01T12:00:00Z' });
    assert.equal(antes.length, d.length, 'data antiga = os mesmos tarifários');
    // Lixo em omieCycles é 400, não um preço inventado.
    const bad = await fetch(`${BASE}/v1/simulate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ omieCycles: { MENSAL: { vazio: 1, fora: 1 } } }),
    });
    assert.equal(bad.status, 400);
  });

  it('alvo `//`: 400 e o processo continua vivo (antes o new URL matava-o)', async () => {
  const status = await new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: PORT, path: '//', method: 'GET' }, r => { r.resume(); resolve(r.statusCode); })
      .on('error', reject).end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);
});

it('HTML também leva nosniff', async () => {
    assert.equal((await fetch(`${BASE}/`)).headers.get('x-content-type-options'), 'nosniff');
  });

  // Rotas do Zerops: sem auth (o balancer tem de as alcançar de dentro do
  // container) e sem rate limit (o check corre a cada 10 s).
  it('/healthz: liveness sem auth, 200 com ok=true', async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.up, 'number');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('/readyz: readiness sem auth, 200 só se a BD responder', async () => {
    const r = await fetch(`${BASE}/readyz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.db, 'up');
  });

  it('/readyz: de fora não se toca na BD (200 com db=unknown)', async () => {
    // Endereço não-loopback da própria máquina, se houver (CI e dev têm).
    const net = networkInterfaces();
    const ip = Object.values(net).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!ip) return; // sem rede a verificar — nada a fazer
    let r;
    try {
      r = await fetch(`http://${ip}:${PORT}/readyz`, { signal: AbortSignal.timeout(5000) });
    } catch {
      return; // rede não-loopback inacessível a partir daqui (sandbox)
    }
    // Nunca 403: um check que reprova o deploy por estar mal endereçado é
    // pior que não ter check.
    assert.equal(r.status, 200);
    assert.equal((await r.json()).db, 'unknown');
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

    it('/api serve o guia de integração da API sem autenticação', async () => {
      const { status, html, cookie, r } = await abrir('/api');
      assert.equal(status, 200);
      assert.ok(html.includes('<title>API Guide — CEME</title>'));
      assert.ok(html.includes('/v1/simulate'));
      assert.ok(html.includes('AI agents'));
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      assert.equal(cookie, '');
    });

    it('a língua negociada é injectada também nestas páginas', async () => {
      // Todas as páginas que têm PT e EN — o /tabela escapava (marcador com
      // espaços) e ninguém deu por isso porque não estava nesta lista.
      for (const caminho of ['/sobre', '/contactos', '/tabela', '/omie', '/assistente', '/simulador']) {
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

  // A página das estatísticas OMIE. Vive em /omie no site principal e é o
  // que aparece na raiz do domínio próprio (omie.cocofree.dev) — o servidor
  // decide pelo Host, não pelo path.
  describe('página OMIE', () => {
    const abrir = async (caminho, headers = {}) => {
      const r = await fetch(`${BASE}${caminho}`, { headers });
      return { status: r.status, html: await r.text(), r };
    };
    // O `fetch` não deixa mandar o cabeçalho Host (é forbidden na spec), e o
    // roteamento por domínio é precisamente sobre o Host — aqui vai-se pelo
    // node:http, que manda o que se lhe disser.
    const abrirComHost = (caminho, host) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: caminho, method: 'GET', headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, html: body }));
      });
      req.on('error', reject);
      req.end();
    });

    it('/omie serve a página das estatísticas', async () => {
      const { status, html } = await abrir('/omie');
      assert.equal(status, 200);
      assert.ok(html.includes('<title>Estatísticas OMIE</title>'), 'título em falta');
      assert.ok(html.includes("CEME_STR('omie')"), 'não pede o namespace certo');
    });

    it('no domínio próprio, a raiz é a página OMIE', async () => {
      const { status, html } = await abrirComHost('/', 'omie.cocofree.dev');
      assert.equal(status, 200);
      assert.ok(html.includes("CEME_STR('omie')"), 'a raiz do domínio próprio não é a página OMIE');
    });

    it('no domínio próprio, o resto do site continua a funcionar', async () => {
      const { status, html } = await abrirComHost('/simulador', 'omie.cocofree.dev');
      assert.equal(status, 200);
      assert.ok(html.includes("CEME_STR('simulador')"), '/simulador devia servir o simulador');
    });

    it('a raiz do site principal continua a ser o assistente', async () => {
      const { status, html } = await abrirComHost('/', 'ceme-beta.ocarroeletrico.com');
      assert.equal(status, 200);
      assert.ok(!html.includes("CEME_STR('omie')"), 'o site principal não deve servir a página OMIE');
    });

    it('/v1/omie/stats exige auth', async () => {
      assert.equal((await fetch(`${BASE}/v1/omie/stats`)).status, 401);
    });
  });

  // Tabela: subpágina sem links no site — só quem sabe a rota a abre.
  describe('página tabela (subpágina sem links)', () => {
    const abrir = async (caminho, headers = {}) => {
      const r = await fetch(`${BASE}${caminho}`, { headers });
      return { status: r.status, html: await r.text() };
    };

    it('/tabela serve a página da tabela', async () => {
      const { status, html } = await abrir('/tabela');
      assert.equal(status, 200);
      assert.ok(html.includes('<title>Tabela — Comparador CEME</title>'), 'título em falta');
      assert.ok(html.includes("CEME_STR('tabela')"), 'não pede o namespace certo');
    });

    it('o HTML da página não aponta para /tabela (subpágina sem links)', async () => {
      const html = (await fetch(`${BASE}/tabela`).then(r => r.text()));
      assert.ok(!/href=["'][^"']*\/tabela/.test(html), 'não devia haver nenhum link para /tabela');
    });

    it('/robots.txt é público e não anuncia a /tabela', async () => {
      const { status, html } = await abrir('/robots.txt');
      assert.equal(status, 200);
      assert.match(html, /User-agent: \*/);
      assert.doesNotMatch(html, /tabela/);
    });

    it('/robots.txt aponta para o sitemap e /sitemap.xml lista as páginas', async () => {
      assert.match((await abrir('/robots.txt')).html, /^Sitemap: https?:\/\/[^/]+\/sitemap\.xml$/m);
      const r = await fetch(`${BASE}/sitemap.xml`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /xml/);
      const xml = await r.text();
      assert.match(xml, /<loc>https?:\/\/[^<]+\/sobre<\/loc>/);
      assert.doesNotMatch(xml, /tabela/);
    });

    it('/tabela leva X-Robots-Tag noindex', async () => {
      const r = await fetch(`${BASE}/tabela`);
      assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
    });

    it('/v1/tabela exige auth', async () => {
      assert.equal((await fetch(`${BASE}/v1/tabela`)).status, 401);
    });

    it('/v1/tabela com sessão devolve todos os tarifários em vigor', async () => {
      const r = await fetch(`${BASE}/v1/tabela`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.ok(j.data.length >= 120, `devolve tarifários (${j.data?.length})`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(j.at || ''), `data de validade (${j.at})`);
      const bi = j.data.find(x => x.kind === 'FIXED' && x.schedule === 'BI_HORARIA');
      assert.ok(bi.prices.FORA_VAZIO > 0 && bi.prices.VAZIO > 0, 'preços por período em falta');
      assert.ok(!j.data.some(x => x.ceme === 'EZU' && x.name === 'AB Energia'), 'campanha expirada não devia aparecer');
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
describe('servidor: secret de dev não emite tokens em produção', () => {
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

  it('Bearer assinado com a secret de dev pública → 401 (não só o mint está fechado)', async () => {
    const forged = signJwt({ kind: 'WEB_SESSION', sid: 'x' }, 'dev-only-change-me');
    const r = await fetch(`http://127.0.0.1:${PORT + 1}/v1/health`, { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(r.status, 401);
  });
});

// A chave de API da env: tirar a env revoga-a (a BD persiste entre arranques,
// por isso a revogação tem de ser explícita).
describe('servidor: CEME_API_KEY — tirar a env revoga a chave', () => {
  const P = PORT + 2, URL_ = `http://127.0.0.1:${P}`;
  const KEY = 'test-key-0123456789abcdef';
  const stop = (p) => new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); });
  const health = () => fetch(`${URL_}/v1/health`, { headers: { 'X-API-Key': KEY } }).then(r => r.status);

  it('com a env: 200; sem a env (mesma BD): 401; com a env outra vez: 200', async () => {
    const { CEME_API_KEY, ...base } = process.env;
    void CEME_API_KEY;
    let p = spawnServer({ ...base, CEME_API_KEY: KEY }, P);
    await waitUp(`${URL_}/`);
    assert.equal(await health(), 200, 'a chave da env autentica');
    await stop(p);

    p = spawnServer(base, P);
    await waitUp(`${URL_}/`);
    assert.equal(await health(), 401, 'sem a env, a chave antiga já não entra');
    await stop(p);

    p = spawnServer({ ...base, CEME_API_KEY: KEY }, P);
    await waitUp(`${URL_}/`);
    assert.equal(await health(), 200, 'voltar a pôr a env reactiva-a');
    await stop(p);
  });
});

// No comparador, indexado DIÁRIO (ynerluz) vs fixo SEMANAL (miio)
// não partilham fronteiras. Sábado 24/10/2026 (ainda hora de Verão): o
// indexado passa a fora-de-vazio às 08:00, o fixo semanal só às 09:00.
// O teste de compare.test.js só cobre o motor; este apanha a rota (período
// de cada tarifário calculado no seu ciclo, e exposto nos dois campos).
describe('servidor: /v1/indexed/quarters com fixo de outro ciclo', () => {
  const PORT2 = PORT + 7;
  const B2 = `http://127.0.0.1:${PORT2}`;
  let proc2, token2;

  before(async () => {
    proc2 = spawnServer({ ...process.env, JWT_SECRET: 'test-secret-server-tests' }, PORT2);
    await waitUp(`${B2}/`);
    const db = new DatabaseSync(path.join(dir, `ceme-${PORT2}.db`));
    const t0 = Date.parse('2026-10-23T23:00:00Z'); // 00:00 de 24/10 em Lisboa (WEST)
    for (let i = 0; i < 96; i++) {
      db.prepare("INSERT OR REPLACE INTO omie_spot (ts_utc,day_lisbon,min_lisbon,price_pt_eur_mwh,source) VALUES (?,?,?,?,'omie')")
        .run(new Date(t0 + i * 900000).toISOString(), '2026-10-24', i * 15, 100 + i);
    }
    db.close();
    token2 = (await (await fetch(`${B2}/v1/session`, { method: 'POST' })).json()).token;
  });
  after(() => { if (proc2) proc2.kill('SIGTERM'); });

  it('cada tarifário no seu período: fixo semanal só passa a fora às 09:00 locais', async () => {
    const r = await fetch(`${B2}/v1/indexed/quarters?tariff=ynerluz-bt&region=CONT&tz=Europe/Lisbon&fixed=miio-bt-miiobihor&date=2026-10-24`,
      { headers: { Authorization: `Bearer ${token2}` } });
    assert.equal(r.status, 200);
    const j = await r.json();
    const at = (hhmm) => j.quarters.find(x => x.start === hhmm);
    assert.equal(at('08:00').period, 'FORA_VAZIO', 'ynerluz (diário) já em fora às 08:00');
    assert.equal(at('08:00').fixPeriod, 'VAZIO', 'miio (semanal, sábado) ainda em vazio às 08:00');
    assert.equal(at('08:00').fixed, 0.2666);
    assert.equal(at('09:00').fixPeriod, 'FORA_VAZIO');
    assert.equal(at('09:00').fixed, 0.3592);
    assert.equal(at('14:00').fixPeriod, 'VAZIO', 'o semanal volta a vazio às 14:00 (sábado, Verão)');
    assert.equal(at('14:00').period, 'FORA_VAZIO', 'o diário só volta às 22:00');
  });

  it('caso inverso: indexado semanal (luzigas) vs fixo diário (miio): fronteiras às 14:00 e 20:00 vs 22:00', async () => {
    const r = await fetch(`${B2}/v1/indexed/quarters?tariff=luzigas-casa-bt&region=CONT&tz=Europe/Lisbon&fixed=miio-bt-miioonebi-2&date=2026-10-24`,
      { headers: { Authorization: `Bearer ${token2}` } });
    const j = await r.json();
    const at = (hhmm) => j.quarters.find(x => x.start === hhmm);
    assert.equal(at('15:00').period, 'VAZIO', 'luzigas (semanal, sábado de Verão) em vazio 14:00-20:00');
    assert.equal(at('15:00').fixPeriod, 'FORA_VAZIO', 'miio diário em fora até às 22:00');
    assert.equal(at('20:00').period, 'FORA_VAZIO');
    assert.equal(at('20:00').fixPeriod, 'FORA_VAZIO');
    assert.equal(at('22:00').period, 'VAZIO');
    assert.equal(at('22:00').fixPeriod, 'VAZIO');
    assert.ok(at('15:00').price < at('20:00').price, 'o indexado sobe às 20:00 (TAR de fora)');
  });
});
