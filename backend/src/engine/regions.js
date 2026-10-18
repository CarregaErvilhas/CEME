// Regiões: timezone IANA, IVA normal (mobilidade = taxa normal;
// a taxa reduzida dos primeiros kWh é do fornecimento doméstico, não Mobi.E),
// ciclos bi-horários BTN por região (fontes em docs/07-ilhas.md).
// Feriados: OWN_DAY em todas as regiões (directiva do dono + sheet não tem
// excepção). Nota: Diretiva 3/2026 n.10 manda domingos nos feriados para
// MT em ciclo semanal — fica como validação aberta para MT, não aplicada.

// DST (hora legal de Verão) em Portugal continental: último domingo de março →
// último domingo de outubro. As ilhas usam meses (Jun–Out), não DST.
function lastSundayOfMonth(y, m) {
  const d = new Date(Date.UTC(y, m + 1, 0)); // último dia do mês
  const dow = d.getUTCDay(); // 0=dom
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
export function isDstLisbon(date) {
  const y = date.getUTCFullYear();
  const start = lastSundayOfMonth(y, 2); // março
  start.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 02:00 CET? aprox; transição real 01:00 UTC
  const end = lastSundayOfMonth(y, 9); // outubro
  end.setUTCHours(1, 0, 0, 0);
  return date >= start && date < end;
}
export function isDstLisbonYMD(Y, M, D) {
  return isDstLisbon(new Date(Date.UTC(Y, M - 1, D, 12, 0)));
}

export const REGIONS = {
  CONT: { tz: 'Europe/Lisbon', vat: 1.23, omieIndexed: true, label: 'Portugal Continental' },
  MAD: { tz: 'Atlantic/Madeira', vat: 1.22, omieIndexed: false, label: 'Madeira' },
  AZO: { tz: 'Atlantic/Azores', vat: 1.16, omieIndexed: false, label: 'Açores' },
};

const h = (hh, mm) => hh * 60 + mm;
const inRanges = (m, ranges) => ranges.some(([a, b]) => m >= a && m < b);

// Meses 6..10 = época Jun–Out (critério ERSE para as ilhas, por mês e não por DST).
const summerSeason = (y, mo, d) => mo >= 6 && mo <= 10;

function islandSaturdayRanges(region, month) {
  if (region === 'MAD') {
    return (month >= 6 && month <= 10)
      ? [[h(11, 0), h(14, 30)], [h(19, 30), h(23, 0)]]
      : [[h(11, 30), h(14, 0)], [h(18, 0), h(22, 30)]];
  }
  // AZO — EDA precário BTN + ERSE (ver docs/07-ilhas.md)
  return (month >= 6 && month <= 10)
    ? [[h(11, 0), h(14, 30)], [h(19, 30), h(23, 0)]]
    : [[h(11, 30), h(13, 30)], [h(18, 0), h(23, 0)]];
}

export function regionParts(region, date) {
  const tz = (REGIONS[region] || REGIONS.CONT).tz;
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  return {
    weekday: p.weekday,
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    month: parseInt(p.month, 10),
  };
}

// Núcleo único das regras (instante ou parede horária): feriados = próprio
// dia (OWN_DAY), sem excepção.
function core({ region, schedule, cycle, weekday, minutes, month, isSummer }) {
  if (schedule === 'SIMPLES') return 'UNICO';
  if (cycle === 'DIARIO') {
    if (region === 'MAD') return (minutes >= h(9, 0) && minutes < h(23, 0)) ? 'FORA_VAZIO' : 'VAZIO';
    return (minutes >= h(8, 0) && minutes < h(22, 0)) ? 'FORA_VAZIO' : 'VAZIO';
  }
  if (weekday === 'Sun') return 'VAZIO';
  if (region === 'CONT') {
    if (weekday !== 'Sat') return minutes >= h(7, 0) ? 'FORA_VAZIO' : 'VAZIO';
    // sábado: época por hora legal (DST) — Verão vs Inverno (ERSE §2.1)
    const fora = isSummer
      ? ((minutes >= h(9, 0) && minutes < h(14, 0)) || (minutes >= h(20, 0) && minutes < h(22, 0)))
      : ((minutes >= h(9, 30) && minutes < h(13, 0)) || (minutes >= h(18, 30) && minutes < h(22, 0)));
    return fora ? 'FORA_VAZIO' : 'VAZIO';
  }
  // MAD + AZO: dias úteis Fora 07:00–24:00 ano todo; domingo vazio
  if (weekday !== 'Sat') return minutes >= h(7, 0) ? 'FORA_VAZIO' : 'VAZIO';
  return inRanges(minutes, islandSaturdayRanges(region, month)) ? 'FORA_VAZIO' : 'VAZIO';
}

// Variante para séries (CSV quarto-horário): dia civil + minutos de parede,
// weekday tirado ao meio-dia UTC (imune a bordas de DST).
export function periodForWall({ region = 'CONT', schedule, cycle, ymd, minutes }) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const tz = (REGIONS[region] || REGIONS.CONT).tz;
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(Date.UTC(Y, M - 1, D, 12, 0)));
  const isSummer = region === 'CONT' ? isDstLisbonYMD(Y, M, D) : (M >= 6 && M <= 10);
  return core({ region, schedule, cycle, weekday, minutes, month: M, isSummer });
}
export function periodForRegion({ region = 'CONT', schedule, cycle, at }) {
  const { weekday, minutes, month } = regionParts(region, at);
  const isSummer = region === 'CONT' ? isDstLisbon(at) : (month >= 6 && month <= 10);
  return core({ region, schedule, cycle, weekday, minutes, month, isSummer });
}
