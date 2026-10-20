// Servidor POC (Node.js + PostgreSQL via pg em producao, SQLite em dev/test).
// Serve a web em / e a API em /v1/* (tudo com auth).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { query, get, run, close, dbInstance } from './db.js';
import { signJwt, verifyJwt } from './auth/tokens.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { REGIONS } from './engine/regions.js';
import { compareWithFixed, tallyWinners } from './engine/compare.js';
import { periodForWall } from './engine/regions.js';
import { getDaily, getFutures, getQuarters } from './omie/cache.js';
import { VERSIONS } from './db/seed.postgres.js';

const PORT = Number(process.env.PORT || 3001);
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const USE_PG = !!process.env.DATABASE_URL;

// Schema executado uma vez no arranque (idempotente).
const schemaFile = USE_PG
  ? new URL('./db/schema.postgres.sql', import.meta.url)
  : new URL('./db/schema.sql', import.meta.url);
const schemaSql = await readFile(schemaFile, 'utf8');
await run(schemaSql);

// TAR 2026 Continente (ERSE) — ilhas entram na fase de seed completo
await run(`
INSERT INTO tar (valid_from, valid_to, region, voltage, period, price_eur_kwh) VALUES
 ('2026-01-01', NULL, 'CONT','BT','VAZIO',0.0266), ('2026-01-01', NULL,'CONT','BT','FORA_VAZIO',0.1192),
 ('2026-01-01', NULL, 'CONT','MT','VAZIO',0.0157), ('2026-01-01', NULL,'CONT','MT','FORA_VAZIO',0.0812)
ON CONFLICT (valid_from, region, voltage, period) DO NOTHING
`);

// Seed — depende do backend ativo.
if (USE_PG) {
  const { seed } = await import('./db/seed.postgres.js');
  await seed();
} else {
  const { seed } = await import('./db/seed.js');
  await seed(dbInstance);
}

function vmeta(tid) {
  const v = VERSIONS[tid] || {};
  const loss = (v.loss != null) ? v.loss : null;
  return { loss, formula: v.formula || 'standard' };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function auth(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return verifyJwt(h.slice(7), SECRET);
  const k = req.headers['x-api-key'];
  if (k) return { ok: true, payload: { kind: 'THIRD_PARTY', key: String(k).slice(0, 8) } };
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
  const price = {};
  let act = 0, iec = 0;
  for (const r of rows) {
    if (r.energy_eur_kwh != null) price[r.period] = r.energy_eur_kwh;
    act = r.activation_eur || 0; iec = r.iec_eur_kwh || 0;
  }
  return { price, act, iec };
}

async function quoteOne(t, { at, kwh, region, omie, omieVazio, omieFora }) {
  const ver = await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]);
  const { price, act, iec } = await comps(t.vid);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: (await get('SELECT brand_color FROM ceme WHERE id = $1', [t.ceme_id]))?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: 0, iec, region });
    return { ...meta, activation: act, iec, prices: price, avail: t.regions, ...q };
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
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support: 0, iec, region });
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
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Web POC sem auth (ficheiro estático); a API continua toda com auth
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = (await readFile(new URL('../../frontend/index.html', import.meta.url), 'utf8'))
        .replace('<html lang="pt-PT">', `<html lang="${negotiateLang(req.headers['accept-language']) === 'en' ? 'en' : 'pt-PT'}">`)
        .replace('window.__LANG__=null', `window.__LANG__=${JSON.stringify(negotiateLang(req.headers['accept-language']))}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Language' });
      return res.end(html);
    } catch { return json(res, 500, { error: { code: 'no_frontend', message: 'frontend/index.html em falta' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/v1/session') {
    const token = signJwt({ kind: 'WEB_SESSION', sid: Math.random().toString(36).slice(2) }, SECRET);
    return json(res, 200, { token, expires_in: 86400 });
  }
  const a = auth(req);
  if (!a.ok) return json(res, 401, { error: { code: 'unauthorized', message: 'falta Authorization (Bearer ou X-API-Key)' } });

  if (url.pathname === '/v1/health') return json(res, 200, { ok: true, as: a.payload.kind, time: new Date().toISOString() });
  if (url.pathname === '/v1/cemes') return json(res, 200, { data: await query('SELECT * FROM ceme ORDER BY name') });
  if (url.pathname === '/v1/tariffs') {
    const rows = await allTariffs();
    const enriched = [];
    for (const t of rows) {
      const version = await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]);
      enriched.push({ ...t, version });
    }
    return json(res, 200, { data: enriched });
  }
  if (url.pathname === '/v1/tar') {
    return json(res, 200, { data: await query("SELECT * FROM tar WHERE valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to > CURRENT_DATE)") });
  }
  if (url.pathname === '/v1/omie/daily' && req.method === 'GET') {
    const days = Math.min(120, Math.max(7, Number(url.searchParams.get('days') || 60)));
    getDaily('./data', days).then(
      d => json(res, 200, d),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `séries indisponíveis: ${e.message}` } }));
    return;
  }
  if (url.pathname === '/v1/omie/futures' && req.method === 'GET') {
    getFutures('./data').then(
      d => json(res, 200, d),
      e => json(res, 502, { error: { code: 'omie_unavailable', message: `futuros indisponíveis: ${e.message}` } }));
    return;
  }
  if (url.pathname === '/v1/indexed/quarters' && req.method === 'GET') {
    const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
    if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } });
    const t = (await query('SELECT * FROM tariff WHERE id = $1', [tid || ''])).find(x => x.kind === 'INDEXED')
      || (await query("SELECT * FROM tariff WHERE kind = 'INDEXED' ORDER BY id LIMIT 1"));
    if (!t) return json(res, 404, { error: { code: 'no_indexed', message: 'sem tarifário indexado' } });
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
           ORDER BY v.valid_from DESC LIMIT 1`,
          [ft.id]
        );
        fixPrice = (await comps(fv?.id))?.price;
        const fc = await get('SELECT name FROM ceme WHERE id = $1', [ft.ceme_id]);
        fixInfo = { id: ft.id, name: ft.name, ceme: fc?.name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule };
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
          const tarRow = await get(
            "SELECT price_eur_kwh FROM tar WHERE region='CONT' AND voltage = $1 AND period = $2 ORDER BY valid_from DESC LIMIT 1",
            [t.voltage, item.period]
          );
          const tarEurKwh = tarRow?.price_eur_kwh ?? 0;
          const vm = vmeta(t.id);
          const { price } = indexedPrice({ omieEurKwh: item.omieMwh / 1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: vm.loss, formula: vm.formula });
          item.price = Math.round(price * 10000) / 10000;
        })).then(() => {
          const comp = compareWithFixed(withP, fixPrice);
          const ranked = [...comp].sort((x, y) => x.price - y.price);
          const cheap = new Set(ranked.slice(0, 8).map(x => x.start));
          const vm2 = vmeta(t.id);
          json(res, 200, {
            date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh,
            loss: vm2.loss ?? LOSS_PLACEHOLDER[t.voltage], cached: q.cached, source: q.source, cutoff: q.cutoff,
            estimated: q.estimated, days: q.days, fixed: fixInfo,
            wins: tallyWinners(comp),
            quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.start) }))
          });
        }).catch(e => json(res, 400, { error: { code: 'quote_failed', message: e.message } }));
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }); }
    };
    getQuarters('./data', url.searchParams.get('date')).then(finish, e => json(res, 502, { error: { code: 'omie_unavailable', message: e.message } }));
    return;
  }
  if (url.pathname === '/v1/simulate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const { kwh = 40, at, region = 'CONT', omie = 0.20, omieVazio, omieFora } = JSON.parse(body || '{}');
        if (!REGIONS[region]) return json(res, 400, { error: { code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' } });
        const now = at ? new Date(at) : new Date();
        const tariffs = await allTariffs();
        const data = [];
        for (const t of tariffs) {
          const q = await quoteOne(t, { at: now, kwh, region, omie, omieVazio, omieFora });
          if (!q.skipped) data.push(q);
        }
        data.sort((x, y) => x.totalEur - y.totalEur);
        const avg = data.length ? data.reduce((s, q) => s + q.totalEur, 0) / data.length : 0;
        json(res, 200, { at: now.toISOString(), kwh, region, omieRef: omie, avg: Math.round(avg * 100) / 100, data });
      } catch (e) { json(res, 400, { error: { code: 'quote_failed', message: e.message } }); }
    });
    return;
  }
  json(res, 404, { error: { code: 'not_found', message: url.pathname } });
});

server.listen(PORT, () => console.log(`ceme-v2 POC http://localhost:${PORT}/ db=${USE_PG ? 'postgresql' : 'sqlite'}`));
