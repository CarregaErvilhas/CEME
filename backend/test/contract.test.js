// O contrato do /v1/simulate com quem o consome (o ohmigo-mcp): arranca um
// servidor a sério e confere a forma da resposta e que as parcelas somam o
// total. O ohmigo testa contra um ceme-v2 simulado, por isso se um campo
// mudar aqui só estes testes dão o aviso antes do deploy. Se mudares um campo
// de propósito, avisa o ohmigo-mcp (src/quote.js, src/promos.js) e muda-o aqui.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'ceme-contract-test-'));
const PORT = 20000 + (process.pid % 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const BACKEND = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const c2 = (v) => Math.round(v * 100) / 100;

const waitUp = async (url) => {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`servidor de teste não arrancou em 10s: ${url}`);
};

describe('contrato do /v1/simulate', () => {
  let proc, token, simple, detailed;
  const sim = async (body) => {
    const r = await fetch(`${BASE}/v1/simulate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return r.json();
  };

  before(async () => {
    proc = spawn(process.execPath, ['src/server.js'], {
      cwd: BACKEND, stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'ceme.db'), JWT_SECRET: 'test-secret-contract' },
    });
    await waitUp(`${BASE}/`);
    token = (await (await fetch(`${BASE}/v1/session`, { method: 'POST' })).json()).token;
    simple = await sim({ kwh: 30 });
    // Duas fatias, uma hora depois da outra: a forma que o ohmigo envia.
    detailed = await sim({ kwh: 30, detail: true, at: '2026-11-10T12:00:00Z', profile: [{ at: '2026-11-10T12:00:00Z', kwh: 15 }, { at: '2026-11-10T12:15:00Z', kwh: 15 }] });
  });
  after(() => { if (proc) proc.kill('SIGTERM'); });

  it('topo da resposta: o que o ohmigo lê', () => {
    assert.equal(typeof simple.at, 'string');
    assert.equal(simple.kwh, 30);
    assert.ok(Array.isArray(simple.data) && simple.data.length > 0);
    assert.ok('omieSpot' in simple);
    assert.equal(detailed.profile.slices, 2);
  });

  it('cada tarifário traz os campos que o ohmigo usa', () => {
    for (const q of [...simple.data, ...detailed.data]) {
      for (const k of ['id', 'ceme', 'name', 'voltage', 'kind', 'period']) assert.equal(typeof q[k], 'string', `${q.id}.${k}`);
      for (const k of ['totalEur', 'vat', 'egme_legal']) assert.equal(typeof q[k], 'number', `${q.id}.${k}`);
      for (const k of ['popular', 'bundle', 'newCustomers', 'activation_stale']) assert.equal(typeof q[k], 'boolean', `${q.id}.${k}`);
      assert.ok(q.vat > 1, `${q.id} vat é um multiplicador`);
    }
  });

  it('parts: forma fixa, e as parcelas somam o total ao cêntimo', () => {
    for (const q of [...simple.data, ...detailed.data]) {
      const p = q.parts;
      assert.ok(p, `${q.id} sem parts`);
      for (const k of ['energyTar', 'iec', 'activation', 'support', 'base', 'vatEur']) assert.equal(typeof p[k], 'number', `${q.id}.parts.${k}`);
      assert.equal(c2(p.energyTar + p.iec + p.activation + p.support), p.base, `${q.id}: parcelas ≠ base`);
      assert.equal(c2(p.base + p.vatEur), q.totalEur, `${q.id}: base + IVA ≠ total`);
      // energy e tar vêm juntos ou nenhum, e partem a energyTar.
      assert.equal(p.energy === null, p.tar === null, `${q.id}: energy/tar`);
      if (p.energy !== null) assert.equal(c2(p.energy + p.tar), p.energyTar, `${q.id}: energy + tar ≠ energyTar`);
    }
  });

  it('promoções: o que o ohmigo precisa para as aplicar', () => {
    const withPromos = [...simple.data, ...detailed.data].filter(q => q.promos?.length);
    assert.ok(withPromos.length, 'o seed tem promoções em vigor');
    for (const q of withPromos) for (const p of q.promos) {
      for (const k of ['id', 'target', 'from']) assert.equal(typeof p[k], 'string', `${p.id}.${k}`);
      // network null: vale em qualquer posto MOBI.E (ex.: kWh grátis).
      assert.ok(p.network === null || typeof p.network === 'string', `${p.id}.network`);
      assert.ok(['ENERGIA', 'FINAL', 'OPC', 'KWH_GRATIS'].includes(p.target), `${p.id}: target ${p.target}`);
      assert.equal(typeof p.newCustomers, 'boolean');
      // ENERGIA, FINAL e KWH_GRATIS trazem o total já cotado; OPC não.
      if (p.target !== 'OPC') assert.equal(typeof p.totalEur, 'number', `${p.id}.totalEur`);
    }
  });

  it('detail com perfil: o detalhe por fatia só vem se for pedido', () => {
    assert.ok(simple.data.every(q => !q.slices), 'sem detail não há slices');
    const multi = detailed.data.filter(q => q.slices);
    assert.ok(multi.length, 'com detail há slices');
    for (const q of multi) {
      assert.equal(q.slices.length, 2);
      for (const s of q.slices) for (const k of ['at', 'kwh', 'period', 'final']) assert.ok(k in s, `${q.id}.slices.${k}`);
    }
  });
});
