import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexedPrice, breakevenOmie } from '../src/engine/indexed.js';

describe('indexados', () => {
  it('PE(h) com perdas E-REDES 2026 MT 7,13%', () => {
    const { price } = indexedPrice({ omieEurKwh: 0.20, kIndex: 0.005, cgs: 0.02, voltage: 'MT', tarEurKwh: 0.0812 });
    assert.ok(Math.abs(price - (0.225 * 1.0713 + 0.0812)) < 1e-9);
  });
  it('breakeven: abaixo dele o indexado ganha', () => {
    const be = breakevenOmie({ fixedFinal: 0.1812, kIndex: 0.005, cgs: 0.02, voltage: 'MT', tarEurKwh: 0.0812 });
    // com OMIE=be, PE == fixo
    const { price } = indexedPrice({ omieEurKwh: be, kIndex: 0.005, cgs: 0.02, voltage: 'MT', tarEurKwh: 0.0812 });
    assert.ok(Math.abs(price - 0.1812) < 1e-9);
    assert.ok(be > 0 && be < 0.2, `breakeven plausível: ${be}`);
  });
});
