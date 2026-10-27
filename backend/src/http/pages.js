// O site: ficheiros estáticos e páginas HTML. Nada disto pede credencial
// (a API sim, vê api.js).
//
// servePage(req, res, url) devolve true se o pedido era para uma página ou
// ficheiro daqui (e já respondeu), ou false para o router seguir para a API.
import { readFile } from 'node:fs/promises';
import { fail } from './respond.js';

const FRONTEND = new URL('../../../frontend/', import.meta.url);
const NOSNIFF = { 'x-content-type-options': 'nosniff' };
// `no-store` em JS/CSS/HTML para o browser nunca ficar com uma versão antiga
// depois de um deploy. Os ícones não mudam, por isso guardam-se um dia.
const NO_STORE = { 'cache-control': 'no-store' };
const ICON = { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable' };
const JS = { 'content-type': 'text/javascript; charset=utf-8', ...NO_STORE };

// Ficheiros estáticos: caminho pedido → ficheiro em frontend/ e cabeçalhos.
// Alguns têm dois caminhos (ex.: /sw.js e /service-worker.js).
const STATIC = {
  '/strings.js': { file: 'strings.js', headers: JS },
  '/tz.js': { file: 'tz.js', headers: JS },
  '/pwa.js': { file: 'pwa.js', headers: JS },
  '/pages.css': { file: 'pages.css', headers: { 'content-type': 'text/css; charset=utf-8', ...NO_STORE } },
  // PWA (app instalável): manifest, service worker e ícones.
  '/manifest.webmanifest': { file: 'manifest.webmanifest', headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...NO_STORE } },
  '/manifest.json': { file: 'manifest.webmanifest', headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...NO_STORE } },
  '/sw.js': { file: 'sw.js', headers: { ...JS, 'service-worker-allowed': '/' } },
  '/service-worker.js': { file: 'sw.js', headers: { ...JS, 'service-worker-allowed': '/' } },
  '/icon-192.png': { file: 'icon-192.png', headers: ICON, missing: 404 },
  '/icon-512.png': { file: 'icon-512.png', headers: ICON, missing: 404 },
  '/icon-180.png': { file: 'icon-180.png', headers: ICON, missing: 404 },
};

// robots.txt. A /tabela não aparece aqui: é escondida pelo cabeçalho
// x-robots-tag (um Disallow aqui anunciava-a).
const ROBOTS = 'User-agent: *\nDisallow: /v1/\n';

// Língua das páginas. Cada HTML traz `window.__LANG__=null`; o servidor
// troca o null por "pt" ou "en" antes de enviar. (O regex aceita espaços à
// volta do `=`.)
const LANG_MARK = /window\.__LANG__\s*=\s*null/;

// Escolhe a língua pelo cabeçalho Accept-Language: inglês só se a língua
// preferida (maior `q`) for inglês; tudo o resto dá português.
export function negotiateLang(header) {
  if (!header) return 'pt';
  const tags = String(header).split(',')
    .map(s => { const [tag, ...params] = s.trim().split(';'); const q = params.find(p => /^\s*q=/.test(p)); return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.split('=')[1]) || 0 : 1 }; })
    .filter(t => t.tag && t.q > 0).sort((a, b) => b.q - a.q);
  return tags[0] && tags[0].tag.startsWith('en') ? 'en' : 'pt';
}

// Duas interfaces para a mesma API: o assistente (três perguntas) e o
// simulador completo. `/` mostra a que estiver no cookie `ceme_ui` (por
// omissão, o assistente). `/assistente` e `/simulador` mostram essa e gravam
// a escolha no cookie.
const UI = {
  assistente: { file: 'assistente.html' },
  completo: { file: 'index.html' },
};
// `null` = respeitar o cookie (a rota `/`); um valor = gravar essa escolha.
const UI_ROUTES = { '/': null, '/index.html': null, '/assistente': 'assistente', '/simulador': 'completo' };
const UI_COOKIE = 'ceme_ui';
const UI_COOKIE_MAX_AGE = 31536000; // 1 ano

// Outras páginas HTML, sem cookie. `/sobre` e `/about` são a mesma página
// (o mesmo para contactos e privacidade).
const INFO_ROUTES = {
  '/sobre': 'about.html', '/about': 'about.html',
  '/contactos': 'contact.html', '/contact': 'contact.html',
  '/privacidade': 'privacy.html', '/privacy': 'privacy.html',
  '/api': 'api.html',
  // Tabela em bruto dos tarifários em vigor. Não tem links a apontar para
  // ela e não é indexada pelos motores de busca.
  '/tabela': 'tabela.html',
};

// Página das estatísticas OMIE: /omie em qualquer domínio, e também a raiz
// `/` quando o pedido chega pelo domínio omie.cocofree.dev.
const OMIE_ROUTES = { '/omie': 'omie.html', '/omie.html': 'omie.html' };
const OMIE_HOST = 'omie.cocofree.dev';

// O valor do cookie `name`, ou null.
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}
// Interface escolhida no cookie; qualquer valor estranho dá o assistente.
const uiFromCookie = req => (readCookie(req, UI_COOKIE) === 'completo' ? 'completo' : 'assistente');
// O cabeçalho Set-Cookie da escolha de interface (válido 1 ano). Leva
// `Secure` só se o pedido veio por https; em dev, com http, o browser
// deitava-o fora.
function uiCookie(req, ui) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${UI_COOKIE}=${ui}; Path=/; Max-Age=${UI_COOKIE_MAX_AGE}; SameSite=Lax${https ? '; Secure' : ''}`;
}

// Envia uma página HTML com a língua negociada: troca o `lang` do <html> e o
// marcador window.__LANG__.
async function sendHtml(req, res, file, headers = {}) {
  const lang = negotiateLang(req.headers['accept-language']);
  let html;
  try { html = await readFile(new URL(file, FRONTEND), 'utf8'); }
  catch { return fail(res, 500, 'no_frontend', `frontend/${file} em falta`); }
  html = html
    .replace('<html lang="pt-PT">', `<html lang="${lang === 'en' ? 'en' : 'pt-PT'}">`)
    .replace(LANG_MARK, `window.__LANG__=${JSON.stringify(lang)}`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, ...NOSNIFF, vary: 'Accept-Language', ...headers });
  res.end(html);
}

export async function servePage(req, res, url) {
  // Só GET e HEAD (o HEAD sem corpo, o node trata disso). O resto segue
  // para a API, que responde 405 ou 401.
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = url.pathname;

  const st = Object.hasOwn(STATIC, p) && STATIC[p];
  if (st) {
    try {
      const body = await readFile(new URL(st.file, FRONTEND));
      res.writeHead(200, { ...st.headers, ...NOSNIFF });
      res.end(body);
    } catch { fail(res, st.missing || 500, 'no_frontend', `frontend/${st.file} em falta`); }
    return true;
  }
  if (p === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', ...NOSNIFF });
    res.end(ROBOTS);
    return true;
  }
  // Página OMIE (vê OMIE_ROUTES). O cabeçalho Host diz por que domínio veio.
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if ((host === OMIE_HOST && p === '/') || Object.hasOwn(OMIE_ROUTES, p)) {
    await sendHtml(req, res, OMIE_ROUTES[p] || 'omie.html', { vary: 'Accept-Language, Host' });
    return true;
  }
  if (Object.hasOwn(INFO_ROUTES, p)) {
    await sendHtml(req, res, INFO_ROUTES[p], p === '/tabela' ? { 'x-robots-tag': 'noindex, nofollow' } : {});
    return true;
  }
  if (Object.hasOwn(UI_ROUTES, p)) {
    // Assistente ou simulador (vê UI_ROUTES). `/` só lê o cookie; as rotas
    // explícitas gravam-no.
    const forced = UI_ROUTES[p]; // null = respeitar o cookie
    const ui = forced || uiFromCookie(req);
    await sendHtml(req, res, UI[ui].file, {
      vary: 'Accept-Language, Cookie',
      ...(forced ? { 'set-cookie': uiCookie(req, forced) } : {}),
    });
    return true;
  }
  return false;
}
