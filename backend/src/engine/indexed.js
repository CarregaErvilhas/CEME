// Preço de um tarifário INDEXADO ao OMIE.
//
// O OMIE é o mercado grossista de electricidade de Portugal e Espanha: todos
// os dias publica o preço da energia para cada quarto de hora do dia
// seguinte. Um tarifário indexado pega nesse preço e soma-lhe as margens do
// comercializador, as perdas na rede e a TAR (a tarifa de acesso às redes).
//
// Há duas maneiras de montar a conta, escolhidas por tarifário no seed
// (`VERSIONS[id].formula`):
//   standard: preço = (OMIE + K + CGS) × (1 + perdas) + TAR
//   ynerluz:  preço = (1 + perdas) × (OMIE + K) + CGS + TAR
// onde K é a margem do comercializador e CGS o custo de gestão do sistema,
// ambos em €/kWh. Tudo aqui é €/kWh sem IVA.

// Perdas médias anuais por nível de tensão (fracção: 0.1531 = 15,31 %).
// Só se usam quando não há perfil por quarto de hora para o ano pedido
// (ver losses.js). BT = baixa tensão, MT = média tensão.
export const LOSS_PLACEHOLDER = { BT: 0.1531, MT: 0.0713 };

// Perdas a usar: o valor que te passarem (`override`) ou o placeholder anual
// da tensão. Uma tensão sem placeholder é erro: quem cota põe o tarifário de
// quarentena em vez de inventar um valor.
export function lossFor(voltage, override) {
  if (override != null) return override;
  const loss = LOSS_PLACEHOLDER[voltage];
  if (loss == null) throw new Error(`sem perdas para a tensão ${voltage}`);
  return loss;
}

export function indexedPrice({ omieEurKwh, kIndex, cgs, voltage, tarEurKwh, loss, formula }) {
  const L = lossFor(voltage, loss);
  let price;
  if (formula === 'ynerluz') price = (1 + L) * (omieEurKwh + kIndex) + cgs + tarEurKwh;
  else price = (omieEurKwh + kIndex + cgs) * (1 + L) + tarEurKwh;
  return { price, loss: L };
}

// O OMIE (€/kWh) a partir do qual o indexado deixa de compensar face a um
// fixo com preço final `fixedFinal`. É a fórmula de cima resolvida em ordem
// ao OMIE.
export function breakevenOmie({ fixedFinal, kIndex, cgs, voltage, tarEurKwh, loss, formula }) {
  const L = lossFor(voltage, loss);
  if (formula === 'ynerluz') return (fixedFinal - cgs - tarEurKwh) / (1 + L) - kIndex;
  return (fixedFinal - tarEurKwh) / (1 + L) - kIndex - cgs;
}
