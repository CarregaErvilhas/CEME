// Conversão dia de mercado (CET) + período 1..96 → instante Europe/Lisbon.
// O leilão corre em CET; Portugal segue Europe/Lisbon (DST próprio).
// Regras defensivas:
// - a hora inexistente da primavera nunca pode resultar em ts_lisbon válido;
// - a hora repetida do outono distingue-se pelo offset, não pelo wall-clock.

const CET_OFFSETS = { winter: 1, summer: 2 }; // CET=+1, CEST=+2

function cetOffsetOn(isoDate) {
  // Último domingo de março (02:00 CET -> 03:00 CEST) e de outubro (inverso).
  const y = Number(isoDate.slice(0, 4));
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(y, month, 31));
    const dow = d.getUTCDay();
    return 31 - dow;
  };
  const dstStart = `${y}-03-${String(lastSunday(2)).padStart(2, '0')}`;
  const dstEnd = `${y}-10-${String(lastSunday(9)).padStart(2, '0')}`;
  return (isoDate >= dstStart && isoDate < dstEnd) ? CET_OFFSETS.summer : CET_OFFSETS.winter;
}

// Devolve o ISO com offset de Lisboa para o início do quarto-horário.
export function marketPeriodToLisbon(marketDayIso, marketPeriod) {
  if (!Number.isInteger(marketPeriod) || marketPeriod < 1 || marketPeriod > 96) {
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
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZoneName: 'shortOffset',
  }).formatToParts(utc);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const tzName = get('timeZoneName') || 'GMT';
  const off = tzName.replace('GMT', '') || '+00:00';
  const norm = off.length <= 3 ? `${off}00:00`.replace('++', '+') : off;
  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00${norm}`;
  return { iso, utc: utc.toISOString(), error: null };
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
