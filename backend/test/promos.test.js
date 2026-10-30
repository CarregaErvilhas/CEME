// As promoções de um CEME numa rede de postos (PROMOS, tabela `promo`,
// src/promos.js). O que interessa: os dados do seed fazem sentido, uma
// promoção só aparece no dia, região e tarifário certos, e um desconto de
// ENERGIA baixa o preço final sem tocar na TAR.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROMOS, TARIFFS, CEMES } from '../src/db/seed-data.js';
import { promosFor, promoOut, discounted, freeFirst, finalTotal } from '../src/promos.js';
import { quoteFixed, quoteSlices } from '../src/engine/quote.js';
import { seededDb, reseed } from './seeded-db.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe('PROMOS: os dados do seed', () => {
  it('cada promoção tem o que o schema e o ohmigo precisam', () => {
    const ids = new Set();
    for (const p of PROMOS) {
      assert.ok(!ids.has(p.id), `${p.id} repetido`); ids.add(p.id);
      assert.ok(CEMES.some(c => c.id === p.ceme), `${p.id}: CEME ${p.ceme} não existe`);
      assert.ok(p.name, `${p.id}: falta name`);
      assert.ok(p.network == null || (typeof p.network === 'string' && p.network), `${p.id}: network`);
      assert.ok(ISO.test(p.from) && ISO.test(p.to) && p.from <= p.to, `${p.id}: datas ${p.from}..${p.to}`);
      assert.ok(ISO.test(p.checked), `${p.id}: checked`);
      assert.match(p.url, /^https:\/\//, `${p.id}: url`);
      if (p.target === 'ENERGIA' || p.target === 'FINAL') assert.ok(p.eurKwh > 0 && p.pct == null && p.freeKwh == null, `${p.id}: ${p.target} leva eurKwh`);
      else if (p.target === 'OPC') assert.ok(p.pct > 0 && p.pct <= 100 && p.eurKwh == null && p.freeKwh == null, `${p.id}: OPC leva pct`);
      else if (p.target === 'KWH_GRATIS') assert.ok(p.freeKwh > 0 && p.eurKwh == null && p.pct == null, `${p.id}: KWH_GRATIS leva freeKwh`);
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
    assert.equal(luz.tariff_ids, 'luzigas-promo-ceme-bt,luzigas-promo-ceme-mt,luzigas-promo-casa-bt,luzigas-promo-casa-mt');
    assert.equal(luz.new_customers, 0);
    assert.equal(promoOut(luz).newCustomers, false);
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

describe('freeFirst: kWh grátis no início do carregamento', () => {
  const P = { UNICO: 0.25 }, S = { UNICO: { energy: 0.2, tar: 0.05 } };
  it('parte a fatia onde os grátis acabam, com o mesmo instante', () => {
    const at = '2026-11-10T12:00:00Z';
    const out = freeFirst([{ at, kwh: 3, price: P, split: S }, { at: 'b', kwh: 10, price: P, split: S }], 7);
    assert.deepEqual(out.map(x => [x.at, x.kwh, x.price.UNICO]), [[at, 3, 0], ['b', 4, 0], ['b', 6, 0.25]]);
    assert.deepEqual(out[0].split.UNICO, { energy: 0, tar: 0 });
  });
  it('mais grátis do que o carregamento: tudo grátis; zero: igual', () => {
    assert.deepEqual(freeFirst([{ at: 'a', kwh: 5, price: P }], 7).map(x => x.price.UNICO), [0]);
    const sl = [{ at: 'a', kwh: 5, price: P }];
    assert.equal(freeFirst(sl, 0), sl);
  });
  it('num fixo, 7 kWh grátis = 7 × preço a menos na energia; IEC e activação ficam', () => {
    const at = new Date('2026-11-10T12:00:00Z');
    const args = { schedule: 'SIMPLES', cycle: 'SIMPLES', activation: 0.1088, iec: 0.001 };
    const full = quoteSlices({ ...args, slices: [{ at, kwh: 30, price: P }] });
    const free = quoteSlices({ ...args, slices: freeFirst([{ at, kwh: 30, price: P }], 7) });
    assert.equal(Math.round((full.parts.energyTar - free.parts.energyTar) * 100), 175);
    assert.equal(free.parts.iec, full.parts.iec);
    assert.equal(free.parts.activation, full.parts.activation);
  });
});

describe('finalTotal: tudo incluído', () => {
  it('kWh × preço, para cima ao cêntimo', () => {
    assert.equal(finalTotal(40, 0.47), 18.8);
    assert.equal(finalTotal(33.333, 0.5), 16.67);
  });
});
