// Conversão dia de mercado (CET) + período 1..96 → instante Europe/Lisbon.
// O leilão corre em CET; Portugal segue Europe/Lisbon (DST próprio).
// Regras defensivas:
// - a hora inexistente da primavera nunca pode resultar em ts_lisbon válido;
// - a hora repetida do outono distingue-se pelo offset, não pelo wall-clock.

const CET_OFFSETS = { winter: 1, summer: 2 }; // CET=+1, CEST=+2

// Último domingo de março (02:00 CET -> 03:00 CEST) e de outubro (inverso).
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

// Offset de Madrid à MEIA-NOITE do dia de mercado.
//
// A transição da hora de verão legal acontece sempre às 01:00 UTC — ou seja,
// *depois* da meia-noite local. Por isso o dia de mercado da mudança de hora
// começa com o offset antigo e acaba com o novo:
//   - manhã (último domingo de março): a meia-noite é CET (+1) e às 02:00
//     salta para as 03:00 (o dia tem 92 períodos);
//   - outono (último domingo de outubro): a meia-noite é CEST (+2) e às
//     03:00 recua para as 02:00 (o dia tem 100 períodos).
//
// Errar aqui significa que o dia inteiro da mudança fica uma hora fora — por
// isso o offset é do dia *da transição*, não do período.
function cetOffsetOn(isoDate) {
  const { spring, autumn } = dstBounds(isoDate);
  if (isoDate === autumn) return CET_OFFSETS.summer; // a meia-noite ainda é CEST
  if (isoDate === spring) return CET_OFFSETS.winter;  // a meia-noite ainda é CET
  return (isoDate > spring && isoDate < autumn) ? CET_OFFSETS.summer : CET_OFFSETS.winter;
}

// Devolve o ISO com offset de Lisboa para o início do quarto-horário.
//
// O dia de mercado tem 96 períodos — 92 na manhã (o dia de mudança de hora
// perde uma hora) e 100 no Outono (ganha uma). O ficheiro oficial é a
// verdade sobre quantos há; aqui só se recusa o que é impossível.
export function marketPeriodToLisbon(marketDayIso, marketPeriod) {
  if (!Number.isInteger(marketPeriod) || marketPeriod < 1 || marketPeriod > 100) {
    return { iso: null, error: `bad_period:${marketPeriod}` };
  }
  const minutes = (marketPeriod - 1) * 15;
  const cetOff = cetOffsetOn(marketDayIso);
  // instante UTC = meia-noite CET + minutos
  const utcMs = Date.parse(`${marketDayIso}T00:00:00+0${cetOff}:00`) + minutes * 60_000;
  if (Number.isNaN(utcMs)) return { iso: null, error: 'bad_day' };
  const utc = new Date(utcMs);
  // formata em Europe/Lisbon com offset numérico
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).formatToParts(utc);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00${normalizeOffset(get('timeZoneName'))}`;
  return { iso, utc: utc.toISOString(), error: null };
}

// O offset que o Intl devolve é "GMT+1", "GMT-3:30" ou "GMT+01:00"
// (consoante o ICU e o locale). Normaliza-se para ±HH:MM — sem isto o ISO
// saía com "+100:00", que não é um offset válido.
function normalizeOffset(tzName) {
  const s = String(tzName || '').replace('GMT', '').trim();
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return '+00:00';
  return `${m[1]}${String(m[2]).padStart(2, '0')}:${m[3] || '00'}`;
}

// Nº esperado de quartos num dia civil de Lisboa (92/96/100).
export function expectedQuartersForLisbonDay(lisbonDayIso) {
  // dias de mudança de hora em PT: último domingo de março/outubro
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

// O mesmo dia civil em número de dias desde a época (só a data conta, o
// fuso não entra): serve para ordenar, subtrair dias e agrupar por mês.
export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
export const dayNumOf = (isoDate) => dayNum(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)));
export const isoOfDayNum = (n) => {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

// Partes de um instante em hora de Lisboa: o dia civil e os minutos desde a
// meia-noite local. O ISO já vem com o offset, por isso é hora de Lisboa —
// e no dia da mudança de hora o offset distingue as duas passagem da hora
// repetida.
export function lisbonParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(String(iso || ''));
  if (!m) return null;
  return {
    day: `${m[1]}-${m[2]}-${m[3]}`,
    minutes: Number(m[4]) * 60 + Number(m[5]),
    offset: m[7] || null,
  };
}

// O mesmo, a partir do instante (epoch ms) — é o que a reconciliação usa,
// porque o instante é a única coisa que não se repete.
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

// A meia-noite local de um dia de Lisboa, em UTC.
//
// A mudança de hora acontece às 01:00 UTC — sempre *depois* da meia-noite
// local. Por isso a meia-noite do dia da transição ainda está no offset
// antigo: WET (+0) na manhã, WEST (+1) no Outono. É isso que dá ao dia de
// Lisboa 23 horas em Março e 25 em Outubro.
export function lisbonMidnightUtc(dayIso) {
  const { spring, autumn } = dstBounds(dayIso);
  const y = Number(dayIso.slice(0, 4)), m = Number(dayIso.slice(5, 7)), d = Number(dayIso.slice(8, 10));
  let offHours;
  if (dayIso === spring) offHours = 0;        // WET — a meia-noite é antes da mudança
  else if (dayIso === autumn) offHours = 1;   // WEST — a meia-noite é antes da mudança
  else offHours = (dayIso > spring && dayIso < autumn) ? 1 : 0;
  return Date.UTC(y, m - 1, d, 0, 0) - offHours * 3600000;
}

// Os instantes dos quartos de um dia civil de Lisboa, por ordem. É a
// sequência de 15 minutos que começa à meia-noite local — e que, num dia de
// mudança de hora, tem 92 ou 100 quartos em vez de 96.
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
