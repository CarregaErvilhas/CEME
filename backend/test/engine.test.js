import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periodFor } from '../src/engine/periods.js';
import { quoteFixed, indexedQuarter } from '../src/engine/quote.js';

// Vectores golden do sheet em 2026-10-15 (quinta, 22:09 Lisbon).
// Atlante MT/BS: Fora-Vazio (22:09 < 24:00 dia útil) -> 0,1812+0,0157 TAR MT
// aproximado; tolerância 0,02 €/kWh porque o sheet mistura ERSE/outras fontes.
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
  it('quoteFixed Atlante MT ordem de grandeza (9,11€/40kWh)', () => {
    const at = new Date('2026-10-15T22:09:00+01:00');
    const q = quoteFixed({
      schedule: 'BI_HORARIA', cycle: 'SEMANAL', at, kwh: 40,
      price: { VAZIO: 0.1157, FORA_VAZIO: 0.1812 }, // final ERSE c/ TAR incluída
      activation: 0.11, support: 0, iec: 0.001,
    });
    assert.ok(Math.abs(q.totalEur - 9.11) < 0.02, `total ${q.totalEur} ≈ 9.11`);
    assert.ok(Math.abs(q.eurKwhNoIva - 0.19) < 0.02);
  });
  it('PE(h) Luzigas: (OMIE+K+CGS)*(1+perdas)+TAR', () => {
    const pe = indexedQuarter({ omieEurKwh: 0.18, kIndex: 0.005, cgs: 0.02, lossFactor: 0.1, tarEurKwh: 0.0157 });
    assert.ok(Math.abs(pe - ((0.18 + 0.005 + 0.02) * 1.1 + 0.0157)) < 1e-9);
  });
});
