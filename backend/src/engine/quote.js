import { periodFor } from './periods.js';
import { REGIONS } from './regions.js';

const up2 = (v) => Math.ceil(v * 100 - 1e-9) / 100;

// Custo de tarifários FIXOS.
// Semântica do sheet (CEME!R:S + AC/AD): o €/kWh final já inclui a TAR
// (ex. Atlante MT = 0,10 base + TAR MT). Por isso NÃO se soma TAR aqui —
// a tabela `tar` serve para auditoria e para os indexados.
// total = ROUNDUP(act + apoio + kwh*preço_final + kwh*iec) * (1+IVA_região).
// IVA: CONT 23% / MAD 22% / AZO 16% (taxa normal; mobilidade não tem a
// taxa reduzida dos primeiros kWh do fornecimento doméstico).
//
// `parts` é a decomposição do total, em €, linha a linha — as MESMAS parcelas
// arredondadas que entram na conta, por isso somam exactamente o total:
//   energyTar  = ROUNDUP(kwh × preço final)   (energia do CEME + TAR)
//     energy, tar: a mesma parcela separada, quando se sabe a separação
//     (`split` do período). A TAR arredonda ao cêntimo e a energia fica com o
//     resto — assim energy + tar = energyTar, sem cêntimos perdidos.
//   iec        = ROUNDUP(kwh × IEC)
//   activation = ROUNDUP(EGME/activação)     support = ROUNDUP(apoio)
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

// Os indexados: engine/indexed.js (indexedPrice).
