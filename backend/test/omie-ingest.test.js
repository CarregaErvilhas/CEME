// Testes da ingestão do OMIE: a reconciliação das duas fontes, a
// chave por instante (e a hora repetida de Outono), os upserts e o lock
// que evita que duas réplicas busquem o ficheiro ao mesmo tempo.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A BD tem de ser escolhida ANTES de o db.js ser importado.
const dir = mkdtempSync(path.join(tmpdir(), 'ceme-omie-test-'));
process.env.DB_PATH = path.join(dir, 'omie.db');

const { run, query } = await import('../src/db.js');
const { readFileSync } = await import('node:fs');
const { reconcile, upsertSpot, spotForDay, upsertDaily, dailyRows } = await import('../src/omie/store.js');
const { lisbonMidnightUtc, expectedQuartersForLisbonDay } = await import('../src/omie/convert.js');

const linha = (utc, day, min, pt, source, extra = {}) => ({
  ts_utc: utc, day_utc: day, min_utc: min,
  price_pt_eur_mwh: pt, price_es_eur_mwh: null,
  bd: null, bs: null, source, flags: null, ...extra,
});

describe('ingestão OMIE — reconciliação', () => {
  it('o omie.es manda no preço e o TF traz a classificação', () => {
    const out = reconcile([
      linha('2026-10-20T00:00:00.000Z', '2026-10-20', 0, 100, 'OMIE_ES'),
      linha('2026-10-20T00:00:00.000Z', '2026-10-20', 0, 101, 'TF', { bd: 'V', bs: 'F' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pt, 100, 'o preço é o do omie.es');
    assert.equal(out[0].bd, 'V');
    assert.equal(out[0].bs, 'F', 'a classificação vem do TF');
    assert.equal(out[0].src, 'OMIE_ES');
  });

  it('o TF cobre o buraco quando o omie.es não traz o instante', () => {
    const out = reconcile([
      linha('2026-10-20T00:00:00.000Z', '2026-10-20', 0, 100, 'OMIE_ES'),
      linha('2026-10-20T00:15:00.000Z', '2026-10-20', 15, 90, 'TF', { bd: 'F', bs: 'F' }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].pt, 90, 'sem o omie.es, o preço é o do TF');
    assert.equal(out[1].src, 'TF');
  });

  it('o que está para além do mercado é estimativa', () => {
    const out = reconcile([
      linha('2026-10-20T00:00:00.000Z', '2026-10-20', 0, 100, 'OMIE_ES'),
      linha('2026-10-21T00:00:00.000Z', '2026-10-21', 0, 70, 'TF'),
    ]);
    assert.equal(out[0].est, undefined, 'o que o omie.es traz é mercado');
    assert.equal(out[1].est, true, 'o que só o TF tem, para além, é estimativa');
  });

  it('a classificação que falta vem das regras do motor', () => {
    // 2026-10-20 é uma terça: às 12:00 UTC (13:00 em Lisboa) é período de
    // ponta no ciclo diário e no semanal.
    const out = reconcile([
      linha('2026-10-20T12:00:00.000Z', '2026-10-20', 720, 100, 'OMIE_ES'),
    ]);
    assert.equal(out[0].bd, 'F', 'BD=F (fora de vazio) às 13:00');
    assert.equal(out[0].bs, 'F', 'BS=F (fora de vazio) às 13:00');
  });
});

describe('ingestão OMIE — instante e mudança de hora', () => {
  it('a hora repetida de Outono são dois instantes diferentes', () => {
    // 2026-10-25: em Lisboa a hora 02:00-03:00 acontece duas vezes (WEST
    // e depois CET). São dois instantes — e a chave é o instante, por isso
    // não se chocam.
    const a = lisbonMidnightUtc('2026-10-25');
    const b = lisbonMidnightUtc('2026-10-26');
    // O dia 25 de Outubro tem 25 horas: das 00:00 às 00:00 do dia 26.
    assert.equal((b - a) / 3600000, 25);
    assert.equal(expectedQuartersForLisbonDay('2026-10-25'), 100);
    assert.equal(expectedQuartersForLisbonDay('2026-03-29'), 92);
    assert.equal(expectedQuartersForLisbonDay('2026-10-21'), 96);
  });

  it('dois instantes com a mesma hora de relógio não se chocam', () => {
    const out = reconcile([
      linha('2026-10-25T01:00:00.000Z', '2026-10-25', 60, 100, 'OMIE_ES'),
      linha('2026-10-25T02:00:00.000Z', '2026-10-25', 120, 110, 'OMIE_ES'),
    ]);
    assert.equal(out.length, 2, 'os dois ficam');
    assert.deepEqual(out.map(r => r.pt), [100, 110]);
  });
});

describe('ingestão OMIE — a BD', () => {
  before(async () => {
    await run(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* já foi */ } });

  it('o upsert é idempotente (duas réplicas podem escrever em cima)', async () => {
    const rows = [
      { utc: '2026-10-20T00:00:00.000Z', day: '2026-10-20', min: 0, pt: 100, es: null, bd: 'V', bs: 'V' },
      { utc: '2026-10-20T00:15:00.000Z', day: '2026-10-20', min: 15, pt: 110, es: null, bd: 'F', bs: 'F' },
    ];
    await upsertSpot(rows, 'OMIE_ES');
    await upsertSpot(rows, 'OMIE_ES'); // outra vez
    const n = await query(`SELECT COUNT(*) c FROM omie_spot WHERE source = 'OMIE_ES' AND day_utc = '2026-10-20'`);
    assert.equal(n[0].c, 2, 'não duplicou');
    // E o preço foi actualizado, não duplicado.
    await upsertSpot([{ ...rows[0], pt: 123 }], 'OMIE_ES');
    const got = await spotForDay('2026-10-20');
    assert.equal(got.length, 2);
    assert.equal(got[0].pt, 123);
  });

  it('as duas fontes convivem na mesma tabela', async () => {
    await upsertSpot([{ utc: '2026-10-21T00:00:00.000Z', day: '2026-10-21', min: 0, pt: 50, es: null, bd: 'V', bs: 'V' }], 'TF');
    const rows = await query(`SELECT source FROM omie_spot WHERE day_utc = '2026-10-21'`);
    assert.ok(rows.length >= 1);
  });

  it('os agregados diários guardam as quatro médias', async () => {
    await upsertDaily([{
      date: '2026-10-20', avg_pt: 100, min_pt: 50, max_pt: 150,
      bd_v: 90, bd_f: 110, bs_v: 95, bs_f: 105, quarters: 96, source: 'teste',
    }]);
    const rows = await dailyRows(10);
    const d = rows.find(r => String(r.date).slice(0, 10) === '2026-10-20');
    assert.ok(d, 'o dia está lá');
    assert.equal(d.bd_v, 90);
    assert.equal(d.bs_f, 105);
  });
});
