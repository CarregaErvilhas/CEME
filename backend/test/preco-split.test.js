// A decomposição do preço em energia + TAR: só existe onde a folha a
// tinha (o CEME publicava a energia à parte) e tem de ser coerente com o
// preço final — senão é aritmética inventada.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { seed } from '../src/db/seed.js';

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  seed(db);
  return db;
};

describe('preço: energia + TAR', () => {
  it('quando há decomposição, energia + TAR = preço final', () => {
    const db = fresh();
    const rows = db.prepare(`
      SELECT t.id, pc.period, pc.energy_eur_kwh AS final,
             pc.energy_only_eur_kwh AS energy, pc.tar_eur_kwh AS tar
        FROM price_component pc
        JOIN tariff_version v ON v.id = pc.tariff_version_id
        JOIN tariff t ON t.id = v.tariff_id
       WHERE pc.energy_only_eur_kwh IS NOT NULL`).all();
    assert.ok(rows.length >= 40, `há decomposições: ${rows.length}`);
    for (const r of rows) {
      assert.ok(Math.abs((r.energy + r.tar) - r.final) < 0.00001,
        `${r.id} ${r.period}: ${r.energy} + ${r.tar} != ${r.final}`);
    }
  });

  it('os tarifários sem decomposição ficam com o preço final e nada mais', () => {
    const db = fresh();
    // A EDP publica o preço final: não há energia separada, e não se inventa.
    const edp = db.prepare(`
      SELECT pc.energy_eur_kwh AS final, pc.energy_only_eur_kwh AS energy, pc.tar_eur_kwh AS tar
        FROM price_component pc
        JOIN tariff_version v ON v.id = pc.tariff_version_id
        JOIN tariff t ON t.id = v.tariff_id
       WHERE t.id = 'edp-bt-cartoedp-8' AND pc.period = 'VAZIO'`).get();
    assert.ok(edp.final > 0);
    assert.equal(edp.energy, null, 'sem energia inventada');
    assert.equal(edp.tar, null, 'sem TAR inventada');
  });

  it('a decomposição do Atlante é a publicada (0,12 + a TAR desde 2026-10-22)', () => {
    const db = fresh();
    const row = db.prepare(`
      SELECT pc.energy_only_eur_kwh AS energy, pc.tar_eur_kwh AS tar
        FROM price_component pc
        JOIN tariff_version v ON v.id = pc.tariff_version_id
        JOIN tariff t ON t.id = v.tariff_id
       WHERE t.id = 'atlante-bt-myatlanteac' AND pc.period = 'VAZIO'`).get();
    assert.equal(row.energy, 0.12);
    assert.equal(row.tar, 0.0266);
  });
});
