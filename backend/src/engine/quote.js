import { REGIONS, periodForRegion } from './regions.js';

// Arredonda para cima ao cêntimo. O `- 1e-9` evita que 0.30000000000000004
// (ruído de vírgula flutuante) suba para 0.31.
const up2 = (v) => Math.ceil(v * 100 - 1e-9) / 100;

// Quanto custa um carregamento num tarifário FIXO.
//
// "Fixo" quer dizer que o comercializador (o CEME) publica um €/kWh que não
// depende do mercado. Pode ter um preço só (SIMPLES) ou dois, um para as
// horas de vazio (noite, fim-de-semana) e outro para fora de vazio (BI_HORARIO).
//
// O €/kWh que guardamos é o FINAL, já com a TAR (tarifa de acesso às redes)
// lá dentro, porque é isso que os CEME publicam. Por isso aqui não se soma
// TAR nenhuma: a tabela `tar` só serve para os indexados e para partir a
// conta em "energia" + "TAR" quando se sabe a separação.
//
// A conta imita a fatura: cada parcela arredonda para cima ao cêntimo, e o
// total, depois do IVA da região, também.
//   total = ROUNDUP( ROUNDUP(activação) + ROUNDUP(apoio)
//                  + ROUNDUP(kWh × preço final) + ROUNDUP(kWh × IEC) ) × IVA
// IEC é o imposto especial sobre a electricidade; a taxa de activação (EGME)
// cobra-se uma vez por carregamento. O IVA vem de REGIONS (regions.js) e é
// sempre a taxa normal: a taxa reduzida dos primeiros kWh é só para casa.
//
// `parts` devolve-te as MESMAS parcelas arredondadas que entram no total,
// por isso somam o total ao cêntimo:
//   energyTar  = ROUNDUP(kWh × preço final)
//     energy, tar: a mesma parcela partida em duas, quando o período tem
//     `split`. A TAR arredonda ao cêntimo e a energia fica com o resto,
//     para energy + tar dar exactamente energyTar.
//   iec        = ROUNDUP(kWh × IEC)
//   activation = ROUNDUP(activação)     support = ROUNDUP(apoio)
//   base       = soma das anteriores (sem IVA)
//   vatEur     = total − base
export function quoteFixed({ schedule, cycle, at, kwh, price, activation = 0, support = 0, iec = 0, region = 'CONT', vatRate, split }) {
  return quoteSlices({ schedule, cycle, slices: [{ at, kwh, price, split }], activation, support, iec, region, vatRate });
}

// O mesmo, para um carregamento partido em fatias no tempo.
//
// Um carregamento de 2 horas pode começar fora de vazio e acabar em vazio,
// apanhar oito quartos de hora com OMIE diferente, ou até atravessar a
// mudança da hora. Cada fatia traz o seu instante, os seus kWh e o seu preço
// final (`price`, e `split` se houver), e é cotada no período em que cai:
//   slices: [{ at, kwh, price: { VAZIO, FORA_VAZIO } ou { UNICO }, split? }]
// Tudo o resto é igual ao quoteFixed, e é por isso que o quoteFixed é só
// isto com uma fatia:
//   - energia+TAR: soma de kWh × preço de cada fatia, arredondada UMA vez
//     (a fatura traz uma linha por carregamento, não uma por quarto de hora);
//   - IEC sobre o total de kWh; activação e apoio uma vez; IVA no fim.
// Com mais de uma fatia devolve também `kwhByPeriod` e `slices` (o período
// e o preço final de cada fatia), para mostrar de onde vem o total.
export function quoteSlices({ schedule, cycle, slices, activation = 0, support = 0, iec = 0, region = 'CONT', vatRate }) {
  if (!slices?.length) throw new Error('sem fatias');
  const vat = vatRate ?? (REGIONS[region] || REGIONS.CONT).vat;
  let kwh = 0, raw = 0, rawTar = 0, knownTar = true;
  const kwhByPeriod = {};
  const detail = slices.map(sl => {
    const period = periodForRegion({ schedule, cycle, at: sl.at, region });
    const final = sl.price[period];
    if (final == null) throw new Error(`sem preço final para ${period}`);
    kwh += sl.kwh;
    raw += sl.kwh * final;
    kwhByPeriod[period] = (kwhByPeriod[period] || 0) + sl.kwh;
    const s = sl.split && sl.split[period];
    if (s && Number.isFinite(s.tar)) rawTar += sl.kwh * s.tar;
    else knownTar = false;
    return { at: new Date(sl.at).toISOString(), kwh: sl.kwh, period, final };
  });
  // Com uma fatia é o preço dela; com várias, a média pesada pelos kWh.
  const final = slices.length === 1 ? detail[0].final : (kwh > 0 ? raw / kwh : detail[0].final);
  const eurKwhNoIva = up2(final + iec);
  const energyTar = up2(raw);
  const parts = { energyTar, energy: null, tar: null, iec: up2(kwh * iec), activation: up2(activation), support: up2(support) };
  if (knownTar) {
    parts.tar = Math.round(rawTar * 100) / 100;
    parts.energy = Math.round((energyTar - parts.tar) * 100) / 100;
  }
  const base = Math.round((parts.activation + parts.support + energyTar + parts.iec) * 100) / 100;
  const totalEur = up2(base * vat);
  parts.base = base;
  parts.vatEur = Math.round((totalEur - base) * 100) / 100;
  const out = { period: detail[0].period, region, eurKwhNoIva, totalEur, vat, parts, breakdown: { final, iec, activation, support, kwh } };
  if (slices.length > 1) {
    for (const k of Object.keys(kwhByPeriod)) kwhByPeriod[k] = Math.round(kwhByPeriod[k] * 1000) / 1000;
    Object.assign(out, { kwhByPeriod, slices: detail });
  }
  return out;
}

// Para os indexados, vê engine/indexed.js (indexedPrice).
