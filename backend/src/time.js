// Contas de datas e horas que o motor (engine/) e o OMIE (omie/) partilham.
//
// Três ideias que vais ver por todo o lado:
//   - Um dia de calendário escreve-se 'AAAA-MM-DD' (texto). Para somar ou
//     comparar dias, passa-o a número (dias desde 1970-01-01) com dayNumOf()
//     e volta com isoOfDayNum(). Assim não há fusos pelo meio.
//   - A hora muda na UE no último domingo de Março e no último domingo de
//     Outubro, sempre às 01:00 UTC (euDstDays, euDstRange).
//   - Para saberes que horas são num fuso, usa zonedParts(instante, fuso). Os
//     formatadores do Intl são caros de criar, por isso guarda-se um por fuso.

const DAY_MS = 86_400_000;
const pad2 = (n) => String(n).padStart(2, '0');

// ---- Dias como números ----

export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
export const dayNumOf = (iso) => dayNum(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
export const isoOfDayNum = (n) => {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
// 'AAAA-MM-DD' mais `delta` dias (pode ser negativo).
export const shiftDays = (iso, delta) => isoOfDayNum(dayNumOf(iso) + delta);

// "5/3/2026" (dia/mês/ano, como o OMIE e o TF escrevem) → '2026-03-05', ou
// null se não tiver essa forma.
export function dmyToIso(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text ?? '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ---- Mudança de hora (UE) ----

// O dia do mês do último domingo de `month` (1..12) no ano `year`.
function lastSunday(year, month) {
  const last = new Date(Date.UTC(year, month, 0)); // dia 0 do mês seguinte = último deste
  return last.getUTCDate() - last.getUTCDay();
}

// Os dois dias de mudança de hora de um ano: { spring, autumn } em
// 'AAAA-MM-DD'. Em `spring` o dia tem 23 h, em `autumn` 25 h.
export function euDstDays(year) {
  return {
    spring: `${year}-03-${pad2(lastSunday(year, 3))}`,
    autumn: `${year}-10-${pad2(lastSunday(year, 10))}`,
  };
}

// O intervalo da hora de Verão de um ano, em ms UTC: [start, end).
export function euDstRange(year) {
  return {
    start: Date.UTC(year, 2, lastSunday(year, 3), 1),
    end: Date.UTC(year, 9, lastSunday(year, 10), 1),
  };
}

// ---- Relógio de um fuso ----

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    });
    formatters.set(tz, f);
  }
  return f;
}

// O instante `date` lido no relógio do fuso `tz`:
//   { year, month (1..12), day, hour, minute, second, weekday ('Mon'..'Sun'),
//     ymd ('AAAA-MM-DD'), minutes (desde a meia-noite), offset ('+01:00') }
export function zonedParts(date, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(date)) p[type] = value;
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  // `% 24`: alguns motores JS escrevem "24" à meia-noite.
  const hour = Number(p.hour) % 24, minute = Number(p.minute);
  return {
    year, month, day, hour, minute, second: Number(p.second), weekday: p.weekday,
    ymd: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + minute,
    offset: normalizeOffset(p.timeZoneName),
  };
}

// O Intl devolve o offset como "GMT", "GMT+1", "GMT-3:30" ou "GMT+01:00",
// conforme o ambiente. Isto passa-o sempre a ±HH:MM.
function normalizeOffset(tzName) {
  const s = String(tzName || '').replace('GMT', '').trim();
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return '+00:00';
  return `${m[1]}${pad2(m[2])}:${m[3] || '00'}`;
}
