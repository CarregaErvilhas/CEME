// O "maestro" do OMIE: vai buscar os dados, guarda-os e serve-os à API.
//
// Fontes (vê omiees.js e tf.js):
//   1. omie.es, a oficial: dá o preço de cada quarto de hora;
//   2. dados.tiagofelicia.pt (TF): dá a classificação vazio/fora de vazio,
//      preenche buracos, estima dias ainda não publicados e traz os futuros.
//
// Não há tarefa agendada (cron). Quem actualiza são os próprios pedidos:
// qualquer leitura do OMIE chama ensureFresh(), que olha para a hora da
// última actualização (`omie_meta.last_refresh`):
//   - se tem menos de 1 hora, não faz nada;
//   - se é mais velha, lança a actualização em segundo plano e responde logo
//     com o que já há;
//   - se a BD ainda está vazia, espera pela actualização (não há nada para
//     mostrar).
//
// Pode haver várias instâncias do servidor ao mesmo tempo. Para não irem
// todas buscar os ficheiros, há um lock guardado na BD: só quem o tiver faz a
// actualização. Se duas o fizessem, os dados não se estragavam (os upserts
// são idempotentes), só se gastava rede.
//
// Com CEME_READONLY=1 não se escreve nada: as estatísticas calculam-se em
// memória a partir do que a BD já tem.
import { run, get, query, affected, READONLY } from '../db.js';
import { fetchOmieDump, parseOmieDump, OMIE_LABEL } from './omiees.js';
import {
  fetchCachedFile, parseTfQuarters, parseTfFutures, parseTfDailyFutures, parseOmieCutoff,
  TF_CURRENT_URL, TF_HISTORY_URL, TF_FUTURES_URL, TF_SOURCE,
  TTL_DAILY, TTL_HISTORY, TTL_FUTURES,
} from './tf.js';
import {
  upsertSpot, upsertDaily, spotForDay, spotBetween, reconcile, spotRange, recentDays, lastMarketDay,
  getMeta, setMeta, getMetaJson, setMetaJson, dailyRows,
} from './store.js';
import { aggregate, currentPrice } from './stats.js';
import { civilDay, expectedQuartersForLisbonDay } from './convert.js';
import { dayNumOf, shiftDays } from '../time.js';

// O crédito às fontes que vai nas respostas da API (a licença do TF obriga).
export const SOURCE_LABEL = `${OMIE_LABEL} + ${TF_SOURCE}`;

// Idade máxima dos dados antes de uma nova actualização.
const TTL_MS = 60 * 60 * 1000;
// Um lock com mais do que isto considera-se abandonado (a instância que o
// tinha morreu a meio) e outra pode ficar com ele.
const LOCK_TTL_MS = 10 * 60 * 1000;
export { TTL_MS as REFRESH_TTL_MS, LOCK_TTL_MS };

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ lock

// O lock é a linha 'refresh_lock' da omie_meta, com o valor
// `<hora em ms>:<texto aleatório>`. A hora diz a idade; o aleatório diz de
// quem é.
const lockTime = (value) => Number(String(value || '').split(':')[0]) || 0;

// Tenta ficar com o lock. Devolve o teu token, ou null se outro o tem.
export async function acquireLock(now = Date.now()) {
  const token = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const ins = await run(
    `INSERT INTO omie_meta (key, value) VALUES ('refresh_lock', $1) ON CONFLICT (key) DO NOTHING`,
    [token]
  );
  if (affected(ins)) return token;
  // Já existe. Só o tiras ao dono se estiver expirado, e o UPDATE só passa
  // se o valor ainda for o que leste ("compare-and-swap"): se outra instância
  // o apanhou entretanto, o UPDATE não muda nada e desistes.
  const row = await get(`SELECT value FROM omie_meta WHERE key = 'refresh_lock'`);
  if (!row || now - lockTime(row.value) <= LOCK_TTL_MS) return null;
  const upd = await run(
    `UPDATE omie_meta SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = 'refresh_lock' AND value = $2`,
    [token, row.value]
  );
  return affected(upd) ? token : null;
}

// Larga o lock, mas só se ainda for teu (o valor tem de ser o teu token).
export async function releaseLock(token) {
  await run(`DELETE FROM omie_meta WHERE key = 'refresh_lock' AND value = $1`, [token]);
}

// --------------------------------------------------------------- refresh

// A actualização completa: omie.es, TF, futuros e por fim os resumos.
// Uma fonte que falhe fica no `log` e as outras seguem.
export async function refreshAll({ now = new Date() } = {}) {
  const log = [];

  // 1. omie.es, com pedido condicional.
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

  // 2. TF. Reescreve-se de 10 dias atrás a 45 dias à frente de hoje (Lisboa),
  // que é onde o TF troca estimativas por valores reais e revê estimativas.
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

  // 3. Os futuros do OMIP (e o último dia de mercado segundo o TF).
  try {
    const { text, payload } = await fetchFutures();
    const cutoff = parseOmieCutoff(text);
    if (cutoff) await setMeta('omie_cutoff', cutoff);
    await setMetaJson('futures', payload);
  } catch (e) {
    log.push(`futuros falharam: ${e.message}`);
  }

  // 4. Os resumos: omie_daily e o payload das estatísticas.
  await rebuildDerived();

  await setMeta('last_refresh', String(Date.now()));
  await setMeta('last_refresh_at', nowIso());
  return { ok: true, log, at: nowIso() };
}

// Lê os CSV do TF do ano passado e do ano corrente (de Lisboa), com cache em
// disco. Devolve todas as linhas juntas.
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

// O dia de Lisboa de um instante.
const lisbonDayOf = (now) => civilDay(now);

// Recalcula, a partir da omie_spot, os resumos diários (omie_daily) e o
// payload da página de estatísticas (guardado em omie_meta 'stats').
// Com `persist: false` (modo readonly) só calcula e devolve, sem gravar.
export async function rebuildDerived({ now = new Date(), persist = !READONLY } = {}) {
  const range = await spotRange();
  if (!range.from || !range.to) return { daily: 0, stats: null };
  // Janela: os 366 dias até ao último dia com preço oficial, mais os dias
  // estimados que houver a seguir.
  const lastMarket = await lastMarketDay();
  if (!lastMarket) return { daily: 0, stats: null };
  const rows = await spotBetween(shiftDays(lastMarket, -365), range.to);
  if (!rows.length) return { daily: 0, stats: null };

  // Resumos por dia de Lisboa, só com preços reais (sem estimativas).
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

  // As linhas no formato que stats.js espera:
  //   dn: dia de Lisboa como número; mk: mês 'AAAA-MM'; min: minutos do dia.
  // Agrupa-se por dia de Lisboa, como o TF faz nos resumos dele, para os
  // números baterem com os publicados.
  const statsRows = rows.map(r => {
    const dn = dayNumOf(r.day);
    return {
      dn,
      day: r.day,
      mk: r.day.slice(0, 7),
      min: r.min,
      bd: r.bd || 'V',
      bs: r.bs || 'V',
      price: r.pt,
      est: !!r.est,
      utc: r.utc,
    };
  }).sort((a, b) => (a.utc && b.utc ? (a.utc < b.utc ? -1 : 1) : (a.dn - b.dn) || (a.min - b.min)));

  // O último dia com preço real, tirado dos próprios dados.
  const marketDays = rows.filter(r => !r.est).map(r => r.day).sort();
  const cutoff = marketDays.length ? marketDays[marketDays.length - 1] : null;
  // Os futuros diários (FPB D), guardados pela actualização. Se ainda não
  // existirem, vão-se buscar agora.
  let fut = await getMetaJson('futures');
  if (!fut || !Array.isArray(fut.daily)) {
    try {
      fut = (await fetchFutures()).payload;
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
    // De onde e quando vieram os dados (aparece nas tooltips da página).
    tfFetchedAt: await getMetaJson('tf_fetched_at'),
    omieEmitted: await getMetaJson('omie_emitted'),
  };
  if (persist) await setMetaJson('stats', payload);
  return { daily: daily.length, stats: payload };
}

// ------------------------------------------------------------- freshness

// true se a omie_spot já tem alguma linha.
async function hasData() {
  const rows = await query('SELECT 1 FROM omie_spot LIMIT 1');
  return rows.length > 0;
}

// Espera (até `timeoutMs`) que outra instância encha a BD. Usa-se quando a
// BD está vazia e o lock é de outro.
async function waitForData(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    if (await hasData()) return true;
  }
  return false;
}

// Garante dados frescos (vê o cabeçalho). Com `wait: true` espera sempre
// pela actualização em vez de a deixar em segundo plano.
export async function ensureFresh({ wait = false } = {}) {
  if (READONLY) return { fresh: true, readonly: true };
  const last = Number(await getMeta('last_refresh') || 0);
  const age = Date.now() - last;
  if (last && age < TTL_MS) return { fresh: true, age };

  const empty = !(await hasData());
  const token = await acquireLock();
  if (!token) {
    // Outra instância está a actualizar. Só esperas por ela se a BD estiver vazia.
    if (empty) await waitForData();
    return { fresh: false, locked: true };
  }

  const refresh = refreshAll()
    .catch(e => ({ ok: false, error: e.message }))
    .finally(() => releaseLock(token));

  if (wait || empty) {
    await refresh;
    return { fresh: true, waited: true };
  }
  refresh.catch(() => {});
  return { fresh: false, started: true };
}

// ---------------------------------------------------------------- leitura

// GET /v1/omie/daily: os últimos `days` resumos diários.
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
      // `complete`: o dia tem todos os quartos. Amanhã, à tarde, ainda não
      // tem: as 23:00–24:00 de Lisboa pertencem ao dia de mercado seguinte
      // (o de Madrid começa uma hora antes), que só sai no outro dia. Uma
      // média sem essa hora não serve de referência.
      quarters: r.quarters,
      complete: r.quarters != null && r.quarters >= expectedQuartersForLisbonDay(String(r.date).slice(0, 10)),
    })),
  };
}

// Os quartos de hora de um dia de Lisboa (para o comparador), mais a lista
// de dias à volta para o selector.
export async function getQuarters(lisDay) {
  await ensureFresh();
  const rows = await spotForDay(lisDay);
  if (!rows.length) throw new Error(`sem quartos para ${lisDay}`);
  const days = await recentDays(lisDay, 10);
  return { date: lisDay, rows, days };
}

// Em readonly, o payload das estatísticas fica aqui em vez de na BD.
let memStats = null;

// GET /v1/omie/stats: o payload da página de estatísticas.
//
// Três coisas podem deixá-lo desactualizado, e cada uma tem o seu remédio:
//   - os dados: ensureFresh() actualiza ao fim de 1 hora;
//   - o dia: se o payload foi calculado noutro dia de Lisboa, os cartões
//     "hoje"/"amanhã" estão errados e recalcula-se já, a partir da BD;
//   - o quarto de hora: o preço "agora" (currentPrice) calcula-se a cada pedido.
// `stale: true` avisa a página de que há uma actualização a correr.
export async function getStats({ now = new Date() } = {}) {
  let payload = READONLY ? memStats : await getMetaJson('stats');
  const st = await ensureFresh({ wait: !payload });
  if (!READONLY && !payload) payload = await getMetaJson('stats');
  const sameDay = payload && payload.generatedAt && civilDay(new Date(payload.generatedAt)) === civilDay(now);
  // Em readonly ninguém o renova, por isso recalcula-se também ao fim de 1 hora.
  const roStale = READONLY && payload && now - new Date(payload.generatedAt) > TTL_MS;
  if (!sameDay || roStale) {
    try {
      const r = await rebuildDerived({ now });
      if (r.stats) payload = r.stats;
      if (READONLY) memStats = payload;
    } catch (e) {
      // Se o recálculo falhar mas houver um payload antigo, serve-se esse.
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

// Vai buscar o ficheiro de futuros do TF (com a cache em disco de tf.js) e
// monta o payload de /v1/omie/futures. Devolve também o texto, de onde a
// actualização tira o último dia de mercado.
async function fetchFutures() {
  const { text } = await fetchCachedFile('tf-futuros.csv', TF_FUTURES_URL, TTL_FUTURES);
  return {
    text,
    payload: {
      fetchedAt: Date.now(),
      source: `OMIP via ${TF_SOURCE}`,
      rows: parseTfFutures(text),
      daily: parseTfDailyFutures(text),
    },
  };
}

// GET /v1/omie/futures: os contratos de futuros do OMIP.
export async function getFutures() {
  const cached = await getMetaJson('futures');
  if (cached && Date.now() - (cached.fetchedAt || 0) < TTL_FUTURES) return cached;
  const { payload } = await fetchFutures();
  if (!READONLY) await setMetaJson('futures', payload);
  return payload;
}

// ------------------------------------------------------------------ util

// Resumo do estado da ingestão, para logs e diagnóstico.
export async function status() {
  return {
    lastRefresh: await getMeta('last_refresh_at'),
    etag: await getMeta('omie_etag'),
    emitted: await getMetaJson('omie_emitted'),
    days: (await dailyRows(400)).length,
  };
}
