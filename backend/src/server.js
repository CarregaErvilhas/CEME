// Servidor POC (só node:* — sem deps). Serve a web em / e a API em /v1/* (tudo com auth).
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signJwt, verifyJwt, hashKey } from './auth/tokens.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { REGIONS } from './engine/regions.js';
import { seed, VERSIONS } from './db/seed.js';
import { getDaily, getFutures, getQuarters } from './omie/cache.js';
import { periodForWall } from './engine/regions.js';
import { compareWithFixed, tallyWinners } from './engine/compare.js';

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'dev-only-change-me') {
  throw new Error('JWT_SECRET environment variable is required (the dev-only fallback is forbidden)');
}
const DB_PATH = process.env.DB_PATH || './data/ceme.db';

mkdirSync('./data', { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));

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
  res.writeHead(code, {
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
};

// Rate limiting: fixed window, in-memory (suitable for a single-node POC;
// a reverse proxy / Redis should front this in production).
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT = 60;
const buckets = new Map(); // key -> { count, resetAt }

function rateBucket(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;
  const remaining = Math.max(0, limit - b.count);
  return { allowed: b.count <= limit, remaining, reset: b.resetAt };
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return verifyJwt(h.slice(7), JWT_SECRET);
  const k = req.headers['x-api-key'];
  if (k) {
    const prefix = String(k).slice(0, 8);
    const row = db.prepare(`SELECT k.id, k.prefix, k.hash, k.revoked_at, k.expires_at,
      c.id AS client_id, c.kind AS client_kind, c.ceme_id, c.rate_limit
      FROM api_key k JOIN api_client c ON c.id = k.client_id WHERE k.prefix = ?`).get(prefix);
    if (!row) return { ok: false, error: 'unknown_key' };
    if (row.revoked_at) return { ok: false, error: 'revoked_key' };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, error: 'expired_key' };
    if (hashKey(k) !== row.hash) return { ok: false, error: 'bad_key' };
    return {
      ok: true,
      payload: {
        kind: 'THIRD_PARTY',
        client: row.client_kind,
        ceme_id: row.ceme_id,
        rate_limit: row.rate_limit,
        key: prefix,
      },
    };
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
  const rows = db.prepare('SELECT * FROM price_component WHERE tariff_version_id=?').all(vid);
  const price = {};
  let act = 0, sup = 0, iec = 0;
  for (const r of rows) {
    if (r.energy_eur_kwh != null) price[r.period] = r.energy_eur_kwh;
    act = r.activation_eur || 0; sup = r.support_eur || 0; iec = r.iec_eur_kwh || 0;
  }
  return { price, act, iec, support: sup };
}

function quoteOne(t, { at, kwh, region, omie, omieVazio, omieFora }) {
  const ver = db.prepare('SELECT * FROM tariff_version WHERE id=?').get(t.vid);
  const { price, act, iec, support } = comps(t.vid);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: db.prepare('SELECT brand_color FROM ceme WHERE id=?').get(t.ceme_id)?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support, iec, region });
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
  // Tarifário indexado com tarifa simples: só existe UNICO. Não ocorre no seed
  // atual, mas evita que quoteFixed lance "sem preço final para UNICO".
  if (t.schedule === 'SIMPLES' && out.UNICO == null) {
    out.UNICO = out.FORA_VAZIO ?? out.VAZIO ?? 0;
  }
  const omieRef = (agg === 'SPLIT_VAZIO_FORA') ? (omieVazio ?? omie) : omie;
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support, iec, region });
  return { ...meta, activation: act, iec, prices: out, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: vm.loss ?? LOSS_PLACEHOLDER[t.voltage], warning: here, avail: t.regions, ...q };
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Web POC sem auth (ficheiro estático); a API continua toda com auth
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8')
        .replace('<html lang="pt-PT">', `<html lang="${negotiateLang(req.headers['accept-language']) === 'en' ? 'en' : 'pt-PT'}">`)
        .replace('window.__LANG__=null', `window.__LANG__=${JSON.stringify(negotiateLang(req.headers['accept-language']))}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Accept-Language' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/index.html em falta' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/v1/session') {
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, JWT_SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  // Rate limit: sessão web anónima por IP; terceiros pela chave de API.
  const rlKey = a.payload.kind === 'WEB_SESSION' ? `ip:${clientIp(req)}` : `key:${a.payload.key}`;
  const rlLimit = a.payload.rate_limit != null ? Number(a.payload.rate_limit) : DEFAULT_RATE_LIMIT;
  const rl = rateBucket(rlKey, rlLimit);
  const rlHeaders = {
    'X-RateLimit-Limit': String(rlLimit),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset': new Date(rl.reset).toISOString(),
  };
  if (!rl.allowed) return json(res, 429, { error: { code: 'rate_limited', message: 'limite de requisições excedido' } }, rlHeaders);

  if (url.pathname === '/v1/health') return json(res, 200, { ok: true, as: a.payload.kind, time: new Date().toISOString() }, rlHeaders);
  if (url.pathname === '/v1/cemes') return json(res, 200, { data: db.prepare('SELECT * FROM ceme ORDER BY name').all() }, rlHeaders);
  if (url.pathname === '/v1/tariffs') {
    return json(res, 200, { data: allTariffs().map(t => ({ ...t, version: db.prepare('SELECT * FROM tariff_version WHERE id=?').get(t.vid) })) }, rlHeaders);
  }
  if (url.pathname === '/v1/tar') {
    return json(res, 200, { data: db.prepare("SELECT * FROM tar WHERE valid_from <= date('now') AND (valid_to IS NULL OR valid_to > date('now'))").all() }, rlHeaders);
  }
  if (url.pathname === '/v1/omie/daily' && req.method === 'GET') {
    const days = Math.min(120, Math.max(7, Number(url.searchParams.get('days') || 60)));
    getDaily('./data', days).then(
      d => json(res, 200, d, rlHeaders),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `séries indisponíveis: ${e.message}` } }, rlHeaders));
    return;
  }
  if (url.pathname === '/v1/omie/futures' && req.method === 'GET') {
    getFutures('./data').then(
      d => json(res, 200, d, rlHeaders),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `futuros indisponíveis: ${e.message}` } }, rlHeaders));
    return;
  }
  if (url.pathname === '/v1/indexed/quarters' && req.method === 'GET') {
    const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
    if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, rlHeaders);
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
      if (ft) {
        const fv = db.prepare(`SELECT id FROM tariff_version v WHERE v.tariff_id=?
          AND v.valid_from <= date('now') AND (v.valid_to IS NULL OR v.valid_to > date('now'))
          ORDER BY v.valid_from DESC LIMIT 1`).get(ft.id);
        fixPrice = comps(fv?.id).price;
        const fc = db.prepare('SELECT name FROM ceme WHERE id=?').get(ft.ceme_id);
        fixInfo = { id: ft.id, name: ft.name, ceme: fc?.name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule };
      }
    }

    const finish = (q) => {
      try {
        const withP = q.rows.map(r => {
          const [sh, sm] = r.start.split(':').map(Number);
          const per = periodForWall({ region, schedule: t.schedule, cycle: t.cycle, ymd: q.date, minutes: sh * 60 + sm });
          const tar = db.prepare("SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage=? AND period=? ORDER BY valid_from DESC LIMIT 1").get(t.voltage, per)?.price_eur_kwh ?? 0;
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
          wins: tallyWinners(comp),
          quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.start) })) }, rlHeaders);
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, rlHeaders); }
    };
    getQuarters('./data', url.searchParams.get('date')).then(finish, e => json(res, 502, { error: { code: 'omie_unavailable', message: e.message } }, rlHeaders));
    return;
  }
  if (url.pathname === '/v1/simulate' && req.method === 'POST') {
    const MAX_BODY = 64 * 1024;
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > MAX_BODY) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: { code: 'bad_request', message: 'corpo JSON inválido' } }, rlHeaders); }
        const { kwh = 40, at, region = 'CONT', omie = 0.20, omieVazio, omieFora } = parsed;
        if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } }, rlHeaders);
        if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) {
          return json(res, 400, { error: { code: 'bad_kwh', message: 'kwh deve ser um número entre 0 e 1000' } }, rlHeaders);
        }
        let now;
        if (at) {
          now = new Date(at);
          if (!Number.isFinite(now.getTime())) return json(res, 400, { error: { code: 'bad_at', message: 'at deve ser uma data ISO válida' } }, rlHeaders);
        } else {
          now = new Date();
        }
        for (const [name, v] of [['omie', omie], ['omieVazio', omieVazio], ['omieFora', omieFora]]) {
          if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
            return json(res, 400, { error: { code: 'bad_omie', message: `${name} deve ser um número` } }, rlHeaders);
          }
        }
        const data = allTariffs().map(t => quoteOne(t, { at: now, kwh, region, omie, omieVazio, omieFora }))
          .filter(q => !q.skipped).sort((x, y) => x.totalEur - y.totalEur);
        const avg = data.length ? data.reduce((s, q) => s + q.totalEur, 0) / data.length : 0;
        json(res, 200, { at: now.toISOString(), kwh, region, omieRef: omie, avg: Math.round(avg * 100) / 100, data }, rlHeaders);
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }, rlHeaders); }
    });
    return;
  }
  json(res, 404, { error: { code: 'not_found', message: url.pathname } }, rlHeaders);
});

server.listen(PORT, () => console.log(`ceme-v2 POC http://localhost:${PORT}/ db=${DB_PATH}`));
