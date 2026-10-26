// Downloads das fontes do OMIE (omie.es e TF), com prazo e novas tentativas.
//
// Faz um GET a `url`, com até `attempts` tentativas (espera 1 s, depois
// 2 s… entre elas). Cada tentativa tem `timeoutMs` para acabar, incluindo
// ler o corpo. `read(res)` lê e valida a resposta: devolve o resultado, ou
// atira um erro e tenta-se outra vez. Depois da última, atira o último erro.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchWithRetry(url, { headers = {}, timeoutMs, attempts = 3, read }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await read(await fetch(url, { signal: ctl.signal, headers }));
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(1000 * attempt);
  }
  throw lastErr || new Error(`falha desconhecida ao ir buscar ${url}`);
}
