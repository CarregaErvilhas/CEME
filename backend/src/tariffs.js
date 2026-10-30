// Os tarifários vistos pela API: lê-os da BD e cota-os.
//
// O motor (engine/) só faz contas com números que lhe dás. Este módulo é a
// ponte entre a BD e o motor:
//   - allTariffs(): todos os tarifários, com a versão em vigor num dia;
//   - comps(): os preços de uma versão numa região;
//   - tarFor(): a TAR em vigor;
//   - loadPricing(): tudo isto de uma vez, para cotar muitos tarifários;
//   - quoteOne(): junta tudo e devolve o cartão de um tarifário, com o total.
import { query } from './db.js';
import { quoteSlices } from './engine/quote.js';
import { indexedPrice, LOSS_PLACEHOLDER } from './engine/indexed.js';
import { lossAt, lossByPeriod } from './engine/losses.js';
import { REGIONS, periodForRegion } from './engine/regions.js';
import { civilDay } from './omie/convert.js';
import { shiftDays } from './time.js';
import { pickComponents } from './db/components.js';
import { VERSIONS } from './db/seed-data.js';
import { discounted, freeFirst, promosFor } from './promos.js';

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
// Para um pedido só (a página do indexado). Para muitos tarifários de uma
// vez usa loadPricing(), que não faz uma query por tarifário.
export async function comps(vid, region = 'CONT') {
  let rows = await query('SELECT * FROM price_component WHERE tariff_version_id = $1', [vid]);
  if (region && region !== 'CONT') {
    rows = [...rows, ...await query('SELECT * FROM price_component_region WHERE tariff_version_id = $1 AND region = $2', [vid, region])];
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

// Escolhe, de entre as linhas da tabela `tar` de uma região, a TAR em vigor
// num dia para (tensão, período), ou null se não houver. Para um dia
// anterior à primeira TAR conhecida, usa a mais antiga.
function pickTar(rows, voltage, period, day) {
  let current = null, first = null;
  for (const r of rows) {
    if (r.voltage !== voltage || r.period !== period) continue;
    if (r.valid_from <= day && (r.valid_to == null || r.valid_to > day)) {
      if (!current || r.valid_from > current.valid_from) current = r;
    } else if (r.valid_from > day && (!first || r.valid_from < first.valid_from)) {
      first = r;
    }
  }
  return (current || first)?.price_eur_kwh ?? null;
}

const tarRows = (region) => query('SELECT * FROM tar WHERE region = $1', [region]);

// A TAR em vigor num dia para (região, tensão, período), ou null.
export async function tarFor(region, voltage, period, day = today()) {
  return pickTar(await tarRows(region), voltage, period, day);
}

// Carrega de uma vez tudo o que é preciso para cotar os tarifários numa
// região: versões, preços (do Continente e, nas ilhas, os próprios da
// região), cores das marcas, TAR e promoções. São 6 queries por pedido, em
// vez de várias por tarifário.
//
// Devolve um objecto com funções que já não vão à BD:
//   version(vid) → a linha de tariff_version
//   comps(vid)   → { price, act, iec, sup, split } (vê compRows)
//   brand(cemeId), tar(voltage, period, day)
//   promos(t, day) → as promoções em vigor para o tarifário (vê promos.js)
export async function loadPricing(region = 'CONT') {
  const island = region && region !== 'CONT';
  const [versions, rows, regRows, cemes, tars, promoRows] = await Promise.all([
    query('SELECT * FROM tariff_version'),
    query('SELECT * FROM price_component'),
    island ? query('SELECT * FROM price_component_region WHERE region = $1', [region]) : [],
    query('SELECT id, brand_color FROM ceme'),
    tarRows(region),
    query('SELECT * FROM promo'),
  ]);
  const byVersion = new Map();
  // Nas ilhas, as linhas de price_component_region vêm DEPOIS das do
  // Continente; como "a última vence" (em compRows), substituem-nas onde
  // existirem.
  for (const r of [...rows, ...regRows]) {
    if (!byVersion.has(r.tariff_version_id)) byVersion.set(r.tariff_version_id, []);
    byVersion.get(r.tariff_version_id).push(r);
  }
  const versionById = new Map(versions.map(v => [v.id, v]));
  const brandById = new Map(cemes.map(c => [c.id, c.brand_color]));
  return {
    version: (vid) => versionById.get(vid) ?? null,
    comps: (vid) => compRows(byVersion.get(vid) ?? [], vid),
    brand: (cemeId) => brandById.get(cemeId) || '#666',
    tar: (voltage, period, day) => pickTar(tars, voltage, period, day),
    promos: (t, day) => promosFor(promoRows, t, day, region),
  };
}

// Cota UM tarifário: devolve os dados para o cartão dele, com o total em €
// e a conta parcela a parcela. Atira erro se faltar algum dado; quem chama
// apanha-o e deixa o tarifário de fora ("quarentena").
//   t:     linha de allTariffs()
//   at:    instante do carregamento; day: o dia dele na região
//   kwh, region
//   omie, omieVazio, omieFora, omieCycles: o OMIE de referência (€/kWh)
//   spot:  { omieKwh, loss } do quarto de hora do carregamento, se houver
//   profile: opcional, o carregamento partido em fatias no tempo,
//          [{ at, kwh, spot }] (spot como acima, ou null). Cada fatia é
//          cotada no seu período e, nos indexados, com o OMIE, as perdas e a
//          TAR do seu instante (vê quoteSlices). Os campos `prices`, `loss` e
//          `omieRef` continuam a ser os do início (`at`).
//   pricing: o resultado de loadPricing(region)
//   discountKwh: €/kWh a menos no preço final de cada período (uma promoção
//          de ENERGIA, vê promos.js). Os campos `prices` e `split` do cartão
//          ficam os do tarifário; só a conta usa o preço com desconto.
//   freeKwh: os primeiros kWh do carregamento sem energia nem TAR (uma
//          promoção KWH_GRATIS, vê freeFirst).
export function quoteOne(t, { at, day, kwh, region, omie, omieVazio, omieFora, omieCycles, spot, profile, discountKwh = 0, freeKwh = 0 }, pricing) {
  const ver = pricing.version(t.vid);
  const { price, act, iec, sup, split } = pricing.comps(t.vid);
  const meta = {
    id: t.id, legacy_id: t.legacy_id ?? null, ceme: t.ceme_name, name: t.name, kind: t.kind, voltage: t.voltage,
    schedule: t.schedule, cycle: t.cycle, green: !!t.green, access: t.access,
    bundle: !!t.bundle, popular: !!t.popular, estimated: /~$/.test(t.name),
    source_url: t.source_url, valid_from: ver?.valid_from || null,
    // O último dia de uma campanha, inclusive (valid_to é exclusivo).
    valid_until: ver?.valid_to ? shiftDays(ver.valid_to, -1) : null,
    newCustomers: !!t.new_customers, audience: t.audience ?? null,
    notes: ver?.notes || null,
    brand: pricing.brand(t.ceme_id),
  };
  if (t.kind === 'FIXED') {
    // O preço final de um fixo não muda com a hora, só com o período, e o
    // quoteSlices já escolhe o período de cada fatia.
    const d = discounted(price, split, discountKwh);
    const slices = freeFirst(profile ? profile.map(p => ({ at: p.at, kwh: p.kwh, ...d })) : [{ at, kwh, ...d }], freeKwh);
    const q = quoteSlices({ schedule: t.schedule, cycle: t.cycle, slices, activation: act, support: sup, iec, region });
    return { ...meta, activation: act, iec, prices: price, split, avail: t.regions, ...egmeFlags(act), ...q };
  }
  // INDEXADO: calcula o €/kWh de cada período e depois usa a mesma conta dos
  // fixos. Nas ilhas o mercado ibérico não chega; usa-se o OMIE do
  // Continente e o cartão leva o aviso OMIE_CONT_REF.
  const here = REGIONS[region].omieIndexed ? null : 'OMIE_CONT_REF';
  // Um indexado SIMPLES (preço único) precisava de uma regra para a TAR,
  // que é bi-horária. Não há nenhum no seed; se aparecer, fica de quarentena
  // em vez de sair com um preço inventado.
  if (t.schedule === 'SIMPLES') throw new Error('indexado SIMPLES não suportado');
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
    // A TAR é a da região do carregamento. Sem TAR, erro (quarentena).
    const tar = pricing.tar(t.voltage, per, day);
    if (tar == null) throw new Error(`sem TAR ${region}/${t.voltage}/${per} em ${day}`);
    const price = indexedPrice({ omieEurKwh: spotKwh ?? omieForPeriod(per), kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh: tar, loss: spot?.loss ?? lossPer?.[per] ?? vm.loss, formula: vm.formula }).price;
    out[per] = price;
    splitIdx[per] = { energy: price - tar, tar };
  }
  const omieRef = spotKwh ?? ((agg === 'SPLIT_VAZIO_FORA') ? (pair.vazio ?? omie) : omie);
  // Com perfil, cada fatia leva o preço do SEU período, calculado com o OMIE
  // do seu quarto de hora (se houver; senão as médias), as perdas desse
  // quarto e a TAR do seu dia (o carregamento pode passar a meia-noite).
  const sliceOf = (p) => {
    const per = periodForRegion({ region, schedule: t.schedule, cycle: t.cycle, at: p.at });
    const tar = pricing.tar(t.voltage, per, civilDay(p.at, REGIONS[region].tz));
    if (tar == null) throw new Error(`sem TAR ${region}/${t.voltage}/${per} em ${civilDay(p.at, REGIONS[region].tz)}`);
    const loss = p.spot ? (lossAt(t.voltage, p.at) ?? vm.loss) : (lossPer?.[per] ?? vm.loss);
    const omieKwh = p.spot?.omieKwh ?? omieForPeriod(per);
    const price = indexedPrice({ omieEurKwh: omieKwh, kIndex: ver.k_index_eur_mwh ?? 0, cgs: ver.cgs_eur_mwh ?? 0, voltage: t.voltage, tarEurKwh: tar, loss, formula: vm.formula }).price;
    return { at: p.at, kwh: p.kwh, ...discounted({ [per]: price }, { [per]: { energy: price - tar, tar } }, discountKwh), omieKwh, omieSpot: !!p.spot };
  };
  let q;
  if (profile) {
    const slices = freeFirst(profile.map(sliceOf), freeKwh);
    q = quoteSlices({ schedule: t.schedule, cycle: t.cycle, slices, activation: act, support: sup, iec, region });
    if (q.slices) q.slices.forEach((d, i) => Object.assign(d, { omie: slices[i].omieKwh, omieSpot: slices[i].omieSpot }));
  } else {
    q = quoteSlices({ schedule: t.schedule, cycle: t.cycle, slices: freeFirst([{ at, kwh, ...discounted(out, splitIdx, discountKwh) }], freeKwh), activation: act, support: sup, iec, region });
  }
  return { ...meta, activation: act, iec, prices: out, split: splitIdx, estimated: false, omieRef, k: ver.k_index_eur_mwh, cgs: ver.cgs_eur_mwh, loss: spot?.loss ?? lossPer?.[q.period] ?? vm.loss ?? LOSS_PLACEHOLDER[t.voltage], omieSpot: spotKwh != null, lossByPeriod: lossPer, formula: vm.formula, warning: here, avail: t.regions, ...egmeFlags(act), ...q };
}
