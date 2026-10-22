// Comparacao indexado vs fixo, quarto a quarto.
//
// Fica aqui, e nao na rota, por duas razoes:
//   - e' logica de negocio pura e testavel sem rede nem base de dados;
//   - o endpoint so recebe o fixo que o utilizador escolheu, e um "vencedor"
//     inventado com o tarifario errado e' pior do que nenhuma comparacao.
//
// Regra: energia a energia, no MESMO instante. Cada tarifario e' cotado no
// SEU periodo: um indexado DIARIO e um fixo SEMANAL nao partilham as
// fronteiras, e usar o periodo de um para cotar o outro daria um preco
// fixo errado (e um "vencedor" errado). A tarifa de activacao fica de fora
// de proposito — e' um valor unico e nao se repete por quarto de hora, e
// compara-lo assim daria a impressao falsa de que o indexado ganha sempre
// (ou perde sempre) por causa de 11 centimos.

const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * @param {Array} quarters  [{ start, period, price, ... }]
 * @param {Object|null} fixPrice  { VAZIO, FORA_VAZIO, UNICO } ou null
 * @returns {Array} os mesmos quartos + { fixed, winner }
 *   winner: 'IDX' | 'FIX' | 'EQ' | null (sem preco de referencia)
 *
 * `q.fixPeriod` e' o periodo do tarifario FIXO nesse instante (quando ha
 * fixo escolhido). Sem ele, cai no `q.period` — que e' o do indexado.
 */
export function compareWithFixed(quarters, fixPrice) {
  return quarters.map((q) => {
    if (!fixPrice) return { ...q, fixed: null, winner: null };
    // Um fixo SIMPLES so tem UNICO: aplica-se a todos os periodos.
    const key = q.fixPeriod ?? q.period;
    const raw = fixPrice[key] ?? fixPrice.UNICO ?? null;
    if (raw == null) return { ...q, fixed: null, winner: null };
    const fixed = r4(raw);
    const idx = r4(q.price);
    return { ...q, fixed, winner: idx < fixed ? 'IDX' : idx > fixed ? 'FIX' : 'EQ' };
  });
}

/** Contagens para o resumo da tabela. */
export function tallyWinners(quarters) {
  const t = { idx: 0, fix: 0, eq: 0, na: 0, total: quarters.length };
  for (const q of quarters) {
    if (q.winner === 'IDX') t.idx++;
    else if (q.winner === 'FIX') t.fix++;
    else if (q.winner === 'EQ') t.eq++;
    else t.na++;
  }
  return t;
}