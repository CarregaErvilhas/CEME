// Garante que o arranque grava a TAR de db/tar.js para todas as regiões e
// que corrigir um valor no código corrige a BD (é um upsert, não um "insere
// se não existir").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A BD tem de ser escolhida ANTES de o db.js ser importado.
process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'ceme-tar-test-')), 'tar.db');
const { exec, run, get, query } = await import('../src/db.js');
const { TAR, syncTar } = await import('../src/db/tar.js');
const { REGIONS } = await import('../src/engine/regions.js');
await exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));

describe('TAR no arranque', () => {
  it('grava uma linha por região, tensão e período', async () => {
    await syncTar();
    const perEntry = Object.values(TAR[0].prices).reduce((n, byPeriod) => n + Object.keys(byPeriod).length, 0);
    const rows = await query('SELECT * FROM tar');
    assert.equal(rows.length, TAR.length * Object.keys(REGIONS).length * perEntry);
  });

  it('um valor errado na BD é corrigido no arranque seguinte', async () => {
    const { valid_from, prices } = TAR[0];
    await run(`UPDATE tar SET price_eur_kwh = 9 WHERE valid_from = $1 AND region = 'MAD' AND voltage = 'BT' AND period = 'VAZIO'`, [valid_from]);
    await syncTar();
    const row = await get(`SELECT price_eur_kwh FROM tar WHERE valid_from = $1 AND region = 'MAD' AND voltage = 'BT' AND period = 'VAZIO'`, [valid_from]);
    assert.equal(row.price_eur_kwh, prices.BT.VAZIO);
  });
});
