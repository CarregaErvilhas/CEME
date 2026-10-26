// Regiões e períodos horários.
//
// Simulas carregamentos em três regiões: Portugal Continental (CONT),
// Madeira (MAD) e Açores (AZO). Cada uma tem o seu fuso horário, a sua taxa
// de IVA e as suas regras de "vazio" e "fora de vazio".
//
// Vazio / fora de vazio: num tarifário bi-horário a electricidade é mais
// barata nas horas de vazio (noite e parte do fim-de-semana). Há dois
// ciclos, definidos pela ERSE (o regulador da energia):
//   - DIARIO: as mesmas horas todos os dias;
//   - SEMANAL: dias úteis, sábado e domingo têm horas diferentes.
// Um tarifário SIMPLES tem um preço só, e o período é sempre UNICO.
//
// Fontes e tabelas completas das ilhas: docs/07-ilhas.md.
//
// Feriados contam como um dia normal da semana em que calham (regra
// OWN_DAY). Em aberto: confirmar a regra de feriados para MT no ciclo
// semanal (docs/06).
//
// A hora de Verão (DST) no Continente vai do último domingo de Março ao
// último domingo de Outubro. Nas ilhas a época de Verão do sábado é por
// mês (Junho a Outubro), não por DST.
import { euDstRange, zonedParts } from '../time.js';

// true se o instante `date` estiver na hora de Verão de Lisboa (a UE muda
// sempre às 01:00 UTC: em Março 00:59 → 02:00, em Outubro 01:59 → 01:00).
export function isDstLisbon(date) {
  const { start, end } = euDstRange(date.getUTCFullYear());
  const t = date.getTime();
  return t >= start && t < end;
}
// O mesmo, para um dia de calendário (ao meio-dia UTC, longe das mudanças).
export function isDstLisbonYMD(Y, M, D) {
  return isDstLisbon(new Date(Date.UTC(Y, M - 1, D, 12, 0)));
}

// tz: fuso IANA; vat: multiplicador do IVA normal (1.23 = 23 %);
// omieIndexed: false onde o mercado ibérico não chega (as ilhas têm redes
// isoladas), e aí os indexados levam um aviso (docs/07).
export const REGIONS = {
  CONT: { tz: 'Europe/Lisbon', vat: 1.23, omieIndexed: true, label: 'Portugal Continental' },
  MAD: { tz: 'Atlantic/Madeira', vat: 1.22, omieIndexed: false, label: 'Madeira' },
  AZO: { tz: 'Atlantic/Azores', vat: 1.16, omieIndexed: false, label: 'Açores' },
};

// Horas convertidas em minutos desde a meia-noite, para comparar intervalos.
const h = (hh, mm) => hh * 60 + mm;
const inRanges = (m, ranges) => ranges.some(([a, b]) => m >= a && m < b);

// Intervalos de fora de vazio ao sábado, no ciclo semanal das ilhas.
// Junho a Outubro é Verão; o resto do ano é Inverno.
function islandSaturdayRanges(region, month) {
  if (region === 'MAD') {
    return (month >= 6 && month <= 10)
      ? [[h(11, 0), h(14, 30)], [h(19, 30), h(23, 0)]]
      : [[h(11, 30), h(14, 0)], [h(18, 0), h(22, 30)]];
  }
  // AZO (fontes: precário BTN da EDA e ERSE, ver docs/07-ilhas.md)
  return (month >= 6 && month <= 10)
    ? [[h(11, 0), h(14, 30)], [h(19, 30), h(23, 0)]]
    : [[h(11, 30), h(13, 30)], [h(18, 0), h(23, 0)]];
}

// Lê um instante no relógio da região: dia da semana ('Mon'..'Sun'),
// minutos desde a meia-noite e mês (1..12).
export function regionParts(region, date) {
  const { weekday, minutes, month } = zonedParts(date, (REGIONS[region] || REGIONS.CONT).tz);
  return { weekday, minutes, month };
}

// As regras propriamente ditas. Recebem a hora já lida no relógio da região,
// por isso servem tanto para um instante como para uma hora de calendário.
function core({ region, schedule, cycle, weekday, minutes, month, isSummer }) {
  if (schedule === 'SIMPLES') return 'UNICO';
  if (cycle === 'DIARIO') {
    if (region === 'MAD') return (minutes >= h(9, 0) && minutes < h(23, 0)) ? 'FORA_VAZIO' : 'VAZIO';
    return (minutes >= h(8, 0) && minutes < h(22, 0)) ? 'FORA_VAZIO' : 'VAZIO';
  }
  if (weekday === 'Sun') return 'VAZIO';
  if (region === 'CONT') {
    if (weekday !== 'Sat') return minutes >= h(7, 0) ? 'FORA_VAZIO' : 'VAZIO';
    // Sábado: no Continente, Verão/Inverno segue a hora legal (DST).
    const fora = isSummer
      ? ((minutes >= h(9, 0) && minutes < h(14, 0)) || (minutes >= h(20, 0) && minutes < h(22, 0)))
      : ((minutes >= h(9, 30) && minutes < h(13, 0)) || (minutes >= h(18, 30) && minutes < h(22, 0)));
    return fora ? 'FORA_VAZIO' : 'VAZIO';
  }
  // MAD e AZO: dias úteis fora de vazio das 07:00 às 24:00, o ano todo.
  if (weekday !== 'Sat') return minutes >= h(7, 0) ? 'FORA_VAZIO' : 'VAZIO';
  return inRanges(minutes, islandSaturdayRanges(region, month)) ? 'FORA_VAZIO' : 'VAZIO';
}

// Período a partir de um dia de calendário ('AAAA-MM-DD') e minutos de
// relógio. Útil para séries que já vêm em hora local. O dia da semana lê-se
// ao meio-dia UTC, longe de qualquer mudança de hora.
export function periodForWall({ region = 'CONT', schedule, cycle, ymd, minutes }) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const tz = (REGIONS[region] || REGIONS.CONT).tz;
  const { weekday } = zonedParts(new Date(Date.UTC(Y, M - 1, D, 12, 0)), tz);
  const isSummer = region === 'CONT' ? isDstLisbonYMD(Y, M, D) : (M >= 6 && M <= 10);
  return core({ region, schedule, cycle, weekday, minutes, month: M, isSummer });
}
// Período de um instante (Date), lido no relógio da região.
export function periodForRegion({ region = 'CONT', schedule, cycle, at }) {
  const { weekday, minutes, month } = regionParts(region, at);
  const isSummer = region === 'CONT' ? isDstLisbon(at) : (month >= 6 && month <= 10);
  return core({ region, schedule, cycle, weekday, minutes, month, isSummer });
}
