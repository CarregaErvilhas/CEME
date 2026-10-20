import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyCsv, parseFuturesCsv } from '../src/omie/cache.js';
import { seed } from '../src/db/seed.js';
import { pickComponents } from '../src/db/components.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

describe('pickComponents: coerência por versão', () => {
  const r = (period, act, iec = 0.001) => ({ period, energy_eur_kwh: 0.1, activation_eur: act, support_eur: 0, iec_eur_kwh: iec });

  it('períodos coerentes: EGME/IEC partilham-se', async () => {
    const { price, act, iec } = pickComponents([r('VAZIO', 0.11), r('FORA_VAZIO', 0.11)]);
    assert.equal(act, 0.11); assert.equal(iec, 0.001);
    assert.deepEqual(Object.keys(price).sort(), ['FORA_VAZIO', 'VAZIO']);
  });

  it('períodos divergentes rebentam (já depois de ver o valor)', async () => {
    assert.throws(() => pickComponents([r('VAZIO', 0.11), r('FORA_VAZIO', 0.12)]), /divergentes/);
  });

  // O bug latente: o guard antigo tratava NULL como carta branca e o
  // `act || 0` no fim APAGAVA a EGME de um tarifário que a cobra.
  it('NULL depois de um valor também é divergência (não zera a EGME)', async () => {
    const out = pickComponents([r('VAZIO', 0.1088), { period: 'FORA_VAZIO', energy_eur_kwh: 0.1, activation_eur: null, support_eur: 0, iec_eur_kwh: 0.001 }]);
    assert.equal(out.act, 0.1088);   // nunca se apaga com NULL
  });

  it('NULL antes do valor: preenche com a primeira não-nula', async () => {
    const out = pickComponents([{ period: 'VAZIO', energy_eur_kwh: 0.1, activation_eur: null, support_eur: 0, iec_eur_kwh: null }, r('FORA_VAZIO', 0.1088, 0.002)]);
    assert.equal(out.act, 0.1088);
    assert.equal(out.iec, 0.002);
  });

  it('tudo a zero/NULL (miio): act 0 sem erros', async () => {
    const out = pickComponents([r('VAZIO', 0), r('FORA_VAZIO', 0)]);
    assert.equal(out.act, 0);
  });
});

describe('cache OMIE: parsers defensivos', () => {
  it('diário: filtra últimos N e ignora linhas más', () => {
    const csv = 'dia,data_iso,dias,quartos,pt_medio,pt_min,pt_max,pt_desvio,es_medio,spread_pt_es,horas_negativas,bd_v,bd_f,bs_v,bs_f,td_v,td_c,td_p,ts_v,ts_c,ts_p\n' +
      '01/01/2010,2010-01-01,1,96,7.2,0.0,30.8,11.88,6.77,0.43,0,4.94,8.82,0.0,10.17,4.94,5.58,16.91,0.0,8.57,14.0\n' +
      'linha má\n' +
      '02/01/2010,2010-01-02,1,96,20.18,0.0,83.1,,,,,,,,,,,,,,\n';
    const rows = parseDailyCsv(csv, 60);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].bd_v, 4.94);
    assert.equal(rows[1].bd_v, null);
  });
  it('diário: rebenta com schema inesperado (fail fast)', () => {
    assert.throws(() => parseDailyCsv('a,b,c\n1,2,3\n', 60), /schema/);
  });
  it('futuros: extrai contratos PT', () => {
    const csv = 'TABELA_FUTUROS_PT\nContrato,Descricao,Valor,Data\nFPB D Fr16Oct-26,16/10/2026,199.38,15/10/2026\nTABELA_FIM\n';
    const rows = parseFuturesCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valor, 199.38);
  });
});

describe('seed POC distingue variantes', () => {
  it('particular vs business e Ks diferentes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    seed(db);
    const names = db.prepare("SELECT id,name FROM tariff WHERE ceme_id='atlante' ORDER BY id").all();
    assert.ok(names.length >= 2 && names.some(t => /Business/.test(t.name)), 'Atlante tem variante Business');
    const ks = db.prepare(`SELECT t.id,v.k_index_eur_mwh k FROM tariff t JOIN tariff_version v ON v.tariff_id=t.id
      WHERE t.ceme_id='luzigas' ORDER BY t.id`).all();
    const kvals = new Set(ks.map(r => r.k));
    assert.ok(kvals.size >= 3, `Ks distintos: ${[...kvals]}`);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM tariff').get().c >= 100, 'seed tem de cobrir todos os tarifários');
  });
});

describe('auditoria EGME (tarifa de activação)', () => {
  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    seed(db);
    return db;
  };
  // CEMEs que não cobram EGME. Todos os restantes devem ter uma activação > 0.
  // (Okeana foi removido em 2026-10-18: última info de 2023, sem EGME discriminado.)
  const SEM_EGME = new Set(['miio']);

  it('só o miio fica sem EGME', () => {
    const db = fresh();
    const q = `SELECT DISTINCT t.ceme_id, pc.activation_eur a FROM price_component pc
      JOIN tariff_version v ON v.id=pc.tariff_version_id JOIN tariff t ON t.id=v.tariff_id
      WHERE pc.activation_eur IS NULL OR pc.activation_eur = 0 ORDER BY t.ceme_id`;
    const sem = [...new Set(db.prepare(q).all().map(r => r.ceme_id))];
    assert.deepEqual(sem.filter(c => !SEM_EGME.has(c)), [], `CEMEs sem EGME que não deveriam: ${sem}`);
  });

  it('os indexados também carregam EGME (o bug era só no seed)', () => {
    const db = fresh();
    const rows = db.prepare(`SELECT t.id, pc.activation_eur a FROM tariff t
      JOIN tariff_version v ON v.tariff_id=t.id JOIN price_component pc ON pc.tariff_version_id=v.id
      WHERE t.kind='INDEXED'`).all();
    assert.ok(rows.length >= 10, `há indexados no seed (${rows.length})`);
    const sem = rows.filter(r => !r.a || r.a <= 0).map(r => r.id);
    assert.deepEqual(sem, [], `indexados sem EGME: ${sem}`);
  });

  it('os valores de EGME-known estão versionados por CEME', () => {
    const db = fresh();
    const byCeme = db.prepare(`SELECT t.ceme_id, pc.activation_eur a FROM tariff t
      JOIN tariff_version v ON v.tariff_id=t.id JOIN price_component pc ON pc.tariff_version_id=v.id
      WHERE t.ceme_id NOT IN ('miio') GROUP BY t.ceme_id`).all();
    const invalidos = byCeme.filter(r => !r.a || r.a <= 0 || r.a > 1);
    assert.deepEqual(invalidos, [], `EGME fora de gama: ${JSON.stringify(invalidos)}`);
  });
});

describe('quarters CSV defensivo', () => {
  it('pára nos blocos TABELA_ e ordena', async () => {
    const { parseQuartersCsv } = await import('../src/omie/cache.js');
    const csv = 'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es\n15/10/2026,00:15,[00:00-00:15[,S,V,V,V,V,104.70,104.70\n15/10/2026,00:30,[00:15-00:30[,S,V,V,V,V,103.98,103.98\nTABELA_ATUALIZACOES\nchave,valor\n';
    const q = parseQuartersCsv(csv);
    const assert2 = (await import('node:assert/strict')).default;
    assert2.equal(q.date, '2026-10-15');
    assert2.equal(q.rows.length, 2);
    assert2.equal(q.rows[0].start, '00:00');
  });

  // Bug real apanhado na revisão: a última linha do dia traz hora=23:59 (fim
  // do dia de dados, não meia-noite arredondada) e o -15 cego dava
  // 23:44–23:59. O certo é 23:45–00:00 — e o `intervalo` é a verdade.
  it('o último quarto do dia fecha em 00:00 (23:45–00:00)', async () => {
    const { parseQuartersCsv } = await import('../src/omie/cache.js');
    const head = 'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es';
    const ok = parseQuartersCsv(`${head}\n15/10/2026,23:45,[23:30-23:45[,S,V,F,V,C,80.00,80.00\n15/10/2026,23:59,[23:45-00:00[,S,V,F,V,C,70.00,70.00\n`);
    assert.equal(ok.rows[1].start, '23:45');
    assert.equal(ok.rows[1].end, '00:00');
    // sem a coluna intervalo, o caso especial do 23:59 mantém o mesmo resultado
    const sem = parseQuartersCsv(`${head}\n15/10/2026,23:45,,S,V,F,V,C,80.00,80.00\n15/10/2026,23:59,,S,V,F,V,C,70.00,70.00\n`);
    assert.equal(sem.rows[1].start, '23:45');
    assert.equal(sem.rows[1].end, '00:00');
    // os restantes quartos continuam a fechar na própria hora (00:15 → 00:00–00:15)
    const normal = parseQuartersCsv(`${head}\n15/10/2026,00:15,[00:00-00:15[,S,V,V,V,V,104.70,104.70\n`);
    assert.equal(normal.rows[0].start, '00:00');
    assert.equal(normal.rows[0].end, '00:15');
  });
});
