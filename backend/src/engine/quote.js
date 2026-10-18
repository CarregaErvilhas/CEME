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
export function quoteFixed({ schedule, cycle, at, kwh, price, activation = 0, support = 0, iec = 0, region = 'CONT', vatRate }) {
  const period = periodFor({ schedule, cycle, at, region });
  const key = period === 'UNICO' ? 'UNICO' : period;
  const final = price[key];
  if (final == null) throw new Error(`sem preço final para ${key}`);
  const vat = vatRate ?? (REGIONS[region] || REGIONS.CONT).vat;
  const eurKwhNoIva = up2(final + iec);
  const base = up2(activation) + up2(support) + up2(kwh * final) + up2(kwh * iec);
  return { period, region, eurKwhNoIva, totalEur: up2(base * vat), vat, breakdown: { final, iec, activation, support, kwh } };
}

// PE(h) = (OMIE + K + CGS) * (1 + Perdas) + TAR — célula LuziGas!A3.
// Só faz sentido no Continente (OMIE/MIBEL não cobre os sistemas isolados
// das ilhas): o motor não bloqueia, mas a API deve avisar (ver docs/07).
export function indexedQuarter({ omieEurKwh, kIndex, cgs, lossFactor, tarEurKwh }) {
  return (omieEurKwh + kIndex + cgs) * (1 + lossFactor) + tarEurKwh;
}
