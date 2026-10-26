// Golden tests: totais congelados para tarifários fixos, a 40 kWh.
//
// Passam pelo seed E pelo motor reais (não por valores escritos à mão), por
// isso garantem que:
//   - o motor de cálculo não regista uma regressão;
//   - o seed não muda um preço, uma EGME ou um ciclo sem dar de conta.
//
// Os valores indexados NÃO entram aqui: dependem do OMIE do dia. Ficam testados
// com um OMIE fixado no teste da fórmula (ver engine.test.js).
//
// Um tarifário que desapareça do seed é apanhado pelas contagens do teste
// "cobertura" no fim (e não por estas âncoras).
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

// [tariff_id, total €, €/kWh s/ IVA] com os preços publicados pelos CEME.
// Só mudam quando um preço publicado muda, e re-congelam-se correndo o motor
// (procedimento em .opencode/commands/ceme-check.md), nunca à mão.
// O cenário «e se o CEME aplicasse a EGME legal?» está mais abaixo.
const GOLDEN = [
  ['atlante-mt-myatlanteac', 10.09, 0.21],
  ['atlante-bt-myatlanteac', 11.96, 0.25],
  ['atlante-mt-myatlantebus', 8.12, 0.17],
  ['atlante-bt-myatlantebus', 9.99, 0.21],
  ['charge2go-mt-ecogreen', 9.32, 0.19],
  // Enable: final = energia + TAR, bi-horário semanal. Quinta 22:09 =
  // fora de vazio no ciclo semanal do Continente.
  ['enable-bt-tarifasimple', 11.96, 0.25],
  ['enable-mt-tarifasimple', 10.09, 0.21],
  ['viaverde-mt-viaverdeelec', 8.31, 0.17],
  ['ezu-mt-abenergia', 5.84, 0.12],
  ['miio-mt-miiobihor-2', 12.64, 0.26],
];

function quoteFromDb(db, id, { kwh = KWH, at = AT, region = 'CONT' } = {}) {
  const t = db.prepare('SELECT * FROM tariff WHERE id=?').get(id);
  assert.ok(t, `tarifário ${id} não existe no seed`);
  const v = db.prepare('SELECT * FROM tariff_version WHERE tariff_id=? ORDER BY id DESC LIMIT 1').get(id);
  const rows = db.prepare('SELECT * FROM price_component WHERE tariff_version_id=?').all(v.id);
  // Mesmas semântica e ordem do comps() do server.js: as linhas de região
  // (price_component_region) vão POR CIMA das de omissão — a última vence.
  if (region && region !== 'CONT') {
    rows.push(...db.prepare('SELECT * FROM price_component_region WHERE tariff_version_id=? AND region=?').all(v.id, region));
  }
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
  // sentidos da actualização. Um CEME que passe a publicar o valor legal sai
  // desta lista.
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

describe('golden: o motor arredonda como a fatura', () => {
  // Um caso de ponta a ponta: Atlante myAtlante (AC) MT/semanal, 40 kWh,
  // 2026-10-15 22:09. Se o arredondamento por parcela mudar, o número muda.
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

describe('golden: preços por região (price_component_region)', () => {
  const db = seeded();
  // Domingo ao meio-dia (MAD 12:00 local, AZO 11:00 local): VAZIO nas três
  // regiões no ciclo semanal. Terça: dia útil não-sábado — Fora nos três
  // (MAD/AZO: 07:00–24:00; CONT: 07:00–24:00).
  const DOMINGO = new Date('2026-11-01T12:00:00Z');
  const TERCA = new Date('2026-11-03T12:00:00Z');

  it('enable BT vazio: continente 0,1466; ilha 0,1766 (energia 0,15 + TAR 0,0266)', () => {
    const cont = quoteFromDb(db, 'enable-bt-tarifasimple', { at: DOMINGO, region: 'CONT' });
    assert.equal(cont.q.breakdown.final, 0.1466);
    assert.equal(cont.q.totalEur, 7.41);
    const mad = quoteFromDb(db, 'enable-bt-tarifasimple', { at: DOMINGO, region: 'MAD' });
    assert.equal(mad.q.breakdown.final, 0.1766);
    assert.equal(mad.q.totalEur, 8.81); // IVA 22% da Madeira
    const azo = quoteFromDb(db, 'enable-bt-tarifasimple', { at: DOMINGO, region: 'AZO' });
    assert.equal(azo.q.breakdown.final, 0.1766);
    assert.equal(azo.q.totalEur, 8.38); // IVA 16% dos Açores
  });

  it('enable BT fora-vazio: continente 0,2392; ilha 0,2692 (energia 0,15 + TAR 0,1192)', () => {
    const cont = quoteFromDb(db, 'enable-bt-tarifasimple', { at: TERCA, region: 'CONT' });
    assert.equal(cont.q.breakdown.final, 0.2392);
    assert.equal(cont.q.period, 'FORA_VAZIO');
    const mad = quoteFromDb(db, 'enable-bt-tarifasimple', { at: TERCA, region: 'MAD' });
    assert.equal(mad.q.breakdown.final, 0.2692);
    assert.equal(mad.q.totalEur, 13.33);
  });

  it('CEME sem linhas de região cota-se com o preço do Continente na ilha', () => {
    // O default é um só: onde não há divergência publicada, não se inventa
    // preço insular — o EVIO nas ilhas sai com a mesma energia+TAR do continente.
    // (EVIO é ciclo DIARIO: domingo não é vazio — ao meio-dia é fora-vazio.)
    const mad = quoteFromDb(db, 'evio-bt-evio', { at: DOMINGO, region: 'MAD' });
    assert.equal(mad.q.breakdown.final, 0.2882);
    assert.equal(mad.q.period, 'FORA_VAZIO');
  });
});

describe('cobertura do seed', () => {
  it('todas as 24 CEME e 128 tarifários', () => {
    const db = seeded();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ceme').get().c, 24);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tariff').get().c, 128);
  });

  it('preços finais têm no máximo 4 casas e foram arredondados para cima', () => {
    const db = seeded();
    const prices = db.prepare('SELECT energy_eur_kwh FROM price_component WHERE energy_eur_kwh IS NOT NULL').all()
      .concat(db.prepare('SELECT energy_eur_kwh FROM price_component_region WHERE energy_eur_kwh IS NOT NULL').all());
    assert.ok(prices.length > 0);
    for (const { energy_eur_kwh: value } of prices) {
      assert.ok(Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-8,
        `${value} tem mais de 4 casas decimais`);
    }
    assert.equal(db.prepare(`SELECT energy_eur_kwh FROM price_component p
      JOIN tariff_version v ON v.id=p.tariff_version_id
      WHERE v.tariff_id='edp-bt-cartoedp-2' AND p.period='UNICO'`).get().energy_eur_kwh, 0.2411);
    assert.equal(db.prepare(`SELECT energy_eur_kwh FROM price_component p
      JOIN tariff_version v ON v.id=p.tariff_version_id
      WHERE v.tariff_id='edp-bt-cartoedp-12' AND p.period='VAZIO'`).get().energy_eur_kwh, 0.1446);
  });

  it('ACP não-sócio, Hyundai Blue e miio têm decomposição energia + TAR', () => {
    const db = seeded();
    const check = (id, period, energy, tar, final) => {
      const row = db.prepare(`SELECT p.energy_eur_kwh, p.energy_only_eur_kwh, p.tar_eur_kwh
        FROM price_component p JOIN tariff_version v ON v.id=p.tariff_version_id
        WHERE v.tariff_id=? AND p.period=?`).get(id, period);
      assert.ok(row, `${id}/${period} não existe`);
      assert.equal(row.energy_only_eur_kwh, energy);
      assert.equal(row.tar_eur_kwh, tar);
      assert.ok(Math.abs(row.energy_only_eur_kwh + row.tar_eur_kwh - row.energy_eur_kwh) < 1e-10,
        `${id}/${period}: energia + TAR não fecha no preço final`);
      if (final != null) assert.equal(row.energy_eur_kwh, final);
    };
    check('acp-bt-acpelectricb-2', 'FORA_VAZIO', 0.169, 0.1192, 0.2882);
    check('evio-bt-hyundaiblue', 'VAZIO', 0.169, 0.0266, 0.1956);
    check('miio-bt-miiobihor', 'FORA_VAZIO', 0.24, 0.1192, 0.3592);
    check('miio-bt-miioonebi', 'VAZIO', 0.17, 0.0266, 0.1966);
    // Enable: energia 0,12 + TAR por período, no ciclo bi-horário semanal.
    check('enable-bt-tarifasimple', 'VAZIO', 0.12, 0.0266, 0.1466);
    check('enable-bt-tarifasimple', 'FORA_VAZIO', 0.12, 0.1192, 0.2392);
    check('enable-mt-tarifasimple', 'VAZIO', 0.12, 0.0157, 0.1357);
    check('enable-mt-tarifasimple', 'FORA_VAZIO', 0.12, 0.0812, 0.2012);
  });

  it('Enable nas ilhas = energia 0,15 + TAR (linhas de região por cima do CONT)', () => {
    const db = seeded();
    const checkRegion = (id, region, period, energy, tar, final) => {
      const row = db.prepare(`SELECT pcr.energy_eur_kwh, pcr.energy_only_eur_kwh, pcr.tar_eur_kwh, pcr.activation_eur, pcr.iec_eur_kwh, pc.activation_eur AS act_cont, pc.iec_eur_kwh AS iec_cont
        FROM price_component_region pcr
        JOIN tariff_version v ON v.id=pcr.tariff_version_id
        JOIN price_component pc ON pc.tariff_version_id=v.id AND pc.period=pcr.period
        WHERE v.tariff_id=? AND pcr.region=? AND pcr.period=?`).get(id, region, period);
      assert.ok(row, `${id}/${region}/${period} não existe`);
      assert.equal(row.energy_only_eur_kwh, energy);
      assert.equal(row.tar_eur_kwh, tar);
      assert.ok(Math.abs(row.energy_only_eur_kwh + row.tar_eur_kwh - row.energy_eur_kwh) < 1e-10,
        `${id}/${region}/${period}: energia + TAR não fecha no preço final`);
      // act/IEC/apoio repetem-se à força igual entre regiões: uma divergência
      // rebenta no pickComponents (server.js), nunca aqui em silêncio.
      assert.equal(row.activation_eur, row.act_cont);
      assert.equal(row.iec_eur_kwh, row.iec_cont);
    };
    // Só MAD por célula: AZO partilha os mesmos valores (mesma TAR, mesma energia).
    checkRegion('enable-bt-tarifasimple', 'MAD', 'VAZIO', 0.15, 0.0266, 0.1766);
    checkRegion('enable-bt-tarifasimple', 'MAD', 'FORA_VAZIO', 0.15, 0.1192, 0.2692);
    checkRegion('enable-mt-tarifasimple', 'MAD', 'VAZIO', 0.15, 0.0157, 0.1657);
    checkRegion('enable-mt-tarifasimple', 'MAD', 'FORA_VAZIO', 0.15, 0.0812, 0.2312);
    const idempotentes = db.prepare('SELECT COUNT(*) c FROM price_component_region').get().c;
    assert.equal(idempotentes, 8, '2 tarifários × 2 regiões × 2 períodos');
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
    // os componentes tem de acompanhar: nenhuma versão órfã (nem por região)
    const orfas = d1.prepare('SELECT COUNT(*) c FROM price_component pc WHERE NOT EXISTS (SELECT 1 FROM tariff_version v WHERE v.id=pc.tariff_version_id)').get().c;
    assert.equal(orfas, 0, `${orfas} price_component órfãos`);
    const orfasReg = d1.prepare('SELECT COUNT(*) c FROM price_component_region pcr WHERE NOT EXISTS (SELECT 1 FROM tariff_version v WHERE v.id=pcr.tariff_version_id)').get().c;
    assert.equal(orfasReg, 0, `${orfasReg} price_component_region órfãos`);
  });

  it('todas as versões partilham a data de captura (nenhuma data inventada)', () => {
    const db = seeded();
    // Só sabemos quando os preços foram verificados, não quando cada contrato
    // começou. Por isso todas as versões usam essa data (SHEET_SNAPSHOT).
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
    // Os indexados também têm de levar a taxa de activação do seed.
    const db = seeded();
    const sem = db.prepare(`SELECT DISTINCT t.ceme_id FROM tariff t
      JOIN tariff_version v ON v.tariff_id=t.id JOIN price_component pc ON pc.tariff_version_id=v.id
      WHERE pc.activation_eur IS NULL OR pc.activation_eur=0`).all().map(r => r.ceme_id);
    assert.deepEqual(sem.filter(c => c !== 'miio'), [], `CEMEs sem EGME: ${sem}`);
  });
});
