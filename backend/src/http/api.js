// A API em /v1/*. Tudo aqui pede credencial, menos POST /v1/session (que é
// onde o browser vai buscar a credencial). Vê docs/04-api-auth.md para o
// formato de cada pedido e resposta.
//
// Cada pedido passa por, nesta ordem:
//   1. método certo? (senão 405)
//   2. /v1/session? (emite token e acaba aqui)
//   3. credencial válida? (senão 401)
//   4. dentro do rate limit? (senão 429)
//   5. o handler da rota, em ROUTES.
import { query, get } from '../db.js';
import { indexedPrice, LOSS_PLACEHOLDER } from '../engine/indexed.js';
import { lossAt } from '../engine/losses.js';
import { REGIONS, periodForRegion } from '../engine/regions.js';
import { compareWithFixed, tallyWinners } from '../engine/compare.js';
import { getDaily, getFutures, getQuarters, getStats, SOURCE_LABEL } from '../omie/pipeline.js';
import { civilDay } from '../omie/convert.js';
import { zonedParts } from '../time.js';
import { allTariffs, comps, compRows, loadPricing, tarFor, quoteOne, today, vmeta } from '../tariffs.js';
import { json, fail, clientIp } from './respond.js';
import { rateBucket, rlHeaders, rateLimited, RATE_DEFAULT } from './ratelimit.js';
import { auth, issueSession } from './auth.js';

const MAX_BODY = 64 * 1024; // tamanho máximo do corpo de um POST (64 KB)

// Valida um nome de fuso IANA vindo do browser (ex.: 'Europe/Lisbon'). Se
// for inválido, usa UTC.
function validTz(name) {
  if (!name || typeof name !== 'string' || name.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return name;
  } catch { return 'UTC'; }
}

// 'HH:MM' de um instante UTC, no fuso pedido.
function fmtTime(utcIso, tz) {
  const { hour, minute } = zonedParts(new Date(utcIso), tz);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// O dia pedido ('AAAA-MM-DD', dia de Lisboa) ou, se não vier, hoje em Lisboa.
function quarterDay(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return civilDay();
}

const badRegion = (res, headers) => fail(res, 400, 'bad_region', 'region ∈ CONT|MAD|AZO', headers);

// ---- Handlers ----
// Cada um recebe { req, res, url, who, headers } (who = payload da auth;
// headers = os do rate limit, que vão em todas as respostas).

async function health({ res, who, headers }) {
  json(res, 200, { ok: true, as: who.kind, time: new Date().toISOString() }, headers);
}

// Lista fechada do que é público num CEME. Nunca `SELECT *`: uma coluna nova
// na tabela não pode aparecer na API sem passar por aqui. A API não lê
// `ceme_contact`.
export const CEME_PUBLIC_COLS = ['id', 'name', 'brand_color', 'website', 'email', 'phone', 'whatsapp'];

async function cemes({ res, headers }) {
  json(res, 200, { data: await query(`SELECT ${CEME_PUBLIC_COLS.join(', ')} FROM ceme ORDER BY name`) }, headers);
}

async function tariffs({ res, headers }) {
  const rows = await allTariffs();
  const versions = new Map((await query('SELECT * FROM tariff_version')).map(v => [v.id, v]));
  json(res, 200, { data: rows.map(t => ({ ...t, version: versions.get(t.vid) ?? null })) }, headers);
}

async function tar({ res, headers }) {
  json(res, 200, { data: await query('SELECT * FROM tar WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)', [today()]) }, headers);
}

// Dados da página /tabela: os tarifários em vigor com os preços, sem
// cálculo nenhum.
async function tabela({ res, headers }) {
  const pricing = await loadPricing('CONT');
  // Preços próprios das ilhas, à parte, por versão: vid → linhas.
  const islandRows = new Map();
  for (const r of await query(
    `SELECT tariff_version_id, region, period, energy_eur_kwh, activation_eur, support_eur, iec_eur_kwh,
            energy_only_eur_kwh, tar_eur_kwh
     FROM price_component_region`)) {
    if (!islandRows.has(r.tariff_version_id)) islandRows.set(r.tariff_version_id, []);
    islandRows.get(r.tariff_version_id).push(r);
  }
  const out = [];
  for (const t of await allTariffs()) {
    if (t.vid == null) continue; // sem versão em vigor (ex.: campanha acabada)
    const cp = pricing.comps(t.vid);
    // { MAD: { prices, split }, … }. Só aparece para quem cobra diferente lá.
    const regRows = islandRows.get(t.vid) ?? [];
    const regionPrices = {};
    for (const region of [...new Set(regRows.map(r => r.region))].sort()) {
      const rp = compRows(regRows.filter(r => r.region === region), t.vid);
      regionPrices[region] = { prices: rp.price, split: rp.split };
    }
    out.push({
      ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
      schedule: t.schedule, cycle: t.cycle, green: t.green, bundle: t.bundle,
      popular: t.popular, access: t.access,
      prices: cp.price, activation: cp.act, iec: cp.iec, split: cp.split,
      ...(Object.keys(regionPrices).length ? { regionPrices } : {}),
    });
  }
  const ver = await get(
    'SELECT MAX(valid_from) AS d FROM tariff_version WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)', [today()]);
  json(res, 200, { at: ver?.d ?? null, data: out }, headers);
}

// As três rotas do OMIE só lêem do pipeline. Se o pipeline falhar (fonte em
// baixo e nada na BD), respondem 502.
const omieRoute = (load, what) => async ({ res, url, headers }) => {
  try { json(res, 200, await load(url), headers); }
  catch (e) { fail(res, 502, 'omie_unavailable', `${what} indisponíveis: ${e.message}`, headers); }
};
const omieDaily = omieRoute((url) => {
  const nDays = Number(url.searchParams.get('days') || 60);
  return getDaily(Number.isFinite(nDays) ? Math.min(120, Math.max(7, Math.trunc(nDays))) : 60);
}, 'séries');
const omieFutures = omieRoute(() => getFutures(), 'futuros');
const omieStats = omieRoute(() => getStats(), 'estatísticas');

// A versão de um tarifário em vigor hoje (ou, se ainda nenhuma começou e
// `orNext`, a próxima).
async function currentVersion(tariffId, orNext = false) {
  const day = today();
  return await get(
    `SELECT * FROM tariff_version WHERE tariff_id = $1
      AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY valid_from DESC LIMIT 1`, [tariffId, day]
  ) || (orNext ? await get(
    `SELECT * FROM tariff_version WHERE tariff_id = $1 AND valid_from > $2
      ORDER BY valid_from ASC LIMIT 1`, [tariffId, day]
  ) : null);
}

// O fixo escolhido no comparador, cotado na região. null se não existir, se
// não tiver versão em vigor ou se não tiver preços (a página esconde então
// as colunas de comparação).
async function fixedForCompare(fixId, region) {
  if (!fixId) return null;
  const ft = await get('SELECT t.*, c.name AS ceme_name FROM tariff t JOIN ceme c ON c.id = t.ceme_id WHERE t.id = $1', [fixId]);
  if (!ft) return null;
  const fv = await currentVersion(ft.id);
  const price = fv ? (await comps(fv.id, region)).price : null;
  if (!price || !Object.keys(price).length) return null;
  return {
    price,
    info: { id: ft.id, name: ft.name, ceme: ft.ceme_name || ft.ceme_id, voltage: ft.voltage, schedule: ft.schedule, cycle: ft.cycle },
  };
}

// Os 96 quartos de hora de um dia com o preço de um indexado e, se vier
// `fixed`, quem ganha em cada quarto contra esse fixo.
// Parâmetros: tariff, region, date (dia de Lisboa), fixed, tz (fuso em que
// se mostram as horas).
async function indexedQuarters({ res, url, headers }) {
  const tid = url.searchParams.get('tariff'), region = url.searchParams.get('region') || 'CONT';
  const tz = validTz(url.searchParams.get('tz'));
  if (!REGIONS[region]) return badRegion(res, headers);
  const t = (await query('SELECT * FROM tariff WHERE id = $1', [tid || ''])).find(x => x.kind === 'INDEXED')
    || (await query("SELECT * FROM tariff WHERE kind = 'INDEXED' ORDER BY id LIMIT 1"))[0];
  if (!t) return fail(res, 404, 'no_indexed', 'sem tarifário indexado', headers);
  const ver = await currentVersion(t.id, true);
  if (!ver) return fail(res, 404, 'no_indexed_version', 'sem versão em vigor do tarifário indexado', headers);
  const fix = await fixedForCompare(url.searchParams.get('fixed'), region);

  let q;
  try { q = await getQuarters(quarterDay(url.searchParams.get('date'))); }
  catch (e) { return fail(res, 502, 'omie_unavailable', e.message, headers); }

  try {
    const vm = vmeta(t.id);
    // A TAR só depende do período, por isso lê-se uma vez por período.
    const tarByPeriod = {};
    for (const per of ['VAZIO', 'FORA_VAZIO', 'UNICO']) {
      tarByPeriod[per] = await tarFor(region, t.voltage, per, q.date);
    }
    const withP = q.rows.map(r => {
      const at = new Date(r.utc);
      // O período de cada quarto, calculado à parte para o indexado e para
      // o fixo (os ciclos deles podem ser diferentes).
      const period = periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at });
      const fixPeriod = fix ? periodForRegion({ region, schedule: fix.info.schedule, cycle: fix.info.cycle, at }) : null;
      // Preço do indexado neste quarto, com a TAR da região e as perdas do
      // próprio quarto.
      const tarEurKwh = tarByPeriod[period];
      if (tarEurKwh == null) throw new Error(`sem TAR ${region}/${t.voltage}/${period} em ${q.date}`);
      const loss = lossAt(t.voltage, r.utc) ?? vm.loss;
      const { price } = indexedPrice({ omieEurKwh: r.pt / 1000, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss, formula: vm.formula });
      return {
        start: fmtTime(r.utc, tz), end: fmtTime(new Date(at.getTime() + 15 * 60000).toISOString(), tz),
        period, fixPeriod, omieMwh: r.pt, utc: r.utc, src: r.src, est: !!r.est,
        loss, price: Math.round(price * 10000) / 10000,
      };
    });
    // Quem ganha em cada quarto (engine/compare.js).
    const comp = compareWithFixed(withP, fix?.price ?? null);
    // Os 8 quartos mais baratos, identificados pelo instante (em Outubro há
    // duas "01:00").
    const cheap = new Set([...comp].sort((x, y) => x.price - y.price).slice(0, 8).map(x => x.utc));
    json(res, 200, {
      date: q.date, tariff: t.id, name: t.name, region, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh,
      // Média das perdas dos quartos (cada quarto usa a sua).
      loss: withP.length && withP.every(x => x.loss != null)
        ? withP.reduce((a, x) => a + x.loss, 0) / withP.length
        : (vm.loss ?? LOSS_PLACEHOLDER[t.voltage]),
      source: SOURCE_LABEL,
      // estimated: o dia todo é estimativa; estimatedFrom: a hora a partir da
      // qual passa a ser (tipicamente 23:00, vê docs/03).
      estimated: q.rows.length > 0 && q.rows.every(r => r.est),
      estimatedFrom: q.rows.some(r => r.est) && !q.rows.every(r => r.est) ? withP.find(x => x.est).start : null,
      days: q.days, fixed: fix?.info ?? null,
      warning: REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF',
      wins: tallyWinners(comp),
      quarters: comp.map(x => ({ ...x, cheap: cheap.has(x.utc) })),
    }, headers);
  } catch (e) { fail(res, 400, 'quote_failed', e.message, headers); }
}

// Lê o corpo de um POST até MAX_BODY. Devolve o texto, ou null se passou do
// limite (o resto do corpo é lido e deitado fora).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '', tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      if (body.length + c.length > MAX_BODY) { tooBig = true; body = ''; return; }
      body += c;
    });
    req.on('end', () => resolve(tooBig ? null : body));
    req.on('error', reject);
  });
}

// Valida o corpo do /v1/simulate. Devolve { ok: true, value } com os campos
// normalizados, ou { ok: false, code, message }.
function parseSimulate(body) {
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { return { ok: false, code: 'bad_request', message: 'corpo JSON inválido' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'bad_request', message: 'corpo deve ser um objecto JSON' };
  }
  const { region = 'CONT', omie = 0.20, omieVazio, omieFora, omieCycles, useSpot, detail } = parsed;
  let { kwh = 40, at } = parsed;
  if (!REGIONS[region]) return { ok: false, code: 'bad_region', message: 'region ∈ CONT|MAD|AZO' };
  // `profile` (opcional): o carregamento partido em fatias, [{ at, kwh }] por
  // ordem de tempo. Quando vem, manda: kwh é a soma e at a primeira fatia.
  const prof = parseProfile(parsed.profile);
  if (prof && !prof.ok) return prof;
  const profile = prof ? prof.value : null;
  if (profile) { kwh = profile.reduce((a, p) => a + p.kwh, 0); at = profile[0].at; }
  if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh <= 0 || kwh > 1000) {
    return { ok: false, code: 'bad_kwh', message: 'kwh deve ser um número maior que 0 e até 1000' };
  }
  const now = at != null ? new Date(at) : new Date();
  if (Number.isNaN(now.getTime())) return { ok: false, code: 'bad_at', message: 'at deve ser uma data ISO válida' };
  const omieVals = [['omie', omie], ['omieVazio', omieVazio], ['omieFora', omieFora]];
  if (omieCycles != null) {
    if (typeof omieCycles !== 'object' || Array.isArray(omieCycles)
      || Object.keys(omieCycles).some(c => c !== 'DIARIO' && c !== 'SEMANAL')) {
      return { ok: false, code: 'bad_omie', message: 'omieCycles: { DIARIO?, SEMANAL? } com { vazio, fora } em €/kWh' };
    }
    for (const [c, v] of Object.entries(omieCycles)) {
      if (typeof v !== 'object' || v === null) return { ok: false, code: 'bad_omie', message: `omieCycles.${c} deve ser { vazio, fora }` };
      omieVals.push([`omieCycles.${c}.vazio`, v.vazio], [`omieCycles.${c}.fora`, v.fora]);
    }
  }
  for (const [nome, v] of omieVals) {
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      return { ok: false, code: 'bad_omie', message: `${nome} deve ser um número (€/kWh) positivo` };
    }
  }
  return { ok: true, value: { kwh, now, region, omie, omieVazio, omieFora, omieCycles, useSpot: useSpot === true, profile, detail: detail === true } };
}

// Valida o `profile` do /v1/simulate. Cada fatia é cotada no seu instante
// `at` (período, quarto de hora OMIE, TAR do dia), por isso quem chama deve
// partir o carregamento nas fronteiras dos quartos de hora (:00, :15, :30,
// :45 UTC): uma fatia que atravesse uma fronteira é cotada toda no início.
const MAX_SLICES = 400; // 100 horas em quartos de hora
function parseProfile(profile) {
  if (profile == null) return null;
  const bad = (message) => ({ ok: false, code: 'bad_profile', message });
  if (!Array.isArray(profile) || !profile.length || profile.length > MAX_SLICES) return bad(`profile deve ter 1 a ${MAX_SLICES} fatias { at, kwh }`);
  const out = [];
  for (const [i, p] of profile.entries()) {
    if (typeof p !== 'object' || p === null) return bad(`profile[${i}] deve ser { at, kwh }`);
    const d = new Date(p.at);
    if (p.at == null || Number.isNaN(d.getTime())) return bad(`profile[${i}].at deve ser uma data ISO válida`);
    if (typeof p.kwh !== 'number' || !Number.isFinite(p.kwh) || p.kwh < 0) return bad(`profile[${i}].kwh deve ser um número ≥ 0`);
    if (out.length && d <= out.at(-1).at) return bad('as fatias do profile devem vir por ordem de tempo, sem repetir instantes');
    out.push({ at: d, kwh: p.kwh });
  }
  const total = out.reduce((a, p) => a + p.kwh, 0);
  if (!(total > 0) || total > 1000) return bad('a soma dos kwh do profile deve ser maior que 0 e até 1000');
  return { ok: true, value: out };
}

// O OMIE do quarto de hora que contém `now`, ou null se não houver.
//   days: Map opcional dia → Promise(getQuarters), para um profile não ler
//   o mesmo dia uma vez por fatia.
async function spotAt(now, days) {
  try {
    const day = civilDay(now);
    let qp = days?.get(day);
    if (!qp) { qp = getQuarters(day); days?.set(day, qp); }
    const qs = await qp;
    const r = qs.rows.find(x => { const t0 = Date.parse(x.utc); return t0 <= now.getTime() && now.getTime() < t0 + 15 * 60000; });
    if (r && Number.isFinite(r.pt)) return { omieKwh: r.pt / 1000, utc: r.utc };
  } catch (e) { console.warn('[ceme-v2] simulate: sem OMIE do quarto, a usar médias:', e.message); }
  return null;
}

// Cota todos os tarifários para um carregamento e devolve-os do mais barato
// para o mais caro.
async function simulate({ req, res, headers }) {
  const body = await readBody(req);
  if (body == null) return fail(res, 413, 'payload_too_large', `corpo > ${MAX_BODY} bytes`, headers);
  const p = parseSimulate(body);
  if (!p.ok) return fail(res, 400, p.code, p.message, headers);
  const { kwh, now, region, omie, omieVazio, omieFora, omieCycles, useSpot, detail } = p.value;
  let { profile } = p.value;
  try {
    // O dia do carregamento na região escolhe a versão e a TAR em vigor.
    const day = civilDay(now, REGIONS[region].tz);
    const list = await allTariffs(day);
    // useSpot: usa o OMIE do quarto de hora do carregamento nos indexados.
    // Se não houver, ficam as médias.
    const days = new Map();
    const spot = useSpot ? await spotAt(now, days) : null;
    // Com profile, cada fatia leva o OMIE do seu quarto (ou null: médias).
    if (profile && useSpot) profile = await Promise.all(profile.map(async x => ({ ...x, spot: await spotAt(x.at, days) })));
    // Cota cada tarifário. Se um falhar (dados errados, falta de TAR), fica
    // de fora com um aviso no log e os outros seguem ("quarentena").
    const pricing = await loadPricing(region);
    const results = list.map(t => {
      try {
        const q = quoteOne(t, { at: now, day, kwh, region, omie, omieVazio, omieFora, omieCycles, spot: spot && { ...spot, loss: lossAt(t.voltage, now) }, profile }, pricing);
        // O detalhe por fatia só vai se for pedido (são N fatias × cada tarifário).
        if (!detail) delete q.slices;
        return q;
      } catch (e) {
        console.warn(`[ceme-v2] tarifário em quarentena: ${t.id}: ${e.message}`);
        return null;
      }
    });
    const data = results.filter(Boolean).sort((x, y) => x.totalEur - y.totalEur);
    const avg = data.length ? data.reduce((s, q) => s + q.totalEur, 0) / data.length : 0;
    json(res, 200, { at: now.toISOString(), kwh, region, omieRef: spot ? spot.omieKwh : omie, omieSpot: spot ? { utc: spot.utc, eurKwh: spot.omieKwh } : null,
      ...(profile && { profile: { slices: profile.length, from: profile[0].at.toISOString(), to: profile.at(-1).at.toISOString(), withSpot: profile.filter(x => x.spot).length } }),
      avg: Math.round(avg * 100) / 100, data }, headers);
  } catch (e) { fail(res, 400, 'quote_failed', e.message, headers); }
}

// As rotas: caminho → { método aceite, handler }. Um GET aceita também HEAD.
const ROUTES = {
  '/v1/health': { method: 'GET', handler: health },
  '/v1/cemes': { method: 'GET', handler: cemes },
  '/v1/tariffs': { method: 'GET', handler: tariffs },
  '/v1/tar': { method: 'GET', handler: tar },
  '/v1/tabela': { method: 'GET', handler: tabela },
  '/v1/omie/daily': { method: 'GET', handler: omieDaily },
  '/v1/omie/futures': { method: 'GET', handler: omieFutures },
  '/v1/omie/stats': { method: 'GET', handler: omieStats },
  '/v1/indexed/quarters': { method: 'GET', handler: indexedQuarters },
  '/v1/session': { method: 'POST', handler: null }, // tratada antes da auth
  '/v1/simulate': { method: 'POST', handler: simulate },
};

export async function serveApi(req, res, url) {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  // Método errado: 405, com o cabeçalho `allow` a dizer o certo.
  if (route && req.method !== route.method && !(route.method === 'GET' && req.method === 'HEAD')) {
    return fail(res, 405, 'method_not_allowed', `${req.method} em ${url.pathname}; usar ${route.method}`, { allow: route.method });
  }
  if (url.pathname === '/v1/session') return issueSession(req, res);

  // Qualquer outro caminho (mesmo um que não existe) pede credencial: um
  // desconhecido sem credencial dá 401, não 404.
  const a = await auth(req);
  if (!a.ok) return fail(res, 401, 'unauthorized', 'falta Authorization (Bearer ou X-API-Key)');

  // Rate limit, depois da auth: por chave (API key) ou por IP (sessão web).
  const thirdParty = a.payload.kind === 'THIRD_PARTY';
  const limit = thirdParty && a.payload.rate_limit != null ? Number(a.payload.rate_limit) : RATE_DEFAULT;
  const rl = rateBucket(thirdParty ? `key:${a.payload.key}` : `ip:${clientIp(req)}`, limit);
  if (!rl.allowed) return rateLimited(res, rl, limit);
  const headers = rlHeaders(rl, limit);

  if (!route) return fail(res, 404, 'not_found', url.pathname, headers);
  return route.handler({ req, res, url, who: a.payload, headers });
}
