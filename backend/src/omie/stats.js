// Os números da página de estatísticas do OMIE (/omie e omie.cocofree.dev).
//
// Recebes as linhas de quartos de hora já reconciliadas (pipeline.js) e
// devolves um objecto com:
//   - months: uma linha por mês (13 meses), com a média simples e as médias
//     de vazio e fora de vazio ("cheia") nos ciclos semanal e diário;
//   - total: as mesmas médias sobre toda a janela de 366 dias;
//   - cards: os cartões (agora, hoje, amanhã, últimos 30 dias, previsão do
//     mês, mês até agora);
//   - recent: os últimos quartos, para recalcular o preço "agora" a cada
//     pedido (currentPrice).
// As escalas de cor das tabelas são feitas no frontend (frontend/omie.html).
//
// Regra da casa: as médias só usam preços reais do mercado. A única
// excepção são os futuros diários (FPB D), que entram no cartão "amanhã"
// quando o dia ainda não foi publicado e na previsão do mês. Detalhe em
// docs/09-omie-estatisticas.md.

// Tamanho da janela das tabelas, em dias.
export const WINDOW_DAYS = 366;
// Quantos quartos recentes ficam no payload, para o "preço à hora actual"
// poder ser recalculado a cada pedido (ver currentPrice).
export const TAIL_ROWS = 400;

import { lisbonMidnightUtc, expectedQuartersForLisbonDay, lisbonWallClock } from './convert.js';
import { dayNum, dayNumOf, isoOfDayNum as isoOf } from '../time.js';

const pad2 = (n) => String(n).padStart(2, '0');
// Os dias contam-se como números (dias desde 1970-01-01; vê time.js), para
// agrupar sem pensar em fusos. monthKey dá o 'AAAA-MM' de um desses números.
const monthKey = (n) => isoOf(n).slice(0, 7);

// "Agora" em UTC: dia, minutos desde a meia-noite UTC e número do dia.
export function utcNow(now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return { day, minutes, dayNum: dayNumOf(day) };
}
// "Agora" em hora de Lisboa (o fuso em que a página agrupa os dias).
export function lisbonNow(now = new Date()) {
  const { day, minutes } = lisbonWallClock(now.getTime());
  return { day, minutes, dayNum: dayNumOf(day) };
}

const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// Um "balde" onde vais deitando quartos para depois tirar médias: todos,
// vazio/fora no ciclo semanal (semV/semF) e no diário (diaV/diaF), o
// primeiro e o último dia vistos e quantos eram estimativas.
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
// Passa um balde ao formato da API (médias arredondadas a 2 casas, contagens
// e soma, para as tooltips mostrarem a conta).
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
// Um mês está incompleto se não tem todos os dias: o primeiro mês da janela
// pode começar a meio (cut: 'start') e o mês corrente ainda não acabou
// (cut: 'end').
function partialOf(mk, b) {
  const [y, m] = mk.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const domMin = Number(isoOf(b.dnMin).slice(8, 10));
  const domMax = Number(isoOf(b.dnMax).slice(8, 10));
  if (domMin > 1) return { partial: true, cut: 'start' };
  if (domMax < lastDay) return { partial: true, cut: 'end' };
  return { partial: false, cut: null };
}

// Monta o payload da página.
//   rows:     [{ dn, mk, min, bd, bs, price, est, utc }]
//             (vê rebuildDerived em pipeline.js)
//   cutoff:   último dia com preço real ('AAAA-MM-DD')
//   fpbDaily: futuros diários { 'AAAA-MM-DD': €/MWh }
export function aggregate(rows, { cutoff = null, now = new Date(), fpbDaily = {} } = {}) {
  if (!rows.length) throw new Error('sem dados de quartos-horários');
  const cutDn = cutoff ? dayNumOf(cutoff) : Infinity;
  // Preços reais: até ao `cutoff` e sem a marca de estimativa.
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

  // "Total geral": média de TODOS os quartos da janela (não a média das
  // médias mensais; um mês com mais quartos pesa mais).
  const win = bucket();
  for (const r of real) if (r.dn >= fromDn) push(win, r);

  // Cartões. A "âncora" é o último quarto com preço real: os "últimos 30
  // dias" e o "mês até agora" contam até ele. "Hoje" e "amanhã" são dias
  // de calendário de Lisboa.
  const anchor = real[real.length - 1];
  // Um balde por dia, só com preços reais. Se hoje ainda não tiver nenhum
  // quarto publicado, o cartão "hoje" mostra o último dia com dados.
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
  // Se amanhã ainda não tem preços reais, usa-se o futuro diário dessa data
  // (marcado como futuro na resposta).
  const fpb = fpbDaily || {};
  const fpbTomorrow = fpb[tomorrowIso] != null && Number.isFinite(Number(fpb[tomorrowIso]))
    ? Number(fpb[tomorrowIso]) : null;
  const last30 = bucket();
  for (const r of real) if (r.dn >= anchor.dn - 30) push(last30, r);
  // Mês corrente até ao último preço real (igual à primeira linha da tabela).
  const monthKeyNow = monthKey(lis.dayNum);
  const monthB = bucket();
  for (const r of real) if (r.mk === monthKeyNow) push(monthB, r);
  // Previsão do mês: média ponderada por quartos de
  //   (preços reais do mês até agora) + (futuro diário × quartos de cada dia
  //   que falta e tem futuro publicado).
  // Dias sem futuro ficam de fora; `coverageTo` diz até onde chega.
  const [fy, fm] = monthKeyNow.split('-').map(Number);
  const dim = new Date(Date.UTC(fy, fm, 0)).getUTCDate();
  const fpbUsed = [];
  let fpbSum = 0;
  for (let dd = 1; dd <= dim; dd++) {
    const iso = `${fy}-${String(fm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const v = fpb[iso];
    if (dayNum(fy, fm, dd) > cutDn && v != null && Number.isFinite(Number(v))) {
      // Cada dia pesa o número de quartos que tem (92/96/100).
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

  // Formatação de (dia, minutos) de Lisboa como 'AAAA-MM-DDTHH:MM'.
  const stamp = (dn, min) => `${isoOf(dn)}T${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  // O mesmo, como instante UTC: a página converte-o para o fuso de quem vê.
  // Parte-se da meia-noite de LISBOA, não da de UTC.
  const stampUtc = (dn, min) => new Date(lisbonMidnightUtc(isoOf(dn)) + min * 60000).toISOString();
  const dayStart = (dn) => ({ dn, min: 0 });

  // Os últimos quartos, guardados no payload para currentPrice() poder
  // recalcular o preço "agora" a cada pedido.
  const recent = rows
    .filter(r => r.dn <= lastDn + 1)
    .slice(-TAIL_ROWS)
    .map(r => ({ dn: r.dn, min: r.min, price: r.price, utc: r.utc }));
  const cutoffIso = cutoff || isoOf(lastDn);

  return {
    generatedAt: now.toISOString(),
    cutoff: cutoffIso,
    dataThrough: stamp(anchor.dn, anchor.min),
    dataThroughUtc: anchor.utc || stampUtc(anchor.dn, anchor.min),
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
        to: stamp(anchor.dn, anchor.min),
        toUtc: anchor.utc || stampUtc(anchor.dn, anchor.min),
        value: round2(avg(last30.all)),
        quarters: last30.all.length,
        estQuarters: last30.est,
        sum: Math.round(sum(last30.all) * 100) / 100,
      },
      forecast: {
        month: monthKeyNow,
        // null se faltam dias e nenhum tem futuro publicado.
        value: (!fcastQuarters || (hasRemaining && !fpbUsed.length)) ? null : round2(fcastSum / fcastQuarters),
        quarters: fcastQuarters,
        mtdQuarters: monthB.all.length,
        mtdSum: Math.round(sum(monthB.all) * 100) / 100,
        fpbDays: fpbUsed,
        sum: Math.round(fcastSum * 100) / 100,
        // Último dia coberto: fim do mês, ou o último com futuro publicado.
        coverageTo: !hasRemaining ? monthEndIso
          : fpbUsed.length ? fpbUsed[fpbUsed.length - 1].date : null,
      },
      monthToDate: {
        month: monthKeyNow,
        from: (() => {
          const s = dayStart(dayNumOf(`${monthKeyNow}-01`));
          return stamp(s.dn, s.min);
        })(),
        fromUtc: (() => {
          const s = dayStart(dayNumOf(`${monthKeyNow}-01`));
          return stampUtc(s.dn, s.min);
        })(),
        to: stamp(anchor.dn, anchor.min),
        toUtc: anchor.utc || stampUtc(anchor.dn, anchor.min),
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

// O preço do quarto de hora que está a decorrer agora (ou do último com
// preço real, se o actual ainda não foi publicado; nesse caso live: false).
// Chama-se a cada pedido, porque o payload guardado tem horas e o quarto
// muda a cada 15 minutos. O preço em si só muda quando o OMIE publica: ele
// publica o dia inteiro de uma vez.
export function currentPrice(payload, now = new Date()) {
  const nowMs = now.getTime();
  const cut = payload.cutoff ? dayNumOf(payload.cutoff) : Infinity;
  // Só preços reais (até ao cutoff).
  const pool = (payload.recent || []).filter(r => r.dn <= cut);
  // O instante de cada linha: `utc` se existir; senão, calcula-se a partir
  // do dia e minutos de Lisboa.
  const rowMs = (r) => r.utc ? new Date(r.utc).getTime() : (lisbonMidnightUtc(isoOf(r.dn)) + (r.min || 0) * 60000);
  const sorted = [...pool].sort((a, b) => rowMs(a) - rowMs(b));
  let best = null;
  for (const r of sorted) {
    if (rowMs(r) > nowMs) break;
    best = r;
  }
  if (!best) return { at: null, price: null, live: false, estimated: false };
  const iso = best.utc ? best.utc : new Date(lisbonMidnightUtc(isoOf(best.dn)) + best.min * 60000).toISOString();
  return {
    at: `${isoOf(best.dn)}T${pad2(Math.floor(best.min / 60))}:${pad2(best.min % 60)}`,
    atUtc: iso,
    price: round2(best.price),
    live: rowMs(best) === (nowMs - (nowMs % (15 * 60000))),
    estimated: false,
  };
}
