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
// NADA CRON: aactualização é a pedido. O que decide é a idade do que está
// na BD (`omie_meta.last_refresh`): se está fresco, ninguém vai buscar
// nada; se está velho, o primeiro pedido dispara a actualização em segundo
// plano e serve-se o que já há. Só quando ainda não há nada é que o
// primeiro pedido espera pela ingestion.
//
// VÁRIAS RÉPLICAS: o refresh é protegido por um lock na própria BD (uma
// linha em `omie_meta`), para duas réplicas não puxarem o ficheiro ao
// mesmo tempo. Os upserts são idempotentes, por isso quem chegue depois
// não estraga nada.
import { run, get, query } from '../db.js';
import { fetchOmieDump, parseOmieDump, OMIE_LABEL } from './omiees.js';
import {
  fetchCachedFile, parseTfQuarters, parseTfFutures, parseOmieCutoff,
  TF_CURRENT_URL, TF_HISTORY_URL, TF_FUTURES_URL, TF_SOURCE,
  TTL_DAILY, TTL_HISTORY, TTL_FUTURES,
} from './tf.js';
import {
  upsertSpot, upsertDaily, spotForDay, spotBetween, reconcile, spotRange, recentDays, lastMarketDay,
  getMeta, setMeta, getMetaJson, setMetaJson, dailyRows, shiftDays,
} from './store.js';
import { aggregate } from './stats.js';

export const SOURCE_LABEL = `${OMIE_LABEL} + ${TF_SOURCE}`;

// De quanto em quanto tempo se re-faz a ingestion (mesmo que a upstream não
// tenha mudado: o TF publica as estimativas e a OMIE pode corrigir).
const TTL_MS = 60 * 60 * 1000;
// O lock: se uma réplica morre a meio, o lock expires e outra retoma.
const LOCK_TTL_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ lock

// Tomar o lock da ingestion. Devolve true se foi tomado.
async function acquireLock() {
  const res = await run(
    `INSERT INTO omie_meta (key, value) VALUES ('refresh_lock', $1) ON CONFLICT (key) DO NOTHING`,
    [String(Date.now())]
  );
  const changed = res && (res.changes != null ? res.changes : res.rowCount);
  if (changed) return true;
  // Já existe: rouba-o se estiver expirado (compare-and-swap).
  const row = await get(`SELECT value FROM omie_meta WHERE key = 'refresh_lock'`);
  const held = Number(row?.value || 0);
  if (Date.now() - held > LOCK_TTL_MS) {
    await run(`UPDATE omie_meta SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'refresh_lock' AND value = $2`,
      [String(Date.now()), String(held)]);
    return true;
  }
  return false;
}

async function releaseLock() {
  await run(`DELETE FROM omie_meta WHERE key = 'refresh_lock'`);
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

  // 2. TF — secundária: classificação BD/BS, buracos e estimativas.
  try {
    const tf = await fetchTfQuarters(now);
    await upsertSpot(tf.rows, 'TF');
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
// corrente muda uma vez por dia, o do ano anterior uma vez por ano.
async function fetchTfQuarters(now) {
  const years = [now.getFullYear() - 1, now.getFullYear()];
  const days = new Map();
  for (const year of years) {
    const isCurrent = year === now.getFullYear();
    const url = isCurrent ? TF_CURRENT_URL : TF_HISTORY_URL(year);
    const name = isCurrent ? 'tf-omie-atual.csv' : `tf-omie-${year}.csv`;
    const ttl = isCurrent ? TTL_DAILY : TTL_HISTORY;
    const got = await fetchCachedFile(name, url, ttl);
    const parsed = parseTfQuarters(got.text);
    for (const [day, rows] of parsed.days) days.set(day, rows);
  }
  const rows = [...days.values()].flat();
  return { rows, days };
}

// Recalcula os agregados diários e o payload das estatísticas a partir do
// que está na BD.
export async function rebuildDerived() {
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

  // Os agregados diários (por dia UTC).
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
  await upsertDaily(daily);

  // O payload das estatísticas.
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
    };
  }).sort((a, b) => (a.dn - b.dn) || (a.min - b.min));

  // A fronteira do mercado: o último dia com preço publicado. Sai dos
  // próprios dados (e não do `Data_Valores_OMIE` do TF, que é uma data e
  // chateia-se com a fronteira do dia).
  const marketDays = rows.filter(r => !r.est).map(r => r.day).sort();
  const cutoff = marketDays.length ? marketDays[marketDays.length - 1] : null;
  const payload = aggregate(statsRows, { cutoff, now: new Date() });
  await setMetaJson('stats', { ...payload, source: SOURCE_LABEL, fetchedAt: Date.now() });
  return { daily: daily.length, stats: payload };
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
  const last = Number(await getMeta('last_refresh') || 0);
  const age = Date.now() - last;
  if (last && age < TTL_MS) return { fresh: true, age };

  const empty = !(await hasData());
  const locked = await acquireLock();
  if (!locked) {
    // Outra réplica está a atualizar. Se ainda não há dados, espera-se por
    // ela (arranque a frio); se já há, não se espera por nada.
    if (empty) await waitForData();
    return { fresh: false, locked: true };
  }

  const run = refreshAll()
    .catch(e => ({ ok: false, error: e.message }))
    .finally(() => releaseLock());

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
    })),
  };
}

// Os quartos de um dia (UTC), para o comparador.
export async function getQuarters(dayUtc) {
  await ensureFresh();
  const rows = await spotForDay(dayUtc);
  if (!rows.length) throw new Error(`sem quartos para ${dayUtc}`);
  const days = await recentDays(dayUtc, 10);
  return { date: dayUtc, rows, days };
}

// As estatísticas: do payload guardado na BD.
export async function getStats() {
  const cached = await getMetaJson('stats');
  if (cached) return cached;
  await ensureFresh({ wait: true });
  const payload = await getMetaJson('stats');
  if (!payload) throw new Error('séries OMIE indisponíveis');
  return payload;
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
  };
  await setMetaJson('futures', payload);
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
