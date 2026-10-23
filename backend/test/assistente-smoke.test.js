// Smoke do assistente passo-a-passo (frontend/assistente.html).
//
// A página não tinha testes: o código só corria num browser, e a lista de
// resultados é a parte que mais depressa parte (filtros, formatação, chaves de
// tradução). Aqui corre-se o ficheiro num contexto isolado e chamam-se as
// vistas directamente — incluindo o filtro de populares, que faltava face ao
// simulador completo.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../../frontend/assistente.html', import.meta.url), 'utf8');
// O último <script> é o da página (`window.__LANG__` e `strings.js` são tags
// separadas e não apanham este regex).
const JS = [...HTML.matchAll(/<script>(.*?)<\/script>/gs)].pop()[1];
const STRINGS = readFileSync(new URL('../../frontend/strings.js', import.meta.url), 'utf8');

const noop = () => 0;
const makeEl = (tag = 'div') => {
  const e = {
    tag, dataset: {}, style: { setProperty: noop }, className: '', id: '', _html: '',
    textContent: '', innerHTML: '', value: '', placeholder: '', children: [],
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop,
    setAttribute: noop, getAttribute: () => null, closest: () => null,
    querySelectorAll: () => [], querySelector: () => null,
  };
  e.style.setProperty = noop;
  return e;
};
const store = { v: {} };
const ctx = {};
vm.createContext(ctx);
ctx.window = ctx;
ctx.addEventListener = noop;
ctx.console = { log: noop, warn: noop, error: noop };
ctx.document = {
  documentElement: { dataset: {} }, title: '',
  body: makeEl('body'),
  getElementById: (id) => (ctx.__els[id] ||= makeEl()),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, createElement: () => makeEl(),
};
ctx.__els = {};
ctx.localStorage = { getItem: (k) => (k in store.v ? store.v[k] : null), setItem: (k, v) => { store.v[k] = v; }, removeItem: (k) => { delete store.v[k]; } };
ctx.sessionStorage = { getItem: () => null, setItem: noop, removeItem: noop };
ctx.navigator = { language: 'pt-PT' };
ctx.location = { href: 'http://x/', origin: 'http://x', hash: '' };
ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ token: 't', data: [], rows: [] }) });
ctx.Intl = Intl;
ctx.performance = { now: () => 0 };
ctx.requestAnimationFrame = noop;
ctx.__LANG__ = 'pt';

vm.runInContext(STRINGS, ctx, { filename: 'strings.js' });
vm.runInContext(readFileSync(new URL('../../frontend/tz.js', import.meta.url), 'utf8'), ctx, { filename: 'tz.js' });
vm.runInContext(JS, ctx, { filename: 'assistente.js' });

// Formato do `POST /v1/simulate` (o que a página usa: totalEur, ceme, name…).
const T = (over) => ({
  ceme: 'Atlante', name: 'myAtlante (AC)', kind: 'FIXED', voltage: 'BT', schedule: 'BI_HORARIA',
  cycle: 'SEMANAL', green: 0, bundle: 0, popular: 0, estimated: false, brand: '#45a267',
  eurKwhNoIva: 0.19, totalEur: 9.11, ...over,
});
const FIXTURE = [
  T({ ceme: 'Atlante', totalEur: 9.11, popular: 1 }),
  T({ ceme: 'EDP', totalEur: 10.5, popular: 0, bundle: 1 }),
  T({ ceme: 'miio', totalEur: 12.0, popular: 0, green: 1 }),
];

const run = (body, extra = '') => vm.runInContext(`(() => {
  LAST = ${JSON.stringify(FIXTURE)};
  AVG = 9.5; LOADING = false; FAILED = false;
  ${extra}
  return (${body});
})()`, ctx);

const semLixo = (h, onde) => {
  const m = h.match(/.{60}(undefined|NaN|\[object).{40}/gs);
  assert.equal(m, null, `${onde} tem lixo:\n  ${(m || []).join('\n  ')}`);
};

describe('smoke do assistente', () => {
  before(() => { ctx.__els = {}; ctx.location.hash = ''; });

  it('as quatro vistas desenham em pt e en, sem undefined nem NaN', () => {
    for (const lang of ['pt', 'en']) {
      for (const vista of ['vLanding', 'vWhere', 'vHow', 'vWhen', 'vResults']) {
        const h = run(`${vista}()`, `LANG = '${lang}';`);
        assert.ok(h.length > 200, `${vista}/${lang} devolveu ${h.length} chars`);
        semLixo(h, `${vista}/${lang}`);
      }
    }
  });

  it('mostra o nome da região e o IVA dela (dados partilhados)', () => {
    const pt = run('vWhere()', "LANG = 'pt';");
    assert.ok(pt.includes('Continente') && pt.includes('IVA 23%'), 'PT sem região/IVA');
    const en = run('vWhere()', "LANG = 'en';");
    assert.ok(en.includes('Mainland') && en.includes('VAT 23%'), 'EN sem região/IVA');
  });

  it('o filtro de populares existe e filtra pela flag da API', () => {
    // o chip tem de estar desenhado, senão não há como o ligar
    const semFiltro = run('vResults()', "LANG = 'pt'; P.popular = false;");
    assert.ok(semFiltro.includes('data-filter="popular"'), 'chip de populares em falta');
    assert.ok(semFiltro.includes('★ populares'), 'rótulo do chip em falta');
    assert.equal((semFiltro.match(/class="row"/g) || []).length, 2, 'sem filtro: os 3 tarifários (1 no «mais barato» + 2 na lista)');

    const comFiltro = run('vResults()', "LANG = 'pt'; P.popular = true;");
    assert.ok(comFiltro.includes('Atlante'), 'o popular tem de continuar');
    assert.ok(!comFiltro.includes('EDP') && !comFiltro.includes('miio'), `populares deixou passar não-populares:\n${comFiltro}`);

    // e o mesmo em EN, para a chave comum estar traduzida
    const en = run('vResults()', "LANG = 'en'; P.popular = true;");
    assert.ok(en.includes('★ popular') && !en.includes('EDP'), 'filtro em EN');
  });

  it('as etiquetas vêm do vocabulário comum (popular/condições/verde)', () => {
    const h = run('vResults()', "LANG = 'pt'; P.popular = false;");
    assert.ok(h.includes('<span class="tag">popular</span>'), 'etiqueta popular em falta');
    assert.ok(h.includes('<span class="tag">com condições</span>'), 'etiqueta de condições em falta');
    assert.ok(h.includes('<span class="tag">verde</span>'), 'etiqueta verde em falta');
  });

  it('o link de troca aponta para /simulador (grava a escolha no servidor)', () => {
    // o href tem de ser o caminho do simulador: `/` voltaria ao próprio
    // assistente enquanto o cookie do utilizador apontar para cá
    const landing = run('vLanding()', "LANG = 'pt';");
    assert.ok(landing.includes('href="/simulador"'), `landing sem link para o simulador:\n${landing}`);
    const results = run('vResults()', "LANG = 'pt';");
    assert.ok(results.includes('href="/simulador"'), 'resultados sem link para o simulador');
    assert.ok(!/href="\/"/.test(landing + results), 'sobrou um href="/" que devolve o assistente');
  });

  it('nenhuma referência ao nome antigo (protótipo)', () => {
    assert.ok(!/prot[óo]tipo/i.test(HTML), 'o HTML ainda fala em protótipo');
    assert.ok(!/prot[óo]tipo/i.test(JS), 'o JS ainda fala em protótipo');
  });
});
