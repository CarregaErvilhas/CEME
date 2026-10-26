// Os tarifários vistos pela API: lê-os da BD e cota-os.
//
// O motor (engine/) só faz contas com números que lhe dás. Este módulo é a
// ponte entre a BD e o motor:
//   - allTariffs(): todos os tarifários, com a versão em vigor num dia;
//   - comps(): os preços de uma versão numa região;
//   - tarFor(): a TAR em vigor;
//   - quoteOne(): junta tudo e devolve o cartão de um tarifário, com o total.
import { query, get } from './db.js';
import { quoteFixed } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { lossByPeriod } from './engine/losses.js';
import { REGIONS, periodForRegion } from './engine/regions.js';
import { civilDay } from './omie/convert.js';
import { pickComponents } from './db/components.js';
import { VERSIONS } from './db/seed.postgres.js';

// "Hoje" em Portugal, para escolher a versão em vigor (vê civilDay).
export const today = () => civilDay();

// Fórmula e perdas fixas de um indexado (VERSIONS no seed).
export function vmeta(tid) {
  const v = VERSIONS[tid] || {};
  const loss = (v.loss != null) ? v.loss : null;
  return { loss, formula: v.formula || 'standard' };
}

// Todos os tarifários, cada um com `vid` = a versão em vigor no dia `day`.
// Se o dia for anterior à primeira versão conhecida, usa a de hoje.
export async function allTariffs(day = today()) {
  return await query(`
    SELECT t.*, c.name AS ceme_name,
      COALESCE(
        (SELECT v.id FROM tariff_version v
         WHERE v.tariff_id = t.id
           AND v.valid_from <= $1
           AND (v.valid_to IS NULL OR v.valid_to > $1)
         ORDER BY v.valid_from DESC LIMIT 1),
        (SELECT v.id FROM tariff_version v
         WHERE v.tariff_id = t.id
           AND v.valid_from > $1 AND v.valid_from <= $2
           AND (v.valid_to IS NULL OR v.valid_to > $2)
         ORDER BY v.valid_from DESC LIMIT 1)) AS vid
    FROM tariff t
    JOIN ceme c ON c.id = t.ceme_id
    ORDER BY t.id
  `, [day, today()]);
}

// Os preços de uma versão numa região: { price, act, iec, sup, split }.
export async function comps(vid, region = 'CONT') {
  let rows = await query('SELECT * FROM price_component WHERE tariff_version_id = $1', [vid]);
  // Nas ilhas, as linhas de price_component_region vêm DEPOIS das do
  // Continente; como "a última vence", substituem-nas onde existirem.
  if (region && region !== 'CONT') {
    const reg = await query('SELECT * FROM price_component_region WHERE tariff_version_id = $1 AND region = $2', [vid, region]);
    rows = [...rows, ...reg];
  }
  return compRows(rows, vid);
}

// Transforma linhas de preço em { price, act, iec, sup, split }. O
// /v1/tabela também a usa, para mostrar os preços das ilhas à parte.
export function compRows(rows, vid) {
  let out;
  try { out = pickComponents(rows); }
  catch (e) { throw new Error(`${e.message} na versão ${vid}`); }
  // split[período] = { energy, tar } quando se conhece a separação; senão null.
  const split = {};
  for (const r of rows) {
    split[r.period] = (r.energy_only_eur_kwh == null || r.tar_eur_kwh == null)
      ? null
      : { energy: r.energy_only_eur_kwh, tar: r.tar_eur_kwh };
  }
  out.split = split;
  return out;
}

// Taxa de activação (EGME). Usamos sempre o valor que o CEME publica. Cada
// tarifário vai com dois campos extra:
//   egme_legal:       o valor legal em vigor, para referência;
//   activation_stale: true se o CEME ainda publica o valor legal do ano
//                     anterior (provavelmente não actualizou a página).
// Um valor próprio acima do legal é legítimo e não é marcado.
export const EGME_LEGAL = 0.1088; // €/carregamento, Regul. ERSE 7/2026 (em vigor 2026-01-01)
const EGME_PREVIOUS = 0.1572; // o valor legal de 2025
export const egmeFlags = (act) => ({ egme_legal: EGME_LEGAL, activation_stale: Math.abs(act - EGME_PREVIOUS) < 1e-9 });

// A TAR em vigor num dia para (região, tensão, período), ou null se não
// houver. Para um dia anterior à primeira TAR conhecida, usa a mais antiga.
export async function tarFor(region, voltage, period, day = today()) {
  const row = await get(
    `SELECT price_eur_kwh FROM tar
      WHERE region = $1 AND voltage = $2 AND period = $3
        AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)
      ORDER BY valid_from DESC LIMIT 1`,
    [region, voltage, period, day]
  ) || await get(
    `SELECT price_eur_kwh FROM tar
      WHERE region = $1 AND voltage = $2 AND period = $3 AND valid_from > $4
      ORDER BY valid_from ASC LIMIT 1`,
    [region, voltage, period, day]
  );
  return row?.price_eur_kwh ?? null;
}

// Cota UM tarifário: devolve os dados para o cartão dele, com o total em €
// e a conta parcela a parcela. Atira erro se faltar algum dado; quem chama
// apanha-o e deixa o tarifário de fora ("quarentena").
//   t:     linha de allTariffs()
//   at:    instante do carregamento; day: o dia dele na região
//   kwh, region
//   omie, omieVazio, omieFora, omieCycles: o OMIE de referência (€/kWh)
//   spot:  { omieKwh, loss } do quarto de hora do carregamento, se houver
export async function quoteOne(t, { at, day, kwh, region, omie, omieVazio, omieFora, omieCycles, spot }) {
  const ver = await get('SELECT * FROM tariff_version WHERE id = $1', [t.vid]);
  const { price, act, iec, sup, split } = await comps(t.vid, region);
  const meta = {
    id: t.id, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    notes: ver?.notes || null,
    brand: (await get('SELECT brand_color FROM ceme WHERE id = $1', [t.ceme_id]))?.brand_color || '#666',
  };
  if (t.kind === 'FIXED') {
    const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: sup, iec, region, split });
    return { ...meta, activation: act, iec, prices: price, split, avail: t.regions, ...egmeFlags(act), ...q };
  }
  // INDEXADO: calcula o €/kWh de cada período e depois usa a mesma conta dos
  // fixos. Nas ilhas o mercado ibérico não chega; usa-se o OMIE do
  // Continente e o cartão leva o aviso OMIE_CONT_REF.
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  // A TAR é a da região do carregamento. Sem TAR, erro (quarentena).
  const tarOf = async (per) => {
    const tar = await tarFor(region, t.voltage, per, day);
    if (tar == null) throw new Error(`sem TAR ${region}/${t.voltage}/${per} em ${day}`);
    return tar;
  };
  const vm = vmeta(t.id);
  // Perdas médias de cada período nesse dia (vê engine/losses.js).
  const lossPer = lossByPeriod(t.voltage, at, d => periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at: d }), `${region}|${t.schedule}|${t.cycle}`);
  // Que OMIE usar em cada período:
  //   SPLIT_VAZIO_FORA: a média desse período no ciclo DO TARIFÁRIO (o vazio
  //     do ciclo semanal não tem as mesmas horas que o do diário). Vem de
  //     `omieCycles[ciclo]`; se não vier, de omieVazio/omieFora; se não, `omie`.
  //   UNICA: `omie` para tudo.
  const agg = ver.omie_aggregation || 'SPLIT_VAZIO_FORA';
  const cyc = (omieCycles && omieCycles[t.cycle]) || {};
  const pair = { vazio: cyc.vazio ?? omieVazio, fora: cyc.fora ?? omieFora };
  const omieForPeriod = (per) => {
    if (agg === 'SPLIT_VAZIO_FORA') return (per === 'VAZIO' ? (pair.vazio ?? omie) : (pair.fora ?? omie));
    return omie;
  };
  // Se há `spot` (o OMIE do quarto de hora do carregamento), é esse que se
  // usa: é o que o CEME cobra de facto. As médias ficam como plano B.
  const spotKwh = spot?.omieKwh ?? null;
  const out = {};
  // Aqui a separação energia + TAR é exacta: a TAR é uma parcela da fórmula.
  const splitIdx = {};
  for (const per of ['VAZIO', 'FORA_VAZIO']) {
    const oref = spotKwh ?? omieForPeriod(per);
    const tar = await tarOf(per);
    const tarEurKwh = tar ?? 0;
    const price = indexedPrice({ omieEurKwh: oref, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh, loss: spot?.loss ?? lossPer?.[per] ?? vm.loss, formula: vm.formula }).price;
    out[per] = price;
    splitIdx[per] = tar == null ? null : { energy: price - tar, tar };
  }
  const omieRef = spotKwh ?? ((agg === 'SPLIT_VAZIO_FORA') ? (pair.vazio ?? omie) : omie);
  // Um indexado SIMPLES precisaria de um preço UNICO, que este código não
  // calcula. Não há nenhum no seed; se aparecer, usa-se o de fora de vazio
  // como aproximação (vê docs/06).
  if (t.schedule === 'SIMPLES' && out.UNICO == null) {
    out.UNICO = out.FORA_VAZIO ?? out.VAZIO ?? 0;
  }
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price: out, activation: act, support: sup, iec, region, split: splitIdx });
  return { ...meta, activation: act, iec, prices: out, split: splitIdx, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: spot?.loss ?? lossPer?.[q.period] ?? vm.loss ?? LOSS_PLACEHOLDER[t.voltage], omieSpot: spotKwh != null, lossByPeriod: lossPer, formula: vm.formula, warning: here, avail: t.regions, ...egmeFlags(act), ...q };
}
