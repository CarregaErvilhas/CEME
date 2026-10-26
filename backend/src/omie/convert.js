// Contas de datas e horas para o OMIE.
//
// O OMIE publica os preços por "dia de mercado" e "período": o período N é o
// N-ésimo quarto de hora do dia, contado a partir da meia-noite de MADRID
// (CET no Inverno, CEST no Verão). Portugal está uma hora atrás. Aqui
// convertes isso em instantes UTC e em dias/horas de Lisboa.
//
// O que tens de ter sempre em mente:
//   - A hora muda no último domingo de Março e no último domingo de Outubro,
//     sempre às 01:00 UTC. Em Março o dia tem 23 h (92 quartos), em Outubro
//     25 h (100 quartos).
//   - Em Outubro, a mesma hora de relógio acontece duas vezes. Só o instante
//     UTC (ou o offset) as distingue.

// Horas de diferença de Madrid para UTC: CET = +1 (Inverno), CEST = +2 (Verão).
const CET_OFFSETS = { winter: 1, summer: 2 };

// Os dois dias de mudança de hora do ano de `isoDate` ('AAAA-MM-DD').
function dstBounds(isoDate) {
  const y = Number(isoDate.slice(0, 4));
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(y, month, 31));
    const dow = d.getUTCDay();
    return 31 - dow;
  };
  return {
    spring: `${y}-03-${String(lastSunday(2)).padStart(2, '0')}`,
    autumn: `${y}-10-${String(lastSunday(9)).padStart(2, '0')}`,
  };
}

// O offset de Madrid à MEIA-NOITE do dia de mercado.
//
// Como a mudança é às 01:00 UTC, depois da meia-noite local, o dia da
// mudança começa ainda com o offset antigo:
//   - Março: a meia-noite é CET (+1); às 02:00 salta para as 03:00
//     (92 períodos);
//   - Outubro: a meia-noite é CEST (+2); às 03:00 volta às 02:00
//     (100 períodos).
// A partir da meia-noite basta somar 15 minutos por período.
function cetOffsetOn(isoDate) {
  const { spring, autumn } = dstBounds(isoDate);
  if (isoDate === autumn) return CET_OFFSETS.summer; // a meia-noite ainda é CEST
  if (isoDate === spring) return CET_OFFSETS.winter;  // a meia-noite ainda é CET
  return (isoDate > spring && isoDate < autumn) ? CET_OFFSETS.summer : CET_OFFSETS.winter;
}

// Converte (dia de mercado, período) no início desse quarto de hora.
// Devolve { iso (hora de Lisboa com offset), utc (ISO terminado em Z), error }.
// Períodos fora de 1..100 são recusados; quantos existem de facto num dia
// é o ficheiro oficial que diz.
export function marketPeriodToLisbon(marketDayIso, marketPeriod) {
  if (!Number.isInteger(marketPeriod) || marketPeriod < 1 || marketPeriod > 100) {
    return { iso: null, error: `bad_period:${marketPeriod}` };
  }
  const minutes = (marketPeriod - 1) * 15;
  const cetOff = cetOffsetOn(marketDayIso);
  // instante = meia-noite de Madrid + 15 min × (período − 1)
  const utcMs = Date.parse(`${marketDayIso}T00:00:00+0${cetOff}:00`) + minutes * 60_000;
  if (Number.isNaN(utcMs)) return { iso: null, error: 'bad_day' };
  const utc = new Date(utcMs);
  // Escreve o instante em hora de Lisboa, com o offset (+00:00 ou +01:00).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(utc);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00${normalizeOffset(get('timeZoneName'))}`;
  return { iso, utc: utc.toISOString(), error: null };
}

// O Intl devolve o offset como "GMT+1", "GMT-3:30" ou "GMT+01:00", conforme
// o ambiente. Isto passa-o sempre a ±HH:MM.
function normalizeOffset(tzName) {
  const s = String(tzName || '').replace('GMT', '').trim();
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return '+00:00';
  return `${m[1]}${String(m[2]).padStart(2, '0')}:${m[3] || '00'}`;
}

// Quantos quartos de hora tem um dia de Lisboa: 92 no último domingo de
// Março, 100 no último domingo de Outubro, 96 nos outros.
export function expectedQuartersForLisbonDay(lisbonDayIso) {
  const y = Number(lisbonDayIso.slice(0, 4));
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(y, month, 31));
    return 31 - d.getUTCDay();
  };
  const spring = `${y}-03-${String(lastSunday(2)).padStart(2, '0')}`;
  const autumn = `${y}-10-${String(lastSunday(9)).padStart(2, '0')}`;
  if (lisbonDayIso === spring) return 92;
  if (lisbonDayIso === autumn) return 100;
  return 96;
}

// Um dia de calendário como número inteiro (dias desde 1970-01-01). Dá
// jeito para somar/subtrair dias e comparar datas sem pensar em fusos.
export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
export const dayNumOf = (isoDate) => dayNum(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)));
export const isoOfDayNum = (n) => {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

// Lê um ISO que já está em hora de Lisboa (com offset) e devolve o dia, os
// minutos desde a meia-noite e o offset. É o offset que distingue as duas
// passagens da hora repetida em Outubro.
export function lisbonParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(String(iso || ''));
  if (!m) return null;
  return {
    day: `${m[1]}-${m[2]}-${m[3]}`,
    minutes: Number(m[4]) * 60 + Number(m[5]),
    offset: m[7] || null,
  };
}

// Dia e minutos desde a meia-noite em Lisboa, a partir de um instante em
// milissegundos (epoch).
export function lisbonWallClock(utcMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// O dia de calendário ('AAAA-MM-DD') de um instante num fuso; por omissão,
// Lisboa. É ESTE o "hoje" que deves usar para validades de tarifários, TAR e
// dias do OMIE. Não uses `CURRENT_DATE` na BD nem
// `new Date().toISOString().slice(0, 10)`: os dois dão o dia em UTC, que
// entre a meia-noite e a 01:00 de Verão em Lisboa ainda é ontem.
export function civilDay(at = new Date(), tz = 'Europe/Lisbon') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// A meia-noite de um dia de Lisboa, em milissegundos UTC.
// No dia da mudança, a meia-noite ainda está no offset antigo: WET (+0) em
// Março, WEST (+1) em Outubro.
export function lisbonMidnightUtc(dayIso) {
  const { spring, autumn } = dstBounds(dayIso);
  const y = Number(dayIso.slice(0, 4)), m = Number(dayIso.slice(5, 7)), d = Number(dayIso.slice(8, 10));
  let offHours;
  if (dayIso === spring) offHours = 0;
  else if (dayIso === autumn) offHours = 1;
  else offHours = (dayIso > spring && dayIso < autumn) ? 1 : 0;
  return Date.UTC(y, m - 1, d, 0, 0) - offHours * 3600000;
}

// Todos os quartos de hora de um dia de Lisboa, por ordem, cada um com o
// instante UTC, o dia e os minutos de relógio. 92, 96 ou 100 entradas.
export function lisbonDayQuarters(dayIso) {
  const start = lisbonMidnightUtc(dayIso);
  const n = expectedQuartersForLisbonDay(dayIso);
  const out = [];
  for (let i = 0; i < n; i++) {
    const utcMs = start + i * 15 * 60000;
    out.push({ utc: new Date(utcMs).toISOString(), ...lisbonWallClock(utcMs) });
  }
  return out;
}
