// Vai buscar dados a dados.tiagofelicia.pt (TF), a fonte SECUNDÁRIA.
//
// O Tiago Felícia republica os preços do OMIE em CSV (licença CC BY 4.0, que
// obriga a dar o crédito) e junta coisas que o omie.es não tem:
//   - a classificação de cada quarto em vazio/fora de vazio nos ciclos
//     diário (BD) e semanal (BS), segundo as regras da ERSE;
//   - preços estimados para dias que o OMIE ainda não publicou;
//   - os futuros do OMIP (o mercado onde se compra energia para datas
//     futuras), incluindo um preço por dia para os próximos dias.
//
// Os CSV são grandes, por isso ficam guardados em backend/data/ (fora do
// git) e só se voltam a descarregar quando ficam velhos (vê os TTL).
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lisbonDayQuarters } from './convert.js';

// Pasta da cache em disco (backend/data/). Podes apagá-la: volta a encher-se.
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

export const TF_BASE = 'https://dados.tiagofelicia.pt/data';
export const TF_CURRENT_URL = `${TF_BASE}/omie/omie_dados_atuais.csv`;
export const TF_HISTORY_URL = (year) => `${TF_BASE}/omie/historico/omie_historico_${year}.csv`;
export const TF_FUTURES_URL = `${TF_BASE}/omie/futuros_omip.csv`;
export const TF_DAILY_URL = `${TF_BASE}/agregados/omie_diario.csv`;
export const TF_SOURCE = 'dados.tiagofelicia.pt (CC BY 4.0)';

// Ao fim de quanto tempo cada ficheiro em cache é considerado velho (TTL).
export const TTL_DAILY = 24 * 3600 * 1000;   // ano corrente
export const TTL_HISTORY = 30 * 24 * 3600 * 1000; // ano anterior (quase não muda)
export const TTL_FUTURES = 6 * 3600 * 1000;  // futuros (mudam com o mercado)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Descarrega um URL como texto, até 3 tentativas.
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

// Devolve o ficheiro `name` da cache se tiver menos de `ttlMs`; senão
// descarrega-o de `url` e guarda-o. Cada instância do servidor tem a sua
// própria cache (é o disco dela); os dados que contam ficam na BD.
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

// Lê o CSV de quartos de hora do TF e agrupa as linhas por dia de Lisboa.
//
// Ao contrário do omie.es, este ficheiro está em HORA DE LISBOA: o dia
// "20/10/2026" vai das 00:00 às 23:45 de Lisboa. Por isso os dois ficheiros
// estão desfasados uma hora, e juntam-se pelo instante UTC, nunca pelo número
// do período.
//
// Cada linha devolvida: { utc, day, min, pt, es, bd, bs }
//   bd, bs: 'V' (vazio) ou 'F' (fora de vazio) nos ciclos diário e semanal.
export function parseTfQuarters(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',').map(h => h.trim());
  const ix = (n) => head.indexOf(n);
  if (ix('dia') < 0 || ix('preco_pt') < 0) throw new Error('schema inesperado no CSV de quartos do TF');
  const days = new Map();
  const quarantined = [];
  // Por dia: a lista real de quartos de Lisboa e qual é o próximo a preencher.
  const dayState = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('TABELA_')) break; // a partir daqui são tabelas de futuros
    const c = line.split(',');
    if (c.length < 9) { quarantined.push({ reason: 'few_columns', text: line.slice(0, 140) }); continue; }
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((c[ix('dia')] || '').trim());
    if (!dm) { quarantined.push({ reason: 'bad_day', text: line.slice(0, 140) }); continue; }
    const pt = Number(c[ix('preco_pt')]);
    if (!Number.isFinite(pt)) { quarantined.push({ reason: 'bad_price', text: line.slice(0, 140) }); continue; }
    const day = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;

    const list = days.get(day) || [];
    // Como chegar ao instante UTC de cada linha:
    // não dá para fazer "meia-noite + hora de relógio", porque em Março o
    // relógio salta das 00:59 para as 02:00 e em Outubro a 01:00–02:00
    // acontece duas vezes. Em vez disso, gera-se a lista real de quartos do
    // dia (lisbonDayQuarters) e procura-se o primeiro, A SEGUIR ao da linha
    // anterior, com a mesma hora de início. É isso que põe a segunda "01:00"
    // de Outubro na segunda passagem. Também não se usa a posição da linha:
    // se faltasse uma, todas as seguintes ficavam 15 minutos ao lado.
    // A hora de início lê-se de `intervalo` ("[00:45-02:00[") ou, se faltar,
    // de `hora` (que é o FIM do quarto; "23:59" quer dizer 24:00).
    let st = dayState.get(day);
    if (!st) { st = { quarters: lisbonDayQuarters(day), next: 0 }; dayState.set(day, st); }
    const startMin = quarterStart(c[ix('intervalo')], c[ix('hora')]);
    let slot = null;
    if (startMin != null) {

      const i = st.quarters.findIndex((q, j) => j >= st.next && q.minutes === startMin);
      if (i >= 0) slot = st.quarters[i];
      else if (st.quarters.some(q => q.minutes === startMin)) {
        // Essa hora existe mas já ficou para trás: linha repetida ou fora de
        // ordem. Vai para a quarentena.
        quarantined.push({ reason: 'dup_hour', text: line.slice(0, 140) });
        continue;
      }
    }
    // Sem hora legível, ou uma hora que não existe nesse dia: usa-se o quarto
    // a seguir ao anterior.
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

// Minutos de relógio em que o quarto COMEÇA, lidos de `intervalo`
// ("[00:45-02:00[") ou, se faltar, de `hora` (o fim). null se ilegível.
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

// Lê "Data_Valores_OMIE" do ficheiro de futuros: o último dia com preços
// reais do mercado. Os dias a seguir no CSV do TF são estimativas.
export function parseOmieCutoff(text) {
  const m = /Data_Valores_OMIE,(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Lê o CSV de médias diárias do TF (bd_v/bd_f/bs_v/bs_f) e devolve os
// últimos `days` dias.
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

// Lê todas as tabelas TABELA_FUTUROS_<zona> do ficheiro de futuros do OMIP.
// Devolve [{ zona, contrato, descricao, valor }]. Só contratos FPB/FBB
// (carga base).
export function parseTfFutures(text) {
  const out = [];
  let table = null, cols = [];
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('TABELA_')) { table = line; cols = []; continue; }
    if (!table || !table.startsWith('TABELA_FUTUROS_')) continue;
    if (!cols.length) { cols = csvFields(line); continue; }
    // Há campos com vírgulas entre aspas ("Semana 44, 2026"), daí o csvFields.
    const c = csvFields(line);
    if (c.length < 3 || !/^FPB/.test(c[0]) && !/^FBB/.test(c[0])) continue;
    const num = Number(String(c[2]).replace(',', '.'));
    out.push({ zona: table.replace('TABELA_FUTUROS_', ''), contrato: c[0], descricao: c[1], valor: Number.isFinite(num) ? num : null });
  }
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

// Os futuros DIÁRIOS da zona PT (contratos "FPB D …", ex.
// `FPB D Sa24Oct-26,24/10/2026,132.31,…`): um preço esperado (€/MWh) para
// cada um dos próximos dias. A página de estatísticas usa-os tal como vêm.
// Devolve [{ date: 'AAAA-MM-DD', value }] por ordem de data.
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
