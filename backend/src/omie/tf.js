// Fonte SECUNDÁRIA: os ficheiros do Tiago Felícia (CC BY 4.0).
//
// O TF republica os preços do OMIE/MIBEL e acrescenta duas coisas que o
// omie.es não dá: a classificação do período horário (BD/BS, as regras da
// ERSE) e as datas futuras estimadas a partir dos futuros OMIP. Por isso
// continua a ser lido — mas como COMPLEMENTO do omie.es, e não como fonte
// primária.
//
// A grande diferença em relação ao código anterior é o CACHE EM DISCO dos
// ficheiros: cada CSV é guardado em `backend/data/` e só é re-baixado quando
// envelhece. Antes, o ficheiro do ano corrente (1,8 MB) e o do ano anterior
// (1,9 MB) eram re-baixados de duas em duas horas, só para se extrair a
// mesma informação — dezenas de MB por dia para dados que mudam uma vez.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lisbonMidnightUtc, lisbonWallClock } from './convert.js';

// O cache em disco dos ficheiros grandes. Vive em `backend/data/` (que não
// é versionado) e é descartável: o que interessa está na BD.
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export const TF_BASE = 'https://dados.tiagofelicia.pt/data';
export const TF_CURRENT_URL = `${TF_BASE}/omie/omie_dados_atuais.csv`;
export const TF_HISTORY_URL = (year) => `${TF_BASE}/omie/historico/omie_historico_${year}.csv`;
export const TF_FUTURES_URL = `${TF_BASE}/omie/futuros_omip.csv`;
export const TF_DAILY_URL = `${TF_BASE}/agregados/omie_diario.csv`;
export const TF_SOURCE = 'dados.tiagofelicia.pt (CC BY 4.0)';

// TTLs: o que muda uma vez por dia não se re-baixam de duas em duas horas.
export const TTL_DAILY = 24 * 3600 * 1000;   // ficheiros do dia corrente
export const TTL_HISTORY = 30 * 24 * 3600 * 1000; // histórico: muda uma vez por ano
export const TTL_FUTURES = 6 * 3600 * 1000;  // futuros: mudam com o mercado

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET com retry (o que o cache.js já fazia) — o texto vem em UTF-8.
export async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'ceme-v2' } });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      if (txt.includes('Page not found')) throw new Error('404 upstream');
      if (txt.length < 1000) throw new Error('corpo suspeito (<1KB)');
      return txt;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

// Ficheiro em disco, com a idade a contar. Se ainda estiver fresco, não há
// rede nenhuma — é isto que corta o re-baixamento constante dos CSVs grandes.
//
// Este cache é POR RÉPLICA (é o disco do contentor): cada uma baixa o
// ficheiro uma vez e usa-o a partir daí. O que fica na BD é o que interessa
// — e essa é partilhada.
export async function fetchCachedFile(name, url, ttlMs) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  if (existsSync(file)) {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) {
      return { text: readFileSync(file, 'utf8'), cached: true, fetchedAt: st.mtimeMs, file };
    }
  }
  const text = await fetchText(url);
  try { writeFileSync(file, text); } catch { /* cache é opcional */ }
  return { text, cached: false, fetchedAt: Date.now(), file };
}

// Os quartos-horários do TF, em linhas comuns, agrupados por dia de LISBOA.
//
// O ficheiro está em HORA DE LISBOA (e não em CET): o dia "20/10/2026" são
// as 96 quartos de 00:00 a 23:45 *de Lisboa*, e a média desse dia bate
// com o agregado diário que o TF publica para a mesma data. (O dia de
// mercado do OMIE é o de Madrid — uma hora à frente — e por isso os dois
// ficheiros estão desfasados uma hora; alinham-se pelo INSTANTE, não pelo
// período.)
//
// Cada linha:
//   { utc, day, min, pt, es, bd, bs }
//  - utc: o instante absoluto — a chave que alinha com o omie.es;
//  - day/min: o dia civil de Lisboa e os minutos desde a meia-noite local;
//  - bd/bs: a classificação do período horário (as regras da ERSE), que o
//    omie.es não traz.
export function parseTfQuarters(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',').map(h => h.trim());
  const ix = (n) => head.indexOf(n);
  if (ix('dia') < 0 || ix('preco_pt') < 0) throw new Error('schema inesperado no CSV de quartos do TF');
  const days = new Map();
  const quarantined = [];
  // Estado por dia para a conversão hora→instante (ver abaixo): vai à parte
  // para não poluir o mapa de dias devolvido.
  const effState = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('TABELA_')) break; // blocos de futuros no fim do ficheiro
    const c = line.split(',');
    if (c.length < 9) { quarantined.push({ reason: 'few_columns', text: line.slice(0, 140) }); continue; }
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((c[ix('dia')] || '').trim());
    if (!dm) { quarantined.push({ reason: 'bad_day', text: line.slice(0, 140) }); continue; }
    const pt = Number(c[ix('preco_pt')]);
    if (!Number.isFinite(pt)) { quarantined.push({ reason: 'bad_price', text: line.slice(0, 140) }); continue; }
    const day = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;

    const list = days.get(day) || [];
    // O instante a partir da coluna `hora` (o FIM do quarto, "00:15" =
    // [00:00-00:15[), e não da posição da linha no ficheiro: se faltar uma
    // linha a meio do dia, a posição deslocava todos os instantes seguintes
    // em 15 minutos sem ninguém dar por isso.
    //
    // Mas a hora de relógio não chega sozinha: no dia de Outono a hora
    // 01:00-02:00 acontece duas vezes (o ficheiro traz 100 linhas com as
    // horas repetidas) e a ordem das linhas é o que distingue a primeira
    // passagem da segunda. Por isso soma-se +60 min a partir do momento em
    // que o relógio anda para trás — sem isto as duas passagens colidiam no
    // mesmo instante e uma delas perdia-se no upsert.
    const st = effState.get(day) || { prevEff: null, extra: 0 };
    const prevEff = st.prevEff;
    let extra = st.extra;
    let eff;
    const hm = /^(\d{2}):(\d{2})$/.exec((c[1] || '').trim());
    if (hm) {
      const s = Number(hm[1]) * 60 + Number(hm[2]) - 15;
      if (Number.isInteger(s) && s >= 0 && s < 1440 && s % 15 === 0) {
        eff = s + extra;
        if (prevEff !== null && eff < prevEff) { extra += 60; eff = s + extra; }
      }
    }
    if (eff === undefined) eff = prevEff === null ? list.length * 15 : prevEff + 15;
    effState.set(day, { prevEff: eff, extra });
    // O instante: a meia-noite local do dia + o início do quarto. É o
    // único jeito de alinhar com o omie.es — na hora repetida de Outubro a
    // hora de relógio é a mesma em dois instantes diferentes.
    const utcMs = lisbonMidnightUtc(day) + eff * 60000;
    const wall = lisbonWallClock(utcMs);
    list.push({
      utc: new Date(utcMs).toISOString(),
      day: wall.day,
      min: wall.minutes,
      pt,
      es: Number.isFinite(Number(c[ix('preco_es')])) ? Number(c[ix('preco_es')]) : null,
      bd: (c[ix('BD')] || '').trim().toUpperCase() === 'F' ? 'F' : 'V',
      bs: (c[ix('BS')] || '').trim().toUpperCase() === 'F' ? 'F' : 'V',
    });
    days.set(day, list);
  }
  return { days, quarantined };
}

// O "Data_Valores_OMIE" do ficheiro de futuros: o último dia de MERCADO.
// O que estiver depois são estimativas OMIP.
export function parseOmieCutoff(text) {
  const m = /Data_Valores_OMIE,(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Os agregados diários que o TF publica (bd_v/bd_f/bs_v/bs_f), do mesmo
// formato que a API já devolve.
export function parseTfDaily(text, days = 60) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',');
  const ix = (n) => head.indexOf(n);
  const need = ['data_iso', 'bd_v', 'bd_f', 'bs_v', 'bs_f'];
  if (need.some(n => ix(n) < 0)) throw new Error('schema inesperado no omie_diario.csv');
  const num = (v) => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[ix('data_iso')])) continue;
    rows.push({ date: c[ix('data_iso')], bd_v: num(c[ix('bd_v')]), bd_f: num(c[ix('bd_f')]), bs_v: num(c[ix('bs_v')]), bs_f: num(c[ix('bs_f')]) });
  }
  return rows.slice(-days);
}

// Os contratos futuros OMIP (só informativo; o preço de mercado é o que o
// omie.es dá).
export function parseTfFutures(text) {
  const out = [];
  let table = null, cols = [];
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('TABELA_')) { table = line; cols = []; continue; }
    if (!table || !table.startsWith('TABELA_FUTUROS_')) continue;
    if (!cols.length) { cols = line.split(','); continue; }
    const c = line.split(',');
    if (c.length < 3 || !/^FPB/.test(c[0]) && !/^FBB/.test(c[0])) continue;
    const num = Number(String(c[2]).replace(',', '.'));
    out.push({ zona: table.replace('TABELA_FUTUROS_', ''), contrato: c[0], descricao: c[1], valor: Number.isFinite(num) ? num : null });
  }
  return out.slice(0, 40);
}
