// Servidor POC (Node.js em produção via pg; SQLite em dev/test).
// Serve a web em / e a API em /v1/* (tudo com auth). O hardening da main
// está re-aplicado sobre a migração assíncrona: nosniff, rate limiting,
// 405 por método, cap do corpo (413), validação de input, guarda da secret
// de dev, auth de X-API-Key por hash e quarentena por tarifário.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { query, get, run, dbInstance } from './db.js';
import { signJwt, verifyJwt, hashKey } from './auth/tokens.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { REGIONS, periodForWall } from './engine/regions.js';
import { compareWithFixed, tallyWinners } from './engine/compare.js';
import { getDaily, getFutures, getQuarters } from './omie/cache.js';
import { pickComponents } from './db/components.js';
import { VERSIONS } from './db/seed.postgres.js';

const PORT = Number(process.env.PORT || 3001);
const USE_PG = !!process.env.DATABASE_URL;
// Secret "de dev" conhecida manteria o POC a arrancar sem configuração —
// mas no deploy real é a porta para fabricar WEB_SESSION à vontade. O meio
// termo: o server arranca sempre (dev/CI não rebenta), mas se a secret em
// uso for a de dev e o processo pareça produção (`NODE_ENV=production`), o
// /v1/session recusa-se a emitir bilhete (503) — o site não fica seguro
// por omissão só porque o aviso do log ninguém o leu.
const DEV_FALLBACK = 'dev-only-change-me';
const SECRET = process.env.JWT_SECRET || DEV_FALLBACK;
const WEAK_SECRET = SECRET === DEV_FALLBACK;
if (WEAK_SECRET) console.warn('[ceme-v2] AVISO: JWT_SECRET não definida — a secret de dev "dev-only-change-me" está em uso. Qualquer pessoa pode fabricar sessões.',
  'Com NODE_ENV=production, POST /v1/session devolve 503 em vez de emitir tokens.',
  'Em publicação: export JWT_SECRET=<openssl rand -hex 32>.');
// Directórios resolvidos a partir do ficheiro, não do cwd: `npm start` corre
// da pasta backend/, mas arrancar `node ceme-v2/backend/src/server.js` da raiz
// do repo criava `./data` no sítio errado (cache OMIE vazia → 502).
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');

// Flags de bootstrap (opcionais, para previews/snapshots/readonly):
//   CEME_READONLY=1     -> não escreve nada na BD (schema/seed/tar/api_key).
//                         Usar com DB de produção readonly ou com snapshot já
//                         restaurado. O server só lê.
//   CEME_SKIP_SEED=1    -> salta o seed (upsert massivo), mas corre schema +
//                         tar + api_key. Útil com snapshot restaurado, para não
//                         sobrescrever edições manuais da produção.
const READONLY = process.env.CEME_READONLY === '1';
const SKIP_SEED = READONLY || process.env.CEME_SKIP_SEED === '1';
const SKIP_SCHEMA = READONLY;
const SKIP_TAR = READONLY;
const SKIP_API_KEY = READONLY;

if (READONLY) console.warn('[ceme-v2] modo READONLY: bootstrap de escrita desactivado.');

// Schema executado uma vez no arranque (idempotente). Em modo readonly as
// tabelas já existem (snapshot ou BD de produção) — saltar evita erros de
// permissão (CREATE TABLE exige privilégio CREATE no schema).
if (!SKIP_SCHEMA) {
  const schemaFile = USE_PG
    ? new URL('./db/schema.postgres.sql', import.meta.url)
    : new URL('./db/schema.sql', import.meta.url);
  const schemaSql = await readFile(schemaFile, 'utf8');
  await run(schemaSql);
}

// API key para terceiros: o valor claro é provido pela env (CEME_API_KEY) e
// NUNCA fica na BD — só o sha256. Sem chave configurada, X-API-Key devolve
// 401 (o caminho web usa Bearer JWT). UPSERT: refresca o hash se a env mudar
// entre restarts; em PG e SQLite a sintaxe upsert coincide.
if (process.env.CEME_API_KEY && !SKIP_API_KEY) {
  await run(`INSERT INTO api_client (id, name, kind) VALUES ('env-key', 'chave da env', 'THIRD_PARTY')
    ON CONFLICT (id) DO NOTHING`);
  await run(`INSERT INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', $1, $2)
    ON CONFLICT (id) DO UPDATE SET hash = $3, prefix = $4`,
    [hashKey(process.env.CEME_API_KEY), process.env.CEME_API_KEY.slice(0, 8),
     hashKey(process.env.CEME_API_KEY), process.env.CEME_API_KEY.slice(0, 8)]);
}

// TAR 2026 Continente (ERSE) — ilhas entram na fase de seed completo
if (!SKIP_TAR) {
  await run(`
INSERT INTO tar (valid_from, valid_to, region, voltage, period, price_eur_kwh) VALUES
 ('2026-01-01', NULL, 'CONT','BT','VAZIO',0.0266), ('2026-01-01', NULL,'CONT','BT','FORA_VAZIO',0.1192),
 ('2026-01-01', NULL, 'CONT','MT','VAZIO',0.0157), ('2026-01-01', NULL,'CONT','MT','FORA_VAZIO',0.0812)
ON CONFLICT (valid_from, region, voltage, period) DO NOTHING
`);
}

// Seed — depende do backend ativo. Saltado em modo readonly ou com snapshot.
if (!SKIP_SEED) {
  if (USE_PG) {
    const { seed } = await import('./db/seed.postgres.js');
    await seed();
  } else {
    const { seed } = await import('./db/seed.js');
    await seed(dbInstance);
  }
} else {
  console.warn('[ceme-v2] seed saltado (CEME_SKIP_SEED/CEME_READONLY).');
}

function vmeta(tid) {
  const v = VERSIONS[tid] || {};
  const loss = (v.loss != null) ? v.loss : null;
  return { loss, formula: v.formula || 'standard' };
}

const json = (res, code, obj, extraHeaders = {}) => {
  // nosniff: sem isto, um JSON reflectido podia ser interpretado como
  // text/html em browsers antigos — resposta barata para um ataque real.
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(obj));
};

// Rate limiting: janela fixa, em memória — suficiente para um POC de nó
// único (em produção, um limitador à frente do server). Sessão web conta
// por IP; terceiros contam pela chave de API. O mapa é podado
// preguiçosamente e tem teto: sem isso, uma enxurrada de IPs distintos
// cresce memória sem limite — DoS do próprio limitador.
const RATE_WINDOW_MS = 60_000;
const RATE_DEFAULT = 60;        // requisições/minuto de API web (Bearer)
const RATE_SESSION = 10;        // /v1/session por IP por minuto (pré-auth!)
const RATE_MAX_BUCKETS = 10_000;
const buckets = new Map();      // chave -> { count, resetAt }
function rateBucket(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    if (buckets.size >= RATE_MAX_BUCKETS) {
      // poda: largar o que já expirou; se ainda estiver cheio, largar o mais antigo
      for (const [k, v] of buckets) { if (now > v.resetAt) buckets.delete(k); }
      if (buckets.size >= RATE_MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
    }
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), reset: b.resetAt };
}
const rlHeaders = (rl, limit) => ({
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-remaining': String(rl.remaining),
  'x-ratelimit-reset': String(Math.ceil(rl.reset / 1000)),
  'retry-after': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))),
});
const rateLimited = (res, rl, limit) => json(res, 429, {
  error: { code: 'rate_limited', message: 'limite de requisições excedido; repetir depois de Retry-After' },
}, rlHeaders(rl, limit));

const clientIp = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';

async function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return verifyJwt(h.slice(7), SECRET);
  const k = req.headers['x-api-key'];
  if (k) {
    // Valida contra o hash em BD (revogada/expirada exclui). Antes aceitava
    // qualquer string — o endpoint estava, na prática, sem auth de terceiros.
    const row = await get(`
      SELECT c.id AS client, c.name AS name, c.kind AS kind, c.rate_limit AS rate_limit
        FROM api_key k JOIN api_client c ON c.id = k.client_id
       WHERE k.hash = $1 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`, [hashKey(String(k))]);
    if (!row) return { ok: false, error: 'invalid_key' };
    return { ok: true, payload: { kind: row.kind, client: row.name, key: String(k).slice(0, 8), rate_limit: row.rate_limit } };
  }
  return { ok: false, error: 'missing' };
}

async function allTariffs() {
  // POC: simulam-se TODOS os tarifários para a região escolhida (com o IVA
  // e os ciclos dessa região). A disponibilidade comercial (`regions`) é
  // mostrada como informação, não como filtro.
  return await query(`
    SELECT t.*, c.name AS ceme_name,
      (SELECT v.id FROM tariff_version v
       WHERE v.tariff_id = t.id
         AND v.valid_from <= CURRENT_DATE
         AND (v.valid_to IS NULL OR v.valid_to > CURRENT_DATE)
       ORDER BY v.valid_from DESC LIMIT 1) AS vid
    FROM tariff t
    JOIN ceme c ON c.id = t.ceme_id
    ORDER BY t.id
  `);
}

async function comps(vid) {
  const rows = await query('SELECT * FROM price_component WHERE tariff_version_id = $1', [vid]);
  let out;
  try { out = pickComponents(rows); }
  catch (e) { throw new Error(`${e.message} na versão ${vid}`); }
  return out;
}

// EGME: o `activation` da resposta é o que o CEME publica (sem substituição
// silenciosa — ver seed.js). O valor legal em vigor fica como contexto no
// lado do cliente: quando o publicado ainda é o de 2025 (acima do legal),
// `activation_stale` assinala — actualizar é tarefa de nova captura da folha,
// não de derivar valores no código a cada mudança de regulamento.
const EGME_LEGAL = 0.1088; // €/carregamento, Regul. ERSE 7/2026 (em vigor 2026-01-01)
const egmeFlags = (act) => ({ egme_legal: EGME_LEGAL, activation_stale: act > EGME_LEGAL });

async function quoteOne(t, { at, kwh, region, omie, omieVazio, omieFora }) {
  const ver = await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]);
  const { price, act, iec, sup } = await comps(t.vid);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: (await get('SELECT brand_color FROM ceme WHERE id = $1', [t.ceme_id]))?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: sup, iec, region });
    return { ...meta, activation: act, iec, prices: price, avail: t.regions, ...egmeFlags(act), ...q };
  }
  // INDEXED: PE por período com o OMIE de referência do pedido.
  // Nas ilhas usa-se a ref. continental com aviso (MIBEL não cobre as ilhas).
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  const tarFor = async (per) => {
    const row = await get(
      "SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage = $1 AND period = $2 AND valid_from <= CURRENT_DATE ORDER BY valid_from DESC LIMIT 1",
      [t.voltage, per]
    );
    return row?.price_eur_kwh ?? 0;
  };
  const vm = vmeta(t.id);
  const agg = ver.omie_aggregation || 'SPLIT_VAZIO_FORA';
  const omieForPeriod = (per) => {
    if (agg === 'SPLIT_VAZIO_FORA') return (per === 'VAZIO' ? (omieVazio ?? omie) : (omieFora ?? omie));
    return omie; // SPOT / UNICA / UNICO
  };
  const out = {};
  for (const per of ['VAZIO', 'FORA_VAZIO']) {
    const oref = omieForPeriod(per);
    const tarEurKwh = await tarFor(per);
    out[per] = indexedPrice({ omieEurKwh: oref, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: vm.loss, formula: vm.formula }).price;
  }
  const omieRef = (agg === 'SPLIT_VAZIO_FORA') ? (omieVazio ?? omie) : omie;
  // Guarda: indexado com ciclo SIMPLES só tem preço UNICO — o motor só sabe
  // preços por período (VAZIO/FORA_VAZIO). Não há tarifário assim no seed,
  // mas um futuro seed sem esta guarda fazia o quoteFixed rebentar com
  // "sem preço final para UNICO" em cada simulação. Aproximação honesta:
  // usa o preço fora-vazio da energia (sem TAR — o UNICO real teria a
  // TAR simples do período, ignorada aqui) — melhor do que 500.
  if (t.schedule === 'SIMPLES' && out.UNICO == null) {
    out.UNICO = out.FORA_VAZIO ?? out.VAZIO ?? 0;
  }
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support: sup, iec, region });
  return { ...meta, activation: act, iec, prices: out, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: vm.loss ?? LOSS_PLACEHOLDER[t.voltage], formula: vm.formula, warning: here, avail: t.regions, ...egmeFlags(act), ...q };
}

// Negociação de idioma a partir do cabeçalho Accept-Language. Só há PT e EN:
// se o browser pedir explicitamente inglês, servimos inglês; qualquer outra
// coisa (es, fr, de, it, ou header ausente) fica em português, porque o
// público-alvo é português. O cliente pode sobrepor via localStorage.
function negotiateLang(header) {
  if (!header) return 'pt';
  const tags = String(header).split(',')
    .map(s => { const [tag, ...params] = s.trim().split(';'); const q = params.find(p => /^\s*q=/.test(p)); return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.split('=')[1]) || 0 : 1 }; })
    .filter(t => t.tag && t.q > 0).sort((a, b) => b.q - a.q);
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

// Duas interfaces para a mesma API: o assistente passo-a-passo (três
// perguntas, por omissão) e o simulador completo. O assistente é a porta de
// entrada; o utilizador troca no link de cada página, e a escolha fica num
// cookie que este servidor lê para responder à página certa em `GET /`.
const UI = {
  assistente: { file: 'assistente.html' },
  completo: { file: 'index.html' },
};
// `null` = respeitar o cookie (a rota `/`); um valor = gravar essa escolha.
const UI_ROUTES = { '/': null, '/index.html': null, '/assistente': 'assistente', '/simulador': 'completo' };
const UI_COOKIE = 'ceme_ui';
const UI_COOKIE_MAX_AGE = 31536000; // 1 ano

// Páginas institucionais do site (Sobre, Contactos). São as mesmas para toda
// a gente — a escolha do cookie é só da interface (assistente vs simulador),
// por isso aqui não há cookie para ler nem para gravar. O English existe
// porque metade dos nossos utilizadores escreve em inglês: `/sobre` e
// `/about` são a mesma página.
const INFO_ROUTES = {
  '/sobre': 'about.html', '/about': 'about.html',
  '/contactos': 'contact.html', '/contact': 'contact.html',
};

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}
// Valor ausente ou desconhecido cai no assistente: é a interface que um
// visitante novo vê, e um cookie editado à mão não pode dar 500.
const uiFromCookie = req => (readCookie(req, UI_COOKIE) === 'completo' ? 'completo' : 'assistente');
// Cookie de preferência de UI, não de sessão: nada aqui autentica, e o JS
// não precisa de o ler. `Secure` só quando o pedido chegou por https (em dev
// é http, e um cookie Secure seria descartado).
function uiCookie(req, ui) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${UI_COOKIE}=${ui}; Path=/; Max-Age=${UI_COOKIE_MAX_AGE}; SameSite=Lax${https ? '; Secure' : ''}`;
}

// Um método por endpoint (POC): leitura para os /v1/* de dados, POST para os
// dois que aceitam corpo. 405 antes de gastar auth.
const METHODS = {
  '/v1/health': 'GET', '/v1/cemes': 'GET', '/v1/tariffs': 'GET', '/v1/tar': 'GET',
  '/v1/omie/daily': 'GET', '/v1/omie/futures': 'GET', '/v1/indexed/quarters': 'GET',
  '/v1/session': 'POST', '/v1/simulate': 'POST',
};
const MAX_BODY = 64 * 1024; // 64 KB — corpos raquíticos; pedir mais é abuso

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Web POC sem auth (ficheiros estáticos); a API continua toda com auth.
  // HEAD é aceito (só read-only, corpo vazio) — sem isto, HEAD / dava 401.
  const readStatic = method => method === 'GET' || method === 'HEAD';
  if (readStatic(req.method) && url.pathname === '/strings.js') {
    // Dicionário partilhado pelas duas interfaces: um só ficheiro para os dois
    // sites, por isso não pode ficar preso em cache depois de um deploy.
    try {
      const js = await readFile(new URL('../../frontend/strings.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(js);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/strings.js em falta' } }); }
  }
  if (readStatic(req.method) && url.pathname === '/pages.css') {
    // Estilo das páginas Sobre/Contactos (frontend/pages.css). Vive fora
    // porque as duas páginas são irmãs e não vale a pena duplicar o CSS.
    try {
      const css = await readFile(new URL('../../frontend/pages.css', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(css);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/pages.css em falta' } }); }
  }
  if (readStatic(req.method) && Object.hasOwn(INFO_ROUTES, url.pathname)) {
    // Sobre e Contactos: HTML estático com a mesma negociação de língua das
    // interfaces (o cabeçalho Accept-Language decide, a bandeira decide
    // depois). Sem cookie — estas páginas não são uma "interface" a escolher.
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${INFO_ROUTES[url.pathname]}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace('window.__LANG__=null', `window.__LANG__=${JSON.stringify(lang)}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${INFO_ROUTES[url.pathname]} em falta` } }); }
  }
  if (readStatic(req.method) && Object.hasOwn(UI_ROUTES, url.pathname)) {
    // A escolha da interface vive num cookie que o servidor lê: `GET /` já
    // responde com a página certa (sem redirect nem flash). Só os caminhos
    // explícitos gravam a escolha; `/` nunca escreve, para a primeira visita
    // ficar sempre no assistente.
    const forced = UI_ROUTES[url.pathname]; // null = respeitar o cookie
    const ui = forced || uiFromCookie(req);
    const lang = negotiateLang(req.headers['accept-language']);
    try {
      const html = (await readFile(new URL(`../../frontend/${UI[ui].file}`, import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
        .replace('window.__LANG__=null', `window.__LANG__=${JSON.stringify(lang)}`);
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language, Cookie' };
      if (forced) headers['set-cookie'] = uiCookie(req, forced);
      res.writeHead(200, headers);
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: `frontend/${UI[ui].file} em falta` } }); }
  }
  // Um método por pathname: os handlers de leitura respondiam 200 a
  // PUT/DELETE (não faziam nada, mas fingiam que sim). 405 com `allow`.
  const allowed = METHODS[url.pathname];
  if (allowed && req.method !== allowed && !(allowed === 'GET' && req.method === 'HEAD')) {
    res.writeHead(405, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', allow: allowed });
    return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: `${req.method} em ${url.pathname}; usar ${allowed}` } }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/session') {
    // /v1/session corre ANTES da auth: sem aqui um teto, um martelo pode
    // assinar JWTs sem fim (custo de CPU) e fabricar sessões à vazia.
    const sessRl = rateBucket(`sess:${clientIp(req)}`, RATE_SESSION);
    if (!sessRl.allowed) return rateLimited(res, sessRl, RATE_SESSION);
    // Com a secret de dev em produção, proteger o bilhete: 503 em vez de
    // emitir tokens fabricáveis. Em dev/CI a secret segue a ser aceitável.
    if (WEAK_SECRET && process.env.NODE_ENV === 'production') {
      return json(res, 503, { error: { code: 'no_secret', message: 'JWT_SECRET em falta: export JWT_SECRET=<openssl rand -hex 32>' } });
    }
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = await auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  // Rate limit depois da auth (401 não dá orçamento). Por IP para a sessão
  // web anonima; pela chave para terceiros. /v1/session tem o dele (acima).
  const rlLimit = a.payload.kind === 'THIRD_PARTY' && a.payload.rate_limit != null ? Number(a.payload.rate_limit) : RATE_DEFAULT;
  const rlKey = `${a.payload.kind === 'THIRD_PARTY' ? 'key' : 'ip'}:${a.payload.kind === 'THIRD_PARTY' ? a.payload.key : clientIp(req)}`;
  const rl = rateBucket(rlKey, rlLimit);
  const headers = rlHeaders(rl, rlLimit);
  if (!rl.allowed) return rateLimited(res, rl, rlLimit);

  if (url.pathname === '/v1/health') return json(res, 200, { ok: true, as: a.payload.kind, time: new Date().toISOString() }, headers);
  if (url.pathname === '/v1/cemes') return json(res, 200, { data: await query('SELECT * FROM ceme ORDER BY name') }, headers);
  if (url.pathname === '/v1/tariffs') {
    const rows = await allTariffs();
    const enriched = await Promise.all(rows.map(async t => ({ ...t, version: await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]) })));
    return json(res, 200, { data: enriched }, headers);
  }
  if (url.pathname === '/v1/tar') {
    return json(res, 200, { data: await query("SELECT * FROM tar WHERE valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to > CURRENT_DATE)") }, headers);
  }
  if (url.pathname === '/v1/omie/daily' && req.method === 'GET') {
    const days = Math.min(120, Math.max(7, Number(url.searchParams.get('days') || 60)));
    getDaily(DATA_DIR, days).then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `séries indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/omie/futures' && req.method === 'GET') {
    getFutures(DATA_DIR).then(
      d => json(res, 200, d, headers),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `futuros indisponíveis: ${e.message}` } }, headers));
    return;
  }
  if (url.pathname === '/v1/indexed/quarters' && req.method === 'GET') {
    const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
    if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, headers);
    const t = (await query('SELECT * FROM tariff WHERE id = $1', [tid || ''])).find(x => x.kind === 'INDEXED')
      || (await query("SELECT * FROM tariff WHERE kind = 'INDEXED' ORDER BY id LIMIT 1"))[0];
    if (!t) return json(res, 404, { error: { code: 'no_indexed', message: 'sem tarifário indexado' } }, headers);
    const ver = await get('SELECT * FROM tariff_version WHERE tariff_id = $1 ORDER BY valid_from DESC LIMIT 1', [t.id]);

    // Fixo de referencia: o que o cliente escolheu no comparador. Sem ele nao
    // ha com quem comparar — o endpoint so sabe quanto o INDEXADO custa.
    const fixId = url.searchParams.get('fixed');
    let fixPrice = null, fixInfo = null;
    if (fixId) {
      const ft = await get('SELECT * FROM tariff WHERE id = $1', [fixId]);
      if (ft) {
        const fv = await get(
          `SELECT id FROM tariff_version v WHERE v.tariff_id = $1
           AND v.valid_from <= CURRENT_DATE AND (v.valid_to IS NULL OR v.valid_to > CURRENT_DATE)
           ORDER BY valid_from DESC LIMIT 1`,
          [ft.id]
        );
        // Fixo sem versão em vigor, ou sem preços de energia (ex. só EGME),
        // não dá comparação: fica null — a UI trata como "sem fixo" e esconde
        // colunas, em vez de mostrar uma referência vazia com nome.
        const fp = fv ? (await comps(fv.id)).price : null;
        if (fp && Object.keys(fp).length) {
          fixPrice = fp;
          const fc = await get('SELECT name FROM ceme WHERE id = $1', [ft.ceme_id]);
          fixInfo = { id: ft.id, name: ft.name, ceme: fc?.name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule };
        }
      }
    }

    const finish = (q) => {
      try {
        const withP = q.rows.map(r => {
          const [sh, sm] = r.start.split(':').map(Number);
          const per = periodForWall({ region, schedule: t.schedule, cycle: t.cycle, ymd: q.date, minutes: sh * 60 + sm });
          return { start: r.start, end: r.end, period: per, omieMwh: r.priceMwh };
        });
        Promise.all(withP.map(async (item) => {
          // TAR vigente (valid_from <= hoje): a coluna pode levar versões futuras
          const tarRow = await get(
            "SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage = $1 AND period = $2 AND (valid_from IS NULL OR valid_from <= CURRENT_DATE) ORDER BY valid_from DESC LIMIT 1",
            [t.voltage, item.period]
          );
          const tarEurKwh = tarRow?.price_eur_kwh ?? 0;
          const vm = vmeta(t.id);
          const { price } = indexedPrice({ omieEurKwh: item.omieMwh / 1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: vm.loss, formula: vm.formula });
          item.price = Math.round(price * 10000) / 10000;
        })).then(() => {
          // quem ganha, quarto a quarto — logica em engine/compare.js
          const comp = compareWithFixed(withP, fixPrice);
          const ranked = [...comp].sort((x, y) => x.price - y.price);
          const cheap = new Set(ranked.slice(0, 8).map(x => x.start));
          const vm2 = vmeta(t.id);
          json(res, 200, {
            date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh,
            loss: vm2.loss ?? LOSS_PLACEHOLDER[t.voltage], cached: q.cached, source: q.source, cutoff: q.cutoff,
            estimated: q.estimated, days: q.days, fixed: fixInfo,
            warning: REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF',
            wins: tallyWinners(comp),
            quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.start) }))
          }, headers);
        }).catch(e => json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers));
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers); }
    };
    getQuarters(DATA_DIR, url.searchParams.get('date')).then(finish, e => json(res, 502, { error: { code: 'omie_unavailable', message: e.message } }, headers));
    return;
  }
  if (url.pathname === '/v1/simulate' && req.method === 'POST') {
    let body = '', tooBig = false;
    req.on('data', c => {
      // Cap de 64 KB: sem isto um POST de 48 MB crescia a String e rebentava
      // no JSON.parse — memória à solta em cada conexão. O cap guarda a
      // decisão para o `end` (linha em branco, sem parse) e responde 413.
      if (tooBig) return;                       // já decidido: não voltar a encher o buffer
      if (body.length + c.length > MAX_BODY) { tooBig = true; body = ''; return; }
      body += c;
    });
    req.on('end', async () => {
      if (tooBig) return json(res, 413, { error: { code: 'payload_too_large', message: `corpo > ${MAX_BODY} bytes` } }, headers);
      try {
        // Corpo de terceiros/anónimos é input hostil: JSON malformado, kwh
        // string, `at` carne para new Date, omie o que vier. Sem validação,
        // o erro apanhado aqui vai com message crua para o cliente e valores
        // tolos (omie negativo, kwh 1e300) produziam preços absurdos.
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: { code: 'bad_request', message: 'corpo JSON inválido' } }, headers); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { error: { code: 'bad_request', message: 'corpo deve ser um objecto JSON' } }, headers);
        }
        const { kwh = 40, at, region = 'CONT', omie = 0.20, omieVazio, omieFora } = parsed;
        if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, headers);
        if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) {
          return json(res, 400, { error: { code: 'bad_kwh', message: 'kwh deve ser um número maior que 0 e até 1000' } }, headers);
        }
        let now;
        if (at != null) {
          now = new Date(at);
          if (Number.isNaN(now.getTime())) return json(res, 400, { error: { code: 'bad_at', message: 'at deve ser uma data ISO válida' } }, headers);
        } else now = new Date();
        for (const [nome, v] of [['omie', omie], ['omieVazio', omieVazio], ['omieFora', omieFora]]) {
          if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
            return json(res, 400, { error: { code: 'bad_omie', message: `${nome} deve ser um número (€/kWh) positivo` } }, headers);
          }
        }
        const tariffs = await allTariffs();
        // Isolamento por tarifário: um seed com um único período divergente
        // não pode derrubar os 128 — quarentena em vez de 400 (princípio do
        // docs/03). O tarifário a mais sai fora do ranking; a lista mantém
        // os restantes.
        //
        // Em paralelo com concorrência limitada: cada quoteOne faz várias
        // queries, e em pg cada uma é um round-trip pela rede. Em série, 128
        // tarifários x ~4 queries ficavam ~500 round-trips encadeados e o
        // pool (max 10) nunca era aproveitado. O limite fica abaixo do pool
        // para não ocupar todas as ligações e deixar pedidos concorrentes à
        // espera; 8 mantém folga e ainda paraleliza.
        const CONCURRENCY = 8;
        const results = new Array(tariffs.length);
        let next = 0;
        const worker = async () => {
          while (true) {
            const i = next++;
            if (i >= tariffs.length) return;
            const t = tariffs[i];
            try {
              results[i] = await quoteOne(t, { at: now, kwh, region, omie, omieVazio, omieFora });
            } catch (e) {
              // com identidade, para quem lê os logs/BD saber o que foi posto de lado
              console.warn(`[ceme-v2] tarifário em quarentena: ${t.id}: ${e.message}`);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, tariffs.length) }, worker)
        );
        // Ordem de resultados independente da ordem de conclusão; a lista de
        // saída tem de continuar determinística.
        const data = results.filter(Boolean);
        data.sort((x, y) => x.totalEur - y.totalEur);
        const avg = data.length ? data.reduce((s, q) => s + q.totalEur, 0) / data.length : 0;
        json(res, 200, { at: now.toISOString(), kwh, region, omieRef: omie, avg: Math.round(avg * 100) / 100, data }, headers);
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, headers); }
    });
    return;
  }
  json(res, 404, { error: { code: 'not_found', message: url.pathname } }, headers);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[ceme-v2] porta ${PORT} ocupada — outro servidor já corre aí.`);
    console.error(`  kill $(lsof -ti tcp:${PORT})  ou  PORT=<outra> node src/server.js`);
    process.exit(1);
  }
  console.error('[ceme-v2] erro no servidor:', e);
});
server.listen(PORT, () => console.log(`ceme-v2 POC http://localhost:${PORT}/ db=${USE_PG ? 'postgresql' : 'sqlite'}`));
