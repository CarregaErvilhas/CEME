// Ingestão directa do omie.es — a fonte PRIMÁRIA dos preços.
//
// Ficheiro: o dump acumulado público (12 meses de quartos-horários, ~2,8 MB).
// A OMIE publica o dia D+1 por volta das 13:00 (hora de Lisboa); o ficheiro
// traz o cabeçalho "Fecha Emisión" com a hora de emissão.
//
// O pedido é CONDICIONAL (If-None-Match / If-Modified-Since): enquanto o
// ficheiro não muda, a resposta é um 304 sem corpo e não se gasta rede. É o
// que permite ter o omie.es como fonte primária sem puxar 2,8 MB de duas em
// duas horas.
//
// O dump é em latin1 (`;` como separador, vírgula decimal) — ver o parser
// defensivo em `parse.js` e a conversão de fuso em `convert.js`.
import { parseOmieTxt, assessDays } from './parse.js';
import { marketPeriodToLisbon, lisbonWallClock, expectedQuartersForLisbonDay } from './convert.js';

export const OMIE_URL = 'https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT';
export const OMIE_SOURCE = 'omie.es';
export const OMIE_LABEL = 'omie.es (OMIE/MIBEL)';

const UA = 'ceme-v2 (omie ingestion)';
const TIMEOUT_MS = 60000;
const MIN_BYTES = 100000; // o dump real é de ~2,8 MB; abaixo disso é erro

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET condicional. Devolve { changed:false } se o ficheiro não mudou.
export async function fetchOmieDump(state = {}) {
  const headers = { 'user-agent': UA };
  if (state.etag) headers['if-none-match'] = state.etag;
  if (state.lastModified) headers['if-modified-since'] = state.lastModified;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const res = await fetch(OMIE_URL, { signal: ctl.signal, headers });
      clearTimeout(timer);
      if (res.status === 304) return { changed: false, etag: state.etag || null, lastModified: state.lastModified || null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES) throw new Error(`corpo suspeito (${buf.length} bytes)`);
      return {
        changed: true,
        // latin1: o mapeamento é byte-a-byte, por isso os acentos não
        // estragam nada e os números ficam intactos.
        text: buf.toString('latin1'),
        bytes: buf.length,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastErr || new Error('falha desconhecida ao ir buscar o omie.es');
}

// "Fecha Emisión :21/10/2026 - 13:57" — a hora a que a OMIE emitiu o
// ficheiro. Em latin1 o "ó" não é legível como tal, por isso o regex é
// tolerante.
export function parseEmitted(text) {
  const m = /Fecha\s+Emisi.{1,3}n\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})/i.exec(String(text || ''));
  if (!m) return null;
  return {
    date: `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`,
    time: `${m[4]}:${m[5]}`,
  };
}

// O dump em linhas comuns, agrupadas por dia de LISBOA.
//
// Cada linha:
//   { utc, day, min, pt, es, flags, marketDay, p }
//  - utc: o instante absoluto (a chave de tudo);
//  - day/min: o mesmo instante em hora de Lisboa (o dia civil e os minutos
//    desde a meia-noite) — é o que se mostra ao utilizador;
//  - marketDay/p: o dia de MERCADO e o período dentro dele, que é como o
//    ficheiro oficial vem (o dia de mercado corre 00:00-24:00 em Madrid) e
//    que serve de auditoria.
export function parseOmieDump(text) {
  const { rows, quarantined, warnings } = parseOmieTxt(text);
  const days = new Map();
  for (const r of rows) {
    const conv = marketPeriodToLisbon(r.marketDay, r.marketPeriod);
    if (conv.error) {
      quarantined.push({ line: null, reason: conv.error, text: `${r.marketDay}:${r.marketPeriod}` });
      continue;
    }
    const wall = lisbonWallClock(Date.parse(conv.utc));
    const row = {
      utc: conv.utc,
      day: wall.day,
      min: wall.minutes,
      pt: r.pricePt,
      es: r.priceEs,
      flags: r.flags && r.flags.length ? r.flags : undefined,
      marketDay: r.marketDay,
      p: r.marketPeriod,
    };
    if (!days.has(row.day)) days.set(row.day, []);
    days.get(row.day).push(row);
  }
  for (const list of days.values()) list.sort((a, b) => (a.utc < b.utc ? -1 : 1));
  // Os dias incompletos (faltam períodos): o dump é rolante e às vezes
  // apanha o dia a meio. Ficam marcados — não se deita nada fora.
  const assessed = assessDays(
    rows.map(r => ({ marketDay: r.marketDay, marketPeriod: r.marketPeriod })),
    day => expectedQuartersForLisbonDay(day)
  );
  const partial = assessed.filter(d => d.status === 'PARTIAL').map(d => ({ day: d.day, count: d.count, missing: d.missing.length }));
  return {
    days,
    quarantined,
    warnings,
    emitted: parseEmitted(text),
    quarters: rows.length,
    partial,
  };
}
