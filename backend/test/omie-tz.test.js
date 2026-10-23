// Guarda de regressão: o ficheiro do TF está em hora de Lisboa, por isso a
// agregação tem de ser por dia civil de Lisboa. Se alguém voltar a agrupar por
// dia de Madrid (CET), a média mensal deixa de bater com o TF.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTfQuarters } from '../src/omie/tf.js';
import { aggregate } from '../src/omie/stats.js';

describe('OMIE — fuso horário (guarda de regressão)', () => {
  it('a média mensal bate com o TF publicado (Setembro 2026 = 143,91)', () => {
    const text = readFileSync('./data/tf-omie-atual.csv', 'utf8');
    const { days } = parseTfQuarters(text);
    const rows = [];
    for (const [day, list] of days) {
      const [y, m, d] = day.split('-').map(Number);
      const dn = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
      for (const r of list) {
        rows.push({
          dn, day, mk: `${y}-${String(m).padStart(2, '0')}`,
          min: r.min, lisbonDn: dn, lisbonMin: r.min,
          bd: r.bd, bs: r.bs, price: r.pt, est: false,
          utc: new Date(Date.UTC(y, m - 1, d, 0, 0) + r.min * 60000).toISOString(),
        });
      }
    }
    const keys = [...days.keys()].sort();
    const cutoff = keys[keys.length - 1];
    const now = new Date(cutoff + 'T12:00:00Z');
    const d = aggregate(rows, { cutoff, now });
    const sep = d.months.find(m => m.key === '2026-09');
    assert.ok(sep, 'Setembro 2026 tem de estar na janela');
    assert.equal(sep.media, 143.91, 'a média tem de bater com o TF publicado');
    assert.equal(sep.quarters, 2880, '4 quartos × 24 h × 30 dias');
  });
});
