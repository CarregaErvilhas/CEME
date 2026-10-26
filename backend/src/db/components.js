// Junta as linhas de `price_component` de uma versão de tarifário num objecto.
//
// Cada versão tem uma linha por período (VAZIO, FORA_VAZIO ou UNICO), com o
// €/kWh desse período. A taxa de activação, o IEC e o apoio são valores do
// tarifário, não do período, e por isso o seed repete-os em todas as linhas.
// Se duas linhas tiverem valores diferentes, os dados estão errados e
// atiras um erro: quem chama põe o tarifário de quarentena (sai do ranking)
// em vez de mostrar um preço errado.
//
// Devolve { price: { [período]: €/kWh }, act, iec, sup }.
export function pickComponents(rows) {
  const price = {};
  let act = null, iec = null, sup = null;
  // Funde o valor `v` desta linha com o que já se viu (`cur`). Um NULL nunca
  // apaga um valor já visto (senão uma linha incompleta zerava a taxa de
  // activação em silêncio); dois valores diferentes são erro.
  const ritmo = (cur, v) => {
    if (cur == null) return v;
    if (v != null && v !== cur) throw new Error('componentes divergentes (act/IEC/apoio diferem por período)');
    return cur;
  };
  for (const r of rows) {
    if (r.energy_eur_kwh != null) price[r.period] = r.energy_eur_kwh;
    act = ritmo(act, r.activation_eur);
    iec = ritmo(iec, r.iec_eur_kwh);
    sup = ritmo(sup, r.support_eur);
  }
  return { price, act: act ?? 0, iec: iec ?? 0, sup: sup ?? 0 };
}
