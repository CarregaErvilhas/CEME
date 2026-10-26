// Perdas na rede, quarto de hora a quarto de hora.
//
// Parte da energia que o comercializador compra perde-se no caminho (cabos,
// transformadores). Quem paga essas perdas és tu, e por isso a fórmula dos
// indexados multiplica o OMIE por (1 + perdas). A E-REDES (a dona da rede de
// distribuição) publica, para cada ano, um valor de perdas por quarto de hora
// e por nível de tensão.
//
// O ficheiro `losses-<ano>.json` é gerado por scripts/etl-perdas.py e já traz
// as perdas em cascata (BT inclui as perdas de MT, AT e da rede de
// transporte). Tem um valor por quarto, contado a partir de 1 de Janeiro em
// UTC: um instante vira um índice no array, sem contas de hora de Verão.
//
// Para anos sem ficheiro, as funções devolvem null e quem chama usa o
// LOSS_PLACEHOLDER de indexed.js. Ano novo: corre o ETL e junta o ano a YEARS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUARTER_MS = 15 * 60000;
const YEARS = [2026];
const profiles = new Map();
for (const y of YEARS) {
  const p = JSON.parse(readFileSync(fileURLToPath(new URL(`./losses-${y}.json`, import.meta.url)), 'utf8'));
  profiles.set(y, { start: Date.parse(p.start), BT: p.BT, MT: p.MT });
}

// Perdas (fracção: 0.1485 = 14,85 %) do quarto de hora que contém `at`.
// null se não houver perfil para esse ano.
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

// Média das perdas por período (VAZIO / FORA_VAZIO / UNICO) no dia de
// Lisboa que contém `at`. `periodOf(date)` diz-te a que período pertence
// cada quarto. Porquê a média: o OMIE de referência do simulador também é a
// média do dia por período, e as perdas têm de vir do mesmo conjunto de
// quartos para a conta bater certo.
// Devolve { [período]: perdas } ou null se faltar perfil para algum quarto.
// `cacheKey` (opcional) identifica o `periodOf` para guardar o resultado.
const dayCache = new Map();
export function lossByPeriod(voltage, at, periodOf, cacheKey = '') {
  const day = lisbonDay.format(at);
  const key = `${voltage}|${day}|${cacheKey}`;
  if (cacheKey && dayCache.has(key)) return dayCache.get(key);
  const [Y, M, D] = day.split('-').map(Number);
  const sums = {};
  // Um dia de Lisboa cabe sempre entre 23:00 UTC da véspera e 01:00 UTC do dia
// seguinte (é UTC+0 ou UTC+1). Percorres essa janela e ficas com os quartos
// cuja data em Lisboa é a pedida.
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
