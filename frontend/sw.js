/* Service worker do CEME: permite instalação como app (PWA) e um arranque
 * offline mínimo.
 *
 * REDE PRIMEIRO para tudo o que muda com um deploy (strings.js, tz.js, theme.js,
 * pages.css, manifest, as páginas): o servidor serve-os com `no-store` de
 * propósito, e um cache-first aqui desfazia isso — a app instalada ficava com
 * o dicionário velho até o próprio sw.js mudar. A cópia em cache só serve
 * quando não há rede.
 *
 * Os ícones são imutáveis (o servidor manda `immutable`): esses sim, cache
 * primeiro.
 *
 * Mudar a estratégia ou a lista? Subir o CACHE: o `activate` apaga as caches
 * com outro nome. */
const CACHE = 'ceme-v3';
const OFFLINE = ['/strings.js', '/tz.js', '/theme.js', '/pages.css', '/manifest.webmanifest'];
const IMMUTABLE = ['/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([...OFFLINE, ...IMMUTABLE])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  let url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/')) return;

  if (IMMUTABLE.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
    return;
  }
  if (!OFFLINE.includes(url.pathname)) return; // o resto vai à rede, sem cópia

  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
