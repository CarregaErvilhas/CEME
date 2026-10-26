// Vai buscar os preços ao omie.es, a fonte OFICIAL e principal.
//
// O OMIE (Operador do Mercado Ibérico de Energia) é quem gere o mercado
// grossista de electricidade de Portugal e Espanha (o MIBEL). Todos os dias,
// por volta das 13:00 de Lisboa, publica os preços de cada quarto de hora do
// dia seguinte. Um ficheiro público acumula os últimos ~12 meses (~2,8 MB).
//
// Para não descarregares 2,8 MB a cada actualização, o pedido é
// CONDICIONAL: mandas o ETag / Last-Modified da última vez e, se o ficheiro
// não mudou, o servidor responde 304 sem corpo.
//
// O ficheiro vem em latin1, com `;` e vírgula decimal. A leitura das linhas
// está em parse.js e as contas de fuso em convert.js.
import { fetchWithRetry } from './fetch.js';
import { parseOmieTxt, assessDays } from './parse.js';
import { marketPeriodToLisbon, lisbonWallClock, expectedQuartersForLisbonDay } from './convert.js';

export const OMIE_URL = 'https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT';
export const OMIE_SOURCE = 'omie.es';
export const OMIE_LABEL = 'omie.es (OMIE/MIBEL)';

const UA = 'ceme-v2 (omie ingestion)';
const TIMEOUT_MS = 60000;
// Abaixo disto o corpo não é o ficheiro (é, por exemplo, uma página de erro
// servida com 200).
const MIN_BYTES = 100000;

// Descarrega o ficheiro, até 3 tentativas. `state` traz o etag/lastModified
// da última vez. Devolve { changed: false } se não mudou, ou
// { changed: true, text, bytes, etag, lastModified }.
export async function fetchOmieDump(state = {}) {
  const headers = { 'user-agent': UA };
  if (state.etag) headers['if-none-match'] = state.etag;
  if (state.lastModified) headers['if-modified-since'] = state.lastModified;

  return fetchWithRetry(OMIE_URL, {
    headers,
    timeoutMs: TIMEOUT_MS,
    read: async (res) => {
      if (res.status === 304) return { changed: false, etag: state.etag || null, lastModified: state.lastModified || null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES) throw new Error(`corpo suspeito (${buf.length} bytes)`);
      return {
        changed: true,
        // latin1 é a codificação do ficheiro (um byte por carácter).
        text: buf.toString('latin1'),
        bytes: buf.length,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      };
    },
  });
}

// Lê a linha "Fecha Emisión :21/10/2026 - 13:57" (quando a OMIE gerou o
// ficheiro). O regex aceita qualquer coisa no lugar do "ó", que pode vir
// mal codificado.
export function parseEmitted(text) {
  const m = /Fecha\s+Emisi.{1,3}n\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})/i.exec(String(text || ''));
  if (!m) return null;
  return {
    date: `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`,
    time: `${m[4]}:${m[5]}`,
  };
}

// Converte o ficheiro em linhas prontas a guardar, agrupadas por dia de
// Lisboa. Cada linha:
//   { utc, day, min, pt, es, flags, marketDay, p }
//   utc:        o instante de início do quarto (ISO, UTC);
//   day, min:   o dia de Lisboa e os minutos desde a meia-noite;
//   pt, es:     preço em Portugal e em Espanha, €/MWh;
//   marketDay, p: o dia de mercado (Madrid) e o período, tal como no ficheiro.
// Devolve também `partial`: os dias a que faltam períodos (marcados, nunca
// deitados fora).
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
