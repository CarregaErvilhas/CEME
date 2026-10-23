// O store do OMIE: os quartos-horários e os agregados, na base de dados.
//
// Porquê na BD e não em ficheiros no contentor: a BD é gerida, persiste
// entre deploys e é partilhada por todas as réplicas. Com ficheiros, cada
// réplica tinha a sua cópia e um deploy deitava tudo fora.
//
// A chave de tudo é o INSTANTE em UTC (`ts_utc`). Nunca a hora local: na
// mudança de hora de Outono a hora de relógio repete-se, e o instante é a
// única coisa que não se repete.
//
// As duas fontes (omie.es e TF) escrevem linhas separadas — a chave
// primária é (instante, fonte) — e a reconciliação acontece na leitura: o
// preço do omie.es quando existe, o do TF quando não; a classificação do
// período (BD/BS) vem do TF, que é quem a calcula.
import { run, query, get } from '../db.js';
import { periodForRegion } from '../engine/regions.js';

// Quantos dias à frente do último são reescritos em cada refresh: é onde
// o OMIE pode corrigir o dia anterior.
const RECENT_DAYS = 3;

const BATCH = 400; // linhas por INSERT (o limite de parâmetros do pg é 65535)

// ------------------------------------------------------------------ meta

export async function getMeta(key) {
  const row = await get('SELECT value FROM omie_meta WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  await run(
    `INSERT INTO omie_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

export async function getMetaJson(key) {
  const raw = await getMeta(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setMetaJson(key, value) {
  await setMeta(key, JSON.stringify(value));
}

// ------------------------------------------------------------------ spot

// Os dias (UTC) que já estão na tabela, para uma fonte.
async function knownDays(source) {
  const rows = await query('SELECT DISTINCT day_utc FROM omie_spot WHERE source = $1', [source]);
  return new Set(rows.map(r => String(r.day_utc).slice(0, 10)));
}

// Escreve as linhas de um dia (ou de vários) — upsert idempotente: correr
// duas vezes com os mesmos dados não muda nada.
//
// Por omissão reescrevem-se os dias em falta e os `recentDays` antes do dia
// mais recente do lote (é onde o OMIE pode ter corrigido). Para o TF passa-se
// uma janela explícita (`fromDay`/`toDay`, dias civis de Lisboa): o ficheiro
// do TF vai até ao fim do ano, por isso "os últimos dias do lote" seriam
// Dezembro — e as revisões dos dias recentes (reais que substituem
// estimativas, estimativas revistas) nunca mais eram escritas depois da
// primeira ingestão.
export async function upsertSpot(rows, source, { recentDays = RECENT_DAYS, maxDay = null, fromDay = null, toDay = null } = {}) {
  if (!rows.length) return 0;
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const known = await knownDays(source);
  const last = maxDay || [...byDay.keys()].sort().pop();
  const from = fromDay || (last ? shiftDays(last, -recentDays) : null);
  const to = toDay || last;
  // Escreve os dias que faltam e os dias dentro da janela (os que o upstream
  // ainda pode rever). O resto do histórico já está lá e não muda.
  const days = [...byDay.keys()].filter(d => !known.has(d) || (from && to && d >= from && d <= to));
  if (!days.length) return 0;

  let written = 0;
  for (const day of days) {
    const list = byDay.get(day);
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const values = [];
      const tuples = chunk.map(r => {
        const p = values.length;
        values.push(r.utc, r.day, r.min, r.pt, r.es ?? null, r.bd ?? null, r.bs ?? null, source, r.flags ? JSON.stringify(r.flags) : null);
        return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9})`;
      });
      await run(
        `INSERT INTO omie_spot
           (ts_utc, day_utc, min_utc, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags)
         VALUES ${tuples.join(',')}
         ON CONFLICT (ts_utc, source) DO UPDATE SET
           day_utc = EXCLUDED.day_utc,
           min_utc = EXCLUDED.min_utc,
           price_pt_eur_mwh = EXCLUDED.price_pt_eur_mwh,
           price_es_eur_mwh = EXCLUDED.price_es_eur_mwh,
           bd = EXCLUDED.bd,
           bs = EXCLUDED.bs,
           flags = EXCLUDED.flags,
           ingested_at = CURRENT_TIMESTAMP`,
        values
      );
      written += chunk.length;
    }
  }
  return written;
}

// As linhas de um dia (UTC), das duas fontes, reconciliadas.
//
// O omie.es manda no preço; o TF traz a classificação BD/BS e cobre os
// buracos. `est` marca as linhas que são estimativa OMIP (o TF vai mais
// longe do que o mercado já publicado).
// O último instante publicado pelo omie.es: a fronteira do mercado.
// Guarda-se à parte porque nas leituras de um só dia pode não haver linhas
// do omie.es no lote para a deduzir (ver `reconcile`).
export async function lastOmieInstant() {
  const rows = await query(`SELECT MAX(ts_utc) AS m FROM omie_spot WHERE source = 'OMIE_ES'`);
  const m = rows[0] && rows[0].m;
  return m ? String(m) : null;
}

export async function spotForDay(dayUtc) {
  const rows = await query(
    `SELECT ts_utc, day_utc, min_utc, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags
       FROM omie_spot WHERE day_utc = $1 ORDER BY ts_utc`,
    [dayUtc]
  );
  return reconcile(rows, { lastOmie: await lastOmieInstant() });
}

// As linhas de um intervalo de dias (inclusive), reconciliadas.
export async function spotBetween(fromUtc, toUtc) {
  const rows = await query(
    `SELECT ts_utc, day_utc, min_utc, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags
       FROM omie_spot WHERE day_utc >= $1 AND day_utc <= $2 ORDER BY ts_utc`,
    [fromUtc, toUtc]
  );
  return reconcile(rows, { lastOmie: await lastOmieInstant() });
}

// Reconcilia as linhas das duas fontes (o JS, para ser igual nos dois
// dialects de BD).
export function reconcile(rows, opts = {}) {
  const byUtc = new Map();
  for (const r of rows) {
    const utc = String(r.ts_utc);
    const day = String(r.day_utc).slice(0, 10);
    const item = byUtc.get(utc) || { utc, day, min: r.min_utc, pt: null, es: null, bd: null, bs: null, src: null, flags: null };
    if (r.source === 'OMIE_ES') {
      item.pt = r.price_pt_eur_mwh;
      if (r.price_es_eur_mwh != null) item.es = r.price_es_eur_mwh;
      item.src = 'OMIE_ES';
      if (r.flags) { try { item.flags = JSON.parse(r.flags); } catch { item.flags = null; } }
    } else {
      // TF: o preço só entra se o omie.es não trouxer o mesmo instante.
      if (item.pt == null) item.pt = r.price_pt_eur_mwh;
      if (item.es == null && r.price_es_eur_mwh != null) item.es = r.price_es_eur_mwh;
      item.bd = r.bd;
      item.bs = r.bs;
      if (!item.src) item.src = 'TF';
    }
    byUtc.set(utc, item);
  }
  const out = [...byUtc.values()].sort((a, b) => (a.utc < b.utc ? -1 : 1));
  // A fronteira do mercado: o último instante que o omie.es trouxe. O que
  // estiver para além e só existir no TF é estimativa, não preço.
  // Aceita-se a fronteira explícita (`opts.lastOmie`): nas leituras de um só
  // dia (ex. um dia futuro só com linhas do TF) não há linhas do omie.es no
  // lote para deduzir a fronteira, e sem ela nada era marcado como estimativa.
  let lastOmie = (opts && opts.lastOmie) || null;
  if (!lastOmie) {
    for (const r of rows) if (r.source === 'OMIE_ES' && (!lastOmie || String(r.ts_utc) > lastOmie)) lastOmie = String(r.ts_utc);
  }
  for (const item of out) {
    if (item.src !== 'OMIE_ES' && lastOmie && item.utc > lastOmie) item.est = true;
    // A classificação do período horário: a do TF quando há (o TF aplica as
    // regras da ERSE); senão, as do motor, calculadas a partir do instante.
    if (!item.bd || !item.bs) {
      const at = new Date(item.utc);
      const dia = periodForRegion({ region: 'CONT', schedule: 'BI_HORARIA', cycle: 'DIARIO', at });
      const sem = periodForRegion({ region: 'CONT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at });
      item.bd = item.bd || (dia === 'FORA_VAZIO' ? 'F' : 'V');
      item.bs = item.bs || (sem === 'FORA_VAZIO' ? 'F' : 'V');
    }
  }
  return out;
}

// ---------------------------------------------------------------- daily

export async function upsertDaily(rows) {
  for (const r of rows) {
    await run(
      `INSERT INTO omie_daily (date, avg_pt, min_pt, max_pt, bd_v, bd_f, bs_v, bs_f, quarters, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (date) DO UPDATE SET
         avg_pt = EXCLUDED.avg_pt, min_pt = EXCLUDED.min_pt, max_pt = EXCLUDED.max_pt,
         bd_v = EXCLUDED.bd_v, bd_f = EXCLUDED.bd_f,
         bs_v = EXCLUDED.bs_v, bs_f = EXCLUDED.bs_f,
         quarters = EXCLUDED.quarters, source = EXCLUDED.source`,
      [r.date, r.avg_pt ?? null, r.min_pt ?? null, r.max_pt ?? null,
       r.bd_v ?? null, r.bd_f ?? null, r.bs_v ?? null, r.bs_f ?? null,
       r.quarters ?? null, r.source ?? null]
    );
  }
  return rows.length;
}

// Os agregados diários, dos mais recentes para os mais antigos.
export async function dailyRows(days) {
  const rows = await query(
    `SELECT date, avg_pt, min_pt, max_pt, bd_v, bd_f, bs_v, bs_f, quarters, source
       FROM omie_daily ORDER BY date DESC LIMIT $1`,
    [days]
  );
  return rows.reverse();
}

// O intervalo de dias que há na tabela.
export async function spotRange() {
  // "from"/"to" são palavras reservadas em SQL — o alias vai entre aspas.
  const rows = await query('SELECT MIN(day_utc) AS "from", MAX(day_utc) AS "to" FROM omie_spot');
  const r = rows[0] || {};
  return {
    from: r.from ? String(r.from).slice(0, 10) : null,
    to: r.to ? String(r.to).slice(0, 10) : null,
  };
}

// O último dia com preço publicado (o omie.es).
export async function lastMarketDay() {
  const rows = await query(`SELECT MAX(day_utc) AS d FROM omie_spot WHERE source = 'OMIE_ES'`);
  const d = rows[0] && rows[0].d;
  return d ? String(d).slice(0, 10) : null;
}

// Os dias disponíveis a partir de um dia (para o seletor de dias).
export async function recentDays(fromUtc, n = 10) {
  const rows = await query(
    `SELECT DISTINCT day_utc FROM omie_spot WHERE day_utc >= $1 ORDER BY day_utc LIMIT $2`,
    [fromUtc, n]
  );
  return rows.map(r => String(r.day_utc).slice(0, 10));
}

// ----------------------------------------------------------------- util

// Uma data ISO, deslocada em dias.
export function shiftDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-${String(nd.getUTCDate()).padStart(2, '0')}`;
}
