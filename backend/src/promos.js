// Promoções de um CEME numa rede de postos (tabela `promo`, vê PROMOS em
// db/seed-data.js).
//
// O simulador cota um carregamento sem saber em que posto é. Por isso uma
// promoção nunca muda o `totalEur` de um tarifário: vai numa lista à parte,
// `promos`, com o nome da rede, e quem sabe o posto (o ohmigo, que conhece o
// operador de cada posto) escolhe as que lá valem.

// As promoções em vigor para um tarifário num dia (o dia civil do
// carregamento na região) e numa região.
//   rows: linhas da tabela `promo`; t: linha de allTariffs() (com ceme_id)
export function promosFor(rows, t, day, region) {
  return rows.filter(p => p.ceme_id === t.ceme_id
    && (p.tariff_ids == null || p.tariff_ids.split(',').includes(t.id))
    && p.starts_on <= day && day <= p.ends_on
    && p.regions.split(',').includes(region));
}

// Uma linha de `promo` como a API a mostra. Lista fechada de campos, como
// CEME_PUBLIC_COLS: uma coluna nova não aparece na API sem passar por aqui.
export const promoOut = (p) => ({
  id: p.id, ceme: p.ceme_id, name: p.name, network: p.network, target: p.target,
  eurKwh: p.eur_kwh ?? null, pct: p.pct ?? null, from: p.starts_on, to: p.ends_on,
  newCustomers: !!p.new_customers, maxHours: p.max_hours ?? null,
  tariffs: p.tariff_ids ? p.tariff_ids.split(',') : null,
  regions: p.regions, url: p.source_url, checked: p.checked_on,
});

// Tira `d` €/kWh a um preço final por período ({ VAZIO, FORA_VAZIO } ou
// { UNICO }) e à parte de energia da separação, se houver. O desconto é na
// componente CEME (energia + TAR); a TAR é da rede e não muda, por isso sai
// tudo da energia. Nunca abaixo de zero: um desconto maior que o preço não
// paga o carregamento.
export function discounted(price, split, d) {
  if (!d) return { price, split };
  const p = Object.fromEntries(Object.entries(price).map(([k, v]) => [k, v == null ? v : Math.max(0, v - d)]));
  const s = split && Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v && { energy: p[k] - v.tar, tar: v.tar }]));
  return { price: p, split: s };
}
