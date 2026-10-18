import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareWithFixed, tallyWinners } from '../src/engine/compare.js';

const Q = (start, period, price) => ({ start, end: start, period, price });

describe('comparacao indexado vs fixo, quarto a quarto', () => {
  it('marca cada quarto com o vencedor, no mesmo periodo', () => {
    const fix = { VAZIO: 0.1157, FORA_VAZIO: 0.1812 };
    const out = compareWithFixed([
      Q('00:00', 'VAZIO', 0.1762),   // indexado mais caro -> fixo
      Q('10:00', 'VAZIO', 0.0436),   // indexado mais barato -> indexado
      Q('20:00', 'FORA_VAZIO', 0.15), // periodo diferente, outra referencia
    ], fix);
    assert.deepEqual(out.map(x => x.winner), ['FIX', 'IDX', 'IDX']);
    assert.deepEqual(out.map(x => x.fixed), [0.1157, 0.1157, 0.1812],
      'o fixo tem de ser o do MESMO periodo, nao um unico preco');
  });

  it('um fixo SIMPLES so tem UNICO e vale para todos os periodos', () => {
    const out = compareWithFixed([Q('09:00', 'VAZIO', 0.05), Q('20:00', 'FORA_VAZIO', 0.30)], { UNICO: 0.2678 });
    assert.deepEqual(out.map(x => x.fixed), [0.2678, 0.2678]);
    assert.deepEqual(out.map(x => x.winner), ['IDX', 'FIX']);
  });

  it('empate conta como empate, nao como vitoria do indexado', () => {
    const out = compareWithFixed([Q('12:00', 'VAZIO', 0.1157)], { VAZIO: 0.1157 });
    assert.equal(out[0].winner, 'EQ');
  });

  it('arredonda os dois lados antes de comparar (0.1+0.2)', () => {
    // sem arredondar, 0.30000000000000004 > 0.3 daria 'FIX' a um empate
    const out = compareWithFixed([Q('12:00', 'VAZIO', 0.1 + 0.2)], { VAZIO: 0.3 });
    assert.equal(out[0].winner, 'EQ', `${out[0].price} vs ${out[0].fixed}`);
  });

  it('sem fixo escolhido nao inventa vencedor', () => {
    const out = compareWithFixed([Q('12:00', 'VAZIO', 0.05)], null);
    assert.equal(out[0].winner, null);
    assert.equal(out[0].fixed, null);
    assert.deepEqual(tallyWinners(out), { idx: 0, fix: 0, eq: 0, na: 1, total: 1 });
  });

  it('periodo sem preco no fixo -> null, nunca zero', () => {
    // zero seria um numero valido e mostraria o fixo como gratis
    const out = compareWithFixed([Q('20:00', 'FORA_VAZIO', 0.15)], { VAZIO: 0.1157 });
    assert.equal(out[0].fixed, null);
    assert.equal(out[0].winner, null);
  });

  it('tallyWinners fecha com o total', () => {
    const out = compareWithFixed([
      Q('00:00', 'VAZIO', 0.20), Q('01:00', 'VAZIO', 0.05), Q('02:00', 'VAZIO', 0.1157),
    ], { VAZIO: 0.1157 });
    assert.deepEqual(tallyWinners(out), { idx: 1, fix: 1, eq: 1, na: 0, total: 3 });
  });
});