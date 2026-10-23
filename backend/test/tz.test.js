// frontend/tz.js: a hora de relógio da região, nos dois sentidos.
//
// O caso que importa são os dias de mudança de hora: o simulador lia a hora
// escrita no fuso do browser, e nos dias de 23/25 horas é onde uma conversão
// "quase certa" se desvia.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { Intl, Date, Number, String, Object, globalThis: undefined };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../../frontend/tz.js', import.meta.url), 'utf8'), ctx);
const { fromWall, toWall, TZ } = ctx.CEME_TZ;
const iso = (d) => d && d.toISOString();

describe('tz.js — relógio da região', () => {
  it('lê a hora no fuso da região, não no do processo', () => {
    assert.equal(iso(fromWall('2026/07/01 12:00', TZ.CONT)), '2026-07-01T11:00:00.000Z');
    assert.equal(iso(fromWall('2026/07/01 12:00', TZ.AZO)), '2026-07-01T12:00:00.000Z');
    assert.equal(iso(fromWall('2026/01/15 12:00', TZ.CONT)), '2026-01-15T12:00:00.000Z');
    assert.equal(iso(fromWall('2026/01/15 12:00', TZ.MAD)), '2026-01-15T12:00:00.000Z');
  });

  it('Março: a hora que não existe (01:30 em Lisboa) vai para depois do salto', () => {
    // 2026-03-29: às 01:00 UTC o relógio de Lisboa salta das 01:00 para as 02:00.
    assert.equal(iso(fromWall('2026/03/29 00:59', TZ.CONT)), '2026-03-29T00:59:00.000Z');
    assert.equal(iso(fromWall('2026/03/29 02:00', TZ.CONT)), '2026-03-29T01:00:00.000Z');
    // A hora que não existe vai para depois do salto, no mesmo dia civil.
    assert.equal(iso(fromWall('2026/03/29 01:30', TZ.CONT)), '2026-03-29T01:30:00.000Z'); // = 02:30 WEST
    // Açores: o salto é das 23:59 de sábado para a 01:00 de domingo.
    assert.equal(iso(fromWall('2026/03/29 00:30', TZ.AZO)), '2026-03-29T01:30:00.000Z'); // = 01:30 de domingo
    assert.equal(toWall(fromWall('2026/03/29 00:30', TZ.AZO), TZ.AZO), '2026/03/29 01:30');
  });

  it('Outubro: a hora repetida resolve-se para a PRIMEIRA passagem', () => {
    // 2026-10-25: às 01:00 UTC o relógio de Lisboa recua das 02:00 para as 01:00.
    assert.equal(iso(fromWall('2026/10/25 01:30', TZ.CONT)), '2026-10-25T00:30:00.000Z'); // 01:30 WEST
    assert.equal(iso(fromWall('2026/10/25 02:30', TZ.CONT)), '2026-10-25T02:30:00.000Z');
    // Açores: a hora repetida é a 00:xx.
    assert.equal(iso(fromWall('2026/10/25 00:30', TZ.AZO)), '2026-10-25T00:30:00.000Z'); // 00:30 (UTC+0)
  });

  it('ida e volta: toWall(fromWall(x)) = x fora dos buracos', () => {
    for (const tz of Object.values(TZ)) {
      for (const w of ['2026/03/28 23:45', '2026/03/29 03:15', '2026/10/24 22:00', '2026/10/25 03:00', '2026/12/31 23:59']) {
        assert.equal(toWall(fromWall(w, tz), tz), w, `${tz} ${w}`);
      }
    }
  });

  it('recusa o que não é data', () => {
    for (const bad of ['', '2026-07-01 12:00', '2026/13/01 12:00', '2026/07/01 24:00', null]) {
      assert.equal(fromWall(bad, TZ.CONT), null, String(bad));
    }
  });
});
