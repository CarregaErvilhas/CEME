// O site: ficheiros estáticos e páginas HTML. Nada disto pede credencial
// (a API sim, vê api.js).
//
// servePage(req, res, url) devolve true se o pedido era para uma página ou
// ficheiro daqui (e já respondeu), ou false para o router seguir para a API.
import { readFile } from 'node:fs/promises';
import { fail } from './respond.js';
import { prerender } from './prerender.js';

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
  '/theme.js': { file: 'theme.js', headers: JS },
  '/pages.css': { file: 'pages.css', headers: { 'content-type': 'text/css; charset=utf-8', ...NO_STORE } },
  // PWA (app instalável): manifest, service worker e ícones.
  '/manifest.webmanifest': { file: 'manifest.webmanifest', headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...NO_STORE } },
  '/manifest.json': { file: 'manifest.webmanifest', headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...NO_STORE } },
  '/sw.js': { file: 'sw.js', headers: { ...JS, 'service-worker-allowed': '/' } },
  '/service-worker.js': { file: 'sw.js', headers: { ...JS, 'service-worker-allowed': '/' } },
  '/icon-192.png': { file: 'icon-192.png', headers: ICON, missing: 404 },
  '/icon-512.png': { file: 'icon-512.png', headers: ICON, missing: 404 },
  '/icon-180.png': { file: 'icon-180.png', headers: ICON, missing: 404 },
  '/icon-32.png': { file: 'icon-32.png', headers: ICON, missing: 404 },
  '/icon-maskable-512.png': { file: 'icon-maskable-512.png', headers: ICON, missing: 404 },
  // Imagem das pré-visualizações de links (WhatsApp, Facebook, X).
  '/og.png': { file: 'og.png', headers: ICON, missing: 404 },
};

// robots.txt. A /tabela não aparece aqui: é escondida pelo cabeçalho
// x-robots-tag (um Disallow aqui anunciava-a). O Sitemap tem de ser um URL
// absoluto, por isso leva o domínio do pedido.
const robots = origin => `User-agent: *\nDisallow: /v1/\nSitemap: ${origin}/sitemap.xml\n`;

// Páginas no sitemap.xml. Só um caminho por página (sem /about, /contact,
// /index.html) e sem a /tabela. No domínio OMIE só existe a raiz.
const SITEMAP_PATHS = ['/', '/simulador', '/sobre', '/contactos', '/api', '/omie'];
const sitemap = (origin, paths) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + paths.map(p => `  <url><loc>${origin}${p}</loc></url>\n`).join('')
  + '</urlset>\n';

// https://<host> do pedido (http só se o proxy disser que veio por http).
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() === 'http' ? 'http' : 'https';
  const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:-]/g, '');
  return `${proto}://${host}`;
}

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

// O domínio público do comparador: o endereço canónico das páginas, mesmo
// quando o pedido chega por outro nome (o domínio interno do Zerops). A página
// OMIE no seu próprio domínio usa esse.
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || 'https://ceme.ocarroeletrico.com').replace(/\/$/, '');

// Páginas cujo texto o servidor já põe no HTML (prerender.js). A OMIE vive
// de dados da API e a /tabela não é indexada; a /api já é HTML estático.
const PRERENDER = new Set(['assistente.html', 'index.html', 'about.html', 'contact.html', 'privacy.html']);

// O endereço canónico de cada caminho: os sinónimos (/about, /index.html)
// apontam para o caminho que está no sitemap. `/` e `/assistente` mostram o
// assistente a quem não escolheu outra interface: são a mesma página.
const CANONICAL = {
  '/': '/', '/index.html': '/', '/assistente': '/', '/simulador': '/simulador',
  '/sobre': '/sobre', '/about': '/sobre', '/contactos': '/contactos', '/contact': '/contactos',
  '/privacidade': '/privacidade', '/privacy': '/privacidade', '/api': '/api', '/omie': '/omie', '/omie.html': '/omie',
};

// Dados estruturados (schema.org) das duas interfaces do simulador.
const appLd = (url, lang) => JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: lang === 'en' ? 'EV Tariff Comparison (CEME)' : 'Comparador CEME',
  url,
  inLanguage: lang === 'en' ? 'en' : 'pt-PT',
  applicationCategory: 'UtilitiesApplication',
  operatingSystem: 'Any',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  areaServed: { '@type': 'Country', name: 'Portugal' },
  publisher: { '@type': 'Organization', name: 'O Carro Elétrico', url: 'https://ocarroeletrico.com' },
}).replace(/</g, '\\u003c');

// As etiquetas que os motores de busca e as pré-visualizações lêem e que a
// página ainda não tem: endereço canónico, og:url, og:image, JSON-LD.
function seoHead(html, req, lang) {
  const p = new URL(req.url, 'http://x').pathname;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const origin = host === OMIE_HOST ? `https://${OMIE_HOST}` : PUBLIC_ORIGIN;
  const path = host === OMIE_HOST && p === '/' ? '/' : CANONICAL[p];
  if (!path) return html;
  const url = origin + path;
  const tags = [];
  if (!/rel="canonical"/.test(html)) tags.push(`<link rel="canonical" href="${url}">`);
  if (!/property="og:url"/.test(html)) tags.push(`<meta property="og:url" content="${url}">`);
  if (!/property="og:image"/.test(html)) tags.push(`<meta property="og:image" content="${PUBLIC_ORIGIN}/og.png">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">');
  if (lang === 'en') html = html.replace(/<meta property="og:locale" content="pt_PT">/, '<meta property="og:locale" content="en_GB">');
  html = html.replace(/<meta name="twitter:card" content="summary">/, '<meta name="twitter:card" content="summary_large_image">');
  if (path === '/' || path === '/simulador') tags.push(`<script type="application/ld+json">${appLd(url, lang)}</script>`);
  if (!tags.length) return html;
  // Algumas páginas não escrevem <head> (é opcional em HTML): aí as etiquetas
  // vão logo a seguir ao viewport, que todas têm.
  const at = html.includes('</head>') ? /<\/head>/ : /(<meta name="viewport"[^>]*>)/;
  return html.replace(at, m => (m === '</head>' ? tags.join('\n') + '\n</head>' : m + '\n' + tags.join('\n')));
}

// Envia uma página HTML com a língua negociada: troca o `lang` do <html> e o
// marcador window.__LANG__, põe o texto na página (prerender.js) e as
// etiquetas para os motores de busca (seoHead).
async function sendHtml(req, res, file, headers = {}) {
  const lang = negotiateLang(req.headers['accept-language']);
  let html;
  try { html = await readFile(new URL(file, FRONTEND), 'utf8'); }
  catch { return fail(res, 500, 'no_frontend', `frontend/${file} em falta`); }
  if (PRERENDER.has(file)) html = prerender(file, lang, html);
  html = seoHead(html, req, lang)
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
  // Página OMIE (vê OMIE_ROUTES). O cabeçalho Host diz por que domínio veio.
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (p === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600', vary: 'Host', ...NOSNIFF });
    res.end(robots(originOf(req)));
    return true;
  }
  if (p === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600', vary: 'Host', ...NOSNIFF });
    res.end(sitemap(originOf(req), host === OMIE_HOST ? ['/'] : SITEMAP_PATHS));
    return true;
  }
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
