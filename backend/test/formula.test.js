// Paridade da fórmula do motor no browser: o gráfico/breakeven do comparador
// usa uma cópia da fórmula dos indexados escrita em JS dentro de
// frontend/index.html (`idxPrice`). É deliberada (o gráfico desenha 60 dias
// sem endpoint novo), mas é uma segunda implementação da mesma conta. Este
// teste extrai essa linha do HTML e compara-a com `indexedPrice()` e
// `breakevenOmie()` nas duas fórmulas, para várias entradas: se as duas
// divergirem, falha aqui.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexedPrice, breakevenOmie } from '../src/engine/indexed.js';

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const m = /const idxPrice = \(o, t\) => (.*?);\n/.exec(html);
if (!m) throw new Error('idxPrice() não encontrada em frontend/index.html — o teste deixa de ter garantido o que protege');
const expr = m[1]; // ex.: "yn ? loss * (o + a.k) + a.cgs + t : loss * (o + a.k + a.cgs) + t"
const idxClient = (yn, lossFactor, k, cgs) => (o, t) =>
  new Function('yn', 'loss', 'a', 'o', 't', `return ${expr};`)(yn, 1 + lossFactor, { k, cgs }, o, t);

const lossBT = 0.1531, lossMT = 0.0713;
const INPUTS = [
  { omie: 0.05, k: 0.001, cgs: 0.001, tar: 0.0266, loss: lossBT },
  { omie: 0.20, k: 0.0, cgs: 0.0, tar: 0.1192, loss: lossMT },
  { omie: 0.118, k: 0.005, cgs: 0.002, tar: 0.0812, loss: lossMT },
  { omie: -0, k: 0.010, cgs: 0.010, tar: 0.0, loss: lossBT },
];

const rounds = (x) => Math.round(x * 1e6) / 1e6;

describe('fórmula no browser == fórmula do motor (engine/indexed.js)', () => {
  it('a expressão existe no frontend e fica colada ao motor', () => {
    assert.ok(expr.includes('yn'), 'a expressão extraída perdeu o ramo ynerluz?');
  });
  for (const [i, inp] of INPUTS.entries()) {
    it(`standard, input #${i}: OMIE ${inp.omie}, K ${inp.k}`, () => {
      const engine = indexedPrice({ omieEurKwh: inp.omie, kIndex: inp.k, cgs: inp.cgs, voltage: 'BT', tarEurKwh: inp.tar, loss: inp.loss, formula: 'standard' }).price;
      assert.equal(rounds(idxClient(false, inp.loss, inp.k, inp.cgs)(inp.omie, inp.tar)), rounds(engine));
    });
    it(`ynerluz, input #${i}`, () => {
      const engine = indexedPrice({ omieEurKwh: inp.omie, kIndex: inp.k, cgs: inp.cgs, voltage: 'MT', tarEurKwh: inp.tar, loss: inp.loss, formula: 'ynerluz' }).price;
      assert.equal(rounds(idxClient(true, inp.loss, inp.k, inp.cgs)(inp.omie, inp.tar)), rounds(engine));
    });
  }
  it('breakeven client == breakevenOmie() (inverso da fórmula)', () => {
    const loss = lossMT, k = 0.005, cgs = 0.002, tar = 0.0812, fixed = 0.30;
    const beEngine = breakevenOmie({ fixedFinal: fixed, kIndex: k, cgs, voltage: 'MT', tarEurKwh: tar, loss, formula: 'ynerluz' });
    const beClient = ((fixed - cgs - tar) / (1 + loss)) - k;
    assert.equal(rounds(beClient), rounds(beEngine));
  });
});
