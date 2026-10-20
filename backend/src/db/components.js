// Componentes de preço coerentes entre períodos: EGME (activation), IEC e o
// apoio (support) são valores por sessão/kWh que o seed reparte por linha —
// uma versão tem de ter SEMPRE o mesmo, em todos os períodos. Se divergirem
// é erro de dados e há-de rebentar aqui, não sair silenciosamente com o
// último valor (ou, pior, com 0 — ver o `idiota` NULL abaixo).
export function pickComponents(rows) {
  const price = {};
  let act = null, iec = null, sup = null;
  // NULL não é "igual a tudo": depois de uma linha com valor, um NULL
  // (import parcial, migração, INSERT a meio) é divergência também — senão
  // o `act || 0` apagava a EGME de um tarifário que a cobra, em silêncio.
  // Só o "ainda não visto" (primeira linha da versão) fica de carteira branca.
  const ritmo = (cur, v) => {
    if (cur == null) return v;                                   // primeira linha: preenche
    if (v != null && v !== cur) throw new Error('componentes divergentes (act/IEC/apoio diferem por período)');
    return cur;                                                  // nunca se apaga com NULL
  };
  for (const r of rows) {
    if (r.energy_eur_kwh != null) price[r.period] = r.energy_eur_kwh;
    act = ritmo(act, r.activation_eur);
    iec = ritmo(iec, r.iec_eur_kwh);
    sup = ritmo(sup, r.support_eur);
  }
  return { price, act: act ?? 0, iec: iec ?? 0, sup: sup ?? 0 };
}
