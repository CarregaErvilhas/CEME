// Golden tests: valores congelados, apanhados do sheet em 2026-10-15.
//
// Estes testes passam pelo seed E pelo motor reais (não por valores escritos à
// mão no teste), por isso protect:
//   - o motor de cálculo não regista uma regressão;
//   - o seed não muda um preço, uma EGME ou um ciclo sem dar de conta.
//
// Os valores indexados NÃO entram aqui: dependem do OMIE do dia. Ficam testados
// com um OMIE fixado no teste da fórmula (ver engine.test.js).
//
// O que estes testes NÃO apanham: um tarifário que desapareça do seed. Isso
// apanha-se a comparar com o sheet — ver o teste "cobertura" no fim.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { seed, SHEET_SNAPSHOT } from '../src/db/seed.js';
import { quoteFixed } from '../src/engine/quote.js';
import { pickComponents } from '../src/db/components.js';

const AT = new Date('2026-10-15T22:09:00+01:00'); // 22:09 de uma quinta, fora-de-vazio
const KWH = 40;

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  seed(db);
  return db;
}

// [tariff_id, total €, €/kWh s/ IVA] — congelados a 2026-10-15 e re-congelados
// a 2026-10-22 onde o CEME mudou o preço publicado (ver cabeçalho do seed.js:
// galp/atlante/acp/bluecharge/charge2go). O Atlante (AC) e o Charge2Go
// divergem da folha POR DECISÃO — a folha ficou desactualada face às páginas.
// TODAS as âncoras implicam os valores publicados; o cenário «E se o CEME
// aplicar a EGME legal 2026?» fica no teste do cenário regulatório, mais abaixo.
const GOLDEN = [
  ['atlante-mt-myatlanteac', 10.09, 0.21],
  ['atlante-bt-myatlanteac', 11.96, 0.25],
  ['atlante-mt-myatlantebus', 8.12, 0.17],
  ['atlante-bt-myatlantebus', 9.99, 0.21],
  ['charge2go-mt-ecogreen', 9.32, 0.19],
  ['viaverde-mt-viaverdeelec', 8.31, 0.17],
  ['ezu-mt-abenergia', 5.84, 0.12],
  ['miio-mt-miiobihor-2', 12.64, 0.26],
];

function quoteFromDb(db, id, { kwh = KWH, at = AT, region = 'CONT' } = {}) {
  const t = db.prepare('SELECT * FROM tariff WHERE id=?').get(id);
  assert.ok(t, `tarifário ${id} não existe no seed`);
  const v = db.prepare('SELECT * FROM tariff_version WHERE tariff_id=? ORDER BY id DESC LIMIT 1').get(id);
  const rows = db.prepare('SELECT * FROM price_component WHERE tariff_version_id=?').all(v.id);
  const { price, act, sup, iec } = pickComponents(rows);
  const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at, kwh, price, activation: act, support: sup, iec, region });
  return { t, q, price, act, sup, iec };
}

describe('golden: fixos a 40 kWh, 2026-10-15 22:09 (CONT)', () => {
  const db = seeded();
  for (const [id, total, eurKwh] of GOLDEN) {
    it(`${id} = ${total.toFixed(2)} €`, () => {
      const { q } = quoteFromDb(db, id);
      assert.equal(q.totalEur.toFixed(2), total.toFixed(2), `total de ${id}`);
      assert.equal(q.eurKwhNoIva.toFixed(2), eurKwh.toFixed(2), `€/kWh de ${id}`);
    });
  }
});

describe('golden: cenário regulatório (EGME 2026 legal em vigor)', () => {
  // Não é âncora externa: é o cenário "e se o CEME aplicar o valor legal".
  // A Via Verde ainda publica o EGME de 2025 (0,1572) enquanto o legal 2026 é
  // 0,1088 (Regul. ERSE 7/2026). O seed fica com o PUBLISHED e a API marca
  // `activation_stale`; aqui congela-se o total QUE O CENÁRIO legal daria
  // (8,31 − 8,25 = 0,06 ≈ (0,1572 − 0,1088) × 1,23) — em qualquer dos
  // sentidos da actualização. (O Charge2Go chegou a estar neste cenário com
  // 0,1572, mas a página passou a publicar 0,1088 a 2026-10-22 — saiu daqui
  // e o golden dele passou para o valor legal.)
  const EGME_2026 = 0.1088;
  for (const [id, scenarioTotal, scenarioKwh] of [
    ['viaverde-mt-viaverdeelec', 8.25, 0.17],
  ]) {
    it(`${id} ficaria em ${scenarioTotal.toFixed(2)} € com a EGME legal 2026`, () => {
      const db = seeded();
      const { t, q, price, act, sup, iec } = quoteFromDb(db, id);
      assert.ok(act > EGME_2026, `${id} tem de estar acima do legal no seed (publicado)`);
      const cenário = quoteFixed({
        schedule: t.schedule, cycle: t.cycle, at: AT, kwh: KWH,
        price, activation: EGME_2026, support: sup, iec, region: 'CONT',
      });
      assert.equal(cenário.totalEur.toFixed(2), scenarioTotal.toFixed(2), `total do cenário regulatório de ${id}`);
      assert.equal(cenário.eurKwhNoIva.toFixed(2), scenarioKwh.toFixed(2), `€/kWh do cenário de ${id}`);
      assert.ok(cenário.totalEur < q.totalEur, 'aplicar o legal tem de baixar o total (EGME baixa)');
    });
  }
});

describe('golden: o motor continua a bater certo com a folha', () => {
  // Este é o teste que vale: 10,09 € é o que o motor dá para o Atlante
  // myAtlante (AC) MT/semanal com 40 kWh a 2026-10-15 22:09, com o preço
  // público actual (energia 0,12 €/kWh desde 2026-10-22 — a folha dava
  // 9,11 € com o 0,10 antigo). Se o motor divergir do ROUNDUP da folha,
  // o número muda.
  it('Atlante myAtlante (AC) MT/semanal fecha em 10,09 €', () => {
    const { q } = quoteFromDb(seeded(), 'atlante-mt-myatlanteac');
    assert.equal(q.totalEur, 10.09);
  });
  it('o ROUNDUP é por componente (fatura), não no fim', () => {
    // 40 × 0,2012 = 8,048 -> 8,05 pelo ROUNDUP; sem ROUNDUP daria 8,198 × 1,23.
    const { q } = quoteFromDb(seeded(), 'atlante-mt-myatlanteac');
    const semArredondar = (40 * 0.2012 + 0.11 + 40 * 0.001) * 1.23;
    assert.equal(q.totalEur, 10.09);
    assert.ok(Math.abs(semArredondar - 10.08) < 0.005, `sem arredondar daria ${semArredondar.toFixed(4)}`);
  });
});

describe('cobertura do seed', () => {
  it('todas as 24 CEME e 128 tarifários', () => {
    const db = seeded();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ceme').get().c, 24);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tariff').get().c, 128);
  });

  // seed() corre em CADA arranque do servidor. Sem chave unica em
  // tariff_version, cada arranque duplicava as 128 versoes.
  it('seed() é idempotente: arrancar duas vezes não duplica versões', () => {
    const d1 = seeded(); seed(d1); seed(d1);
    const versoes = d1.prepare('SELECT COUNT(*) c FROM tariff_version').get().c;
    const porTarifario = d1.prepare('SELECT COUNT(*) c FROM (SELECT tariff_id FROM tariff_version GROUP BY tariff_id HAVING COUNT(*)>1)').get().c;
    assert.equal(porTarifario, 0, 'há tarifários com mais de uma versão para a mesma data');
    assert.equal(versoes, d1.prepare('SELECT COUNT(*) c FROM tariff').get().c,
      'deve haver exatamente uma versão activa por tarifário');
    // os componentes tem de acompanhar: nenhuma versão órfã
    const orfas = d1.prepare('SELECT COUNT(*) c FROM price_component pc WHERE NOT EXISTS (SELECT 1 FROM tariff_version v WHERE v.id=pc.tariff_version_id)').get().c;
    assert.equal(orfas, 0, `${orfas} price_component órfãos`);
  });

  it('todas as versões partilham a data de captura (nenhuma data inventada)', () => {
    const db = seeded();
    // A folha CEME nao tem coluna de datas: so sabemos quando capturamos. Uma
    // data de "inicio de contrato" aqui seria invencao — e foi o que o seed
    // teve ('2025-01-01') durante meses, com a UI a dizer "em vigor desde".
    const d = db.prepare('SELECT COUNT(*) c FROM tariff_version WHERE valid_from != ? OR valid_from IS NULL').get(SHEET_SNAPSHOT);
    assert.equal(d.c, 0, `${d.c} versoes com data diferente de ${SHEET_SNAPSHOT}`);
    const aberta = db.prepare("SELECT COUNT(*) c FROM tariff_version WHERE valid_to IS NOT NULL AND status='ACTIVE'").get();
    assert.equal(aberta.c, 0, 'uma versao ACTIVE nao pode ter valid_to');
  });

  it('todo o tarifário tem versão com componente de preço (ou é INDEXED)', () => {
    const db = seeded();
    const semPreco = db.prepare(`SELECT t.id FROM tariff t
      JOIN tariff_version v ON v.tariff_id=t.id
      WHERE NOT EXISTS (SELECT 1 FROM price_component pc WHERE pc.tariff_version_id=v.id)
        AND t.kind <> 'INDEXED'`).all();
    assert.deepEqual(semPreco, [], `fixos sem componente de preço: ${semPreco.map(r => r.id).join(', ')}`);
  });

  it('todo o indexado tem K e CGM', () => {
    const db = seeded();
    const semK = db.prepare(`SELECT t.id FROM tariff t JOIN tariff_version v ON v.tariff_id=t.id
      WHERE t.kind='INDEXED' AND (v.k_index_eur_mwh IS NULL OR v.cgs_eur_mwh IS NULL)`).all();
    assert.deepEqual(semK, [], `indexados sem K/CGS: ${semK.map(r => r.id).join(', ')}`);
  });

  it('a EGME só falta no miio', () => {
    // Este é o teste que apanhou o bug do seed: o ramo dos indexados zerava a
    // activação, e os 10 indexados ficavam sem EGME.
    const db = seeded();
    const sem = db.prepare(`SELECT DISTINCT t.ceme_id FROM tariff t
      JOIN tariff_version v ON v.tariff_id=t.id JOIN price_component pc ON pc.tariff_version_id=v.id
      WHERE pc.activation_eur IS NULL OR pc.activation_eur=0`).all().map(r => r.ceme_id);
    assert.deepEqual(sem.filter(c => c !== 'miio'), [], `CEMEs sem EGME: ${sem}`);
  });
});