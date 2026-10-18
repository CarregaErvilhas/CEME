// Parser defensivo do dump oficial omie.es (INT_PBC_EV_H_ACUM.TXT).
// Nunca lança por linhas más — devolve { rows, quarantined, warnings }.
// Formato: latin1, ';', Fecha d/m/aaaa, Periodo 1..96, preços com vírgula.

export const PLAUSIBLE_MIN = -500;
export const PLAUSIBLE_MAX = 3000;

export function parsePrice(raw) {
  if (raw == null) return { value: null, error: 'empty' };
  const s = String(raw).trim().replace(/\u00a0/g, '').replace(',', '.');
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return { value: null, error: 'empty' };
  const v = Number(s);
  if (!Number.isFinite(v)) return { value: null, error: `not_numeric:${raw}` };
  return { value: v, error: null };
}

export function parseMarketDay(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw || '').trim());
  if (!m) return { iso: null, error: `bad_date:${raw}` };
  const [_, d, mo, y] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return { iso: null, error: `bad_date:${raw}` };
  return { iso, error: null };
}

export function parseOmieTxt(text) {
  const rows = [];
  const quarantined = [];
  const warnings = [];
  // Remove BOM, normaliza CRLF
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  const seenPeriods = new Map(); // marketDayIso -> Set(period)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // cabeçalhos / rodapés conhecidos
    if (/^OMIE\s*-/i.test(line) || /^Fecha\s*;/i.test(line)) continue;
    const cols = line.split(';');
    if (cols.length < 4) {
      quarantined.push({ line: i + 1, reason: 'few_columns', text: line.slice(0, 160) });
      continue;
    }
    const [fechaRaw, periodoRaw, esRaw, ptRaw] = cols;
    if (!/^\d/.test(fechaRaw.trim())) continue; // linha de rodapé

    const { iso, error: dateErr } = parseMarketDay(fechaRaw);
    const period = Number(String(periodoRaw).trim());
    if (dateErr || !iso) {
      quarantined.push({ line: i + 1, reason: dateErr || 'bad_date', text: line.slice(0, 160) });
      continue;
    }
    if (!Number.isInteger(period) || period < 1 || period > 96) {
      quarantined.push({ line: i + 1, reason: `bad_period:${periodoRaw}`, text: line.slice(0, 160) });
      continue;
    }
    const key = `${iso}:${period}`;
    if (!seenPeriods.has(iso)) seenPeriods.set(iso, new Set());
    if (seenPeriods.get(iso).has(period)) {
      quarantined.push({ line: i + 1, reason: `dup_period:${key}`, text: line.slice(0, 160) });
      warnings.push(`dup ${key} (linha ${i + 1} em quarentena, fica a 1ª)`);
      continue;
    }
    seenPeriods.get(iso).add(period);

    const es = parsePrice(esRaw);
    const pt = parsePrice(ptRaw);
    if (es.error || pt.error) {
      quarantined.push({ line: i + 1, reason: `bad_price es=${es.error} pt=${pt.error}`, text: line.slice(0, 160) });
      continue;
    }
    const flags = [];
    if (pt.value < PLAUSIBLE_MIN || pt.value > PLAUSIBLE_MAX) flags.push('suspect_range');
    if (Math.abs(pt.value - es.value) > 100) flags.push('suspect_pt_es_split');
    rows.push({ marketDay: iso, marketPeriod: period, priceEs: es.value, pricePt: pt.value, flags, srcLine: i + 1 });
  }
  return { rows, quarantined, warnings };
}

// Agrupa por dia de mercado e avalia integridade (92/96/100 + gaps).
export function assessDays(rows, expectedCountFn) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.marketDay)) byDay.set(r.marketDay, []);
    byDay.get(r.marketDay).push(r);
  }
  const days = [];
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.marketPeriod - b.marketPeriod);
    const periods = new Set(list.map(r => r.marketPeriod));
    const missing = [];
    for (let p = 1; p <= 96; p++) if (!periods.has(p)) missing.push(p);
    const expected = expectedCountFn ? expectedCountFn(day) : 96;
    days.push({
      day, count: list.length, expected,
      missing, complete: missing.length === 0,
      status: missing.length === 0 ? 'OK' : 'PARTIAL',
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}
