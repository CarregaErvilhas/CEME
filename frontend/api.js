// Cliente da API partilhado pelas páginas (simulador, assistente, OMIE e
// tabela). Carrega-se com <script src="/api.js"> antes do script da página e
// deixa uma função global, `api(caminho, opções)`, que devolve o JSON da
// resposta.
//
// Toda a API pede credencial (docs/04-api-auth.md). O browser não tem chave:
// pede uma sessão web em POST /v1/session, um token que dura 24 h. Aqui:
//   - o token fica no sessionStorage, por isso as páginas do mesmo domínio
//     aproveitam-no enquanto o separador estiver aberto (o POST /v1/session
//     tem um limite por IP, vê backend/src/http/ratelimit.js);
//   - chamadas feitas ao mesmo tempo partilham um só pedido de sessão;
//   - num 401 (o token expirou, ou o servidor mudou de segredo) pede outro e
//     repete o pedido uma vez;
//   - qualquer outro erro HTTP vira uma excepção com a mensagem do servidor,
//     para não ser confundido com uma lista vazia.
(function () {
  const KEY = 'ceme:jwt';
  // O sessionStorage pode atirar (modo privado, cookies bloqueados): sem ele,
  // o token vive só enquanto a página estiver aberta.
  const guardado = {
    ler() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } },
    gravar(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} },
  };
  let token = guardado.ler();
  let pedido = null; // o POST /v1/session em curso, se houver

  function sessao() {
    if (token) return Promise.resolve(token);
    if (!pedido) {
      pedido = (async () => {
        const r = await fetch('/v1/session', { method: 'POST' });
        if (!r.ok) throw new Error('sessão indisponível (erro ' + r.status + ')');
        const tk = (await r.json()).token;
        if (!tk) throw new Error('sessão sem token');
        token = tk;
        guardado.gravar(tk);
        return tk;
      })().finally(() => { pedido = null; });
    }
    return pedido;
  }

  async function api(path, opts = {}) {
    const pedir = tk => fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tk } });
    let r = await pedir(await sessao());
    if (r.status === 401) {
      token = null;
      guardado.gravar(null);
      r = await pedir(await sessao());
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error((j && j.error && j.error.message) || ('erro ' + r.status));
    }
    return r.json();
  }

  window.api = api;
})();
