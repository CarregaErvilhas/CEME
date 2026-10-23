// O pipeline do OMIE.
//
// Duas fontes em paralelo, reconciliadas na BD:
//
//   1. omie.es (primária) — o dump acumulado público, com pedido
//      condicional (ETag): enquanto o ficheiro não muda, a resposta é um
//      304 e não se gasta rede;
//   2. TF (secundária) — os ficheiros do Tiago Felícia (CC BY 4.0), que
//      trazem a classificação do período horário (BD/BS, as regras da
//      ERSE) e as estimativas OMIP dos dias que a OMIE ainda não publicou.
//
// Em cada quarto-horário o preço é o do omie.es quando existe, o do TF
// quando não; a classificação é a do TF (e, se também não houver, as
// regras do motor).
//
// SEM CRON (decisão: o tráfego não o justifica; revê-se se justificar). A
// actualização é a pedido: qualquer leitura do OMIE (/daily, /quarters,
// /stats) olha para a idade do que está na BD (`omie_meta.last_refresh`).
// Fresco: ninguém vai buscar nada. Velho: o pedido dispara a actualização em
// segundo plano e serve-se o que já há. Só quando ainda não há nada é que o
// pedido espera pela ingestion.
//
// VÁRIAS RÉPLICAS: o refresh é protegido por um lock na própria BD (uma
// linha em `omie_meta` com um token do dono), para duas réplicas não puxarem
// o ficheiro ao mesmo tempo. Os upserts são idempotentes, por isso uma
// corrida não estraga dados — só gasta rede.
//
// READONLY (`CEME_READONLY=1`, a BD é de outro ambiente): não há ingestion
// nem escrita de derivados; as estatísticas calculam-se em memória a partir
// do que a BD já tem.
import { run, get, query, affected, READONLY } from '../db.js';
import { fetchOmieDump, parseOmieDump, OMIE_LABEL } from './omiees.js';
import {
  fetchCachedFile, parseTfQuarters, parseTfFutures, parseTfDailyFutures, parseOmieCutoff,
  TF_CURRENT_URL, TF_HISTORY_URL, TF_FUTURES_URL, TF_SOURCE,
  TTL_DAILY, TTL_HISTORY, TTL_FUTURES,
} from './tf.js';
import {
  upsertSpot, upsertDaily, spotForDay, spotBetween, reconcile, spotRange, recentDays, lastMarketDay,
  getMeta, setMeta, getMetaJson, setMetaJson, dailyRows, shiftDays,
} from './store.js';
import { aggregate, currentPrice } from './stats.js';
import { civilDay, expectedQuartersForLisbonDay } from './convert.js';

export const SOURCE_LABEL = `${OMIE_LABEL} + ${TF_SOURCE}`;

// De quanto em quanto tempo se re-faz a ingestion (mesmo que a upstream não
// tenha mudado: o TF publica as estimativas e a OMIE pode corrigir).
const TTL_MS = 60 * 60 * 1000;
// O lock: se uma réplica morre a meio, o lock expira e outra retoma.
const LOCK_TTL_MS = 10 * 60 * 1000;
export { TTL_MS as REFRESH_TTL_MS, LOCK_TTL_MS };

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ lock

// O valor do lock é `<epoch ms>:<aleatório>`: a hora diz quando expira, o
// aleatório diz de quem é. (Locks antigos, só com a hora, continuam a ler-se.)
const lockTime = (value) => Number(String(value || '').split(':')[0]) || 0;

// Tomar o lock da ingestion. Devolve o token do dono, ou null.
export async function acquireLock(now = Date.now()) {
  const token = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const ins = await run(
    `INSERT INTO omie_meta (key, value) VALUES ('refresh_lock', $1) ON CONFLICT (key) DO NOTHING`,
    [token]
  );
  if (affected(ins)) return token;
  // Já existe: rouba-o só se estiver expirado — e só se o UPDATE acertar no
  // valor que se leu (compare-and-swap). Se outra réplica o roubou entretanto,
  // o UPDATE não muda nenhuma linha e esta desiste.
  const row = await get(`SELECT value FROM omie_meta WHERE key = 'refresh_lock'`);
  if (!row || now - lockTime(row.value) <= LOCK_TTL_MS) return null;
  const upd = await run(
    `UPDATE omie_meta SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'refresh_lock' AND value = $2`,
    [token, row.value]
  );
  return affected(upd) ? token : null;
}

// Largar o lock — só se ainda for nosso. Se expirou e outra réplica o tomou,
// apagá-lo às cegas deixava uma terceira entrar a meio da ingestion dela.
export async function releaseLock(token) {
  await run(`DELETE FROM omie_meta WHERE key = 'refresh_lock' AND value = $1`, [token]);
}

// --------------------------------------------------------------- refresh

// A ingestion completa: omie.es + TF, e depois os derivados.
export async function refreshAll({ now = new Date() } = {}) {
  const log = [];

  // 1. omie.es — primária, com pedido condicional.
  const etag = await getMeta('omie_etag');
  const lastModified = await getMeta('omie_last_modified');
  let omieRows = [];
  try {
    const res = await fetchOmieDump({ etag, lastModified });
    if (res.changed) {
      const parsed = parseOmieDump(res.text);
      omieRows = [...parsed.days.values()].flat();
      await upsertSpot(omieRows, 'OMIE_ES', { maxDay: parsed.days.size ? [...parsed.days.keys()].sort().pop() : null });
      await setMeta('omie_etag', res.etag || '');
      await setMeta('omie_last_modified', res.lastModified || '');
      await setMeta('omie_emitted', JSON.stringify(parsed.emitted || null));
      await setMeta('omie_partial_days', JSON.stringify(parsed.partial || []));
      log.push(`omie.es: ${parsed.quarters} quartos em ${parsed.days.size} dias${parsed.partial.length ? ` (${parsed.partial.length} incompletos)` : ''}`);
    } else {
      log.push('omie.es: sem alterações (304)');
    }
  } catch (e) {
    log.push(`omie.es falhou: ${e.message}`);
  }

  // 1b. Reparação única: o parser antigo do TF punha os quartos do dia de
  // Março (mudança de hora) uma hora ao lado. Os dias antigos já não caem na
  // janela de reescrita, por isso apagam-se as linhas TF desses dias e a
  // ingestion a seguir volta a inseri-las (dia em falta = dia escrito).
  if (!(await getMeta('fix_tf_spring_dst_v1'))) {
    const spring = await springDstDaysInStore();
    if (spring.length) {
      await run(`DELETE FROM omie_spot WHERE source = 'TF' AND day_lisbon IN (${spring.map((_, i) => `$${i + 1}`).join(',')})`, spring);
    }
    await setMeta('fix_tf_spring_dst_v1', JSON.stringify({ at: nowIso(), days: spring }));
    log.push(`TF: reparados os dias de Março ${spring.join(', ') || '(nenhum)'}`);
  }

  // 2. TF — secundária: classificação BD/BS, buracos e estimativas.
  // A janela de reescrita é em torno de HOJE (dia civil de Lisboa): é aí que
  // o TF revê os dados (reais que substituem estimativas, estimativas
  // revistas). Sem janela explícita o upsert só reescrevia os últimos dias
  // do ficheiro (Dezembro) e as revisões dos dias recentes nunca mais
  // entravam na BD depois da primeira ingestão.
  try {
    const tf = await fetchTfQuarters(now);
    const lisToday = lisbonDayOf(now);
    await upsertSpot(tf.rows, 'TF', {
      fromDay: shiftDays(lisToday, -10),
      toDay: shiftDays(lisToday, 45),
    });
    await setMeta('tf_fetched_at', JSON.stringify(tf.fetchedAt));
    log.push(`TF: ${tf.rows.length} quartos`);
  } catch (e) {
    log.push(`TF falhou: ${e.message}`);
  }

  // 2b. O ficheiro de futuros: traz o `Data_Valores_OMIE` (a fronteira do
  // mercado, segundo o TF) e os contratos OMIP.
  try {
    const got = await fetchCachedFile('tf-futuros.csv', TF_FUTURES_URL, TTL_FUTURES);
    const cutoff = parseOmieCutoff(got.text);
    if (cutoff) await setMeta('omie_cutoff', cutoff);
    await setMetaJson('futures', {
      fetchedAt: Date.now(),
      source: `OMIP via ${TF_SOURCE}`,
      rows: parseTfFutures(got.text),
      daily: parseTfDailyFutures(got.text),
    });
  } catch (e) {
    log.push(`futuros falharam: ${e.message}`);
  }

  // 3. Os derivados: agregados diários e o payload das estatísticas.
  await rebuildDerived();

  await setMeta('last_refresh', String(Date.now()));
  await setMeta('last_refresh_at', nowIso());
  return { ok: true, log, at: nowIso() };
}

// Os ficheiros do TF, com cache em disco (por réplica): o ficheiro do ano
// corrente re-baixa-se uma vez por dia (TTL_DAILY), o do ano anterior uma vez
// por mês (TTL_HISTORY) — quase nunca muda, mas pode ser corrigido.
// O ano é o civil de Lisboa (não o do relógio do processo, que pode estar
// noutro fuso).
async function fetchTfQuarters(now) {
  const thisYear = Number(lisbonDayOf(now).slice(0, 4));
  const years = [thisYear - 1, thisYear];
  const days = new Map();
  const fetchedAt = {};
  for (const year of years) {
    const isCurrent = year === thisYear;
    const url = isCurrent ? TF_CURRENT_URL : TF_HISTORY_URL(year);
    const name = isCurrent ? 'tf-omie-atual.csv' : `tf-omie-${year}.csv`;
    const ttl = isCurrent ? TTL_DAILY : TTL_HISTORY;
    const got = await fetchCachedFile(name, url, ttl);
    fetchedAt[name] = { fetchedAt: got.fetchedAt, cached: got.cached };
    const parsed = parseTfQuarters(got.text);
    for (const [day, rows] of parsed.days) days.set(day, rows);
  }
  const rows = [...days.values()].flat();
  return { rows, days, fetchedAt };
}

// O dia civil de Lisboa de um instante: é nele que assentam as janelas de
// reescrita e os cartões de hoje/amanhã.
const lisbonDayOf = (now) => civilDay(now);

// Recalcula os agregados diários e o payload das estatísticas a partir do
// que está na BD. `persist: false` (modo readonly) devolve o payload sem
// escrever nada.
export async function rebuildDerived({ now = new Date(), persist = !READONLY } = {}) {
  const range = await spotRange();
  if (!range.from || !range.to) return { daily: 0, stats: null };
  // A janela das estatísticas: 366 dias a contar do último dia de MERCADO
  // (é o que a página mostra). A store também tem os dias estimados (até ao
  // fim do ano), por isso a janela é a do mercado e não a do último dia
  // guardado.
  const lastMarket = await lastMarketDay();
  if (!lastMarket) return { daily: 0, stats: null };
  const rows = await spotBetween(shiftDays(lastMarket, -365), range.to);
  if (!rows.length) return { daily: 0, stats: null };

  // Os agregados diários (por dia civil de Lisboa).
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const daily = [];
  for (const [day, list] of byDay) {
    const market = list.filter(r => !r.est);
    if (!market.length) continue;
    const pick = (k, v) => market.filter(r => r[k] === v && Number.isFinite(r.pt)).map(r => r.pt);
    const all = market.map(r => r.pt);
    daily.push({
      date: day,
      avg_pt: mean(all),
      min_pt: Math.min(...all),
      max_pt: Math.max(...all),
      bd_v: mean(pick('bd', 'V')), bd_f: mean(pick('bd', 'F')),
      bs_v: mean(pick('bs', 'V')), bs_f: mean(pick('bs', 'F')),
      quarters: market.length,
      source: SOURCE_LABEL,
    });
  }
  if (persist) await upsertDaily(daily);

  // O payload das estatísticas.
  //
  // A chave de agrupamento (`dn`/`mk`) é o dia civil de LISBOA (`r.day`):
  // é por aí que o TF publica os seus agregados diários e mensais, e é o
  // que o utilizador vê. A hora mostrada é a mesma (Lisboa), por isso não
  // há conversão separada — `lisbonDn`/`lisbonMin` são a mesma leitura.
  const statsRows = rows.map(r => {
    const dn = dayNum(r.day);
    return {
      dn,
      day: r.day,
      mk: r.day.slice(0, 7),
      min: r.min,
      lisbonDn: dn,
      lisbonMin: r.min,
      bd: r.bd || 'V',
      bs: r.bs || 'V',
      price: r.pt,
      est: !!r.est,
      utc: r.utc,
    };
  }).sort((a, b) => (a.utc && b.utc ? (a.utc < b.utc ? -1 : 1) : (a.dn - b.dn) || (a.min - b.min)));

  // A fronteira do mercado: o último dia com preço publicado. Sai dos
  // próprios dados (e não do `Data_Valores_OMIE` do TF, que é uma data e
  // chateia-se com a fronteira do dia).
  const marketDays = rows.filter(r => !r.est).map(r => r.day).sort();
  const cutoff = marketDays.length ? marketDays[marketDays.length - 1] : null;
  // Os futuros diários FPB D (a única fonte de futuro da página): vêm da
  // meta guardada na ingestion. Se ainda não estiver lá (BD antiga, ou
  // ingestion falhou), busca-os agora.
  let fut = await getMetaJson('futures');
  if (!fut || !Array.isArray(fut.daily)) {
    try {
      const got = await fetchCachedFile('tf-futuros.csv', TF_FUTURES_URL, TTL_FUTURES);
      fut = {
        fetchedAt: Date.now(),
        source: `OMIP via ${TF_SOURCE}`,
        rows: parseTfFutures(got.text),
        daily: parseTfDailyFutures(got.text),
      };
      if (persist) await setMetaJson('futures', fut);
    } catch (e) {
      fut = null;
    }
  }
  const fpbDaily = Object.fromEntries(((fut && fut.daily) || []).map(d => [d.date, d.value]));
  const payload = {
    ...aggregate(statsRows, { cutoff, now, fpbDaily }),
    source: SOURCE_LABEL,
    fetchedAt: Date.now(),
    // Proveniência para as tooltips de validação: de onde veio cada número.
    tfFetchedAt: await getMetaJson('tf_fetched_at'),
    omieEmitted: await getMetaJson('omie_emitted'),
  };
  if (persist) await setMetaJson('stats', payload);
  return { daily: daily.length, stats: payload };
}
// Os dias de mudança de hora de Março (dias de 92 quartos) que há na BD.
async function springDstDaysInStore() {
  const range = await spotRange();
  if (!range.from || !range.to) return [];
  const out = [];
  for (let y = Number(range.from.slice(0, 4)); y <= Number(range.to.slice(0, 4)); y++) {
    for (let d = 25; d <= 31; d++) {
      const iso = `${y}-03-${d}`;
      if (expectedQuartersForLisbonDay(iso) === 92) out.push(iso);
    }
  }
  return out;
}

// ------------------------------------------------------------- freshness

// Já há alguma coisa na BD?
async function hasData() {
  const rows = await query('SELECT 1 FROM omie_spot LIMIT 1');
  return rows.length > 0;
}

// Espera que outra réplica termine a ingestion (quando esta não tem o lock
// e ainda não há dados). Tempo limite generoso: é o arranque a frio.
async function waitForData(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    if (await hasData()) return true;
  }
  return false;
}

// A ingestion está fresco? Se não, dispara-se em segundo plano (ou à espera,
// se ainda não há nada).
export async function ensureFresh({ wait = false } = {}) {
  if (READONLY) return { fresh: true, readonly: true };
  const last = Number(await getMeta('last_refresh') || 0);
  const age = Date.now() - last;
  if (last && age < TTL_MS) return { fresh: true, age };

  const empty = !(await hasData());
  const token = await acquireLock();
  if (!token) {
    // Outra réplica está a atualizar. Se ainda não há dados, espera-se por
    // ela (arranque a frio); se já há, não se espera por nada.
    if (empty) await waitForData();
    return { fresh: false, locked: true };
  }

  const run = refreshAll()
    .catch(e => ({ ok: false, error: e.message }))
    .finally(() => releaseLock(token));

  if (wait || empty) {
    // Ainda não há nada para mostrar: o pedido espera pela ingestion.
    await run;
    return { fresh: true, waited: true };
  }
  // Em segundo plano: quem chegou não espera.
  run.catch(() => {});
  return { fresh: false, started: true };
}

// ---------------------------------------------------------------- leitura

// Os agregados diários.
export async function getDaily(days = 60) {
  await ensureFresh();
  const rows = await dailyRows(days);
  return {
    source: SOURCE_LABEL,
    rows: rows.map(r => ({
      date: String(r.date).slice(0, 10),
      bd_v: r.bd_v, bd_f: r.bd_f,
      bs_v: r.bs_v, bs_f: r.bs_f,
      avg_pt: r.avg_pt,
      // Dia civil de Lisboa completo (92/96/100 quartos). O dia de amanhã,
      // depois das ~13:00, só tem 92: as 23:00–24:00 de Lisboa são do dia de
      // mercado SEGUINTE de Madrid, que ainda não saiu — e uma média sem a
      // última hora (vazio) não serve de referência.
      quarters: r.quarters,
      complete: r.quarters != null && r.quarters >= expectedQuartersForLisbonDay(String(r.date).slice(0, 10)),
    })),
  };
}

// Os quartos de um dia civil de Lisboa, para o comparador.
export async function getQuarters(lisDay) {
  await ensureFresh();
  const rows = await spotForDay(lisDay);
  if (!rows.length) throw new Error(`sem quartos para ${lisDay}`);
  const days = await recentDays(lisDay, 10);
  return { date: lisDay, rows, days };
}

// Readonly: o payload calculado em memória (não se pode gravar na BD).
let memStats = null;

// As estatísticas.
//
// Três relógios diferentes mexem nelas:
//   - os dados (a ingestion): `ensureFresh` dispara o refresh quando passou
//     o TTL, como nas outras leituras do OMIE — a página das estatísticas é a
//     única coisa que o omie.cocofree.dev pede, e sem isto nunca actualizava;
//   - o dia (hoje/amanhã/mês): um payload calculado ontem tem os cartões de
//     ontem, por isso, se o dia de Lisboa mudou, recalcula-se já (da BD, sem
//     rede);
//   - o quarto de hora (o preço "à hora actual"): recalcula-se a cada pedido.
// `stale: true` diz à página que há um refresh a decorrer em segundo plano.
export async function getStats({ now = new Date() } = {}) {
  let payload = READONLY ? memStats : await getMetaJson('stats');
  const st = await ensureFresh({ wait: !payload });
  if (!READONLY && !payload) payload = await getMetaJson('stats');
  const sameDay = payload && payload.generatedAt && civilDay(new Date(payload.generatedAt)) === civilDay(now);
  // Em readonly não há refresh que o renove: recalcula-se também ao fim do
  // TTL (senão o "amanhã" de um preview só aparecia à meia-noite).
  const roStale = READONLY && payload && now - new Date(payload.generatedAt) > TTL_MS;
  if (!sameDay || roStale) {
    try {
      const r = await rebuildDerived({ now });
      if (r.stats) payload = r.stats;
      if (READONLY) memStats = payload;
    } catch (e) {
      // Falhou o recálculo, mas há payload: serve-se o que há (com aviso no
      // log) em vez de um 502.
      if (!payload) throw e;
      console.warn('[ceme-v2] stats: recálculo falhou, a servir o payload anterior:', e.message);
    }
  }
  if (!payload) throw new Error('séries OMIE indisponíveis');
  return {
    ...payload,
    current: payload.recent ? currentPrice(payload, now) : payload.current,
    stale: !!(st && (st.started || st.locked)),
  };
}

// Os futuros OMIP (só informativo; o preço de mercado é o do omie.es).
export async function getFutures() {
  const cached = await getMetaJson('futures');
  if (cached && Date.now() - (cached.fetchedAt || 0) < TTL_FUTURES) return cached;
  const got = await fetchCachedFile('tf-futuros.csv', TF_FUTURES_URL, TTL_FUTURES);
  const payload = {
    fetchedAt: Date.now(),
    source: `OMIP via ${TF_SOURCE}`,
    rows: parseTfFutures(got.text),
    daily: parseTfDailyFutures(got.text),
  };
  if (!READONLY) await setMetaJson('futures', payload);
  return payload;
}

// ------------------------------------------------------------------ util

const dayNum = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

// O estado da ingestion (para o log e para o diagnóstico).
export async function status() {
  return {
    lastRefresh: await getMeta('last_refresh_at'),
    etag: await getMeta('omie_etag'),
    emitted: await getMetaJson('omie_emitted'),
    days: (await dailyRows(400)).length,
  };
}
