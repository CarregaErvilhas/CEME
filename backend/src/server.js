// O servidor HTTP. Um só processo serve tudo:
//   - as páginas HTML e os ficheiros estáticos (http/pages.js);
//   - a API em /v1/*, que pede sempre credencial (http/api.js);
//   - /healthz e /readyz, para a plataforma saber se o processo está vivo
//     (aqui mesmo).
//
// Usa só o módulo `node:http`, sem framework. Ao arrancar:
//   1. prepara a BD (boot.js: schema, migrações, chave da API, TAR, seed);
//   2. começa a aceitar pedidos na porta PORT.
//
// Se é a primeira vez que lês isto, segue um pedido: handle() aqui em baixo,
// depois servePage() ou serveApi(), e no fim tariffs.js e engine/.
//
// Glossário rápido (mais em docs/00-glossario.md):
//   CEME: a empresa que te vende a energia no posto (via cartão/app);
//   TAR:  tarifa de acesso às redes, fixada pela ERSE;
//   EGME: a taxa de activação cobrada por carregamento;
//   IEC:  imposto especial sobre a electricidade;
//   OMIE: o mercado grossista ibérico, de onde vem o preço dos indexados.
import http from 'node:http';
import { query, USE_PG } from './db.js';
import { boot } from './boot.js';
import { json, fail, isLoopback } from './http/respond.js';
import { servePage } from './http/pages.js';
import { serveApi } from './http/api.js';

const PORT = Number(process.env.PORT || 3001);

// A BD responde? Faz um SELECT 1 com 3 s de prazo e guarda a resposta 5 s,
// para não fazer uma query por cada verificação. Devolve true/false, nunca
// atira erro.
const DB_CHECK_TTL = 5000;
let dbCheck = null;
const dbAlive = async () => {
  const now = Date.now();
  if (dbCheck && now - dbCheck.at < DB_CHECK_TTL) return dbCheck.promise;
  const promise = (async () => {
    let timer;
    const guard = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 3000);
      timer.unref?.();
    });
    try {
      return await Promise.race([query('SELECT 1').then(() => true, () => false), guard]);
    } finally {
      clearTimeout(timer);
    }
  })();
  dbCheck = { at: now, promise };
  return promise;
};

// Verificações da plataforma (zerops.yml), sem auth. Devolve true se
// respondeu.
//   /healthz: "o processo está vivo?" Não toca na BD, para uma falha da BD
//             não tirar o site do ar.
//   /readyz:  "posso receber tráfego?" Também testa a BD. Usa-se num deploy,
//             antes de pôr a versão nova a servir. Só testa a BD se o pedido
//             vier da própria máquina (é de lá que a plataforma pergunta); de
//             fora responde 200 com `db: unknown`, para ninguém usar isto
//             para martelar a BD.
async function serveHealth(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname === '/healthz') {
    json(res, 200, { ok: true, up: Math.round(process.uptime()) });
    return true;
  }
  if (url.pathname === '/readyz') {
    if (!isLoopback(req)) json(res, 200, { ok: true, db: 'unknown' });
    else if (await dbAlive()) json(res, 200, { ok: true, db: 'up' });
    else json(res, 503, { ok: false, db: 'down', error: { code: 'db_unavailable', message: 'a BD não respondeu' } });
    return true;
  }
  return false;
}

// O domínio antigo (beta) redirecciona para o de produção, no mesmo caminho.
// 301 em GET/HEAD; 308 nos restantes métodos, para o cliente repetir o pedido
// com o mesmo método e corpo (chamadas à API).
const BETA_HOST = 'ceme-beta.ocarroeletrico.com';
const PROD_HOST = 'ceme.ocarroeletrico.com';
function redirectBeta(req, res) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host !== BETA_HOST) return false;
  const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
  res.writeHead(status, { location: `https://${PROD_HOST}${req.url}`, 'cache-control': 'public, max-age=3600', vary: 'Host' });
  res.end();
  return true;
}

// O router: health → site → API. Cada um responde e devolve true, ou deixa
// passar para o seguinte. A API é a última e responde sempre.
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return fail(res, 400, 'bad_request', 'alvo do pedido inválido'); }
  if (await serveHealth(req, res, url)) return;
  if (redirectBeta(req, res)) return;
  if (await servePage(req, res, url)) return;
  await serveApi(req, res, url);
}

await boot();

// Qualquer erro não apanhado num pedido vira um 500, em vez de derrubar o
// processo inteiro.
const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) {
    console.error('[ceme-v2] erro no pedido:', e);
    if (!res.headersSent) fail(res, 500, 'internal', 'erro interno');
    else res.end();
  }
});
process.on('unhandledRejection', (e) => console.error('[ceme-v2] rejeição não tratada:', e));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[ceme-v2] porta ${PORT} ocupada — outro servidor já corre aí.`);
    console.error(`  kill $(lsof -ti tcp:${PORT})  ou  PORT=<outra> node src/server.js`);
    process.exit(1);
  }
  console.error('[ceme-v2] erro no servidor:', e);
});
server.listen(PORT, () => console.log(`ceme-v2 http://localhost:${PORT}/ db=${USE_PG ? 'postgresql' : 'sqlite'}`));
