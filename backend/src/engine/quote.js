import { periodFor } from './periods.js';
import { REGIONS } from './regions.js';

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
  const period = periodFor({ schedule, cycle, at, region });
  const key = period === 'UNICO' ? 'UNICO' : period;
  const final = price[key];
  if (final == null) throw new Error(`sem preço final para ${key}`);
  const vat = vatRate ?? (REGIONS[region] || REGIONS.CONT).vat;
  const eurKwhNoIva = up2(final + iec);
  const energyTar = up2(kwh * final);
  const parts = { energyTar, energy: null, tar: null, iec: up2(kwh * iec), activation: up2(activation), support: up2(support) };
  const s = split && split[key];
  if (s && Number.isFinite(s.tar)) {
    parts.tar = Math.round(kwh * s.tar * 100) / 100;
    parts.energy = Math.round((energyTar - parts.tar) * 100) / 100;
  }
  const base = Math.round((parts.activation + parts.support + energyTar + parts.iec) * 100) / 100;
  const totalEur = up2(base * vat);
  parts.base = base;
  parts.vatEur = Math.round((totalEur - base) * 100) / 100;
  return { period, region, eurKwhNoIva, totalEur, vat, parts, breakdown: { final, iec, activation, support, kwh } };
}

// Para os indexados, vê engine/indexed.js (indexedPrice).
