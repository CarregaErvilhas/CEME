// Onde os preços do OMIE ficam guardados: as tabelas omie_spot, omie_daily
// e omie_meta (vê os comentários no schema).
//
// Ficam na BD, e não em ficheiros, porque a BD sobrevive a deploys e é
// partilhada por todas as instâncias do servidor.
//
// Cada fonte (omie.es e TF) escreve as suas próprias linhas; a chave é
// (instante UTC, fonte). Juntar as duas faz-se só na leitura, em
// reconcile(): o preço vem do omie.es quando existe, senão do TF; a
// classificação vazio/fora de vazio vem do TF.
import { run, query, get } from '../db.js';
import { periodForRegion } from '../engine/regions.js';
import { shiftDays } from '../time.js';

// Quantos dias antes do último são reescritos em cada actualização (é onde
// o OMIE ainda pode corrigir valores).
const RECENT_DAYS = 3;

// Linhas por INSERT. Cada linha usa até 10 parâmetros e o Postgres aceita
// no máximo 65535 por query.
const BATCH = 400;

// Monta o VALUES de um INSERT com várias linhas: para [[a, b], [c, d]] dá
// tuples = '($1,$2),($3,$4)' e values = [a, b, c, d].
function multiValues(rows) {
  const values = [];
  const tuples = rows.map(row => {
    const first = values.length + 1;
    values.push(...row);
    return `(${row.map((_, j) => `$${first + j}`).join(',')})`;
  }).join(',');
  return { tuples, values };
}

// ------------------------------------------------------------------ meta
// omie_meta é uma tabela chave → valor (texto). As versões *Json fazem o
// JSON.parse/stringify por ti.

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

// Os dias de Lisboa que já têm linhas desta fonte.
async function knownDays(source) {
  const rows = await query('SELECT DISTINCT day_lisbon FROM omie_spot WHERE source = $1', [source]);
  return new Set(rows.map(r => String(r.day_lisbon).slice(0, 10)));
}

// Grava linhas na omie_spot (upsert: repetir com os mesmos dados não muda
// nada). Devolve quantas linhas escreveu.
//
// Para poupar trabalho, só escreve:
//   - os dias que ainda não estão na tabela; e
//   - os dias dentro de uma janela que a fonte ainda pode rever. Por omissão
//     é [último dia do lote − recentDays, último dia]. Podes passar outra
//     com `fromDay`/`toDay`; o TF precisa disso, porque o ficheiro dele vai
//     até ao fim do ano e os dias que ele revê são os próximos de hoje.
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
  const days = [...byDay.keys()].filter(d => !known.has(d) || (from && to && d >= from && d <= to));
  if (!days.length) return 0;

  let written = 0;
  for (const day of days) {
    const list = byDay.get(day);
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const { tuples, values } = multiValues(chunk.map(r =>
        [r.utc, r.day, r.min, r.pt, r.es ?? null, r.bd ?? null, r.bs ?? null, source, r.flags ? JSON.stringify(r.flags) : null]));
      await run(
        `INSERT INTO omie_spot
           (ts_utc, day_lisbon, min_lisbon, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags)
         VALUES ${tuples}
         ON CONFLICT (ts_utc, source) DO UPDATE SET
           day_lisbon = EXCLUDED.day_lisbon,
           min_lisbon = EXCLUDED.min_lisbon,
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

// As linhas de um dia civil de Lisboa, das duas fontes, reconciliadas.
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

// As linhas de um dia de Lisboa, já reconciliadas.
export async function spotForDay(lisDay) {
  const rows = await query(
    `SELECT ts_utc, day_lisbon, min_lisbon, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags
       FROM omie_spot WHERE day_lisbon = $1 ORDER BY ts_utc`,
    [lisDay]
  );
  return reconcile(rows, { lastOmie: await lastOmieInstant() });
}

// As linhas de um intervalo de dias de Lisboa (inclusive), reconciliadas.
export async function spotBetween(fromDay, toDay) {
  const rows = await query(
    `SELECT ts_utc, day_lisbon, min_lisbon, price_pt_eur_mwh, price_es_eur_mwh, bd, bs, source, flags
       FROM omie_spot WHERE day_lisbon >= $1 AND day_lisbon <= $2 ORDER BY ts_utc`,
    [fromDay, toDay]
  );
  return reconcile(rows, { lastOmie: await lastOmieInstant() });
}

// Junta as linhas das duas fontes numa só por instante:
//   { utc, day, min, pt, es, bd, bs, src, flags, est? }
//   src: de onde veio o preço ('OMIE_ES' ou 'TF');
//   est: true se é uma estimativa (só TF, depois do último instante oficial).
// Faz-se em JS e não em SQL para ser igual em SQLite e Postgres.
// `opts.lastOmie` é o último instante oficial; se não vier, deduz-se das
// linhas (o que falha quando o lote só tem linhas do TF).
export function reconcile(rows, opts = {}) {
  const byUtc = new Map();
  for (const r of rows) {
    const utc = String(r.ts_utc);
    const day = String(r.day_lisbon).slice(0, 10);
    const item = byUtc.get(utc) || { utc, day, min: r.min_lisbon, pt: null, es: null, bd: null, bs: null, src: null, flags: null };
    if (r.source === 'OMIE_ES') {
      item.pt = r.price_pt_eur_mwh;
      if (r.price_es_eur_mwh != null) item.es = r.price_es_eur_mwh;
      item.src = 'OMIE_ES';
      if (r.flags) { try { item.flags = JSON.parse(r.flags); } catch { item.flags = null; } }
    } else {
      // TF: o preço só conta se o omie.es não tiver este instante.
      if (item.pt == null) item.pt = r.price_pt_eur_mwh;
      if (item.es == null && r.price_es_eur_mwh != null) item.es = r.price_es_eur_mwh;
      item.bd = r.bd;
      item.bs = r.bs;
      if (!item.src) item.src = 'TF';
    }
    byUtc.set(utc, item);
  }
  const out = [...byUtc.values()].sort((a, b) => (a.utc < b.utc ? -1 : 1));
  let lastOmie = (opts && opts.lastOmie) || null;
  if (!lastOmie) {
    for (const r of rows) if (r.source === 'OMIE_ES' && (!lastOmie || String(r.ts_utc) > lastOmie)) lastOmie = String(r.ts_utc);
  }
  for (const item of out) {
    if (item.src !== 'OMIE_ES' && lastOmie && item.utc > lastOmie) item.est = true;
    // Sem classificação do TF, calcula-se com as regras do motor (regions.js).
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

// Grava os resumos diários (um upsert por dia, BATCH dias por INSERT).
export async function upsertDaily(rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { tuples, values } = multiValues(rows.slice(i, i + BATCH).map(r =>
      [r.date, r.avg_pt ?? null, r.min_pt ?? null, r.max_pt ?? null,
       r.bd_v ?? null, r.bd_f ?? null, r.bs_v ?? null, r.bs_f ?? null,
       r.quarters ?? null, r.source ?? null]));
    await run(
      `INSERT INTO omie_daily (date, avg_pt, min_pt, max_pt, bd_v, bd_f, bs_v, bs_f, quarters, source)
       VALUES ${tuples}
       ON CONFLICT (date) DO UPDATE SET
         avg_pt = EXCLUDED.avg_pt, min_pt = EXCLUDED.min_pt, max_pt = EXCLUDED.max_pt,
         bd_v = EXCLUDED.bd_v, bd_f = EXCLUDED.bd_f,
         bs_v = EXCLUDED.bs_v, bs_f = EXCLUDED.bs_f,
         quarters = EXCLUDED.quarters, source = EXCLUDED.source`,
      values
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

// O primeiro e o último dia que há na omie_spot.
export async function spotRange() {
  // "from" e "to" são palavras reservadas em SQL, daí as aspas.
  const rows = await query('SELECT MIN(day_lisbon) AS "from", MAX(day_lisbon) AS "to" FROM omie_spot');
  const r = rows[0] || {};
  return {
    from: r.from ? String(r.from).slice(0, 10) : null,
    to: r.to ? String(r.to).slice(0, 10) : null,
  };
}

// O último dia de Lisboa com preço oficial (omie.es).
export async function lastMarketDay() {
  const rows = await query(`SELECT MAX(day_lisbon) AS d FROM omie_spot WHERE source = 'OMIE_ES'`);
  const d = rows[0] && rows[0].d;
  return d ? String(d).slice(0, 10) : null;
}

// Até `n` dias com dados à volta de `fromDay` (para o selector de dias):
// cerca de metade para trás e o resto para a frente, incluindo `fromDay`.
export async function recentDays(fromDay, n = 10) {
  const before = Math.floor(n / 2);
  const back = await query(
    `SELECT DISTINCT day_lisbon FROM omie_spot WHERE day_lisbon < $1 ORDER BY day_lisbon DESC LIMIT $2`,
    [fromDay, before]
  );
  const fwd = await query(
    `SELECT DISTINCT day_lisbon FROM omie_spot WHERE day_lisbon >= $1 ORDER BY day_lisbon LIMIT $2`,
    [fromDay, n - back.length]
  );
  // Se não houver dias suficientes à frente, vai buscar mais para trás.
  const extra = n - back.length - fwd.length;
  const more = extra > 0 && back.length === before
    ? await query(
      `SELECT DISTINCT day_lisbon FROM omie_spot WHERE day_lisbon < $1 ORDER BY day_lisbon DESC LIMIT $2`,
      [fromDay, before + extra]
    )
    : back;
  return [...more.reverse(), ...fwd].map(r => String(r.day_lisbon).slice(0, 10));
}
