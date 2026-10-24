import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOmieTxt, assessDays } from '../src/omie/parse.js';
import { marketPeriodToLisbon, expectedQuartersForLisbonDay } from '../src/omie/convert.js';
import { reconcile } from '../src/omie/store.js';

describe('parseOmieTxt defensivo', () => {
  it('aceita período 1..96 com vírgula decimal e rejeita linhas más sem lançar', () => {
    const txt = [
      'OMIE - Mercado de electricidad;Fecha Emisión :14/10/2026 - 13:32;;15/10/2026;;;;',
      'Fecha;Periodo;ES;PT;',
      '15/10/2026;1;226;226;',
      '15/10/2026;2;225,5;225,5;',
      '15/10/2026;101;999;999;',  // período impossível (>100) -> quarentena
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
    const bad = marketPeriodToLisbon('2026-10-15', 101);
    assert.ok(bad.error);
  });

  // O dia de mercado corre de 00:00 a 24:00 em Madrid (CET), que está sempre
  // uma hora à frente de Lisboa. Nos dias de mudança de hora o dia tem 92
  // (Manhã) ou 100 (Outono) períodos — e o offset de Lisboa muda a meio.
  it('o dia de mudança de hora de Outono tem 100 períodos', () => {
    const p1 = marketPeriodToLisbon('2026-10-25', 1);
    assert.equal(p1.error, null);
    assert.match(p1.iso, /T23:00:00\+01:00$/, 'a meia-noite de Madrid são as 23:00 de Lisboa');
    const p100 = marketPeriodToLisbon('2026-10-25', 100);
    assert.equal(p100.error, null);
    assert.match(p100.iso, /T22:45:00\+00:00$/, 'no fim do dia já é CET (a hora voltou atrás)');
  });

  it('o dia de mudança de hora da manhã tem 92 períodos', () => {
    const p1 = marketPeriodToLisbon('2026-03-29', 1);
    assert.match(p1.iso, /T23:00:00\+00:00$/);
    const p92 = marketPeriodToLisbon('2026-03-29', 92);
    assert.equal(p92.error, null);
    assert.match(p92.iso, /T22:45:00\+01:00$/, 'no fim do dia já é WEST');
  });
});

describe('a reconciliação entre as fontes (na BD)', () => {
  it('prefere a fonte primária e marca o conflito', () => {
    // A reconciliação em si está em `omie/store.js` (e é testada lá, com a
    // BD); aqui fica o caso mais simples: duas fontes para o mesmo
    // instante, com o omie.es a ganhar.
    const rows = [
      { ts_utc: '2026-10-20T00:00:00.000Z', day_lisbon: '2026-10-20', min_lisbon: 0, price_pt_eur_mwh: 100, price_es_eur_mwh: 100, bd: null, bs: null, source: 'OMIE_ES', flags: null },
      { ts_utc: '2026-10-20T00:00:00.000Z', day_lisbon: '2026-10-20', min_lisbon: 0, price_pt_eur_mwh: 106, price_es_eur_mwh: 106, bd: 'V', bs: 'F', source: 'TF', flags: null },
    ];
    const out = reconcile(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].pt, 100, 'o omie.es manda');
    assert.equal(out[0].bs, 'F', 'a classificação vem do TF');
  });
});
