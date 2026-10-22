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
// Este módulo só faz a AGREGAÇÃO: recebe as linhas dos quartos-horários
// (já reconciliadas entre omie.es e TF, em `pipeline.js`) e devolve o
// payload. Quem busca os dados e quem escreve o cache é o pipeline.
//
// O "preço à hora actual" não vem do payload em cache: recalcula-se a cada
// pedido a partir da cauda de quartos guardados, para acompanhar o relógio.
export const WINDOW_DAYS = 366;
// Quantos quartos recentes ficam no payload, para o "preço à hora actual"
// poder ser recalculado a cada pedido (ver currentPrice).
export const TAIL_ROWS = 400;

const pad2 = (n) => String(n).padStart(2, '0');
// Dia do calendário como número inteiro (epoch em UTC). Serve para ordenar,
// para subtrair dias e para agrupar por mês sem tocar em fusos: os dados
// estão em hora de Lisboa, mas a agregação é por dia local, e o epoch UTC
// de uma data (sem hora) é uma bijection data→inteiro.
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const numToDay = (n) => new Date(n * 86400000);
const isoOf = (n) => { const d = numToDay(n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const monthKey = (n) => { const d = numToDay(n); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; };

// "Agora" — em UTC, como tudo o resto.
//
// O quarter em curso é o que contém o instante actual: a grelha de 15
// minutos do mercado coincide com a de UTC (as duas difere de um número
// inteiro de horas), por isso não é preciso converter para o fuso local
// para saber qual é o quarter. O que o relógio local decide é o *período
// do tarifário* — e isso é do motor (`engine/regions.js`), que tem as
// regras da ERSE por região.
export function utcNow(now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return { day, minutes, dayNum: dayNum(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))) };
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
//
// As linhas vêm do store (já reconciliadas): cada uma tem o dia civil de
// LISBOA (`dn`), os minutos desde a meia-noite local (`min`), a mesma
// leitura em `lisbonDn`/`lisbonMin`, a classificação do período (`bd`/`bs`),
// o preço e — quando o preço é uma estimativa OMIP e não um preço de
// mercado — a marca `est`.
//
// `cutoff` é o último dia de mercado ('YYYY-MM-DD'); o que está depois disso
// são estimativas OMIP e entra só na previsão do mês.
export function aggregate(rows, { cutoff = null, now = new Date() } = {}) {
  if (!rows.length) throw new Error('sem dados de quartos-horários');
  const cutDn = cutoff ? dayNum(Number(cutoff.slice(0, 4)), Number(cutoff.slice(5, 7)), Number(cutoff.slice(8, 10))) : Infinity;
  // Uma linha é de mercado se o dia está dentro do corte E não está
  // marcada como estimativa (um dia pode ter preços de mercado e estimativas
  // ao mesmo tempo — é o que acontece no dia em que a OMIE publica).
  const real = rows.filter(r => r.dn <= cutDn && !r.est);
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
  const lis = utcNow(now);
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

  // Preço "à hora actual": o quarter de mercado que está a correr AGORA, em
  // hora de Lisboa. O ficheiro está em CET, por isso o quarter em curso é o
  // que tem a hora de Lisboa correspondente — e é o que se mostra.
  const stamp = (dn, min) => `${isoOf(dn)}T${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  // O mesmo instante, em UTC ISO-8601 — é o que a página converte para o
  // fuso de quem a vê (o backend não sabe o fuso do utilizador).
  const stampUtc = (dn, min) => new Date(numToDay(dn).getTime() + min * 60000).toISOString();
  // O dia civil (UTC) começa à meia-noite.
  const dayStart = (dn) => ({ dn, min: 0 });

  // Os últimos quartos (dia de mercado + o dia seguinte), para o preço "à
  // hora actual" poder ser recalculado a cada pedido em vez de ficar
  // preso no que foi calculado quando o cache foi feito.
  const recent = rows
    .filter(r => r.dn <= lastDn + 1)
    .slice(-TAIL_ROWS)
    .map(r => ({ dn: r.dn, lisbonDn: r.lisbonDn, lisbonMin: r.lisbonMin, price: r.price, utc: r.utc }));
  const cutoffIso = cutoff || isoOf(lastDn);

  return {
    generatedAt: now.toISOString(),
    cutoff: cutoffIso,
    // Tudo o que se mostra com hora é hora de Lisboa.
    dataThrough: stamp(anchor.lisbonDn, anchor.lisbonMin),
    dataThroughUtc: anchor.utc || stampUtc(anchor.lisbonDn, anchor.lisbonMin),
    window: { from: isoOf(fromDn), to: isoOf(lastDn) },
    today: lis.day,
    current: currentPrice({ recent, cutoff: cutoffIso }, now),
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
        from: (() => { const s = dayStart(anchor.dn - 30); return stamp(s.dn, s.min); })(),
        fromUtc: (() => { const s = dayStart(anchor.dn - 30); return stampUtc(s.dn, s.min); })(),
        to: stamp(anchor.lisbonDn, anchor.lisbonMin),
        toUtc: anchor.utc || stampUtc(anchor.lisbonDn, anchor.lisbonMin),
        value: round2(avg(last30.all)),
      },
      forecast: { month: monthKeyNow, value: round2(avg(monthFull.all)) },
      monthToDate: {
        month: monthKeyNow,
        from: (() => {
          const s = dayStart(dayNum(Number(monthKeyNow.slice(0, 4)), Number(monthKeyNow.slice(5, 7)), 1));
          return stamp(s.dn, s.min);
        })(),
        fromUtc: (() => {
          const s = dayStart(dayNum(Number(monthKeyNow.slice(0, 4)), Number(monthKeyNow.slice(5, 7)), 1));
          return stampUtc(s.dn, s.min);
        })(),
        to: stamp(anchor.lisbonDn, anchor.lisbonMin),
        toUtc: anchor.utc || stampUtc(anchor.lisbonDn, anchor.lisbonMin),
        value: round2(avg(monthB.all)),
      },
    },
    months,
    total: shape(win),
    recent,
  };
}

// O preço "à hora actual": o quarter de mercado que está a correr AGORA.
// Calculado a cada pedido a partir da cauda guardada no cache — o cache
// é de horas, mas a hora que está a correr muda a cada 15 minutos.
//
// Nota: o mercado à vista de dia publica a curva inteira do dia de uma
// vez, por isso este preço não é um "tick" — muda quando a OMIE publica
// (e quando o TF vai buscar o ficheiro). O que muda a cada 15 minutos é o
// quarter em que estamos.
export function currentPrice(payload, now = new Date()) {
  const lis = utcNow(now);
  const floorMin = Math.floor(lis.minutes / 15) * 15;
  let best = null;
  for (const r of payload.recent || []) {
    if (r.lisbonDn > lis.dayNum) continue;
    if (r.lisbonDn < lis.dayNum) { best = r; continue; }
    if (r.lisbonMin > floorMin) break;
    best = r;
  }
  if (!best) return { at: null, price: null, live: false, estimated: false };
  const cut = payload.cutoff ? dayNum(Number(payload.cutoff.slice(0, 4)), Number(payload.cutoff.slice(5, 7)), Number(payload.cutoff.slice(8, 10))) : Infinity;
  const iso = best.utc ? best.utc : new Date(numToDay(best.lisbonDn).getTime() + best.lisbonMin * 60000).toISOString();
  return {
    at: `${isoOf(best.lisbonDn)}T${pad2(Math.floor(best.lisbonMin / 60))}:${pad2(best.lisbonMin % 60)}`,
    atUtc: iso,
    price: round2(best.price),
    live: best.lisbonDn === lis.dayNum && best.lisbonMin === floorMin,
    // O dia de mercado ainda não foi publicado: o preço é uma estimativa
    // OMIP, não um preço de mercado.
    estimated: best.dn > cut,
  };
}
