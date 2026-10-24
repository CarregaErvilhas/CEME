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
import { lisbonDayQuarters } from './convert.js';

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
export const TTL_HISTORY = 30 * 24 * 3600 * 1000; // histórico: quase não muda; re-baixa-se uma vez por mês
export const TTL_FUTURES = 6 * 3600 * 1000;  // futuros: mudam com o mercado

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET com retry — o texto vem em UTF-8.
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
  const dayState = new Map();
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
    // O instante a partir da HORA DE RELÓGIO do quarto, e não da posição da
    // linha (se faltar uma linha a meio do dia, a posição deslocava todos os
    // instantes seguintes em 15 minutos sem ninguém dar por isso).
    //
    // A hora de relógio não é tempo decorrido desde a meia-noite: no dia de
    // Março o relógio salta das 00:59 para as 02:00 (a linha
    // `02:00,[00:45-02:00[` começou 45 min depois da meia-noite, não 105), e
    // no de Outubro a hora 01:00–02:00 passa duas vezes. Por isso não se faz
    // aritmética: procura-se o quarto na lista REAL de quartos desse dia de
    // Lisboa (`lisbonDayQuarters`), pela hora de início, a seguir ao quarto da
    // linha anterior (é o que separa a primeira e a segunda passagem de
    // Outubro). O início lê-se do `intervalo` ("[00:45-02:00[");
    // sem ele, da `hora` (o FIM do quarto; "23:59" = 24:00).
    let st = dayState.get(day);
    if (!st) { st = { quarters: lisbonDayQuarters(day), next: 0 }; dayState.set(day, st); }
    const startMin = quarterStart(c[ix('intervalo')], c[ix('hora')]);
    let slot = null;
    if (startMin != null) {
      // O primeiro quarto com esta hora DEPOIS do anterior: na hora repetida
      // de Outubro, a segunda linha "01:00" cai na segunda passagem.
      const i = st.quarters.findIndex((q, j) => j >= st.next && q.minutes === startMin);
      if (i >= 0) slot = st.quarters[i];
      else if (st.quarters.some(q => q.minutes === startMin)) {
        // A hora existe nesse dia mas já ficou para trás: linha repetida (ou
        // fora de ordem). Quarentena — encaixá-la "no quarto a seguir"
        // deslocava todas as linhas seguintes do dia em 15 minutos.
        quarantined.push({ reason: 'dup_hour', text: line.slice(0, 140) });
        continue;
      }
    }
    // Sem hora legível, ou uma hora que não existe nesse dia (só com a
    // `hora` e sem `intervalo`, o quarto que fecha às 02:00 de Março "começa"
    // às 01:45): o quarto a seguir ao anterior.
    if (!slot) slot = st.quarters[st.next] || null;
    if (!slot) { quarantined.push({ reason: 'bad_hour', text: line.slice(0, 140) }); continue; }
    st.next = st.quarters.indexOf(slot) + 1;
    const utcMs = Date.parse(slot.utc);
    const wall = { day: slot.day, minutes: slot.minutes };
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

// Minutos de relógio do INÍCIO do quarto: do `intervalo` ("[00:45-02:00[")
// ou, na falta, da `hora` (o fim; "23:59" é o fim do dia). null se ilegível.
function quarterStart(intervalo, hora) {
  const iv = /^\[(\d{2}):(\d{2})-/.exec(String(intervalo || '').trim());
  if (iv) return Number(iv[1]) * 60 + Number(iv[2]);
  const hm = /^(\d{2}):(\d{2})$/.exec(String(hora || '').trim());
  if (!hm) return null;
  let end = Number(hm[1]) * 60 + Number(hm[2]);
  if (end === 23 * 60 + 59) end = 24 * 60;
  const start = end - 15;
  return start >= 0 && start % 15 === 0 ? start : null;
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
    if (!cols.length) { cols = csvFields(line); continue; }
    // Campos com aspas: `FPB Wk44-26,"Semana 44, 2026",194.25,...` — com um
    // split(',') simples o preço caía no campo errado e saía null.
    const c = csvFields(line);
    if (c.length < 3 || !/^FPB/.test(c[0]) && !/^FBB/.test(c[0])) continue;
    const num = Number(String(c[2]).replace(',', '.'));
    out.push({ zona: table.replace('TABELA_FUTUROS_', ''), contrato: c[0], descricao: c[1], valor: Number.isFinite(num) ? num : null });
  }
  // Sem tecto: o ficheiro é pequeno, e um corte por número de linhas (havia
  // um de 40, para todas as zonas) podia deixar de fora futuros diários.
  return out;
}

// Uma linha CSV em campos, com aspas duplas ("a, b" é um campo; "" é uma aspa).
function csvFields(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
// Os futuros DIÁRIOS (FPB D ...) da zona PT: um número publicado por dia
// (ex. `FPB D Sa24Oct-26,24/10/2026,132.31,...`). É a única fonte de futuro
// admitida na página — e usa-se o número tal como vem, sem médias nossas.
// Devolve [{ date: 'YYYY-MM-DD', value }] por ordem de data.
export function parseTfDailyFutures(text, zona = 'PT') {
  const rows = parseTfFutures(text).filter(r => r.zona === zona && /^FPB D\b/.test(r.contrato));
  const out = [];
  for (const r of rows) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(r.descricao || '').trim());
    if (!m || r.valor == null) continue;
    out.push({ date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, value: r.valor });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
