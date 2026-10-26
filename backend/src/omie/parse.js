// Lê o ficheiro oficial de preços do omie.es (INT_PBC_EV_H_ACUM.TXT).
//
// É texto separado por ';', com uma linha por quarto de hora:
//   Fecha (d/m/aaaa) ; Periodo (1..100) ; preço ES ; preço PT ; …
// Os preços estão em €/MWh e usam vírgula decimal ("219,86").
//
// Uma linha má nunca faz o parser falhar: vai para a "quarentena" (uma lista
// à parte, com o motivo) e o resto do ficheiro segue.
// Devolve { rows, quarantined, warnings }.
import { dmyToIso } from '../time.js';

// Gama de preços (€/MWh) considerada normal. Fora dela, a linha entra na
// mesma mas leva a flag 'suspect_range'.
export const PLAUSIBLE_MIN = -500;
export const PLAUSIBLE_MAX = 3000;

// "219,86" → { value: 219.86 }. Vazio, '-' ou texto → { value: null, error }.
export function parsePrice(raw) {
  if (raw == null) return { value: null, error: 'empty' };
  const s = String(raw).trim().replace(/\u00a0/g, '').replace(',', '.');
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return { value: null, error: 'empty' };
  const v = Number(s);
  if (!Number.isFinite(v)) return { value: null, error: `not_numeric:${raw}` };
  return { value: v, error: null };
}

// "5/3/2026" → { iso: '2026-03-05' }.
export function parseMarketDay(raw) {
  const iso = dmyToIso(raw);
  if (!iso) return { iso: null, error: `bad_date:${raw}` };
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return { iso: null, error: `bad_date:${raw}` };
  return { iso, error: null };
}

export function parseOmieTxt(text) {
  const rows = [];
  const quarantined = [];
  const warnings = [];
  // Tira o BOM (marca invisível no início de alguns ficheiros) e os \r do Windows.
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  const seenPeriods = new Map(); // marketDayIso -> Set(period)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Cabeçalhos conhecidos.
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
    // Nenhum dia tem mais de 100 períodos.
    if (!Number.isInteger(period) || period < 1 || period > 100) {
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
    // PT e ES costumam ter o mesmo preço; uma diferença grande é rara (pode
    // ser legítima, quando o mercado separa os dois países) e fica marcada.
    if (Math.abs(pt.value - es.value) > 100) flags.push('suspect_pt_es_split');
    rows.push({ marketDay: iso, marketPeriod: period, priceEs: es.value, pricePt: pt.value, flags, srcLine: i + 1 });
  }
  return { rows, quarantined, warnings };
}

// Agrupa as linhas por dia de mercado e diz se cada dia está completo.
// `expectedCountFn(dia)` diz quantos períodos o dia devia ter (92/96/100).
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
    const expected = expectedCountFn ? expectedCountFn(day) : 96;
    // Só conta como em falta um período que devia existir nesse dia.
    const top = expected >= 100 ? 100 : expected >= 96 ? 96 : 92;
    const missing = [];
    for (let p = 1; p <= top; p++) if (!periods.has(p)) missing.push(p);
    days.push({
      day, count: list.length, expected,
      missing, complete: missing.length === 0 && list.length === expected,
      status: (missing.length === 0 && list.length === expected) ? 'OK' : 'PARTIAL',
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}
