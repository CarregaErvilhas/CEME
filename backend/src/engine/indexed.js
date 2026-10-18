// Helpers de indexados para o POC (e futura API).
// Fórmulas suportadas:
//   standard: PE = (OMIE + K + CGS) * (1 + perdas) + TAR
//   ynerluz:  PE = (1 + perdas) * (OMIE + K) + CGS + TAR
export const LOSS_PLACEHOLDER = { BT: 0.1531, MT: 0.0713 }; // E-REDES BTN 2026 (média anual)

export function lossFor(voltage, override) {
  return override != null ? override : (LOSS_PLACEHOLDER[voltage] ?? 0.08);
}

export function indexedPrice({ omieEurKwh, kIndex, cgs, voltage, tarEurKwh, loss, formula }) {
  const L = lossFor(voltage, loss);
  let price;
  if (formula === 'ynerluz') price = (1 + L) * (omieEurKwh + kIndex) + cgs + tarEurKwh;
  else price = (omieEurKwh + kIndex + cgs) * (1 + L) + tarEurKwh;
  return { price, loss: L };
}

export function breakevenOmie({ fixedFinal, kIndex, cgs, voltage, tarEurKwh, loss, formula }) {
  const L = lossFor(voltage, loss);
  if (formula === 'ynerluz') return (fixedFinal - cgs - tarEurKwh) / (1 + L) - kIndex;
  return (fixedFinal - tarEurKwh) / (1 + L) - kIndex - cgs;
}
