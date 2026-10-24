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
  ts_utc: utc, day_lisbon: day, min_lisbon: min,
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

  it('um dia futuro só com TF é estimativa quando se passa a fronteira', () => {
    const rows = [
      linha('2026-10-22T00:00:00.000Z', '2026-10-22', 0, 70, 'TF'),
    ];
    const semFronteira = reconcile(rows);
    assert.equal(semFronteira[0].est, undefined, 'sem linhas OMIE_ES no lote, não há como saber');
    const comFronteira = reconcile(rows, { lastOmie: '2026-10-21T22:45:00.000Z' });
    assert.equal(comFronteira[0].est, true, 'para além do mercado é estimativa');
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
    const n = await query(`SELECT COUNT(*) c FROM omie_spot WHERE source = 'OMIE_ES' AND day_lisbon = '2026-10-20'`);
    assert.equal(n[0].c, 2, 'não duplicou');
    // E o preço foi actualizado, não duplicado.
    await upsertSpot([{ ...rows[0], pt: 123 }], 'OMIE_ES');
    const got = await spotForDay('2026-10-20');
    assert.equal(got.length, 2);
    assert.equal(got[0].pt, 123);
  });

  it('as duas fontes convivem na mesma tabela', async () => {
    await upsertSpot([{ utc: '2026-10-21T00:00:00.000Z', day: '2026-10-21', min: 0, pt: 50, es: null, bd: 'V', bs: 'V' }], 'TF');
    const rows = await query(`SELECT source FROM omie_spot WHERE day_lisbon = '2026-10-21'`);
    assert.ok(rows.length >= 1);
  });

  it('a janela explícita reescreve os dias recentes do TF (não só Dezembro)', async () => {
    // O ficheiro do TF vai até ao fim do ano: sem janela explícita, o upsert
    // só reescrevia os últimos dias do LOTE (Dezembro) e as revisões dos dias
    // recentes (reais que substituem estimativas) ficavam congeladas na BD.
    const mk = (day, pt) => ({ utc: `${day}T00:00:00.000Z`, day, min: 0, pt, es: null, bd: 'V', bs: 'V' });
    const oldDays = ['2026-05-10', '2026-05-19', '2026-05-25', '2026-12-29'];
    await upsertSpot(oldDays.map(d => mk(d, 10)), 'TF');
    const rev = [...oldDays.map(d => mk(d, 99)), mk('2026-12-30', 99)];
    await upsertSpot(rev, 'TF', { fromDay: '2026-05-18', toDay: '2026-06-30' });
    const got = Object.fromEntries(
      (await query(`SELECT day_lisbon d, price_pt_eur_mwh p FROM omie_spot WHERE source = 'TF' AND day_lisbon LIKE '2026-%'`))
        .map(r => [String(r.d).slice(0, 10), r.p])
    );
    assert.equal(got['2026-05-10'], 10, 'fora da janela: congela (não reescreve)');
    assert.equal(got['2026-05-19'], 99, 'dentro da janela: revisto');
    assert.equal(got['2026-05-25'], 99, 'dentro da janela: revisto');
    assert.equal(got['2026-12-29'], 10, 'fora da janela: congela, mesmo sendo Dezembro');
    assert.equal(got['2026-12-30'], 99, 'dia novo: escreve sempre');
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

// O ficheiro do TF está em hora de RELÓGIO de Lisboa. Nos dias de mudança de
// hora o relógio não é tempo decorrido: o parser antigo somava minutos de
// relógio à meia-noite e, no dia de Março, punha 89 dos 92 quartos uma hora
// à frente (e os últimos por cima do dia seguinte). Linhas tal como o TF as
// publica (cabeçalho e formato reais).
describe('TF — hora de relógio → instante, nos dias de mudança de hora', () => {
  const HEAD = 'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es';
  const csvDay = (d, rows) => rows.map(([hora, iv], i) => `${d},${hora},${iv},S,V,V,V,V,${10 + i},${10 + i}`);
  it('Março (29/03/2026): depois do salto 00:59 → 02:00, os instantes continuam seguidos', async () => {
    const { parseTfQuarters } = await import('../src/omie/tf.js');
    const text = [HEAD, ...csvDay('29/03/2026', [
      ['00:15', '[00:00-00:15['], ['00:30', '[00:15-00:30['], ['00:45', '[00:30-00:45['],
      ['02:00', '[00:45-02:00['], ['02:15', '[02:00-02:15['], ['02:30', '[02:15-02:30['],
    ])].join('\n');
    const utc = parseTfQuarters(text).days.get('2026-03-29').map(r => r.utc);
    assert.deepEqual(utc, [
      '2026-03-29T00:00:00.000Z', '2026-03-29T00:15:00.000Z', '2026-03-29T00:30:00.000Z',
      '2026-03-29T00:45:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:15:00.000Z',
    ]);
  });
  it('Outubro (25/10/2026): a hora 01:xx repetida dá dois instantes distintos, por ordem', async () => {
    const { parseTfQuarters } = await import('../src/omie/tf.js');
    const text = [HEAD, ...csvDay('25/10/2026', [
      ['01:45', '[01:30-01:45['], ['01:00', '[01:45-01:00['], ['01:15', '[01:00-01:15['],
      ['01:30', '[01:15-01:30['], ['01:45', '[01:30-01:45['], ['02:00', '[01:45-02:00['], ['02:15', '[02:00-02:15['],
    ])].join('\n');
    const rows = parseTfQuarters(text).days.get('2026-10-25');
    // 01:30 (WEST) = 00:30Z; a segunda passagem das 01:00 (WET) = 01:00Z;
    // depois das 01:45 (WET) vêm as 02:00 (WET) = 02:00Z.
    assert.deepEqual(rows.map(r => r.utc), [
      '2026-10-25T00:30:00.000Z', '2026-10-25T00:45:00.000Z', '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:15:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T01:45:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
    assert.equal(new Set(rows.map(r => r.utc)).size, rows.length, 'nenhum instante repetido');
  });
  it('o último quarto ("23:59", [23:45-00:00[) fica no próprio dia', async () => {
    const { parseTfQuarters } = await import('../src/omie/tf.js');
    const text = [HEAD, ...csvDay('29/03/2026', [['23:59', '[23:45-00:00[']])].join('\n');
    assert.deepEqual(parseTfQuarters(text).days.get('2026-03-29').map(r => r.utc), ['2026-03-29T22:45:00.000Z']);
  });
});

describe('TF — reparação dos dias de Março já gravados', () => {
  it('apaga as linhas TF dos dias de 92 quartos uma vez (e só essas)', async () => {
    const { upsertSpot, getMeta } = await import('../src/omie/store.js');
    const { refreshAll } = await import('../src/omie/pipeline.js');
    await run(`DELETE FROM omie_meta WHERE key = 'fix_tf_spring_dst_v1'`);
    await upsertSpot([
      { utc: '2026-03-29T05:00:00.000Z', day: '2026-03-29', min: 360, pt: 98765.4 },
      { utc: '2026-03-28T05:00:00.000Z', day: '2026-03-28', min: 300, pt: 98765.5 },
    ], 'TF', { fromDay: '2026-03-28', toDay: '2026-03-29' });
    // Sem rede: as fontes falham e ficam no log; a reparação corre antes.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('sem rede no teste'); };
    try { await refreshAll(); } finally { globalThis.fetch = realFetch; }
    // As linhas-marca (preços impossíveis): a do dia de Março tem de ter ido embora
    // (o dia pode voltar a entrar, se houver cache do TF em disco — mas já
    // com o parser novo, e sem a marca); a do dia anterior fica.
    const left = (await query(`SELECT day_lisbon d, price_pt_eur_mwh p FROM omie_spot WHERE source = 'TF' AND day_lisbon IN ('2026-03-28','2026-03-29')`))
      .map(r => `${String(r.d).slice(0, 10)}:${r.p}`);
    assert.ok(!left.includes('2026-03-29:98765.4'), 'a linha antiga do dia de Março foi limpa');
    assert.ok(left.includes('2026-03-28:98765.5'), 'os outros dias ficam como estavam');
    assert.ok(JSON.parse(await getMeta('fix_tf_spring_dst_v1')).days.includes('2026-03-29'));
  });
});

describe('TF — linha repetida', () => {
  it('vai para a quarentena e não desloca as seguintes', async () => {
    const { parseTfQuarters } = await import('../src/omie/tf.js');
    const HEAD = 'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es';
    const rows = [['10:00', '[09:45-10:00['], ['10:15', '[10:00-10:15['], ['10:15', '[10:00-10:15['], ['10:30', '[10:15-10:30[']];
    const text = [HEAD, ...rows.map(([h, iv], i) => `01/07/2026,${h},${iv},S,F,F,F,F,${50 + i},${50 + i}`)].join('\n');
    const out = parseTfQuarters(text);
    assert.deepEqual(out.days.get('2026-07-01').map(r => r.utc),
      ['2026-07-01T08:45:00.000Z', '2026-07-01T09:00:00.000Z', '2026-07-01T09:15:00.000Z']);
    assert.equal(out.quarantined.filter(q => q.reason === 'dup_hour').length, 1);
  });
});

describe('TF — futuros com campos entre aspas', () => {
  it('"Semana 44, 2026" não desloca o preço', async () => {
    const { parseTfFutures, parseTfDailyFutures } = await import('../src/omie/tf.js');
    const text = ['TABELA_FUTUROS_PT', 'contrato,descricao,valor,data,var',
      'FPB D Sa24Oct-26,24/10/2026,132.31,22/10/2026,up:+15.99',
      'FPB Wk44-26,"Semana 44, 2026",194.25,22/10/2026,up:+8.0'].join('\n');
    const rows = parseTfFutures(text);
    assert.equal(rows.find(r => r.contrato === 'FPB Wk44-26').valor, 194.25);
    assert.equal(rows.find(r => r.contrato === 'FPB Wk44-26').descricao, 'Semana 44, 2026');
    assert.deepEqual(parseTfDailyFutures(text).map(d => d.date), ['2026-10-24']);
  });
});
