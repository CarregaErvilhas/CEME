// Perdas por quarto de hora (E-REDES, Perfis de Perdas) — o `Perdas(h)` da
// fórmula dos indexados. Os valores já vêm em cascata por nível de tensão
// (ver scripts/etl-perdas.py); o ficheiro tem um valor por quarto, indexado
// a partir de 1 de janeiro (UTC), por isso a hora legal não precisa de
// tratamento: um instante UTC é um índice.
//
// Fora dos anos carregados devolve null e o chamador cai no placeholder
// anual (LOSS_PLACEHOLDER em indexed.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUARTER_MS = 15 * 60000;
const YEARS = [2026];
const profiles = new Map();
for (const y of YEARS) {
  const p = JSON.parse(readFileSync(fileURLToPath(new URL(`./losses-${y}.json`, import.meta.url)), 'utf8'));
  profiles.set(y, { start: Date.parse(p.start), BT: p.BT, MT: p.MT });
}

// Perdas (fracção, ex.: 0.1485) do quarto que contém `at`; null sem perfil.
export function lossAt(voltage, at) {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const p = profiles.get(new Date(t).getUTCFullYear());
  const arr = p && p[voltage];
  if (!arr) return null;
  const v = arr[Math.floor((t - p.start) / QUARTER_MS)];
  return v == null ? null : v;
}

const lisbonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' });

// Média das perdas por período (ex.: VAZIO / FORA_VAZIO) no dia civil de
// Lisboa de `at`. `periodOf(date)` diz a que período pertence cada quarto.
// O OMIE de referência dos indexados também é uma média do dia por período,
// por isso as perdas têm de ser a média do mesmo conjunto de quartos.
// Devolve { [periodo]: perdas } ou null se faltar perfil.
const dayCache = new Map();
export function lossByPeriod(voltage, at, periodOf, cacheKey = '') {
  const day = lisbonDay.format(at);
  const key = `${voltage}|${day}|${cacheKey}`;
  if (cacheKey && dayCache.has(key)) return dayCache.get(key);
  const [Y, M, D] = day.split('-').map(Number);
  const sums = {};
  // O dia de Lisboa cabe sempre em [00:00 UTC - 1h, 24:00 UTC + 1h]; filtra-se pela data.
  for (let t = Date.UTC(Y, M - 1, D, 0) - 3600000; t < Date.UTC(Y, M - 1, D + 1, 0) + 3600000; t += QUARTER_MS) {
    const d = new Date(t);
    if (lisbonDay.format(d) !== day) continue;
    const l = lossAt(voltage, d);
    if (l == null) { dayCache.set(key, null); return null; }
    const per = periodOf(d);
    const s = sums[per] || (sums[per] = { sum: 0, n: 0 });
    s.sum += l; s.n++;
  }
  const out = {};
  for (const [per, s] of Object.entries(sums)) out[per] = s.sum / s.n;
  if (cacheKey) { if (dayCache.size > 500) dayCache.clear(); dayCache.set(key, out); }
  return out;
}
