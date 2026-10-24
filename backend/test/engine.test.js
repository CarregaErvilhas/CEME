import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periodFor } from '../src/engine/periods.js';
import { quoteFixed } from '../src/engine/quote.js';
import { indexedPrice } from '../src/engine/indexed.js';

// Sanidade do motor com preços escritos à mão (as âncoras reais, do seed, estão
// no golden.test.js). Tolerância 0,02 €: aqui só interessa a ordem de grandeza.
describe('motor', () => {
  it('bi-horário diário: 12h é fora-vazio, 23h é vazio', () => {
    const noon = new Date('2026-10-15T12:00:00+01:00');
    const night = new Date('2026-10-15T23:30:00+01:00');
    assert.equal(periodFor({ schedule: 'BI_HORARIA', cycle: 'DIARIO', at: noon }), 'FORA_VAZIO');
    assert.equal(periodFor({ schedule: 'BI_HORARIA', cycle: 'DIARIO', at: night }), 'VAZIO');
  });
  it('semanal: domingo sempre vazio', () => {
    const sun = new Date('2026-10-18T12:00:00+01:00'); // domingo
    assert.equal(periodFor({ schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: sun }), 'VAZIO');
  });
  it('quoteFixed: ordem de grandeza de um fixo bi-horário a 40 kWh', () => {
    const at = new Date('2026-10-15T22:09:00+01:00');
    const q = quoteFixed({
      schedule: 'BI_HORARIA', cycle: 'SEMANAL', at, kwh: 40,
      price: { VAZIO: 0.1157, FORA_VAZIO: 0.1812 }, // final ERSE c/ TAR incluída
      activation: 0.11, support: 0, iec: 0.001,
    });
    assert.ok(Math.abs(q.totalEur - 9.11) < 0.02, `total ${q.totalEur} ≈ 9.11`);
    assert.ok(Math.abs(q.eurKwhNoIva - 0.19) < 0.02);
  });
  it('PE(h) standard: (OMIE+K+CGS)*(1+perdas)+TAR', () => {
    const { price } = indexedPrice({ omieEurKwh: 0.18, kIndex: 0.005, cgs: 0.02, voltage: 'MT', loss: 0.1, tarEurKwh: 0.0157 });
    assert.ok(Math.abs(price - ((0.18 + 0.005 + 0.02) * 1.1 + 0.0157)) < 1e-9);
  });
});

describe('quoteFixed — decomposição do total (parts)', () => {
  it('as linhas somam o total ao cêntimo, com e sem separação energia/TAR', () => {
    const at = new Date('2026-10-21T12:00:00Z');
    for (const kwh of [0.1, 7.3, 40, 56.8, 999]) {
      for (const split of [undefined, { FORA_VAZIO: { energy: 0.12, tar: 0.0812 } }]) {
        for (const region of ['CONT', 'MAD', 'AZO']) {
          const q = quoteFixed({ schedule: 'BI_HORARIA', cycle: 'SEMANAL', at, kwh, price: { VAZIO: 0.1357, FORA_VAZIO: 0.2012 },
            activation: 0.11, iec: 0.001, region, split });
          const p = q.parts;
          const cents = (x) => Math.round(x * 100);
          assert.equal(cents(p.energyTar + p.iec + p.activation + p.support), cents(p.base), `base ${kwh}/${region}`);
          assert.equal(cents(p.base + p.vatEur), cents(q.totalEur), `total ${kwh}/${region}`);
          if (split) assert.equal(cents(p.energy + p.tar), cents(p.energyTar), 'energia + TAR = a parcela conjunta');
          else assert.equal(p.energy, null, 'sem separação conhecida, não se inventa');
        }
      }
    }
  });
});
