// Servidor POC (só node:* — sem deps). Serve a web em / e a API em /v1/* (tudo com auth).
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { signJwt, verifyJwt, hashKey } from './auth/tokens.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { REGIONS } from './engine/regions.js';
import { seed, VERSIONS } from './db/seed.js';
import { getDaily, getFutures, getQuarters } from './omie/cache.js';
import { periodForWall } from './engine/regions.js';
import { compareWithFixed, tallyWinners } from './engine/compare.js';

const PORT = Number(process.env.PORT || 3001);
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (!process.env.JWT_SECRET) console.warn('[ceme-v2] AVISO: JWT_SECRET não definida — a secret de dev "dev-only-change-me" está em uso. Qualquer pessoa pode fabricar sessões.',
  'Em publicação: export JWT_SECRET=<valor aleatório>.');
// Directórios resolvidos a partir do ficheiro, não do cwd: `npm start` corre
// da pasta backend/, mas arrancar `node ceme-v2/backend/src/server.js` da raiz
// do repo criava `./data` no sítio errado (e a BD ficava vazia).
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ceme.db');

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));

// API key para terceiros: o valor claro é provido pela env (CEME_API_KEY) e
// NUNCA fica na BD — só o sha256. Sem chave configurada, X-API-Key devolve
// 401 (o caminho web usa Bearer JWT; a key é para consumidores externos).
if (process.env.CEME_API_KEY) {
  db.prepare(`INSERT OR REPLACE INTO api_client (id, name, kind) VALUES ('env-key', 'chave da env', 'THIRD_PARTY')`).run();
  db.prepare(`INSERT OR REPLACE INTO api_key (id, client_id, hash, prefix) VALUES ('env-key', 'env-key', ?, ?)`)
    .run(hashKey(process.env.CEME_API_KEY), process.env.CEME_API_KEY.slice(0, 8));
}

// TAR 2026 Continente (ERSE) — ilhas entram na fase de seed completo
db.exec(`
INSERT OR IGNORE INTO tar (valid_from, valid_to, region, voltage, period, price_eur_kwh) VALUES
 ('2026-01-01', NULL, 'CONT','BT','VAZIO',0.0266), ('2026-01-01', NULL,'CONT','BT','FORA_VAZIO',0.1192),
 ('2026-01-01', NULL, 'CONT','MT','VAZIO',0.0157), ('2026-01-01', NULL,'CONT','MT','FORA_VAZIO',0.0812);
`);
seed(db);

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

function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return verifyJwt(h.slice(7), SECRET);
  const k = req.headers['x-api-key'];
  if (k) {
    // Valida contra o hash em BD (revogada/expirada exclui). Antes aceitava
    // qualquer string — o endpoint estava, na prática, sem auth de terceiros.
    const row = db.prepare(`
      SELECT c.id AS client, c.name AS name, c.kind AS kind, c.rate_limit AS rate_limit
        FROM api_key k JOIN api_client c ON c.id = k.client_id
       WHERE k.hash = ? AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))`).get(hashKey(String(k)));
    if (!row) return { ok: false, error: 'invalid_key' };
    return { ok: true, payload: { kind: row.kind, client: row.name, key: String(k).slice(0, 8), rate_limit: row.rate_limit } };
  }
  return { ok: false, error: 'missing' };
}

function allTariffs() {
  // POC: simulam-se TODOS os tarifários para a região escolhida (com o IVA
  // e os ciclos dessa região). A disponibilidade comercial (`regions`) é
  // mostrada como informação, não como filtro.
  return db.prepare(`SELECT t.*, c.name AS ceme_name,
      (SELECT id FROM tariff_version v WHERE v.tariff_id=t.id AND v.valid_from <= date('now')
        AND (v.valid_to IS NULL OR v.valid_to > date('now')) ORDER BY v.valid_from DESC LIMIT 1) AS vid
    FROM tariff t JOIN ceme c ON c.id=t.ceme_id ORDER BY t.id`).all();
}

function comps(vid) {
  // Os componentes têm de ser coerentes entre períodos: EGME/IEC são valores
  // por sessão/kWh que o seed reparte por linha. Se divergirem, é erro de
  // dados — falhar aqui em vez de silenciosamente usar o último valor.
  const rows = db.prepare('SELECT * FROM price_component WHERE tariff_version_id=?').all(vid);
  const price = {};
  let act = null, iec = null, sup = null;
  for (const r of rows) {
    if (r.energy_eur_kwh != null) price[r.period] = r.energy_eur_kwh;
    const same = (a, b) => a == null || b == null || a === b;
    if (!same(act, r.activation_eur) || !same(iec, r.iec_eur_kwh) || !same(sup, r.support_eur))
      throw new Error(`componentes divergentes na versão ${vid}: act/IEC/apoio diferem por período`);
    act = r.activation_eur; iec = r.iec_eur_kwh; sup = r.support_eur;
  }
  return { price, act: act || 0, iec: iec || 0, sup: sup || 0 };
}

function quoteOne(t, { at, kwh, region, omie, omieVazio, omieFora }) {
  const ver = db.prepare('SELECT * FROM tariff_version WHERE id=?').get(t.vid);
  const { price, act, iec, sup } = comps(t.vid);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: db.prepare('SELECT brand_color FROM ceme WHERE id=?').get(t.ceme_id)?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: sup, iec, region });
    return { ...meta, activation: act, iec, prices: price, avail: t.regions, ...q };
  }
  // INDEXED: PE por período com o OMIE de referência do pedido.
  // Nas ilhas usa-se a ref. continental com aviso (MIBEL não cobre as ilhas).
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  const tarFor = (per) => db.prepare("SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage=? AND period=? AND valid_from <= date('now') ORDER BY valid_from DESC LIMIT 1").get(t.voltage, per)?.price_eur_kwh ?? 0;
  const vm = vmeta(t.id);
  const agg = ver.omie_aggregation || 'SPLIT_VAZIO_FORA';
  const omieForPeriod = (per) => {
    if (agg === 'SPLIT_VAZIO_FORA') return (per === 'VAZIO' ? (omieVazio ?? omie) : (omieFora ?? omie));
    return omie; // SPOT / UNICA / UNICO
  };
  const out = {};
  for (const per of ['VAZIO', 'FORA_VAZIO']) {
    const oref = omieForPeriod(per);
    out[per] = indexedPrice({ omieEurKwh: oref, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh: tarFor(per), loss: vm.loss, formula: vm.formula }).price;
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
  return { ...meta, activation: act, iec, prices: out, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: vm.loss ?? LOSS_PLACEHOLDER[t.voltage], formula: vm.formula, warning: here, avail: t.regions, ...q };
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
  // Decide o PRIMEIRO tag (o de maior preferência): só passa a inglês se o
  // browser pedir explicitamente en como primeira escolha. Um "en;q=0.8"
  // atrás de um "pt;q=0.9" não pode ganhar.
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

// Um método por endpoint (POC): leitura para os /v1/* de dados, POST para os
// dois que aceitam corpo. 405 antes de gastar auth.
const METHODS = {
  '/v1/health': 'GET', '/v1/cemes': 'GET', '/v1/tariffs': 'GET', '/v1/tar': 'GET',
  '/v1/omie/daily': 'GET', '/v1/omie/futures': 'GET', '/v1/indexed/quarters': 'GET',
  '/v1/session': 'POST', '/v1/simulate': 'POST',
};
const MAX_BODY = 64 * 1024; // 64 KB — corpos raquíticos; pedir mais é abuso

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Web POC sem auth (ficheiro estático); a API continua toda com auth.
  // HEAD é aceito (só read-only, corpo vazio) — sem isto, HEAD / dava 401.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8')
        .replace('<html lang="pt-PT">', `<html lang="${negotiateLang(req.headers['accept-language']) === 'en' ? 'en' : 'pt-PT'}">`)
        .replace('window.__LANG__=null', `window.__LANG__=${JSON.stringify(negotiateLang(req.headers['accept-language']))}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/index.html em falta' } }); }
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
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  // Rate limit depois da auth (401 não dá orçamento). Por IP para a sessão
  // web anonima; pela chave para terceiros. /v1/session tem o dele (acima).
  const rlLimit = a.payload.kind === 'THIRD_PARTY' && a.payload.rate_limit != null ? Number(a.payload.rate_limit) : RATE_DEFAULT;
  const rlKey = `${a.payload.kind === 'THIRD_PARTY' ? 'key' : 'ip'}:${a.payload.kind === 'THIRD_PARTY' ? a.payload.key : clientIp(req)}`;
  const rl = rateBucket(rlKey, rlLimit);
  const headers = rlHeaders(rl, rlLimit);
  if (!rl.allowed) return rateLimited(res, rl, rlLimit);

  if (url.pathname === '/v1/health') return json(res, 200, { ok: true, as: a.payload.kind, time: new Date().toISOString() }, headers);
  if (url.pathname === '/v1/cemes') return json(res, 200, { data: db.prepare('SELECT * FROM ceme ORDER BY name').all() }, headers);
  if (url.pathname === '/v1/tariffs') {
    return json(res, 200, { data: allTariffs().map(t => ({ ...t, version: db.prepare('SELECT * FROM tariff_version WHERE id=?').get(t.vid) })) }, headers);
  }
  if (url.pathname === '/v1/tar') {
    return json(res, 200, { data: db.prepare("SELECT * FROM tar WHERE valid_from <= date('now') AND (valid_to IS NULL OR valid_to > date('now'))").all() }, headers);
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
    const t = db.prepare('SELECT * FROM tariff WHERE id=?').all(tid || '').find(x => x.kind === 'INDEXED')
      || db.prepare("SELECT * FROM tariff WHERE kind='INDEXED' ORDER BY id LIMIT 1").get();
    if (!t) return json(res, 404, { error: { code: 'no_indexed', message: 'sem tarifário indexado' } });
    const ver = db.prepare('SELECT * FROM tariff_version WHERE tariff_id=? ORDER BY valid_from DESC LIMIT 1').get(t.id);

    // Fixo de referencia: o que o cliente escolheu no comparador. Sem ele nao
    // ha com quem comparar — o endpoint so sabe quanto o INDEXADO custa.
    const fixId = url.searchParams.get('fixed');
    let fixPrice = null, fixInfo = null;
    if (fixId) {
      const ft = db.prepare('SELECT * FROM tariff WHERE id=?').get(fixId);
      const fv = ft && db.prepare(`SELECT id FROM tariff_version v WHERE v.tariff_id=?
        AND v.valid_from <= date('now') AND (v.valid_to IS NULL OR v.valid_to > date('now'))
        ORDER BY v.valid_from DESC LIMIT 1`).get(ft.id);
      const fp = fv ? comps(fv.id).price : null;
      // Fixo sem preços de energia (ex. só EGME) não dá comparação: fica
      // null — a UI trata como "sem fixo" e esconde colunas, em vez de
      // mostrar uma referência vazia com nome.
      if (fp && Object.keys(fp).length) {
        fixPrice = fp;
        const fc = db.prepare('SELECT name FROM ceme WHERE id=?').get(ft.ceme_id);
        fixInfo = { id: ft.id, name: ft.name, ceme: fc?.name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule };
      }
    }

    const finish = (q) => {
      try {
        const withP = q.rows.map(r => {
          const [sh, sm] = r.start.split(':').map(Number);
          const per = periodForWall({ region, schedule: t.schedule, cycle: t.cycle, ymd: q.date, minutes: sh * 60 + sm });
          // TAR vigente (valid_from <= hoje): a coluna pode levar versões futuras
          const tar = db.prepare("SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage=? AND period=? AND (valid_from IS NULL OR valid_from <= date('now')) ORDER BY valid_from DESC LIMIT 1").get(t.voltage, per)?.price_eur_kwh ?? 0;
          const vm = vmeta(t.id);
          const { price } = indexedPrice({ omieEurKwh: r.priceMwh/1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh: tar, loss: vm.loss, formula: vm.formula });
          return { start: r.start, end: r.end, period: per, omieMwh: r.priceMwh, price: Math.round(price * 10000) / 10000 };
        });
        // quem ganha, quarto a quarto — logica em engine/compare.js
        const comp = compareWithFixed(withP, fixPrice);
        const ranked = [...comp].sort((x, y) => x.price - y.price);
        const cheap = new Set(ranked.slice(0, 8).map(x => x.start));
        const vm2 = vmeta(t.id);
        json(res, 200, { date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: vm2.loss ?? LOSS_PLACEHOLDER[t.voltage], cached: q.cached, source: q.source, cutoff: q.cutoff, estimated: q.estimated, days: q.days, fixed: fixInfo,
          warning: REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF',
          wins: tallyWinners(comp),
          quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.start) })) }, headers);
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
      if (body.length + c.length > MAX_BODY) { tooBig = true; body = ''; return; }
      body += c;
    });
    req.on('end', () => {
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
        const data = allTariffs().map(t => quoteOne(t, { at: now, kwh, region, omie, omieVazio, omieFora }))
          .filter(q => !q.skipped).sort((x, y) => x.totalEur - y.totalEur);
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
server.listen(PORT, () => console.log(`ceme-v2 POC http://localhost:${PORT}/ db=${DB_PATH}`));
