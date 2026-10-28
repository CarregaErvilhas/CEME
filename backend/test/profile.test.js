// Carregamentos partidos em fatias no tempo (quoteSlices e o `profile` do
// quoteOne). Um carregamento de minutos a horas pode atravessar a fronteira
// vazio/fora de vazio, vários quartos de hora OMIE, a meia-noite (TAR do dia
// seguinte) e até a mudança da hora. Os preços aqui são escritos à mão: o que
// se testa é em que período e com que preço cai cada fatia, não o seed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFixed, quoteSlices } from '../src/engine/quote.js';
import { quoteOne } from '../src/tariffs.js';

const PRICE = { VAZIO: 0.12, FORA_VAZIO: 0.2 };
const BI = { schedule: 'BI_HORARIA', activation: 0.11, iec: 0.001 };
// Fatias de 10 kWh nos instantes dados (UTC).
const slices = (ats, kwh = 10, extra = {}) => ats.map(at => ({ at: new Date(at), kwh, price: PRICE, ...extra }));
const periods = (q) => q.slices.map(s => s.period);
const cents = (x) => Math.round(x * 100);

describe('quoteSlices', () => {
  it('uma fatia é exactamente o quoteFixed', () => {
    for (const at of ['2026-10-21T12:00:00Z', '2026-10-21T23:00:00Z', '2026-03-29T01:30:00Z']) {
      for (const region of ['CONT', 'MAD', 'AZO']) {
        for (const kwh of [0.1, 7.3, 56.8]) {
          const args = { ...BI, cycle: 'DIARIO', region, price: PRICE, split: { VAZIO: { energy: 0.1, tar: 0.02 }, FORA_VAZIO: { energy: 0.12, tar: 0.08 } } };
          const one = quoteSlices({ ...args, slices: [{ at: new Date(at), kwh, price: PRICE, split: args.split }] });
          assert.deepEqual(one, quoteFixed({ ...args, at: new Date(at), kwh }));
          assert.equal(one.slices, undefined, 'com uma fatia não há detalhe');
        }
      }
    }
  });

  it('fora de vazio → vazio: cada metade paga o seu preço', () => {
    // Terça 10 Nov 2026, Inverno (Lisboa = UTC). O vazio diário começa às 22:00.
    const q = quoteSlices({ ...BI, cycle: 'DIARIO', slices: slices(['2026-11-10T21:30:00Z', '2026-11-10T21:45:00Z', '2026-11-10T22:00:00Z', '2026-11-10T22:15:00Z']) });
    assert.deepEqual(periods(q), ['FORA_VAZIO', 'FORA_VAZIO', 'VAZIO', 'VAZIO']);
    assert.deepEqual(q.kwhByPeriod, { FORA_VAZIO: 20, VAZIO: 20 });
    assert.equal(q.parts.energyTar, 6.4, '20 × 0,20 + 20 × 0,12');
    assert.equal(q.period, 'FORA_VAZIO', '`period` continua a ser o do início');
    assert.ok(Math.abs(q.breakdown.final - 0.16) < 1e-9, 'preço médio pesado pelos kWh');
    // Cotado só no início, sairia tudo a fora de vazio.
    const start = quoteFixed({ ...BI, cycle: 'DIARIO', at: new Date('2026-11-10T21:30:00Z'), kwh: 40, price: PRICE });
    assert.equal(start.parts.energyTar, 8);
    assert.ok(q.totalEur < start.totalEur);
  });

  it('a forma de partir não muda o total, só o período de cada kWh', () => {
    const fine = quoteSlices({ ...BI, cycle: 'DIARIO', slices: slices(['2026-11-10T21:30:00Z', '2026-11-10T21:45:00Z', '2026-11-10T22:00:00Z', '2026-11-10T22:15:00Z']) });
    const coarse = quoteSlices({ ...BI, cycle: 'DIARIO', slices: slices(['2026-11-10T21:30:00Z', '2026-11-10T22:00:00Z'], 20) });
    assert.equal(coarse.totalEur, fine.totalEur);
    assert.deepEqual(coarse.parts, fine.parts);
  });

  it('as parcelas somam o total ao cêntimo, com energia/TAR separadas', () => {
    const split = { VAZIO: { energy: 0.1, tar: 0.02 }, FORA_VAZIO: { energy: 0.12, tar: 0.08 } };
    const q = quoteSlices({ ...BI, cycle: 'DIARIO', region: 'MAD', slices: slices(['2026-11-10T22:30:00Z', '2026-11-10T22:45:00Z', '2026-11-10T23:00:00Z'], 7.37, { split }) });
    const p = q.parts;
    assert.equal(cents(p.energyTar + p.iec + p.activation + p.support), cents(p.base));
    assert.equal(cents(p.base + p.vatEur), cents(q.totalEur));
    assert.equal(cents(p.energy + p.tar), cents(p.energyTar));
    assert.equal(p.tar, Math.round((7.37 * 0.08 * 2 + 7.37 * 0.02) * 100) / 100);
  });

  it('sem separação energia/TAR numa das fatias, não se inventa', () => {
    const q = quoteSlices({ ...BI, cycle: 'DIARIO', slices: [
      { at: new Date('2026-11-10T21:45:00Z'), kwh: 10, price: PRICE, split: { FORA_VAZIO: { energy: 0.12, tar: 0.08 } } },
      { at: new Date('2026-11-10T22:00:00Z'), kwh: 10, price: PRICE },
    ] });
    assert.equal(q.parts.tar, null);
    assert.equal(q.parts.energy, null);
  });

  it('fim da hora de Verão (25 Out 2026): a hora repetida e as 08:00 de Inverno', () => {
    // A mudança é às 01:00 UTC. 00:45Z = 01:45 de Verão; 01:15Z = 01:15 de
    // Inverno (a hora que se repete); 07:30Z = 07:30 de Inverno, ainda vazio
    // (com a hora de Verão seria 08:30, fora de vazio); 08:00Z = 08:00.
    const q = quoteSlices({ ...BI, cycle: 'DIARIO', slices: slices(['2026-10-25T00:45:00Z', '2026-10-25T01:15:00Z', '2026-10-25T07:30:00Z', '2026-10-25T08:00:00Z']) });
    assert.deepEqual(periods(q), ['VAZIO', 'VAZIO', 'VAZIO', 'FORA_VAZIO']);
  });

  it('início da hora de Verão (29 Mar 2026): a hora que salta', () => {
    // 00:45Z = 00:45 de Inverno; 01:00Z = 02:00 de Verão (01:00-02:00 não
    // existe); 06:45Z = 07:45, vazio; 07:00Z = 08:00, fora de vazio.
    const q = quoteSlices({ ...BI, cycle: 'DIARIO', slices: slices(['2026-03-29T00:45:00Z', '2026-03-29T01:00:00Z', '2026-03-29T06:45:00Z', '2026-03-29T07:00:00Z']) });
    assert.deepEqual(periods(q), ['VAZIO', 'VAZIO', 'VAZIO', 'FORA_VAZIO']);
  });

  it('sábado no ciclo semanal, no dia antes da mudança da hora', () => {
    // Sáb 28 Mar 2026 ainda é Inverno: fora de vazio 09:30-13:00 e
    // 18:30-22:00. Sáb 4 Abr já é Verão: 09:00-14:00 e 20:00-22:00.
    const inv = quoteSlices({ ...BI, cycle: 'SEMANAL', slices: slices(['2026-03-28T09:15:00Z', '2026-03-28T09:30:00Z', '2026-03-28T13:00:00Z']) });
    assert.deepEqual(periods(inv), ['VAZIO', 'FORA_VAZIO', 'VAZIO']);
    // 08:00Z = 09:00 de Verão.
    const ver = quoteSlices({ ...BI, cycle: 'SEMANAL', slices: slices(['2026-04-04T07:45:00Z', '2026-04-04T08:00:00Z', '2026-04-04T12:45:00Z', '2026-04-04T13:00:00Z']) });
    assert.deepEqual(periods(ver), ['VAZIO', 'FORA_VAZIO', 'FORA_VAZIO', 'VAZIO']);
  });

  it('ilhas: a hora e as regras de cada região', () => {
    // Madeira (= Lisboa em hora): vazio diário das 23:00 às 09:00.
    const mad = quoteSlices({ ...BI, cycle: 'DIARIO', region: 'MAD', slices: slices(['2026-11-10T22:45:00Z', '2026-11-10T23:00:00Z']) });
    assert.deepEqual(periods(mad), ['FORA_VAZIO', 'VAZIO']);
    // Açores (UTC-1 no Inverno): 22:45Z = 21:45, 23:00Z = 22:00.
    const azo = quoteSlices({ ...BI, cycle: 'DIARIO', region: 'AZO', slices: slices(['2026-11-10T22:45:00Z', '2026-11-10T23:00:00Z']) });
    assert.deepEqual(periods(azo), ['FORA_VAZIO', 'VAZIO']);
    assert.ok(mad.vat < 1.23 && azo.vat < mad.vat, 'IVA da região, uma vez no fim');
  });

  it('um tarifário SIMPLES não liga a períodos', () => {
    const q = quoteSlices({ schedule: 'SIMPLES', cycle: null, slices: [
      { at: new Date('2026-11-10T21:45:00Z'), kwh: 10, price: { UNICO: 0.2 } },
      { at: new Date('2026-11-10T22:00:00Z'), kwh: 10, price: { UNICO: 0.2 } },
    ] });
    assert.deepEqual(q.kwhByPeriod, { UNICO: 20 });
    assert.equal(q.parts.energyTar, 4);
  });
});

// quoteOne com um `pricing` de mentira: deixa ver o OMIE e a TAR de cada
// fatia sem BD. 'meo-dinamica-bt' é um indexado real do seed (fórmula e
// perdas vêm de VERSIONS); os preços e a TAR são os daqui.
describe('quoteOne com profile (indexado)', () => {
  const t = { id: 'meo-dinamica-bt', vid: 1, kind: 'INDEXED', voltage: 'BT', schedule: 'BI_HORARIA', cycle: 'DIARIO', ceme_name: 'MEO', name: 'teste', regions: ['CONT'] };
  // TAR por dia: 1 Jan 2027 é outro tarifário de acesso.
  const tarOf = (day) => (day >= '2027-01-01' ? { VAZIO: 0.03, FORA_VAZIO: 0.09 } : { VAZIO: 0.02, FORA_VAZIO: 0.08 });
  const pricing = {
    version: () => ({ k_index_eur_mwh: 5, cgs_eur_mwh: 10, omie_aggregation: 'SPLIT_VAZIO_FORA' }),
    comps: () => ({ price: null, act: 0.11, iec: 0.001, sup: 0, split: null }),
    brand: () => null,
    tar: (_v, per, day) => tarOf(day)[per],
  };
  const quote = (profile, extra = {}) => quoteOne(t, { at: profile[0].at, day: '2026-11-10', kwh: profile.reduce((a, p) => a + p.kwh, 0), region: 'CONT', omie: 0.1, omieVazio: 0.05, omieFora: 0.1, profile, ...extra }, pricing);

  it('cada quarto de hora com o seu OMIE (spot)', () => {
    const at = (s) => new Date(`2026-11-10T${s}:00Z`);
    const q = quote([
      { at: at('14:00'), kwh: 10, spot: { omieKwh: 0.08 } },
      { at: at('14:15'), kwh: 10, spot: { omieKwh: 0.16 } },
      { at: at('14:30'), kwh: 10, spot: null }, // sem quarto publicado: média do período
    ]);
    assert.deepEqual(q.slices.map(s => s.omie), [0.08, 0.16, 0.1]);
    assert.deepEqual(q.slices.map(s => s.omieSpot), [true, true, false]);
    assert.ok(q.slices[1].final > q.slices[0].final, 'quarto mais caro, fatia mais cara');
    const sum = q.slices.reduce((a, s) => a + s.kwh * s.final, 0);
    assert.equal(q.parts.energyTar, Math.ceil(sum * 100 - 1e-9) / 100);
  });

  it('à meia-noite muda o dia: a fatia seguinte usa a TAR do dia novo', () => {
    const q = quote([
      { at: new Date('2026-12-31T23:45:00Z'), kwh: 10, spot: { omieKwh: 0.1 } },
      { at: new Date('2027-01-01T00:00:00Z'), kwh: 10, spot: { omieKwh: 0.1 } },
    ]);
    // Mesmo OMIE, mesmo período (vazio): a diferença é a TAR (0,02 → 0,03)
    // mais a diferença de perdas entre os dois quartos.
    assert.deepEqual(periods(q), ['VAZIO', 'VAZIO']);
    assert.equal(cents(q.parts.tar), cents(10 * 0.02 + 10 * 0.03));
  });

  it('sem profile, o quoteOne é o de sempre (cotado no início)', () => {
    const at = new Date('2026-11-10T21:45:00Z');
    const plain = quoteOne(t, { at, day: '2026-11-10', kwh: 20, region: 'CONT', omie: 0.1, omieVazio: 0.05, omieFora: 0.1 }, pricing);
    assert.equal(plain.slices, undefined);
    assert.equal(plain.kwhByPeriod, undefined);
    // Um profile de uma fatia, sem spot, dá o mesmo total.
    assert.equal(quote([{ at, kwh: 20, spot: null }]).totalEur, plain.totalEur);
  });
});
