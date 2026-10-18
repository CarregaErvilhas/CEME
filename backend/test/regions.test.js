import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periodForRegion, periodForWall, REGIONS } from '../src/engine/regions.js';
import { quoteFixed } from '../src/engine/quote.js';

const D = (s) => new Date(s);

describe('regiões: janelas próprias', () => {
  it('Madeira diário: 10h é fora (09–23), 08h é vazio', () => {
    assert.equal(periodForRegion({ region: 'MAD', schedule: 'BI_HORARIA', cycle: 'DIARIO', at: D('2026-10-15T10:00:00+01:00') }), 'FORA_VAZIO');
    assert.equal(periodForRegion({ region: 'MAD', schedule: 'BI_HORARIA', cycle: 'DIARIO', at: D('2026-10-15T08:00:00+01:00') }), 'VAZIO');
  });
  it('Açores sábado inverno: 12h fora (11:30–13:30), 15h vazio', () => {
    // 2026-01-10 foi sábado
    assert.equal(periodForRegion({ region: 'AZO', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-01-10T12:00:00-01:00') }), 'FORA_VAZIO');
    assert.equal(periodForRegion({ region: 'AZO', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-01-10T15:00:00-01:00') }), 'VAZIO');
  });
  it('Madeira sábado verão 12h fora, domingo vazio', () => {
    // 2026-07-11 sábado, 2026-07-12 domingo
    assert.equal(periodForRegion({ region: 'MAD', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-07-11T12:00:00+01:00') }), 'FORA_VAZIO');
    assert.equal(periodForRegion({ region: 'MAD', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-07-12T12:00:00+01:00') }), 'VAZIO');
  });
  it('fuso dos Açores: 07:30 Lisboa = 06:30 Açores (vazio) em dia útil', () => {
    // 2026-10-15 07:30+01:00 Lisboa = 06:30-01:00 Açores
    assert.equal(periodForRegion({ region: 'CONT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-10-15T07:30:00+01:00') }), 'FORA_VAZIO');
    assert.equal(periodForRegion({ region: 'AZO', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-10-15T07:30:00+01:00') }), 'VAZIO');
  });
});

describe('feriados = próprio dia (sem excepção)', () => {
  it('10 Jun 2026 (quarta, feriado) ao meio-dia é fora-vazio, não vazio', () => {
    assert.equal(periodForRegion({ region: 'CONT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-06-10T12:00:00+01:00') }), 'FORA_VAZIO');
  });
});

describe('IVA por região', () => {
  const base = { schedule: 'BI_HORARIA', cycle: 'SEMANAL', at: D('2026-10-15T22:09:00+01:00'), kwh: 40, price: { VAZIO: 0.1157, FORA_VAZIO: 0.1812 }, activation: 0.11, iec: 0.001 };
  it('CONT 9.11 / MAD menos / AZO ainda menos', () => {
    const c = quoteFixed({ ...base, region: 'CONT' });
    const m = quoteFixed({ ...base, region: 'MAD' });
    const a = quoteFixed({ ...base, region: 'AZO' });
    assert.equal(c.totalEur, 9.11);
    assert.ok(m.totalEur < c.totalEur && a.totalEur < m.totalEur);
    assert.equal(c.vat, REGIONS.CONT.vat);
    assert.equal(a.vat, 1.16);
  });
  it('indexados OMIE só no continente por omissão', () => {
    assert.equal(REGIONS.CONT.omieIndexed, true);
    assert.equal(REGIONS.MAD.omieIndexed, false);
    assert.equal(REGIONS.AZO.omieIndexed, false);
  });
});

describe('periodForWall == periodForRegion (paridade)', () => {
  it('vários instantes dão o mesmo período', async () => {
    const { default: assert2 } = await import('node:assert/strict');
    const cases = [
      ['CONT', 'BI_HORARIA', 'SEMANAL', '2026-10-15T12:00:00+01:00'],
      ['CONT', 'BI_HORARIA', 'SEMANAL', '2026-10-17T12:00:00+01:00'],
      ['CONT', 'BI_HORARIA', 'SEMANAL', '2026-10-18T12:00:00+01:00'],
      ['MAD', 'BI_HORARIA', 'SEMANAL', '2026-07-11T12:00:00+01:00'],
      ['AZO', 'BI_HORARIA', 'SEMANAL', '2026-01-10T12:00:00-01:00'],
      ['AZO', 'BI_HORARIA', 'DIARIO', '2026-01-10T08:30:00-01:00'],
    ];
    for (const [region, schedule, cycle, iso] of cases) {
      const at = new Date(iso);
      const a = periodForRegion({ region, schedule, cycle, at });
      // ymd + minutos na hora local da região
      const tz = { CONT: 'Europe/Lisbon', MAD: 'Atlantic/Madeira', AZO: 'Atlantic/Azores' }[region];
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at).map(x => [x.type, x.value]));
      const b = periodForWall({ region, schedule, cycle, ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) });
      assert2.equal(b, a, `${region} ${iso}`);
    }
  });
});
