// O cliente da API das páginas (frontend/api.js), num contexto isolado com um
// `fetch` falso: uma só sessão para chamadas ao mesmo tempo, o token
// reaproveitado do sessionStorage, uma nova tentativa num 401 e a mensagem do
// servidor nos erros.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../frontend/api.js', import.meta.url), 'utf8');

// Carrega o api.js num contexto novo. `responder(url, opts)` faz de servidor;
// devolve o contexto e a lista de pedidos feitos.
function carregar(responder, guardado = {}) {
  const pedidos = [];
  const ctx = {
    sessionStorage: {
      getItem: k => (k in guardado ? guardado[k] : null),
      setItem: (k, v) => { guardado[k] = v; },
      removeItem: k => { delete guardado[k]; },
    },
    fetch: async (url, opts = {}) => {
      pedidos.push({ url, auth: opts.headers?.Authorization ?? null, method: opts.method ?? 'GET' });
      const [status, body] = await responder(url, opts);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'api.js' });
  return { ctx, pedidos, guardado };
}

describe('frontend/api.js', () => {
  it('chamadas ao mesmo tempo partilham um só POST /v1/session', async () => {
    let n = 0;
    const { ctx, pedidos, guardado } = carregar(async url => (url === '/v1/session' ? [200, { token: `t${++n}` }] : [200, { ok: url }]));
    const r = await Promise.all([ctx.api('/v1/a'), ctx.api('/v1/b'), ctx.api('/v1/c')]);
    assert.deepEqual(r.map(x => x.ok), ['/v1/a', '/v1/b', '/v1/c']);
    assert.equal(pedidos.filter(p => p.url === '/v1/session').length, 1);
    assert.ok(pedidos.filter(p => p.url !== '/v1/session').every(p => p.auth === 'Bearer t1'));
    assert.equal(guardado['ceme:jwt'], 't1', 'o token fica para as outras páginas');
  });

  it('um token já guardado (de outra página) é usado sem pedir sessão', async () => {
    const { ctx, pedidos } = carregar(async () => [200, {}], { 'ceme:jwt': 'velho' });
    await ctx.api('/v1/x');
    assert.deepEqual(pedidos.map(p => [p.url, p.auth]), [['/v1/x', 'Bearer velho']]);
  });

  it('num 401 pede outro token e repete o pedido uma vez', async () => {
    const { ctx, pedidos, guardado } = carregar(async (url, opts) => {
      if (url === '/v1/session') return [200, { token: 'novo' }];
      return opts.headers.Authorization === 'Bearer novo' ? [200, { ok: true }] : [401, { error: { message: 'token expirado' } }];
    }, { 'ceme:jwt': 'expirado' });
    assert.deepEqual(await ctx.api('/v1/x'), { ok: true });
    assert.deepEqual(pedidos.map(p => p.url), ['/v1/x', '/v1/session', '/v1/x']);
    assert.equal(guardado['ceme:jwt'], 'novo');
  });

  it('um erro HTTP vira uma excepção com a mensagem do servidor', async () => {
    const { ctx } = carregar(async url => (url === '/v1/session' ? [200, { token: 't' }] : [429, { error: { code: 'rate_limited', message: 'limite excedido' } }]));
    await assert.rejects(ctx.api('/v1/x'), /limite excedido/);
  });

  it('uma sessão recusada diz o código, e a seguinte tenta outra vez', async () => {
    let falhar = true;
    const { ctx } = carregar(async url => (url === '/v1/session' ? (falhar ? [429, {}] : [200, { token: 't' }]) : [200, { ok: 1 }]));
    await assert.rejects(ctx.api('/v1/x'), /erro 429/);
    falhar = false;
    assert.deepEqual(await ctx.api('/v1/x'), { ok: 1 });
  });

  it('sem sessionStorage (modo privado) funciona na mesma', async () => {
    const pedidos = [];
    const ctx = {
      get sessionStorage() { throw new Error('SecurityError'); },
      fetch: async (url) => { pedidos.push(url); return { ok: true, status: 200, json: async () => (url === '/v1/session' ? { token: 't' } : { ok: 1 }) }; },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    assert.deepEqual(await ctx.api('/v1/x'), { ok: 1 });
    await ctx.api('/v1/y');
    assert.deepEqual(pedidos, ['/v1/session', '/v1/x', '/v1/y']);
  });
});
