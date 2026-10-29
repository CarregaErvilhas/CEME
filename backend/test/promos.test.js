// As promoções de um CEME numa rede de postos (PROMOS, tabela `promo`,
// src/promos.js). O que interessa: os dados do seed fazem sentido, uma
// promoção só aparece no dia, região e tarifário certos, e um desconto de
// ENERGIA baixa o preço final sem tocar na TAR.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROMOS, TARIFFS, CEMES } from '../src/db/seed-data.js';
import { promosFor, promoOut, discounted } from '../src/promos.js';
import { quoteFixed } from '../src/engine/quote.js';
import { seededDb, reseed } from './seeded-db.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe('PROMOS: os dados do seed', () => {
  it('cada promoção tem o que o schema e o ohmigo precisam', () => {
    const ids = new Set();
    for (const p of PROMOS) {
      assert.ok(!ids.has(p.id), `${p.id} repetido`); ids.add(p.id);
      assert.ok(CEMES.some(c => c.id === p.ceme), `${p.id}: CEME ${p.ceme} não existe`);
      assert.ok(p.name && p.network, `${p.id}: falta name ou network`);
      assert.ok(ISO.test(p.from) && ISO.test(p.to) && p.from <= p.to, `${p.id}: datas ${p.from}..${p.to}`);
      assert.ok(ISO.test(p.checked), `${p.id}: checked`);
      assert.match(p.url, /^https:\/\//, `${p.id}: url`);
      if (p.target === 'ENERGIA') assert.ok(p.eurKwh > 0 && p.pct == null, `${p.id}: ENERGIA leva eurKwh`);
      else if (p.target === 'OPC') assert.ok(p.pct > 0 && p.pct <= 100 && p.eurKwh == null, `${p.id}: OPC leva pct`);
      else assert.fail(`${p.id}: target ${p.target}`);
      for (const tid of p.tariffs ?? []) {
        const t = TARIFFS.find(x => x.id === tid);
        assert.ok(t, `${p.id}: tarifário ${tid} não existe`);
        assert.equal(t.ceme, p.ceme, `${p.id}: ${tid} é de outro CEME`);
      }
    }
  });

  it('o seed grava-as, e voltar a correr não duplica', async () => {
    const db = await seededDb();
    await reseed(db);
    const rows = db.prepare('SELECT * FROM promo ORDER BY id').all();
    assert.equal(rows.length, PROMOS.length);
    const luz = rows.find(r => r.id === 'luzigas-powerdot-2026-10');
    assert.equal(luz.tariff_ids, null, 'sem lista = todos os tarifários do CEME');
    assert.equal(luz.new_customers, 1);
    assert.equal(promoOut(luz).newCustomers, true);
  });
});

describe('promosFor: dia, região e tarifário', () => {
  const row = { id: 'x', ceme_id: 'miio', tariff_ids: 'miio-bt-miioonebi', starts_on: '2026-02-03', ends_on: '2026-12-31', regions: 'CONT' };
  const one = { id: 'miio-bt-miioonebi', ceme_id: 'miio' };
  it('o primeiro e o último dia contam (inclusive)', () => {
    assert.equal(promosFor([row], one, '2026-02-03', 'CONT').length, 1);
    assert.equal(promosFor([row], one, '2026-12-31', 'CONT').length, 1);
    assert.equal(promosFor([row], one, '2026-02-02', 'CONT').length, 0);
    assert.equal(promosFor([row], one, '2027-01-01', 'CONT').length, 0);
  });
  it('fora da região ou de outro tarifário, não', () => {
    assert.equal(promosFor([row], one, '2026-06-01', 'MAD').length, 0);
    assert.equal(promosFor([row], { id: 'miio-bt-miiobihor', ceme_id: 'miio' }, '2026-06-01', 'CONT').length, 0);
  });
  it('sem lista de tarifários, vale para todos os do CEME e só esses', () => {
    const all = { ...row, tariff_ids: null };
    assert.equal(promosFor([all], { id: 'miio-bt-miiobihor', ceme_id: 'miio' }, '2026-06-01', 'CONT').length, 1);
    assert.equal(promosFor([all], { id: 'edp-bt-cartoedp', ceme_id: 'edp' }, '2026-06-01', 'CONT').length, 0);
  });
});

describe('discounted: desconto de ENERGIA', () => {
  it('sai da energia; a TAR fica', () => {
    const { price, split } = discounted({ VAZIO: 0.2, FORA_VAZIO: 0.3 }, { VAZIO: { energy: 0.17, tar: 0.03 }, FORA_VAZIO: null }, 0.12);
    assert.ok(Math.abs(price.VAZIO - 0.08) < 1e-12);
    assert.ok(Math.abs(price.FORA_VAZIO - 0.18) < 1e-12);
    assert.equal(split.VAZIO.tar, 0.03);
    assert.ok(Math.abs(split.VAZIO.energy - 0.05) < 1e-12);
    assert.equal(split.FORA_VAZIO, null, 'sem separação conhecida, não se inventa');
  });
  it('nunca abaixo de zero', () => {
    assert.equal(discounted({ UNICO: 0.05 }, {}, 0.12).price.UNICO, 0);
  });
  it('num fixo, 40 kWh × 0,12 € a menos = 4,80 € a menos antes do IVA', () => {
    const at = new Date('2026-11-10T12:00:00Z');
    const args = { schedule: 'SIMPLES', cycle: 'SIMPLES', at, kwh: 40, activation: 0.1088, iec: 0.001 };
    const full = quoteFixed({ ...args, price: { UNICO: 0.25 } });
    const off = quoteFixed({ ...args, ...discounted({ UNICO: 0.25 }, {}, 0.12) });
    assert.equal(Math.round((full.parts.base - off.parts.base) * 100), 480);
  });
});
