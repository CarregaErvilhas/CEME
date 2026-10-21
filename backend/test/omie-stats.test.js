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
    // O último quarter do dia 02/01 é o das 23:45.
    const last = days.get('2026-01-02');
    assert.equal(last[0].min, 0, 'o dia 02/01 começa à meia-noite');
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

  it('o preço à hora actual é o quarter em curso (em UTC)', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // 13:00 UTC → o quarter das 13:00; o último publicado que não passa
    // disso é o das 08:00.
    assert.equal(d.current.at, '2026-10-21T08:00');
    assert.equal(d.current.price, 160);
    assert.equal(d.current.live, false);
    const d2 = aggregate(rows, { cutoff: '2026-10-21', now: new Date('2026-10-21T00:05:00Z') });
    assert.equal(d2.current.at, '2026-10-21T00:00');
    assert.equal(d2.current.live, true, 'o quarter em curso está publicado');
  });

  it('as janelas são mostradas em UTC', () => {
    const d = aggregate(rows, { cutoff: '2026-10-21', now: NOW });
    // O dia civil (UTC) começa à meia-noite.
    assert.equal(d.cards.last30.from, '2026-09-21T00:00');
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
  const NOW = new Date('2026-10-21T13:00:00Z');
  // A cauda de um dia: 96 quartos de 00:00 a 23:45 (UTC). Preço = 10 + índice.
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
    const c = currentPrice(curto, new Date('2026-10-21T12:05:00Z'));
    assert.equal(c.at, '2026-10-21T11:45');
    assert.equal(c.live, false);
  });

  it('marca como estimativa o quarter de um dia que a OMIE ainda não publicou', () => {
    const comFuturo = {
      cutoff: '2026-10-21',
      recent: [...payload.recent, { dn: dnOf('2026-10-22'), lisbonDn: dnOf('2026-10-22'), lisbonMin: 0, price: 99 }],
    };
    const c = currentPrice(comFuturo, new Date('2026-10-22T00:05:00Z')); // 01:05 em Lisboa
    assert.equal(c.at, '2026-10-22T00:00', 'o quarter das 01:00 ainda não existe');
    assert.equal(c.price, 99);
    assert.equal(c.estimated, true, 'o dia 22/10 ainda é estimativa OMIP');
  });
});
