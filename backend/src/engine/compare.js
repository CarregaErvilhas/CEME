// Indexado vs fixo, quarto de hora a quarto de hora.
//
// Contexto rápido: um tarifário FIXO cobra sempre o mesmo €/kWh (às vezes um
// valor de dia e outro de noite). Um INDEXADO segue o preço do mercado
// grossista (o OMIE), que muda a cada 15 minutos. Esta função pega nos 96
// quartos de hora de um dia, já com o preço do indexado calculado, e diz-te
// em cada um quem sai mais barato.
//
// Está aqui, e não na rota HTTP, porque é lógica pura: testas sem rede nem BD.
//
// Regras que convém teres presentes:
//   - Compara-se energia com energia, no MESMO instante, mas cada tarifário
//     no SEU período (vazio/fora de vazio). Um indexado de ciclo diário e um
//     fixo de ciclo semanal não mudam de período às mesmas horas.
//   - A taxa de activação (cobrada uma vez por carregamento) fica de fora: não
//     se repete a cada quarto de hora, e somá-la aqui enviesava o resultado.
//   - Sem fixo escolhido não há vencedor. Um vencedor calculado contra o
//     tarifário errado engana mais do que não dizer nada.

const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * @param {Array} quarters  [{ start, period, price, fixPeriod?, ... }]
 * @param {Object|null} fixPrice  { VAZIO, FORA_VAZIO, UNICO } (€/kWh) ou null
 * @returns {Array} os mesmos quartos + { fixed, winner }
 *   winner: 'IDX' (ganha o indexado) | 'FIX' (ganha o fixo) | 'EQ' (empate)
 *           | null (não há preço do fixo para comparar)
 *
 * `q.fixPeriod` é o período do FIXO nesse instante. Se não vier, usa-se
 * `q.period`, que é o do indexado.
 *
 * Os dois lados arredondam a 4 casas antes de comparar: sem isso, ruído de
 * vírgula flutuante (0.1 + 0.2 = 0.30000000000000004) estragava os empates.
 */
export function compareWithFixed(quarters, fixPrice) {
  return quarters.map((q) => {
    if (!fixPrice) return { ...q, fixed: null, winner: null };
    // Um fixo SIMPLES só tem UNICO, que vale para qualquer período.
    // Período sem preço dá null, nunca 0 (0 mostrava o fixo como grátis).
    const key = q.fixPeriod ?? q.period;
    const raw = fixPrice[key] ?? fixPrice.UNICO ?? null;
    if (raw == null) return { ...q, fixed: null, winner: null };
    const fixed = r4(raw);
    const idx = r4(q.price);
    return { ...q, fixed, winner: idx < fixed ? 'IDX' : idx > fixed ? 'FIX' : 'EQ' };
  });
}

/** Conta quantos quartos ganhou cada lado (para o resumo por baixo da tabela). */
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