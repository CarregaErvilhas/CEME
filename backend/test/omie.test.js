import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOmieTxt, assessDays } from '../src/omie/parse.js';
import { marketPeriodToLisbon, expectedQuartersForLisbonDay } from '../src/omie/convert.js';
import { parseTiagoFeliciaCsv, reconcileQuarters } from '../src/omie/fallback.js';

describe('parseOmieTxt defensivo', () => {
  it('aceita período 1..96 com vírgula decimal e rejeita linhas más sem lançar', () => {
    const txt = [
      'OMIE - Mercado de electricidad;Fecha Emisión :14/10/2026 - 13:32;;15/10/2026;;;;',
      'Fecha;Periodo;ES;PT;',
      '15/10/2026;1;226;226;',
      '15/10/2026;2;225,5;225,5;',
      '15/10/2026;97;999;999;',   // período inválido -> quarentena
      'lixo sem colunas',
      '15/10/2026;2;225;225;',    // duplicado -> quarentena
      '15/10/2026;3;abc;10;',     // preço mau -> quarentena
    ].join('\n');
    const { rows, quarantined } = parseOmieTxt(txt);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].pricePt, 225.5);
    assert.ok(quarantined.length >= 3);
  });

  it('assinala suspect_range e suspect_pt_es_split sem deitar fora', () => {
    const txt = 'Fecha;Periodo;ES;PT;\n15/10/2026;1;10;5000;\n';
    const { rows, quarantined } = parseOmieTxt(txt);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].flags.includes('suspect_range'));
    assert.ok(rows[0].flags.includes('suspect_pt_es_split'));
    assert.equal(quarantined.length, 0);
  });

  it('assessDays detecta PARTIAL', () => {
    const { rows } = parseOmieTxt('Fecha;Periodo;ES;PT;\n15/10/2026;1;1;1;\n15/10/2026;3;1;1;\n');
    const days = assessDays(rows, () => 96);
    assert.equal(days[0].status, 'PARTIAL');
    assert.deepEqual(days[0].missing.slice(0, 2), [2, 4]);
  });
});

describe('conversão CET->Lisbon e DST', () => {
  it('dias normais têm 96 quartos', () => {
    assert.equal(expectedQuartersForLisbonDay('2026-10-15'), 96);
  });
  it('primavera 92 / outono 100 (últimos domingos)', () => {
    assert.equal(expectedQuartersForLisbonDay('2026-03-29'), 92);
    assert.equal(expectedQuartersForLisbonDay('2026-10-25'), 100);
  });
  it('período 1 converte sem erro e período inválido dá erro sem lançar', () => {
    const ok = marketPeriodToLisbon('2026-10-15', 1);
    assert.equal(ok.error, null);
    assert.match(ok.iso, /^2026-10-1[45]T/);
    const bad = marketPeriodToLisbon('2026-10-15', 97);
    assert.ok(bad.error);
  });
});

describe('fallback tiagofelicia + reconciliação', () => {
  it('parse do CSV já em hora PT', () => {
    const csv = 'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es\n01/01/2026,00:15,[00:00-00:15[,S,V,V,V,V,104.70,104.70\nlinha má\n';
    const { rows, quarantined } = parseTiagoFeliciaCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pricePt, 104.7);
    assert.equal(quarantined.length, 1);
  });
  it('reconcile prefere a 1ª fonte e marca conflito > 5', () => {
    const out = reconcileQuarters([
      { name: 'OMIE_ES', map: new Map([['t1', 100], ['t2', 100]]) },
      { name: 'REN', map: new Map([['t1', 100.5], ['t2', 200]]) },
    ]);
    assert.equal(out[0].source, 'OMIE_ES');
    assert.equal(out[0].conflict, null);
    assert.ok(out[1].conflict);
  });
});
