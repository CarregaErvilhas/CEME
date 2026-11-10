import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExpectedError, failFromError, GENERIC_MESSAGE } from '../src/http/expected.js';

const fakeRes = () => {
  const r = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
  return r;
};
const quiet = fn => { const o = console.error; console.error = () => {}; try { return fn(); } finally { console.error = o; } };

describe('erros nas respostas da API', () => {
  it('erro esperado: 400 com a mensagem', () => {
    const res = fakeRes();
    failFromError(res, new ExpectedError('sem TAR X/BTN/VAZIO em 2026-01-01'), {}, { where: 't' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error, { code: 'quote_failed', message: 'sem TAR X/BTN/VAZIO em 2026-01-01' });
  });
  it('erro inesperado: 500 genérico, sem vazar a mensagem', () => {
    const res = fakeRes();
    quiet(() => failFromError(res, new Error('connect ECONNREFUSED db.internal:5432 SELECT *'), {}, { where: 't' }));
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, GENERIC_MESSAGE);
    assert.ok(!JSON.stringify(res.body).includes('db.internal'));
  });
  it('fonte OMIE: 502 com mensagem fixa', () => {
    const res = fakeRes();
    quiet(() => failFromError(res, new Error('getaddrinfo omie.internal'), {}, { where: 't', status: 502, code: 'omie_unavailable', message: 'OMIE indisponível' }));
    assert.equal(res.status, 502);
    assert.deepEqual(res.body.error, { code: 'omie_unavailable', message: 'OMIE indisponível' });
  });
});
