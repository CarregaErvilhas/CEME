import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lossAt, lossByPeriod } from '../src/engine/losses.js';
import { periodForRegion } from '../src/engine/regions.js';

const semanal = d => periodForRegion({ region: 'CONT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: d });

describe('perdas E-REDES por quarto de hora', () => {
  it('BT 2026-10-23 23:30 (fim do quarto) = 0,1484981 — cascata BT×MT×AT×AT/RNT', () => {
    // 23:15-23:30 em Lisboa (WEST, UTC+1) = 22:15Z
    const l = lossAt('BT', new Date('2026-10-23T22:15:00Z'));
    assert.ok(Math.abs(l - 0.1484981) < 1e-7, `BT ${l}`);
  });
  it('MT é a cascata sem o BT, logo menor', () => {
    const t = new Date('2026-10-23T22:15:00Z');
    assert.ok(lossAt('MT', t) < lossAt('BT', t));
    assert.ok(Math.abs(lossAt('MT', t) - 0.0708569) < 1e-7);
  });
  it('a média anual bate com o LOSS_PLACEHOLDER (0,1531 / 0,0713)', () => {
    for (const [v, ref] of [['BT', 0.1531], ['MT', 0.0713]]) {
      let s = 0, n = 0;
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 900000) { s += lossAt(v, new Date(t)); n++; }
      assert.equal(n, 35040);
      assert.ok(Math.abs(s / n - ref) < 5e-5, `${v} ${s / n}`);
    }
  });
  it('sem perfil para o ano devolve null (o chamador usa o placeholder)', () => {
    assert.equal(lossAt('BT', new Date('2025-06-01T12:00:00Z')), null);
  });
  it('média por período: dia útil tem vazio e fora-vazio', () => {
    for (const day of ['2026-10-23T12:00:00Z', '2026-03-30T12:00:00Z', '2026-10-26T12:00:00Z']) {
      const m = lossByPeriod('BT', new Date(day), semanal);
      assert.ok(m.VAZIO > 0.05 && m.FORA_VAZIO > 0.05, JSON.stringify(m));
    }
  });
  it('domingo (semanal) é todo vazio, também nos dias de 92 e 100 quartos', () => {
    for (const day of ['2026-03-29T12:00:00Z', '2026-10-25T12:00:00Z']) {
      const m = lossByPeriod('BT', new Date(day), semanal);
      assert.deepEqual(Object.keys(m), ['VAZIO']);
      assert.ok(m.VAZIO > 0.05, JSON.stringify(m));
    }
  });
});
