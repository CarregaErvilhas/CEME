// Estatísticas OMIE — as tabelas mensais e as células de referência que
// estavam na folha "Comparador Mobie CEME" (separador "OMIE (via TF)").
//
// A folha encolheu a uma aba de quartos-horários com três tabelas: a
// "coloração de média anual" (uma escala verde→amarelo→vermelho sobre todas
// as células da tabela), a "coloração mês-a-mês" (a coluna Simples com a
// escala fixa em 60 €/MWh e as colunas Vazio/Cheia com uma escala divergente
// azul↔vermelho POR LINHA) e as seis células de referência à esquerda.
// Aqui essas três coisas passam a ser calculadas, não copiadas.
//
// Fonte: dados.tiagofelicia.pt (CC BY 4.0) — o CSV de quartos-horários do ano
// corrente (que traz as datas futuras estimadas a partir dos futuros OMIP) e
// o histórico anual do ano anterior, para a janela de 12 meses + o mês
// corrente. Nada disto é versionado: vive em `backend/data/`, gerado.
//
// Cache de 24h: a página é refrescada uma vez por dia, que é o que o dono
// pediu. Um cache vencido devolve-se já (a página mostra a idade dos dados) e
// a actualização corre em segundo plano — a primeira visita depois do prazo
// não fica à espera de 4 MB de CSV.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fetchText } from './cache.js';

const BASE = 'https://dados.tiagofelicia.pt/data';
const CURRENT_URL = `${BASE}/omie/omie_dados_atuais.csv`;
const HISTORY_URL = (year) => `${BASE}/omie/historico/omie_historico_${year}.csv`;
const FUT_URL = `${BASE}/omie/futuros_omip.csv`;

const TTL_MS = 24 * 3600 * 1000;
// Janela da tabela: os últimos 366 dias de mercado. Dá 13 linhas (do mês
// corrente a 12 meses atrás) e é o que a folha mostrava — o primeiro mês
// aparece truncado, porque a janela não começa no dia 1.
const WINDOW_DAYS = 366;
const SOURCE = 'dados.tiagofelicia.pt (CC BY 4.0)';

const pad2 = (n) => String(n).padStart(2, '0');
// Dia do calendário como número inteiro (epoch em UTC). Sirve para ordenar,
// para subtrair dias e para agrupar por mês sem tocar em fusos: os dados
// estão em hora de Lisboa, mas a agregação é por dia local, e o epoch UTC
// de uma data (sem hora) é uma bijection data→inteiro.
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const numToDay = (n) => new Date(n * 86400000);
const isoOf = (n) => { const d = numToDay(n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const monthKey = (n) => { const d = numToDay(n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; };

// "Agora" em hora de Lisboa. O servidor corre em UTC e os dados estão em
// hora local: sem esta conversão o "preço à hora actual" aponta para o
// quarter errado (e no limite para o dia errado).
export function lisbonNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { day, minutes, dayNum: dayNum(Number(parts.year), Number(parts.month), Number(parts.day)) };
}

// CSV de quartos-horários do TF: dia,hora,intervalo,Simples,BD,BS,TD,TS,
// preco_pt,preco_es. As colunas BD/BS são a classificação de período
// horário (V = vazio, F = fora de vazio) que o TF calcula com as regras da
// ERSE — são elas que alimentam as colunas "Bi-horário Diário" e
// "Bi-horário Semanal" da tabela.
export function parseStatsCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  const head = (lines.shift() || '').split(',').map(h => h.trim());
  const ix = (n) => head.indexOf(n);
  if (ix('dia') < 0 || ix('intervalo') < 0 || ix('preco_pt') < 0 || ix('BD') < 0 || ix('BS') < 0) {
    throw new Error('schema inesperado no CSV de quartos-horários');
  }
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('TABELA_')) break; // blocos de futuros no fim do ficheiro
    const c = line.split(',');
    if (c.length < 10) continue;
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((c[ix('dia')] || '').trim());
    const iv = /^\[(\d{2}):(\d{2})-/.exec((c[ix('intervalo')] || '').trim());
    const price = Number(c[ix('preco_pt')]);
    if (!dm || !iv || !Number.isFinite(price)) continue;
    const day = Number(dayNum(Number(dm[3]), Number(dm[2]), Number(dm[1])));
    const bd = (c[ix('BD')] || '').trim().toUpperCase();
    const bs = (c[ix('BS')] || '').trim().toUpperCase();
    rows.push({
      dn: day,
      day: isoOf(day),
      mk: monthKey(day),
      min: Number(iv[1]) * 60 + Number(iv[2]),
      bd: bd === 'F' ? 'F' : 'V',
      bs: bs === 'F' ? 'F' : 'V',
      price,
    });
  }
  rows.sort((a, b) => (a.dn - b.dn) || (a.min - b.min));
  return rows;
}

// Dia de mercado: o último dia com preço publicado. Sai do bloco
// TABELA_ATUALIZACOES do ficheiro de futuros OMIP (Data_Valores_OMIE) —
// é a mesma regra que o resto do backend usa, e o que separa mercado de
// estimativa OMIP.
export function parseOmieCutoff(text) {
  const m = /Data_Valores_OMIE,(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// Um agregado: média simples e as duas séries por ciclo horário.
function bucket() {
  return { all: [], semV: [], semF: [], diaV: [], diaF: [], dnMin: Infinity, dnMax: -Infinity };
}
function push(b, row) {
  b.all.push(row.price);
  (row.bs === 'F' ? b.semF : b.semV).push(row.price);
  (row.bd === 'F' ? b.diaF : b.diaV).push(row.price);
  if (row.dn < b.dnMin) b.dnMin = row.dn;
  if (row.dn > b.dnMax) b.dnMax = row.dn;
}
function shape(b) {
  return {
    media: round2(avg(b.all)),
    semVazio: round2(avg(b.semV)),
    semCheia: round2(avg(b.semF)),
    diaVazio: round2(avg(b.diaV)),
    diaCheia: round2(avg(b.diaF)),
    quarters: b.all.length,
  };
}
// Um mês está truncado se não cobre todos os dias do calendário: ou porque
// a janela de 366 dias não começou no dia 1 (o primeiro mês), ou porque o
// mês ainda não acabou (o mês corrente). `cut` diz qual dos dois é.
function partialOf(mk, b) {
  const [y, m] = mk.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const domMin = numToDay(b.dnMin).getUTCDate();
  const domMax = numToDay(b.dnMax).getUTCDate();
  if (domMin > 1) return { partial: true, cut: 'start' };
  if (domMax < lastDay) return { partial: true, cut: 'end' };
  return { partial: false, cut: null };
}

// Agrega os quartos-horários no payload da página.
// `cutoff` é o último dia de mercado ('YYYY-MM-DD'); o que está depois disso
// são estimativas OMIP e entra só na previsão do mês.
export function aggregate(rows, { cutoff = null, now = new Date() } = {}) {
  if (!rows.length) throw new Error('sem dados de quartos-horários');
  const cutDn = cutoff ? dayNum(Number(cutoff.slice(0, 4)), Number(cutoff.slice(5, 7)), Number(cutoff.slice(8, 10))) : Infinity;
  const real = rows.filter(r => r.dn <= cutDn);
  if (!real.length) throw new Error('sem preços de mercado');

  const lastDn = real[real.length - 1].dn;
  const fromDn = lastDn - (WINDOW_DAYS - 1);

  // Tabela: os meses da janela, do mais recente para o mais antigo.
  const byMonth = new Map();
  for (const r of real) {
    if (r.dn < fromDn) continue;
    if (!byMonth.has(r.mk)) byMonth.set(r.mk, bucket());
    push(byMonth.get(r.mk), r);
  }
  const months = [...byMonth.entries()].map(([mk, b]) => ({
    key: mk,
    label: mk.replace('-', '/'),
    ...partialOf(mk, b),
    ...shape(b),
  })).sort((a, b) => (a.key < b.key ? 1 : -1));

  // "Total geral": a média de toda a janela, não a média das médias.
  const win = bucket();
  for (const r of real) if (r.dn >= fromDn) push(win, r);

  // Cartões da esquerda. A "âncora" é o último quarto de mercado: é a
  // partir dele que contam os 30 dias e o mês em curso (é o que a folha
  // fazia). Já o "hoje" e o "amanhã" são dias de calendário — o "hoje" usa
  // o que houver no ficheiro para esse dia (preço de mercado se já foi
  // publicado, estimativa OMIP se ainda não), e o "amanhã" é a estimativa.
  const anchor = real[real.length - 1];
  const dayBuckets = new Map();
  for (const r of rows) {
    if (!dayBuckets.has(r.dn)) dayBuckets.set(r.dn, bucket());
    push(dayBuckets.get(r.dn), r);
  }
  const dayOf = (dn) => dayBuckets.get(dn) || bucket();
  const lis = lisbonNow(now);
  const todayB = dayBuckets.has(lis.dayNum) ? dayBuckets.get(lis.dayNum) : dayOf(anchor.dn);
  const tomorrowB = dayOf(lis.dayNum + 1);
  const last30 = bucket();
  for (const r of real) if (r.dn >= anchor.dn - 30) push(last30, r);
  // Mês em curso: o que o calendário já viu, contado até ao último quarto
  // de mercado (é a mesma figura que a última linha da tabela).
  const monthKeyNow = monthKey(lis.dayNum);
  const monthB = bucket();
  for (const r of real) if (r.mk === monthKeyNow) push(monthB, r);
  // Previsão: o mês completo, com o resto estimado a partir dos futuros.
  const monthFull = bucket();
  for (const r of rows) if (r.mk === monthKeyNow) push(monthFull, r);

  // Preço "à hora actual": o quarter em curso, se já foi publicado; senão o
  // último publicado (e dizemos que não é o current).
  const floorMin = Math.floor(lis.minutes / 15) * 15;
  let current = null;
  for (const r of real) {
    if (r.dn > lis.dayNum) continue;
    if (r.dn < lis.dayNum) { current = r; continue; }
    if (r.min > floorMin) break;
    current = r;
  }
  current = current || anchor;

  const stamp = (dn, min) => `${isoOf(dn)}T${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

  return {
    generatedAt: now.toISOString(),
    source: SOURCE,
    cutoff: cutoff || isoOf(anchor.dn),
    dataThrough: stamp(anchor.dn, anchor.min),
    window: { from: isoOf(fromDn), to: isoOf(lastDn) },
    today: lis.day,
    current: {
      at: stamp(current.dn, current.min),
      price: round2(current.price),
      live: current.dn === lis.dayNum && current.min === floorMin,
    },
    cards: {
      today: {
        date: isoOf(dayBuckets.has(lis.dayNum) ? lis.dayNum : anchor.dn),
        value: round2(avg(todayB.all)),
        quarters: todayB.all.length,
      },
      tomorrow: {
        date: isoOf(lis.dayNum + 1),
        value: round2(avg(tomorrowB.all)),
        quarters: tomorrowB.all.length,
        estimated: tomorrowB.all.length > 0,
      },
      last30: {
        from: stamp(anchor.dn - 30, 0),
        to: stamp(anchor.dn, anchor.min),
        value: round2(avg(last30.all)),
      },
      forecast: { month: monthKeyNow, value: round2(avg(monthFull.all)) },
      monthToDate: {
        month: monthKeyNow,
        from: stamp(dayNum(Number(monthKeyNow.slice(0, 4)), Number(monthKeyNow.slice(5, 7)), 1), 0),
        to: stamp(anchor.dn, anchor.min),
        value: round2(avg(monthB.all)),
      },
    },
    months,
    total: shape(win),
  };
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

// Ficheiros do ano corrente e do anterior: a janela de 366 dias atravessa
// sempre dois anos, e o "ano corrente" do TF é o ficheiro omie_dados_atuais
// (que traz as estimativas OMIP em cima).
async function fetchYearRows(year) {
  const isCurrentYear = year === new Date().getFullYear();
  const url = isCurrentYear ? CURRENT_URL : HISTORY_URL(year);
  const text = await fetchText(url);
  const rows = parseStatsCsv(text);
  return rows;
}

let inflight = null;

async function build(now = new Date()) {
  const futText = await fetchText(FUT_URL);
  const cutoff = parseOmieCutoff(futText);
  const years = new Set();
  const ref = cutoff ? Number(cutoff.slice(0, 4)) : now.getFullYear();
  years.add(ref - 1);
  years.add(ref);
  const rows = [];
  for (const y of [...years].sort()) {
    rows.push(...(await fetchYearRows(y)));
  }
  rows.sort((a, b) => (a.dn - b.dn) || (a.min - b.min));
  const payload = aggregate(rows, { cutoff, now });
  return { ...payload, fetchedAt: Date.now() };
}

// Payload fresco, com cache de 24h em disco. Cache vencido devolve-se na
// mesma e a actualização fica em segundo plano: quem chega ao site não
// espera por 4 MB de CSV, e mesmo assim os dados não ficam velhos.
export async function getStats(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = `${dataDir}/omie-stats.json`;
  const cached = readJson(path);
  const fresh = cached && Date.now() - cached.fetchedAt < TTL_MS;
  if (fresh) return { ...cached, cached: true, stale: false };

  if (cached) {
    if (!inflight) {
      inflight = build()
        .then(payload => { try { writeFileSync(path, JSON.stringify(payload)); } catch { /* cache opcional */ } })
        .catch(() => { /* fica o cache velho; o próximo pedido tenta outra vez */ })
        .finally(() => { inflight = null; });
    }
    return { ...cached, cached: true, stale: true };
  }

  try {
    const payload = await build();
    try { writeFileSync(path, JSON.stringify(payload)); } catch { /* cache opcional */ }
    return { ...payload, cached: false, stale: false };
  } catch (e) {
    throw new Error(`séries OMIE indisponíveis: ${e.message}`);
  }
}
