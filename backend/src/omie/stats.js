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

import { lisbonMidnightUtc, expectedQuartersForLisbonDay } from './convert.js';

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
// "Agora" em hora de Lisboa — é o fuso da página das estatísticas OMIE.
export function lisbonNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { day, minutes, dayNum: dayNum(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))) };
}

const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// Um agregado: média simples e as duas séries por ciclo horário.
// Guarda também a soma e quantos quarters são estimativa OMIP — é o que as
// tooltips de validação mostram (a fórmula, não só o resultado).
function bucket() {
  return { all: [], semV: [], semF: [], diaV: [], diaF: [], dnMin: Infinity, dnMax: -Infinity, est: 0 };
}
function push(b, row) {
  b.all.push(row.price);
  (row.bs === 'F' ? b.semF : b.semV).push(row.price);
  (row.bd === 'F' ? b.diaF : b.diaV).push(row.price);
  if (row.est) b.est++;
  if (row.dn < b.dnMin) b.dnMin = row.dn;
  if (row.dn > b.dnMax) b.dnMax = row.dn;
}
const sum = (v) => v.reduce((a, b) => a + b, 0);
function shape(b) {
  return {
    media: round2(avg(b.all)),
    semVazio: round2(avg(b.semV)),
    semCheia: round2(avg(b.semF)),
    diaVazio: round2(avg(b.diaV)),
    diaCheia: round2(avg(b.diaF)),
    quarters: b.all.length,
    estQuarters: b.est,
    sum: Math.round(sum(b.all) * 100) / 100,
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
// `cutoff` é o último dia de mercado ('YYYY-MM-DD'); `fpbDaily` são os
// futuros diários FPB D do TF ({ 'YYYY-MM-DD': €/MWh }), a única fonte de
// futuro admitida — e só na previsão do mês e no cartão de amanhã.
export function aggregate(rows, { cutoff = null, now = new Date(), fpbDaily = {} } = {}) {
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
  // Médias por dia: SÓ mercado. As estimativas OMIP não entram em nenhuma
  // média — excepto na previsão do mês (ver abaixo), que é o único cartão
  // que as usa, e aí vindas dos futuros diários FPB D do TF (números
  // publicados, sem contas nossas sobre quarters).
  //
  // O dia de hoje tem quase sempre mercado (o dia de mercado publica-se na
  // véspera às ~13h; só os 4 quarters das 23:00-23:45, do dia de mercado
  // seguinte, ficam por publicar até às 13h). Quando o dia ainda não tem
  // nenhum quarter publicado, o cartão fica vazio em vez de inventar.
  const dayBuckets = new Map();
  for (const r of rows) {
    if (r.est || r.dn > cutDn) continue;
    if (!dayBuckets.has(r.dn)) dayBuckets.set(r.dn, bucket());
    push(dayBuckets.get(r.dn), r);
  }
  const marketOf = (dn) => dayBuckets.get(dn) || bucket();
  const lis = lisbonNow(now);
  const todayDn = dayBuckets.has(lis.dayNum) ? lis.dayNum : anchor.dn;
  const todayB = marketOf(todayDn);
  const tomorrowDn = lis.dayNum + 1;
  const tomorrowIso = isoOf(tomorrowDn);
  const tomorrowB = marketOf(tomorrowDn);
  // Amanhã sem mercado publicado: vale o futuro diário FPB D do TF para essa
  // data (um número publicado, sem médias nossas) — assinalado como futuro,
  // não como mercado.
  const fpb = fpbDaily || {};
  const fpbTomorrow = fpb[tomorrowIso] != null && Number.isFinite(Number(fpb[tomorrowIso]))
    ? Number(fpb[tomorrowIso]) : null;
  const last30 = bucket();
  for (const r of real) if (r.dn >= anchor.dn - 30) push(last30, r);
  // Mês em curso: o que o calendário já viu, contado até ao último quarto
  // de mercado (é a mesma figura que a última linha da tabela).
  const monthKeyNow = monthKey(lis.dayNum);
  const monthB = bucket();
  for (const r of real) if (r.mk === monthKeyNow) push(monthB, r);
  // Previsão do mês: o que já é mercado (mês em curso) mais os futuros
  // diários FPB D do TF para os restantes dias com futuro publicado — sem
  // misturar quarters estimados. A cobertura vai só até onde há dados.
  const [fy, fm] = monthKeyNow.split('-').map(Number);
  const dim = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  const fpbUsed = [];
  let fpbSum = 0;
  for (let dd = 1; dd <= dim; dd++) {
    const iso = `${fy}-${String(fm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const v = fpb[iso];
    if (dayNum(fy, fm, dd) > cutDn && v != null && Number.isFinite(Number(v))) {
      // O peso de um dia é o nº de quartos DESSE dia: 92/100 nos dias de
      // mudança de hora (o último domingo de Outubro tem 25 horas).
      const n = expectedQuartersForLisbonDay(iso);
      fpbUsed.push({ date: iso, value: Number(v), quarters: n });
      fpbSum += Number(v) * n;
    }
  }
  const monthEndIso = `${fy}-${String(fm).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
  const hasRemaining = (() => {
    for (let dd = 1; dd <= dim; dd++) if (dayNum(fy, fm, dd) > cutDn) return true;
    return false;
  })();
  const fcastQuarters = monthB.all.length + fpbUsed.reduce((a, d) => a + d.quarters, 0);
  const fcastSum = sum(monthB.all) + fpbSum;

  // Preço "à hora actual": o quarter que está a correr AGORA, em hora de
  // Lisboa (é o fuso da página; os instantes guardados já estão alinhados).
  const stamp = (dn, min) => `${isoOf(dn)}T${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  // O mesmo instante, em UTC ISO-8601 — é o que a página converte para o
  // fuso de quem a vê (o backend não sabe o fuso do utilizador). Atenção:
  // a meia-noite é a de LISBOA (lisbonMidnightUtc), não a de UTC — usar a
  // meia-noite UTC aqui fazia a página mostrar 01:00 no Verão.
  const stampUtc = (dn, min) => new Date(lisbonMidnightUtc(isoOf(dn)) + min * 60000).toISOString();
  // O dia civil de Lisboa começa à meia-noite local.
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
        date: isoOf(todayDn),
        value: round2(avg(todayB.all)),
        quarters: todayB.all.length,
        estQuarters: 0,
        sum: Math.round(sum(todayB.all) * 100) / 100,
        estimated: false,
        source: todayB.all.length ? 'market' : 'none',
      },
      tomorrow: tomorrowB.all.length ? {
        date: tomorrowIso,
        value: round2(avg(tomorrowB.all)),
        quarters: tomorrowB.all.length,
        estQuarters: 0,
        sum: Math.round(sum(tomorrowB.all) * 100) / 100,
        estimated: false,
        source: 'market',
      } : {
        date: tomorrowIso,
        value: fpbTomorrow == null ? null : round2(fpbTomorrow),
        quarters: 0,
        estQuarters: 0,
        sum: null,
        estimated: fpbTomorrow != null,
        source: fpbTomorrow == null ? 'none' : 'fpbd',
        fpbValue: fpbTomorrow == null ? null : round2(fpbTomorrow),
      },
      last30: {
        from: (() => { const s = dayStart(anchor.dn - 30); return stamp(s.dn, s.min); })(),
        fromUtc: (() => { const s = dayStart(anchor.dn - 30); return stampUtc(s.dn, s.min); })(),
        to: stamp(anchor.lisbonDn, anchor.lisbonMin),
        toUtc: anchor.utc || stampUtc(anchor.lisbonDn, anchor.lisbonMin),
        value: round2(avg(last30.all)),
        quarters: last30.all.length,
        estQuarters: last30.est,
        sum: Math.round(sum(last30.all) * 100) / 100,
      },
      forecast: {
        month: monthKeyNow,
        // Sem dias por publicar, é o mês fechado; com dias por publicar mas
        // sem futuro publicado para eles, fica vazio em vez de inventar.
        value: (!fcastQuarters || (hasRemaining && !fpbUsed.length)) ? null : round2(fcastSum / fcastQuarters),
        quarters: fcastQuarters,
        mtdQuarters: monthB.all.length,
        mtdSum: Math.round(sum(monthB.all) * 100) / 100,
        fpbDays: fpbUsed,
        sum: Math.round(fcastSum * 100) / 100,
        // Até onde chega a cobertura: fim do mês (completo) ou o último dia
        // com futuro publicado (parcial).
        coverageTo: !hasRemaining ? monthEndIso
          : fpbUsed.length ? fpbUsed[fpbUsed.length - 1].date : null,
      },
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
        quarters: monthB.all.length,
        estQuarters: monthB.est,
        sum: Math.round(sum(monthB.all) * 100) / 100,
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
  const nowMs = now.getTime();
  const cut = payload.cutoff ? dayNum(Number(payload.cutoff.slice(0, 4)), Number(payload.cutoff.slice(5, 7)), Number(payload.cutoff.slice(8, 10))) : Infinity;
  // Só mercado: os quarters estimados (para além do corte) nunca alimentam
  // o preço actual — quando o quarter em curso ainda não foi publicado,
  // fica o último publicado.
  const pool = (payload.recent || []).filter(r => r.dn <= cut);
  // Quando o instante real está disponível (produção), selecciona-se por ele —
  // é a única coisa que não se repete e não depende de fusos. Caso contrário
  // (testes/fallback), usa-se a leitura em hora de Lisboa.
  // (O fallback parte da meia-noite de LISBOA — não da de UTC, que punha
  // tudo uma hora ao lado no Verão.)
  const rowMs = (r) => r.utc ? new Date(r.utc).getTime() : (lisbonMidnightUtc(isoOf(r.lisbonDn)) + (r.lisbonMin || 0) * 60000);
  const sorted = [...pool].sort((a, b) => rowMs(a) - rowMs(b));
  let best = null;
  for (const r of sorted) {
    if (rowMs(r) > nowMs) break;
    best = r;
  }
  if (!best) return { at: null, price: null, live: false, estimated: false };
  const iso = best.utc ? best.utc : new Date(lisbonMidnightUtc(isoOf(best.lisbonDn)) + best.lisbonMin * 60000).toISOString();
  return {
    at: `${isoOf(best.lisbonDn)}T${pad2(Math.floor(best.lisbonMin / 60))}:${pad2(best.lisbonMin % 60)}`,
    atUtc: iso,
    price: round2(best.price),
    live: rowMs(best) === (nowMs - (nowMs % (15 * 60000))),
    estimated: false,
  };
}
