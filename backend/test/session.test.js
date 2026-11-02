// Indexados que cobram pela média do OMIE da sessão (engine/session.js e o
// `session` do quoteOne).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR_MS, hourQuarters, sessionHours, sessionLoss, sessionOmie } from '../src/engine/session.js';
import { indexedPrice } from '../src/engine/indexed.js';
import { quoteOne, vmeta } from '../src/tariffs.js';

// Uma sessão real facturada pela LUZiGÁS (Cliente Casa e CEME, BTN, ciclo
// semanal): ligada 1267 min, 21,705 kWh. A LUZiGÁS mandou a conta: estes 21
// preços horários do OMIE (€/kWh), a média, K, CGS e perdas, e o preço
// unitário da energia que deu os 3,37 € facturados. A TAR veio à parte
// (21,705 kWh × 0,0266 = 0,5774 €).
const HOURLY = [0.00022, 0.00016, 0.00007, 0, -0.00001, 0.00139, 0.05693, 0.15144, 0.19374, 0.19664, 0.18526,
  0.17523, 0.16509, 0.16787, 0.16598, 0.15911, 0.15788, 0.1627, 0.17659, 0.21113, 0.24139];
const FIRST_HOUR = Date.parse('2026-09-27T09:00:00Z');
const KWH = 21.705;

describe('sessionHours / sessionOmie', () => {
  it('as horas tocadas, da hora do início à hora do fim', () => {
    const h = sessionHours(new Date('2026-09-27T11:44:00Z'), new Date('2026-09-28T08:45:00Z'));
    assert.equal(h[0], Date.parse('2026-09-27T11:00:00Z'));
    assert.equal(h.at(-1), Date.parse('2026-09-28T08:00:00Z'));
    assert.equal(h.length, 22);
    // Uma fatia que começa às 09:45 acaba até às 10:00: a hora das 10 não entra.
    assert.equal(sessionHours(new Date('2026-09-28T09:00:00Z'), new Date('2026-09-28T09:45:00Z')).length, 1);
  });

  it('média simples dos preços horários (cada hora = média dos seus quartos)', () => {
    const hours = HOURLY.map((_, i) => FIRST_HOUR + i * HOUR_MS);
    const s = sessionOmie(hours, q => HOURLY[Math.floor((q - FIRST_HOUR) / HOUR_MS)]);
    // O valor que a LUZiGÁS mandou: 0,122324 €/kWh.
    assert.equal(Math.round(s.omieKwh * 1e6) / 1e6, 0.122324);
    assert.equal(s.hours, 21);
    assert.equal(s.from, '2026-09-27T09:00:00.000Z');
    assert.equal(s.to, '2026-09-28T06:00:00.000Z');
    // Uma hora com quartos diferentes vale a média deles.
    const one = sessionOmie([FIRST_HOUR], q => [0.1, 0.2, 0.3, 0.4][(q - FIRST_HOUR) / (15 * 60000)]);
    assert.equal(Math.round(one.omieKwh * 1e9) / 1e9, 0.25);
  });

  it('falta um quarto: null (não se inventa o preço da hora)', () => {
    const hours = [FIRST_HOUR, FIRST_HOUR + HOUR_MS];
    const last = hourQuarters(hours).at(-1);
    assert.equal(sessionOmie(hours, q => (q === last ? null : 0.1)), null);
    assert.equal(sessionOmie([], () => 0.1), null);
  });

  it('a conta da LUZiGÁS dá os 3,37 € de energia', () => {
    const omie = HOURLY.reduce((a, v) => a + v, 0) / HOURLY.length;
    const unit = indexedPrice({ omieEurKwh: omie, kIndex: 0.005, cgs: 0.0183, voltage: 'BT', tarEurKwh: 0, loss: 0.0669 }).price;
    assert.equal(Math.round(unit * 1e6) / 1e6, 0.155367);
    assert.equal(Math.round(unit * KWH * 100) / 100, 3.37);
  });
});

describe('quoteOne de um indexado que cobra pela média da sessão', () => {
  const t = { id: 'luzigas-casa-bt', vid: 1, kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', ceme_name: 'LUZiGÁS', name: 'teste', regions: ['CONT'] };
  const TAR = { VAZIO: 0.0266, FORA_VAZIO: 0.1192 };
  const pricing = {
    version: () => ({ k_index_eur_mwh: 0.005, cgs_eur_mwh: 0.0183, omie_aggregation: 'SPLIT_VAZIO_FORA' }),
    comps: () => ({ price: null, act: 0, iec: 0, sup: 0, split: null }),
    brand: () => null,
    tar: (_v, per) => TAR[per],
  };
  // A carga a sério ficou nas primeiras horas, com o OMIE a ~0 (domingo de
  // sol, todo em vazio no ciclo semanal); o resto da sessão o carro esteve só
  // ligado (fatias de 0 kWh).
  const hours = HOURLY.map((_, i) => FIRST_HOUR + i * HOUR_MS);
  const omieOf = (ms) => HOURLY[Math.floor((ms - FIRST_HOUR) / HOUR_MS)];
  const profile = hourQuarters(hours).map((ms, i) => ({ at: new Date(ms), kwh: i < 12 ? KWH / 12 : 0, spot: { omieKwh: omieOf(ms) } }));
  const session = sessionOmie(hours, omieOf);
  const input = { at: profile[0].at, day: '2026-09-27', kwh: KWH, region: 'CONT', omie: 0.1, profile };

  it('VERSIONS marca os indexados LUZiGÁS', () => {
    assert.equal(vmeta('luzigas-casa-bt').billing, 'MEDIA_SESSAO');
    assert.equal(vmeta('meo-dinamica-bt').billing, null);
  });

  it('o total é o da média; a curva fica ao lado', () => {
    const q = quoteOne(t, { ...input, session }, pricing);
    const loss = sessionLoss('BT', session);
    assert.equal(q.billing, 'MEDIA_SESSAO');
    assert.equal(q.sessionOmie.eurKwh, session.omieKwh);
    assert.equal(q.sessionOmie.loss, loss);
    // Energia: (OMIE médio + K + CGS) × (1 + perdas) × todos os kWh; a TAR
    // é a do período de cada kWh (aqui tudo vazio).
    const energy = (session.omieKwh + 0.005 + 0.0183) * (1 + loss) * KWH;
    assert.ok(Math.abs(q.parts.energy - energy) < 0.011, `${q.parts.energy} vs ${energy}`);
    assert.equal(q.parts.tar, Math.round(KWH * TAR.VAZIO * 100) / 100);
    // Pela curva a energia entrou com o OMIE a ~0: bem mais barato.
    assert.ok(q.curve.totalEur < q.totalEur - 1, `${q.curve.totalEur} vs ${q.totalEur}`);
    assert.equal(q.curve.parts.tar, q.parts.tar);
    // As fatias levam todas o OMIE médio.
    assert.ok(q.slices.every(s => s.omie === session.omieKwh && s.omieSpot === false));
  });

  it('sem `session` (falta OMIE) ou sem profile: fica pela curva, como os outros', () => {
    const curve = quoteOne(t, input, pricing);
    assert.equal(curve.billing, 'MEDIA_SESSAO');
    assert.equal(curve.curve, undefined);
    assert.equal(curve.sessionOmie, undefined);
    assert.equal(curve.totalEur, quoteOne(t, { ...input, session }, pricing).curve.totalEur);
    const plain = quoteOne(t, { at: profile[0].at, day: '2026-09-27', kwh: KWH, region: 'CONT', omie: 0.1, session }, pricing);
    assert.equal(plain.curve, undefined);
  });

  it('um indexado sem a marca ignora `session`', () => {
    const other = { ...t, id: 'meo-dinamica-bt' };
    const a = quoteOne(other, input, pricing), b = quoteOne(other, { ...input, session }, pricing);
    assert.equal(a.totalEur, b.totalEur);
    assert.equal(b.curve, undefined);
  });
});
