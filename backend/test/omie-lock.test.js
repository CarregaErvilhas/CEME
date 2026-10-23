// O lock do refresh do OMIE (várias réplicas, uma BD) e a guarda do modo
// readonly.
//
// O lock antigo dizia sempre "é meu" depois de tentar roubar um lock
// expirado (sem ver se o UPDATE tinha acertado) e largava-o às cegas
// (DELETE sem dono) — duas réplicas podiam ingerir ao mesmo tempo e uma
// apagava o lock da outra.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(path.join(tmpdir(), 'ceme-lock-test-'));
process.env.DB_PATH = path.join(dir, 'lock.db');

const { run, get } = await import('../src/db.js');
await run(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
const { acquireLock, releaseLock, LOCK_TTL_MS } = await import('../src/omie/pipeline.js');
const lockValue = async () => (await get(`SELECT value FROM omie_meta WHERE key = 'refresh_lock'`))?.value ?? null;

describe('OMIE — lock do refresh', () => {
  it('só um dono de cada vez', async () => {
    const a = await acquireLock();
    assert.ok(a, 'o primeiro toma-o');
    assert.equal(await acquireLock(), null, 'o segundo não');
    await releaseLock(a);
    assert.equal(await lockValue(), null, 'o dono larga-o');
  });

  it('um lock expirado rouba-se — uma vez só', async () => {
    const t0 = Date.now() - LOCK_TTL_MS - 1000;
    const velho = await acquireLock(t0);
    assert.ok(velho);
    const b = await acquireLock();
    assert.ok(b, 'expirado: rouba-se');
    assert.equal(await lockValue(), b);
    assert.equal(await acquireLock(), null, 'já não está expirado: o terceiro não entra');
    await releaseLock(b);
  });

  it('largar um lock que já não é nosso não apaga o do novo dono', async () => {
    const velho = await acquireLock(Date.now() - LOCK_TTL_MS - 1000);
    const novo = await acquireLock();
    await releaseLock(velho);
    assert.equal(await lockValue(), novo, 'o lock do novo dono fica');
    await releaseLock(novo);
  });

  it('lê os locks antigos (só a hora, sem token)', async () => {
    await run(`INSERT INTO omie_meta (key, value) VALUES ('refresh_lock', $1)`, [String(Date.now())]);
    assert.equal(await acquireLock(), null, 'um lock antigo ainda válido é respeitado');
    await run(`DELETE FROM omie_meta WHERE key = 'refresh_lock'`);
  });
});

describe('CEME_READONLY — a BD não se toca', () => {
  it('run() recusa escrever; ensureFresh não ingere', () => {
    const roDir = mkdtempSync(path.join(tmpdir(), 'ceme-ro-test-'));
    const src = new URL('../src/', import.meta.url).pathname;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { run, query } = await import('${src}db.js');
      const { ensureFresh } = await import('${src}omie/pipeline.js');
      let refused = false;
      try { await run("CREATE TABLE x (a INTEGER)"); } catch (e) { refused = /CEME_READONLY/.test(e.message); }
      const fresh = await ensureFresh();
      const tables = (await query("SELECT name FROM sqlite_master WHERE type = 'table'")).length;
      console.log(JSON.stringify({ refused, fresh, tables }));
    `], { env: { ...process.env, CEME_READONLY: '1', DB_PATH: path.join(roDir, 'ro.db') }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.refused, true, 'a escrita tem de rebentar');
    assert.deepEqual(r.fresh, { fresh: true, readonly: true }, 'sem ingestion');
    assert.equal(r.tables, 0, 'nada foi criado');
  });
});

describe('OMIE — /v1/omie/stats acompanha o dia', () => {
  it('um payload de ontem é recalculado (da BD, sem rede) e o refresh é pedido como nas outras leituras', async () => {
    const { upsertSpot, setMeta, setMetaJson } = await import('../src/omie/store.js');
    const { getStats } = await import('../src/omie/pipeline.js');
    const { lisbonDayQuarters } = await import('../src/omie/convert.js');
    const rows = lisbonDayQuarters('2026-10-21').map((q, i) => ({ utc: q.utc, day: q.day, min: q.minutes, pt: 50 + i }));
    await upsertSpot(rows, 'OMIE_ES');
    await setMetaJson('futures', { fetchedAt: Date.now(), rows: [], daily: [] });
    await setMetaJson('stats', { generatedAt: '2026-10-20T12:00:00.000Z', recent: [], cards: {} });
    await setMeta('last_refresh', String(Date.now())); // fresco: nada de rede
    const now = new Date('2026-10-21T15:00:00Z');
    const d = await getStats({ now });
    assert.equal(d.generatedAt, now.toISOString(), 'recalculado hoje');
    assert.equal(d.stale, false, 'dados frescos: nenhum refresh em curso');
    assert.ok(d.current && d.current.price != null, 'há preço à hora actual');
  });
});
