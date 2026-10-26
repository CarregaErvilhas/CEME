// Garante que o verifyJwt só aceita tokens assinados por nós, com HS256,
// dentro da validade, e que um token estragado devolve erro em vez de
// rebentar o pedido.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signJwt, verifyJwt } from '../src/auth/tokens.js';

const SECRET = 'segredo-de-teste';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (h, b, secret = SECRET) => createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');

describe('verifyJwt', () => {
  it('aceita um token emitido pelo signJwt', () => {
    const r = verifyJwt(signJwt({ kind: 'WEB_SESSION' }, SECRET), SECRET);
    assert.equal(r.ok, true);
    assert.equal(r.payload.kind, 'WEB_SESSION');
  });

  it('recusa assinatura de outro segredo e assinatura com outro tamanho', () => {
    const t = signJwt({ kind: 'WEB_SESSION' }, 'outro');
    assert.equal(verifyJwt(t, SECRET).error, 'bad_signature');
    const [h, b] = t.split('.');
    assert.equal(verifyJwt(`${h}.${b}.abc`, SECRET).error, 'bad_signature');
  });

  it('recusa alg diferente de HS256, mesmo bem assinado', () => {
    const h = b64({ alg: 'none', typ: 'JWT' });
    const b = b64({ kind: 'WEB_SESSION' });
    assert.equal(verifyJwt(`${h}.${b}.${sign(h, b)}`, SECRET).error, 'malformed');
  });

  it('recusa token expirado', () => {
    assert.equal(verifyJwt(signJwt({}, SECRET, -10), SECRET).error, 'expired');
  });

  it('não lança com lixo', () => {
    for (const t of ['', 'a.b', 'a.b.c.d', '###.###.###', null, undefined]) {
      assert.equal(verifyJwt(t, SECRET).ok, false);
    }
    const h = b64({ alg: 'HS256' });
    const b = Buffer.from('não é json').toString('base64url');
    assert.equal(verifyJwt(`${h}.${b}.${sign(h, b)}`, SECRET).error, 'malformed');
  });
});
