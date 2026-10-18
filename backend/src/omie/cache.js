// Séries OMIE para o comparador (POC): agregados diários + futuros OMIP,
// via dados.tiagofelicia.pt (CC BY 4.0, com atribuição) com cache local de 6h.
// Produção usa omie.es directo (ver docs/03); o formato aqui é o fallback TF.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DAILY_URL = 'https://dados.tiagofelicia.pt/data/agregados/omie_diario.csv';
const FUT_URL = 'https://dados.tiagofelicia.pt/data/omie/futuros_omip.csv';
const QUARTERS_URL = 'https://dados.tiagofelicia.pt/data/omie/omie_dados_atuais.csv';
const TTL_MS = 6 * 3600 * 1000;

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'ceme-v2-poc' } });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      if (txt.includes('Page not found')) throw new Error('404 upstream');
      if (txt.length < 1000) throw new Error('corpo suspeito (<1KB)');
      return txt;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

export function parseDailyCsv(text, days = 60) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',');
  const ix = (n) => head.indexOf(n);
  const need = ['data_iso', 'bd_v', 'bd_f', 'bs_v', 'bs_f'];
  if (need.some(n => ix(n) < 0)) throw new Error('schema inesperado no omie_diario.csv');
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split(',');
    const num = (v) => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[ix('data_iso')])) continue;
    rows.push({ date: c[ix('data_iso')], bd_v: num(c[ix('bd_v')]), bd_f: num(c[ix('bd_f')]), bs_v: num(c[ix('bs_v')]), bs_f: num(c[ix('bs_f')]) });
  }
  return rows.slice(-days);
}

export function parseFuturesCsv(text) {
  // TABELA_FUTUROS_PT / _ES com cabeçalho próprio; pára na próxima TABELA_
  const out = [];
  let table = null, cols = [];
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('TABELA_')) { table = line; cols = []; continue; }
    if (!table || !table.startsWith('TABELA_FUTUROS_')) continue;
    if (!cols.length) { cols = line.split(','); continue; }
    if (line.startsWith('TABELA_')) { table = line; cols = []; continue; }
    const c = line.split(',');
    if (c.length < 3 || !/^FPB/.test(c[0]) && !/^FBB/.test(c[0])) continue;
    const num = Number(String(c[2]).replace(',', '.'));
    out.push({ zona: table.replace('TABELA_FUTUROS_', ''), contrato: c[0], descricao: c[1], valor: Number.isFinite(num) ? num : null });
  }
  return out.slice(0, 40);
}

function cacheGet(path) {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.now() - j.fetchedAt > TTL_MS) return null;
    return j;
  } catch { return null; }
}

export async function getDaily(dataDir, days = 60) {
  mkdirSync(dataDir, { recursive: true });
  const hit = cacheGet(`${dataDir}/omie-daily.json`);
  if (hit && (hit.days || 60) >= days) return { ...hit, cached: true, rows: hit.rows.slice(-days) };
  const rows = parseDailyCsv(await fetchText(DAILY_URL), days);
  const payload = { fetchedAt: Date.now(), days, source: 'dados.tiagofelicia.pt (CC BY 4.0)', rows };
  try { writeFileSync(`${dataDir}/omie-daily.json`, JSON.stringify(payload)); } catch { /* cache opcional */ }
  return { ...payload, cached: false };
}

export async function getFutures(dataDir) {  mkdirSync(dataDir, { recursive: true });  const hit = cacheGet(`${dataDir}/omie-futures.json`);
  if (hit) return { ...hit, cached: true };
  const rows = parseFuturesCsv(await fetchText(FUT_URL));
  const payload = { fetchedAt: Date.now(), source: 'OMIP via dados.tiagofelicia.pt (CC BY 4.0)', rows };
  try { writeFileSync(`${dataDir}/omie-futures.json`, JSON.stringify(payload)); } catch { /* cache opcional */ }
  return { ...payload, cached: false };
}

// Quartos-horários do dia (para "quando carregar"): dia,hora(fim),preco_pt.
// A hora vem em hora PT; para MAD/AZO interpreta-se a mesma parede horária
// local (aproximação POC documentada — o pipeline final guarda ts por zona).
export function parseQuartersCsv(text, wantIso) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',');
  const ix = (n) => head.indexOf(n);
  if (ix('dia') < 0 || ix('hora') < 0 || ix('preco_pt') < 0) throw new Error('schema inesperado no omie_dados_atuais.csv');
  const byDay = new Map();
  for (const line of lines) {
    if (!line.trim() || line.startsWith('TABELA_')) break; // blocos extra no fim
    const c = line.split(',');
    if (c.length < 9) continue;
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(c[ix('dia')].trim());
    const hm = /^(\d{2}):(\d{2})$/.exec((c[ix('hora')] || '').trim());
    const pt = Number(c[ix('preco_pt')]);
    if (!dm || !hm || !Number.isFinite(pt)) continue;
    const iso = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    if (!byDay.has(iso)) byDay.set(iso, []);
    const endMin = Number(hm[1]) * 60 + Number(hm[2]);
    const stMin = (endMin - 15 + 1440) % 1440;
    const hh = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    byDay.get(iso).push({ start: hh(stMin), end: hm[0], priceMwh: pt });
  }
  const days = [...byDay.keys()].sort();
  const date = wantIso && byDay.has(wantIso) ? wantIso : days[days.length - 1];
  if (!date) throw new Error('sem dias no CSV');
  return { date, days, rows: byDay.get(date).sort((a, b) => a.start.localeCompare(b.start)) };
}

export async function getQuarters(dataDir, wantIso) {
  mkdirSync(dataDir, { recursive: true });
  const key = (wantIso || 'auto').replace(/[^0-9-]/g, '') || 'auto';
  const path = `${dataDir}/omie-q-${key}.json`;
  const hit = cacheGet(path);
  if (hit && hit.rows?.length >= 90) return { ...hit, cached: true };
  const qtxt = await fetchText(QUARTERS_URL);
  const parsed = parseQuartersCsv(qtxt, null);
  // dias após Data_Valores_OMIE são estimativas OMIP, não mercado (aviso do próprio TF)
  let cutoff = null;
  try {
    const fraw = await fetchText(FUT_URL);
    const m = /Data_Valores_OMIE,(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(fraw);
    if (m) cutoff = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  } catch { /* sem cutoff: tudo é mercado */ }
  const realDays = cutoff ? parsed.days.filter(d => d <= cutoff) : parsed.days;
  const want = wantIso && parsed.days.includes(wantIso) ? wantIso : (realDays[realDays.length - 1] || parsed.days[parsed.days.length - 1]);
  // montra de dias: 4 reais + cutoff + 2 estimativas (hoje + próximos)
  const ci = parsed.days.indexOf(want);
  const window = parsed.days.slice(Math.max(0, ci - 4), ci + 3);
  const rows = parseQuartersCsv(qtxt, want).rows;
  const payload = { fetchedAt: Date.now(), source: 'dados.tiagofelicia.pt (CC BY 4.0)',
    date: want, cutoff, estimated: !!(cutoff && want > cutoff), days: window, rows };
  try { writeFileSync(path, JSON.stringify(payload)); } catch { /* cache opcional */ }
  return { ...payload, cached: false };
}
