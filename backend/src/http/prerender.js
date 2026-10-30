// As páginas vêm do servidor já com o texto lá dentro.
//
// Cada HTML chega ao browser com os contentores vazios (<main id="app"></main>,
// <h1 id="...">) e é o script da página que os enche, com os textos de
// strings.js. Para quem lê, é igual; para os motores de busca e os crawlers
// de IA, que muitas vezes não correm JavaScript, a página tinha 4 ou 5
// palavras. Por isso o servidor corre aqui o próprio script da página, uma vez
// por (página, língua), num `document` falso que só regista o que o script
// escreve em cada elemento (innerHTML/textContent por id). Depois põe esse
// HTML nos elementos que estão vazios no ficheiro. No browser o script corre
// outra vez e escreve o mesmo por cima: o resultado é igual.
//
// Não há uma segunda cópia dos templates a manter: se uma página mudar, o que
// sai daqui muda com ela. Se o script rebentar no `document` falso, a página
// sai como está no ficheiro (é o que acontecia antes).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const FRONTEND = new URL('../../../frontend/', import.meta.url);
const cache = new Map(); // `${file}|${lang}` -> { fills, title }

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const noop = () => {};

// Um elemento falso: aceita tudo o que os scripts lhe fazem e guarda, por id,
// a última coisa escrita como HTML.
function fakeElement(id, fills) {
  const el = {
    id, style: { setProperty: noop }, dataset: {}, value: '', children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop, appendChild: c => c, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    focus: noop, blur: noop, scrollIntoView: noop, showModal: noop, close: noop,
  };
  return new Proxy(el, {
    set(o, k, v) {
      if (k === 'innerHTML') fills.set(id, String(v));
      else if (k === 'textContent') fills.set(id, esc(v));
      o[k] = v;
      return true;
    },
  });
}

function run(file, lang, html) {
  const fills = new Map();
  const els = new Map();
  const byId = id => { if (!els.has(id)) els.set(id, fakeElement(id, fills)); return els.get(id); };
  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const document = {
    title: '',
    documentElement: { dataset: {}, style: { setProperty: noop }, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop },
    getElementById: byId,
    // Sem id não há onde pôr o resultado: estes ficam de fora.
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, createElement: () => fakeElement('', new Map()),
    body: fakeElement('', new Map()), head: fakeElement('', new Map()),
  };
  const ctx = {
    document, localStorage: storage, sessionStorage: storage, console: { log: noop, warn: noop, error: noop },
    navigator: { languages: [], language: '', userAgent: '' },
    location: { search: '', hash: '', pathname: '/', href: '', origin: '' },
    history: { replaceState: noop, pushState: noop },
    // Nada de rede nem de timers: a página fica no primeiro ecrã.
    fetch: () => new Promise(noop), setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    __LANG__: lang,
  };
  ctx.window = ctx.self = ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Os scripts partilhados que a página carrega (strings.js, tz.js...), menos
  // o da app instalável, que não escreve texto.
  for (const [, src] of html.matchAll(/<script src="\/([a-z]+\.js)"><\/script>/g)) {
    if (src === 'pwa.js') continue;
    vm.runInContext(readFileSync(new URL(src, FRONTEND), 'utf8'), ctx, { timeout: 500 });
  }
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    if (/__LANG__\s*=\s*null/.test(code)) continue;
    vm.runInContext(code, ctx, { timeout: 500 });
  }
  return { fills, title: document.title };
}

// O HTML da página com o texto já nos elementos vazios, e o <title> da
// língua. `html` é o ficheiro como está em frontend/.
export function prerender(file, lang, html) {
  const key = `${file}|${lang}`;
  if (!cache.has(key)) {
    try { cache.set(key, run(file, lang, html)); }
    catch (e) { console.warn(`[prerender] ${file} (${lang}): ${e.message}`); cache.set(key, null); }
  }
  const r = cache.get(key);
  if (!r) return html;
  let out = html;
  for (const [id, inner] of r.fills) {
    if (!id) continue;
    // Só elementos vazios no ficheiro: os que já têm conteúdo ficam como estão.
    const re = new RegExp(`(<(\\w+)\\b[^>]*\\bid="${id.replace(/[^\w-]/g, '')}"[^>]*>)(</\\2>)`);
    out = out.replace(re, (m, open, tag, close) => open + inner + close);
  }
  if (r.title) out = out.replace(/(<title\b[^>]*>)[^<]*<\/title>/, (m, open) => `${open}${esc(r.title)}</title>`);
  return out;
}
