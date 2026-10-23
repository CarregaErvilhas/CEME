// Testes das estatísticas OMIE: o parser dos quartos-horários e a
// agregação que produz as duas tabelas e as células de referência.
//
// Os números da folha original ("Comparador Mobie CEME", separador
// "OMIE (via TF)") são o gabarito: as médias mensais de um mês fechado têm
// de bater certo, e o "Total geral" é a média da janela toda — não a média
// das médias.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, utcNow, currentPrice } from '../src/omie/stats.js';
import { parseTfQuarters, parseOmieCutoff } from '../src/omie/tf.js';

const dnOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

const CSV = [
  '﻿dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es',
  '01/01/2026,00:15,[00:00-00:15[,S,V,V,V,V,104.70,104.70',
  '01/01/2026,00:30,[00:15-00:30[,S,V,F,V,F,90.00,90.00',
  '02/01/2026,23:45,[23:30-23:45[,S,V,F,V,C,50.00,50.00',
  'TABELA_FUTUROS_PT',
  'Contrato,Descricao,Valor',
  'FPB M Jan-26,Janeiro 2026,99.00',
].join('\n');

describe('estatísticas OMIE — parser do TF', () => {
  it('lê o dia, a classificação e o preço', () => {
    const { days } = parseTfQuarters(CSV);
    assert.equal(days.size, 2, 'o bloco TABELA_ no fim não são dados');
    const rows = days.get('2026-01-01');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].day, '2026-01-01');
    assert.equal(rows[0].min, 0, 'o dia começa à meia-noite de Lisboa');
    assert.equal(rows[0].pt, 104.7);
    assert.equal(rows[0].bd, 'V');
    assert.equal(rows[1].bs, 'F');
  });

  it('o ficheiro do TF está em hora de Lisboa', () => {
    const { days } = parseTfQuarters(CSV);
    const rows = days.get('2026-01-01');
    // 00:00-00:15 de Lisboa. (O dia de mercado do OMIE é o de Madrid, uma
    // hora à frente — por isso os dois ficheiros não alinham por período,
    // alinham por instante.)
    assert.equal(rows[0].min, 0);
    assert.equal(rows[1].min, 15);
    // A única linha do dia 02/01 é o quarter das 23:30-23:45: o instante vem
    // da coluna `hora`, não da posição da linha (que diria 00:00).
    const last = days.get('2026-01-02');
    assert.equal(last[0].min, 23 * 60 + 30);
  });

  it('uma linha em falta não desloca os instantes seguintes', () => {
    const csv = [
      'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es',
      '05/01/2026,00:15,[00:00-00:15[,S,V,V,V,V,100,100',
      // falta o quarter das 00:15-00:30
      '05/01/2026,00:45,[00:30-00:45[,S,V,V,V,V,102,102',
    ].join('\n');
    const { days } = parseTfQuarters(csv);
    const rows = days.get('2026-01-05');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].min, 0);
    assert.equal(rows[1].min, 30, 'o instante vem da hora, não da posição');
    assert.notEqual(rows[0].utc, rows[1].utc);
  });

  it('a hora repetida de Outubro dá dois instantes distintos', () => {
    const mk = (hora, iv) => `26/10/2025,${hora},${iv},S,V,V,V,V,100,100`;
    const csv = [
      'dia,hora,intervalo,Simples,BD,BS,TD,TS,preco_pt,preco_es',
      mk('01:30', '[01:15-01:30['),
      mk('01:45', '[01:30-01:45['),
      mk('01:00', '[01:45-01:00['), // o relógio andou para trás: 2ª passagem
      mk('01:15', '[01:00-01:15['),
    ].join('\n');
    const { days } = parseTfQuarters(csv);
    const rows = days.get('2025-10-26');
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map(r => r.utc)).size, 4, 'nenhum instante colide');
    assert.deepEqual(rows.map(r => r.min), [75, 90, 105, 60], 'a hora de relógio repete-se');
  });

  it('rebenta com um schema inesperado', () => {
    assert.throws(() => parseTfQuarters('a,b,c\n1,2,3'), /schema inesperado/);
  });

  it('tira o dia de mercado do bloco de actualizações do OMIP', () => {
    const txt = 'TABELA_ATUALIZACOES\nchave,valor\nData_Valores_OMIE,22/10/2026\nData_Valores_OMIP,20/10/2026';
    assert.equal(parseOmieCutoff(txt), '2026-10-22');
    assert.equal(parseOmieCutoff('nada aqui'), null);
  });
});

// Constrói uma linha como o parser a devolve. O ficheiro está em CET: o
// `min` é a hora de Madrid e a linha traz também a hora de Lisboa.
function q(day, min, bd, bs, price) {
  const [y, m, d] = day.split('-').map(Number);
  const dn = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  // O agrupamento é por dia civil de LISBOA: a hora local e a hora de Lisboa
  // são a mesma coisa (o dia de mercado de Madrid é que está uma hora à
  // frente).
  return { dn, day, mk: `${y}-${String(m).padStart(2, '0')}`, min, lisbonDn: dn, lisbonMin: min, bd, bs, price };
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

  it('a previsão é MTD mercado + FPB D (sem quarters estimados)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW, fpbDaily: { '2026-10-22': 300 } });
    // média do mês só com o que é mercado: 6 quartos
    assert.equal(d.cards.monthToDate.value, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    // a previsão junta o futuro diário publicado: (930 + 300×96)/(6 + 96)
    assert.equal(d.cards.forecast.value, Math.round((930 + 300 * 96) / 102 * 100) / 100);
    assert.equal(d.cards.forecast.month, '2026-10');
    assert.deepEqual(d.cards.forecast.fpbDays, [{ date: '2026-10-22', value: 300, quarters: 96 }]);
    assert.equal(d.cards.forecast.mtdQuarters, 6);
  });

  it('a previsão pesa cada dia de futuro pelos SEUS quartos (25/10 tem 100)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW, fpbDaily: { '2026-10-22': 300, '2026-10-25': 50 } });
    assert.deepEqual(d.cards.forecast.fpbDays.map(x => x.quarters), [96, 100]);
    assert.equal(d.cards.forecast.quarters, 6 + 96 + 100);
    assert.equal(d.cards.forecast.value, Math.round((930 + 300 * 96 + 50 * 100) / 202 * 100) / 100);
  });

  it('sem FPB D para o resto do mês, a previsão fica vazia (não inventa)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW, fpbDaily: {} });
    assert.equal(d.cards.forecast.coverageTo, null);
    assert.equal(d.cards.forecast.value, null);
  });

  it('média de hoje, de amanhã e dos últimos 30 dias', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.cards.today.date, '2026-10-21');
    assert.equal(d.cards.today.value, Math.round((110 + 210 + 160) / 3 * 100) / 100);
    assert.equal(d.cards.tomorrow.date, '2026-10-22');
    assert.equal(d.cards.tomorrow.value, null, 'sem mercado e sem FPB D: vazio, não inventa');
    assert.equal(d.cards.tomorrow.source, 'none');
    assert.equal(d.cards.last30.value, Math.round((100 + 200 + 150 + 110 + 210 + 160) / 6 * 100) / 100);
    assert.equal(d.cards.last30.from, '2026-09-21T00:00', 'a janela começa à meia-noite do dia');
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

  it('o preço à hora actual é o quarter em curso (no relógio de Lisboa)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // 13:00 UTC → o quarter das 13:00; o último publicado que não passa
    // disso é o das 08:00.
    assert.equal(d.current.at, '2026-10-21T08:00');
    assert.equal(d.current.price, 160);
    assert.equal(d.current.live, false);
    // 00:05Z em Outubro (WEST, +1) são 01:05 em Lisboa: o quarter é o das
    // 01:00 (ler a hora de Lisboa como se fosse UTC dava o das 00:00).
    const d2 = aggregate(rows, { cutoff: '2026-10-21', now: new Date('2026-10-21T00:05:00Z') });
    assert.equal(d2.current.at, '2026-10-21T01:00');
    assert.equal(d2.current.live, true, 'o quarter em curso está publicado');
  });

  it('as janelas são mostradas em hora de Lisboa (não UTC)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // A janela começa à meia-noite de Lisboa do dia.
    assert.equal(d.cards.last30.from, '2026-09-21T00:00');
    // ...e o instante UTC correspondente é 23:00Z do dia anterior (WEST, +1).
    assert.equal(d.cards.last30.fromUtc, '2026-09-20T23:00:00.000Z');
    // A última linha dos dados de teste é 08:00.
    assert.equal(d.cards.last30.to, '2026-10-21T08:00');
    assert.equal(d.dataThrough, '2026-10-21T08:00');
  });

  it('o último quarter do dia são 23:45', () => {
    const comFim = [...rows, q('2026-10-21', 23 * 60 + 45, 'V', 'V', 50)];
    const d = aggregate(comFim, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.dataThrough, '2026-10-21T23:45');
    assert.equal(d.cards.last30.to, '2026-10-21T23:45');
  });

  it('a janela são 366 dias: o que está fora não entra', () => {
    const antigo = q('2025-01-01', 0, 'V', 'V', 9999);
    const d = aggregate([antigo, ...rows], { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.total.quarters, 6, 'o dia de 2025 ficou de fora');
    assert.equal(d.window.from, '2025-10-21');
    assert.equal(d.window.to, '2026-10-21');
  });

  it('o dia de hoje exclui as estimativas quando já há mercado', () => {
    const mixed = [
      q('2026-10-21', 0, 'V', 'V', 100), q('2026-10-21', 60, 'F', 'F', 200),
      { ...q('2026-10-21', 120, 'V', 'V', 999), dn: dnOf('2026-10-21'), est: true },
    ];
    const d = aggregate(mixed, { cutoff: '2026-10-21', now: new Date('2026-10-21T13:00:00Z') });
    assert.equal(d.cards.today.value, 150, 'média só dos publicados');
    assert.equal(d.cards.today.quarters, 2);
    assert.equal(d.cards.today.estQuarters, 0);
    assert.equal(d.cards.today.estimated, false);
  });

  it('sem mercado publicado, o dia de hoje fica vazio (não usa OMIP)', () => {
    const onlyEst = [q('2026-10-20', 0, 'V', 'V', 100),
      ...[q('2026-10-22', 0, 'V', 'V', 300), q('2026-10-22', 60, 'F', 'F', 300)]
        .map(r => ({ ...r, est: true }))];
    const d = aggregate(onlyEst, { cutoff: '2026-10-20', now: new Date('2026-10-22T08:00:00Z') });
    assert.equal(d.cards.today.date, '2026-10-20', 'recua para o último dia com mercado');
    assert.equal(d.cards.today.value, 100);
    assert.equal(d.cards.today.source, 'market');
  });

  it('amanhã sem mercado usa o FPB D (assinalado como futuro)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW, fpbDaily: { '2026-10-22': 300 } });
    assert.equal(d.cards.tomorrow.value, 300, 'o número publicado, sem médias');
    assert.equal(d.cards.tomorrow.source, 'fpbd');
    assert.equal(d.cards.tomorrow.estimated, true);
    assert.equal(d.cards.tomorrow.quarters, 0);
  });

  it('os cartões e os meses trazem a fórmula (soma e n)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    assert.equal(d.cards.today.sum, 110 + 210 + 160);
    assert.equal(d.cards.today.quarters, 3);
    assert.equal(d.cards.today.estQuarters, 0);
    assert.equal(d.cards.today.source, 'market');
    assert.equal(d.months[0].sum, 100 + 200 + 150 + 110 + 210 + 160);
    assert.equal(d.total.sum, d.months[0].sum);
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

describe('estatísticas OMIE — o agora', () => {
  it('é em UTC (o backend nunca converte para um fuso)', () => {
    const l = utcNow(new Date('2026-10-21T12:00:00Z'));
    assert.equal(l.day, '2026-10-21');
    assert.equal(l.minutes, 12 * 60);
  });
  it('e o dia é o dia UTC', () => {
    const l = utcNow(new Date('2026-01-21T23:30:00Z'));
    assert.equal(l.day, '2026-01-21');
    assert.equal(l.minutes, 23 * 60 + 30);
  });
});

describe('estatísticas OMIE — o preço à hora actual é vivo', () => {
  // 12:00Z = 13:00 em Lisboa (WEST). Os quartos da cauda estão em hora de
  // Lisboa, sem `utc` (o caminho de fallback).
  const NOW = new Date('2026-10-21T12:00:00Z');
  // A cauda de um dia: 96 quartos de 00:00 a 23:45 (Lisboa). Preço = 10 + índice.
  const tail = (day) => {
    const out = [];
    for (let min = 0; min < 96 * 15; min += 15) {
      out.push({
        dn: dnOf(day),
        lisbonDn: dnOf(day),
        lisbonMin: min,
        price: 10 + out.length,
      });
    }
    return out;
  };
  const payload = { cutoff: '2026-10-21', recent: tail('2026-10-21') };
  const priceAt = (min) => payload.recent.find(r => r.lisbonDn === dnOf('2026-10-21') && r.lisbonMin === min).price;

  it('acompanha o relógio: cada 15 minutos muda o quarter', () => {
    const c = currentPrice(payload, NOW);
    assert.equal(c.at, '2026-10-21T13:00');
    assert.equal(c.live, true);
    assert.equal(c.price, priceAt(13 * 60));
  });

  it('quando o quarter em curso ainda não saiu, fica o último e diz que não é "live"', () => {
    // cauda truncada às 11:45: o quarter das 12:00 ainda não foi publicado
    const curto = { ...payload, recent: payload.recent.filter(r => r.lisbonMin <= 11 * 60 + 45) };
    const c = currentPrice(curto, new Date('2026-10-21T11:05:00Z')); // 12:05 em Lisboa
    assert.equal(c.at, '2026-10-21T11:45');
    assert.equal(c.live, false);
  });

  it('o quarter futuro (estimativa) nunca alimenta o preço actual', () => {
    const comFuturo = {
      cutoff: '2026-10-21',
      recent: [...payload.recent, { dn: dnOf('2026-10-22'), lisbonDn: dnOf('2026-10-22'), lisbonMin: 0, price: 99 }],
    };
    const c = currentPrice(comFuturo, new Date('2026-10-22T00:05:00Z')); // 01:05 em Lisboa
    assert.equal(c.at, '2026-10-21T23:45', 'fica o último quarter publicado');
    assert.equal(c.estimated, false);
    assert.equal(c.live, false);
  });
});
