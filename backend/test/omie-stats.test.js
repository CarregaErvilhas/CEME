// Testes das estatísticas OMIE: o parser dos quartos-horários e a
// agregação que produz as duas tabelas e as células de referência.
//
// Os números da folha original ("Comparador Mobie CEME", separador
// "OMIE (via TF)") são o gabarito: as médias mensais de um mês fechado têm
// de bater certo, e o "Total geral" é a média da janela toda — não a média
// das médias.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatsCsv, parseOmieCutoff, aggregate, lisbonNow } from '../src/omie/stats.js';

const CSV = [
  '﻿dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es',
  '01/01/2026,00:15,[00:00-00:15[,S,V,V,V,V,104.70,104.70',
  '01/01/2026,00:30,[00:15-00:30[,S,V,F,V,F,90.00,90.00',
  '02/01/2026,23:45,[23:30-23:45[,S,V,F,V,C,50.00,50.00',
  'TABELA_FUTUROS_PT',
  'Contrato,Descricao,Valor',
  'FPB M Jan-26,Janeiro 2026,99.00',
].join('\n');

describe('estatísticas OMIE — parser', () => {
  it('lê dia, intervalo e as colunas de período', () => {
    const rows = parseStatsCsv(CSV);
    assert.equal(rows.length, 3, 'o bloco TABELA_ no fim não são dados');
    assert.deepEqual(rows[0], { dn: Date.UTC(2026, 0, 1) / 86400000, day: '2026-01-01', mk: '2026-01', min: 0, bd: 'V', bs: 'V', price: 104.7 });
    assert.equal(rows[1].bs, 'F');
    assert.equal(rows[1].min, 15);
    assert.equal(rows[2].day, '2026-01-02');
    assert.equal(rows[2].min, 23 * 60 + 30);
  });

  it('ordena por data e hora', () => {
    const rows = parseStatsCsv(CSV);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      assert.ok(a.dn < b.dn || (a.dn === b.dn && a.min <= b.min), 'linhas fora de ordem');
    }
  });

  it('rebenta com um schema inesperado', () => {
    assert.throws(() => parseStatsCsv('a,b,c\n1,2,3'), /schema inesperado/);
  });

  it('tira o dia de mercado do bloco de actualizações do OMIP', () => {
    const txt = 'TABELA_ATUALIZACOES\nchave,valor\nData_Valores_OMIE,22/10/2026\nData_Valores_OMIP,20/10/2026';
    assert.equal(parseOmieCutoff(txt), '2026-10-22');
    assert.equal(parseOmieCutoff('nada aqui'), null);
  });
});

// Constrói uma linha como o parser a devolve.
function q(day, min, bd, bs, price) {
  const [y, m, d] = day.split('-').map(Number);
  const dn = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return { dn, day, mk: `${y}-${String(m).padStart(2, '0')}`, min, bd, bs, price };
}

describe('estatísticas OMIE — agregação', () => {
  // Dois dias fechados (20 e 21 de Outubro) e um dia estimado (22).
  const rows = [
    q('2026-10-20', 0, 'V', 'V', 100), q('2026-10-20', 60, 'F', 'F', 200),
    q('2026-10-20', 480, 'F', 'V', 150),
    q('2026-10-21', 0, 'V', 'V', 110), q('2026-10-21', 60, 'F', 'F', 210),
    q('2026-10-21', 480, 'F', 'V', 160),
    q('2026-10-22', 0, 'V', 'V', 300), q('2026-10-22', 60, 'F', 'F', 300),
    q('2026-10-22', 480, 'F', 'V', 300),
  ];
  const NOW = new Date('2026-10-21T13:00:00Z');

  it('separa o mês em curso em mercado e estimativa', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // média do mês só com o que é mercado: 6 quartos
    assert.equal(d.cards.monthToDate.value, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    // a previsão junta o dia estimado
    assert.equal(d.cards.forecast.value, Math.round((100 + 200 + 150 + 110 + 210 + 160 + 900) / 9 * 100) / 100);
    assert.equal(d.cards.forecast.month, '2026-10');
  });

  it('média de hoje, de amanhã e dos últimos 30 dias', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.cards.today.date, '2026-10-21');
    assert.equal(d.cards.today.value, Math.round((110 + 210 + 160) / 3 * 100) / 100);
    assert.equal(d.cards.tomorrow.date, '2026-10-22');
    assert.equal(d.cards.tomorrow.value, 300, 'amanhã é estimativa OMIP');
    assert.equal(d.cards.tomorrow.estimated, true);
    assert.equal(d.cards.last30.value, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    assert.equal(d.cards.last30.from, '2026-09-21T00:00');
  });

  it('as séries por ciclo horário seguem a classificação BD/BS', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    const m = d.months[0];
    assert.equal(m.media, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    // BD=V nos quartos 0 e 0; BD=F nos outros quatro
    assert.equal(m.diaVazio, Math.round((100 + 110) / 2 * 100) / 100, 'BD=V');
    assert.equal(m.diaCheia, Math.round((200 + 150 + 210 + 160) / 4 * 100) / 100, 'BD=F');
    // BS=V nos quartos 0 e 480 de cada dia; BS=F nos outros
    assert.equal(m.semVazio, Math.round((100 + 150 + 110 + 160) / 4 * 100) / 100, 'BS=V');
    assert.equal(m.semCheia, Math.round((200 + 210) / 2 * 100) / 100, 'BS=F');
  });

  it('o total geral é a média da janela toda, não a média das médias', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.total.media, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    assert.equal(d.total.quarters, 6);
  });

  it('o preço à hora actual é o quarter em curso', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // 13:00 em Lisboa → quarter das 13:00, que não existe; fica o último
    assert.equal(d.current.at, '2026-10-21T08:00');
    assert.equal(d.current.price, 160);
    assert.equal(d.current.live, false);
    const d2 = aggregate(rows, { cutoff: '2026-10-21', now: new Date('2026-10-21T07:05:00Z') });
    assert.equal(d2.current.at, '2026-10-21T08:00');
    assert.equal(d2.current.live, true, 'o quarter em curso está publicado');
  });

  it('a janela são 366 dias: o que está fora não entra', () => {
    const antigo = q('2025-01-01', 0, 'V', 'V', 9999);
    const d = aggregate([antigo, ...rows], { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.total.quarters, 6, 'o dia de 2025 ficou de fora');
    assert.equal(d.window.from, '2025-10-21');
    assert.equal(d.window.to, '2026-10-21');
  });

  it('marca como parciais os meses que a janela ou o calendário truncam', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.months.length, 1);
    assert.equal(d.months[0].partial, true, 'só há dois dias de Outubro');
    assert.equal(d.months[0].cut, 'start', 'a janela não começa no dia 1');
    assert.equal(d.months[0].label, '2026/10');
  });

  it('um mês fechado não é parcial', () => {
    // Setembro completo: todos os dias com 4 quartos.
    const full = [];
    for (let day = 1; day <= 30; day++) {
      const dd = `2026-09-${String(day).padStart(2, '0')}`;
      full.push(q(dd, 0, 'V', 'V', 100), q(dd, 60, 'F', 'F', 200), q(dd, 480, 'F', 'V', 150));
    }
    const d = aggregate(full, { cutoff: '2026-09-30', now: new Date('2026-09-30T12:00:00Z') });
    assert.equal(d.months[0].partial, false);
    assert.equal(d.months[0].cut, null);
    assert.equal(d.months[0].quarters, 90);
  });

  it('sem dados de mercado não inventa nada', () => {
    assert.throws(() => aggregate([], { cutoff: '2026-10-21' }), /sem dados/);
    assert.throws(() => aggregate(rows, { cutoff: '2020-01-01' }), /sem preços de mercado/);
  });
});

describe('estatísticas OMIE — hora de Lisboa', () => {
  it('converte o UTC para a hora local (no verão, +1h)', () => {
    const l = lisbonNow(new Date('2026-10-21T12:00:00Z'));
    assert.equal(l.day, '2026-10-21');
    assert.equal(l.minutes, 13 * 60, 'WEST = UTC+1');
  });
  it('no Inverno é UTC+0', () => {
    const l = lisbonNow(new Date('2026-01-21T12:00:00Z'));
    assert.equal(l.minutes, 12 * 60);
  });
});
