// O ficheiro do TF está em hora de Lisboa, por isso a agregação tem de ser
// por dia de Lisboa. Este teste confirma que a média mensal calculada bate
// com a que o TF publica.
//
// A validação usa o ficheiro em cache quando existe (dev) e, em alternativa,
// tenta ir buscá-lo à fonte (CI). Se não for possível obter os dados, o teste
// é ignorado em vez de falhar — a asserção só faz sentido com os dados reais.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseTfQuarters } from '../src/omie/tf.js';
import { aggregate } from '../src/omie/stats.js';

const TF_URL = 'https://dados.tiagofelicia.pt/data/omie/omie_dados_atuais.csv';

async function loadText() {
  if (existsSync('./data/tf-omie-atual.csv')) {
    return readFileSync('./data/tf-omie-atual.csv', 'utf8');
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(TF_URL, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

describe('OMIE — fuso horário (guarda de regressão)', () => {
  it('a média mensal bate com o TF publicado (Setembro 2026 = 143,91)', async (t) => {
    const text = await loadText();
    if (!text) { t.skip('dados do TF indisponíveis'); return; }
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
