// Garante as contas de datas partilhadas (src/time.js): os dias de mudança
// de hora, o relógio de cada fuso (incluindo a hora repetida de Outubro) e
// as conversões de dias.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumOf, isoOfDayNum, shiftDays, dmyToIso, euDstDays, euDstRange, zonedParts } from '../src/time.js';

describe('time.js', () => {
  it('dias de mudança de hora: último domingo de Março e de Outubro', () => {
    assert.deepEqual(euDstDays(2026), { spring: '2026-03-29', autumn: '2026-10-25' });
    assert.deepEqual(euDstDays(2027), { spring: '2027-03-28', autumn: '2027-10-31' });
    const { start, end } = euDstRange(2026);
    assert.equal(new Date(start).toISOString(), '2026-03-29T01:00:00.000Z');
    assert.equal(new Date(end).toISOString(), '2026-10-25T01:00:00.000Z');
  });

  it('a hora repetida de Outubro distingue-se pelo offset', () => {
    const a = zonedParts(new Date('2026-10-25T00:30:00Z'), 'Europe/Lisbon');
    const b = zonedParts(new Date('2026-10-25T01:30:00Z'), 'Europe/Lisbon');
    assert.equal(a.minutes, b.minutes);
    assert.deepEqual([a.offset, b.offset], ['+01:00', '+00:00']);
    assert.equal(a.weekday, 'Sun');
  });

  it('cada fuso tem o seu dia e a sua hora', () => {
    const at = new Date('2026-07-01T23:30:00Z');
    assert.equal(zonedParts(at, 'Europe/Lisbon').ymd, '2026-07-02');
    assert.equal(zonedParts(at, 'Atlantic/Azores').ymd, '2026-07-01');
    assert.equal(zonedParts(at, 'Atlantic/Azores').offset, '+00:00');
    assert.equal(zonedParts(new Date('2026-01-01T00:00:00Z'), 'UTC').hour, 0);
  });

  it('dias como números, nos dois sentidos e a atravessar meses e anos', () => {
    assert.equal(isoOfDayNum(dayNumOf('2026-02-28')), '2026-02-28');
    assert.equal(shiftDays('2026-02-28', 1), '2026-03-01');
    assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
  });

  it('d/m/aaaa → AAAA-MM-DD', () => {
    assert.equal(dmyToIso('5/3/2026'), '2026-03-05');
    assert.equal(dmyToIso(' 25/10/2026 '), '2026-10-25');
    assert.equal(dmyToIso('2026-10-25'), null);
    assert.equal(dmyToIso(undefined), null);
  });
});
