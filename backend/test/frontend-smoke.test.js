// Smoke test do frontend.
//
// Os outros testes de i18n olham para o texto do ficheiro; este corre o código
// a sério num contexto isolado (sem browser) e chama as funções que desenham
// cada vista. Sem isto, dois bugs meus passaram despercebidos:
//
//   1. `.map(t => ...)` sobre um tarifário sombreava a função `t()` e o modal
//      de favoritos ficava em branco com um TypeError silencioso.
//   2. depois de renomear `t()` para `i18n()`, ficou um `t(cond ? 'a' : 'b')`
//      por converter dentro de um ternário — a página deixava de renderizar.
//
// E um achado do próprio teste: sem `vat` no tarifário, o detalhe imprimia
// "NaN% incluído no total". O código passou a omitir a linha nesse caso.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const JS = [...HTML.matchAll(/<script>(.*?)<\/script>/gs)].pop()[1];

const noop = () => 0;
// Stub de elemento. `select` devolve <option> para o dropdown do comparador.
const makeEl = (tag = 'div') => {
  const e = {
    tag, dataset: {}, style: {}, className: '', id: '', _html: '',
    textContent: '', innerHTML: '', value: '', placeholder: '', children: [],
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop,
    appendChild: (c) => { e.children.push(c); return c; }, removeChild: noop,
    scrollIntoView: noop, showModal: noop, close: noop, closest: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    set innerHTML(v) { e._html = v; }, get innerHTML() { return e._html; },
  };
  if (tag === 'select') e.options = [];
  return e;
};

const store = { v: {} };
const ctx = {};
vm.createContext(ctx);
ctx.window = ctx;
ctx.addEventListener = noop;
ctx.console = { log: noop, warn: noop, error: noop };
ctx.document = {
  hidden: false, documentElement: {}, body: makeEl('body'),
  getElementById: (id) => (ctx.__els[id] ||= makeEl()),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, createElement: () => makeEl(),
};
ctx.__els = {};
ctx.localStorage = { getItem: (k) => (k in store.v ? store.v[k] : null), setItem: (k, v) => { store.v[k] = v; }, removeItem: (k) => { delete store.v[k]; } };
ctx.sessionStorage = { getItem: () => null, setItem: noop, removeItem: noop };
ctx.location = { href: 'http://x/', origin: 'http://x', hash: '', search: '' };
ctx.fetch = async () => ({ json: async () => ({ token: 't', data: [], rows: [] }) });
ctx.Intl = Intl; ctx.URLSearchParams = URLSearchParams;
ctx.setInterval = noop; ctx.clearInterval = noop; ctx.__LANG__ = 'pt';

// Corta o `init()` (faz fetch), mantendo o resto.
vm.runInContext(JS.replace(/^init\(\);?$/m, '/* init() removido no teste */'), ctx, { filename: 'frontend.js' });

// Um tarifário de cada tipo, com o formato que `POST /v1/simulate` devolve.
const FIXED = (over = {}) => ({
  id: 'f', ceme: 'Atlante', name: 'myAtlante (AC)', kind: 'FIXED', voltage: 'MT',
  schedule: 'BI_HORARIA', cycle: 'SEMANAL', green: 1, bundle: 0, popular: 1,
  estimated: false, source_url: 'https://x', valid_from: '2026-10-15', brand: '#45a267',
  regions: 'CONT', activation: 0.11, iec: 0.001, vat: 1.23,
  prices: { VAZIO: 0.1157, FORA_VAZIO: 0.1812 }, totalEur: 9.11, eurKwhNoIva: 0.19,
  period: 'FORA_VAZIO', ...over,
});
const INDEXED = (over = {}) => ({
  id: 'i', ceme: 'LUZiGÁS', name: 'Tarifário Indexado Cliente CEME', kind: 'INDEXED',
  voltage: 'MT', schedule: 'BI_HORARIA', cycle: 'SEMANAL', green: 0, bundle: 0,
  popular: 0, estimated: false, source_url: 'https://y', valid_from: '2026-10-15',
  brand: '#87b9f9', regions: 'CONT', activation: 0.1088, iec: 0.001, vat: 1.23,
  prices: { VAZIO: 0.14, FORA_VAZIO: 0.22 }, totalEur: 12.5, eurKwhNoIva: 0.29,
  period: 'VAZIO', omieRef: 0.08, k: 0.05, cgs: 0.02, loss: 0.1531, ...over,
});
const FIXTURE = [
  FIXED({ id: 'f-mt' }),
  FIXED({ id: 'f-bt', voltage: 'BT', estimated: true, warning: 'OMIE_CONT_REF', prices: { VAZIO: 0.1266, FORA_VAZIO: 0.2192 }, totalEur: 10.98 }),
  // nome próprio: o dedup é por ceme|nome, partilhar o nome faria o
  // simples desaparecer dentro dos outros (e no mundo real também).
  FIXED({ id: 'f-simples', name: 'myAtlante (AC) Simples', schedule: 'SIMPLES', cycle: 'SIMPLES', prices: { UNICO: 0.2 }, totalEur: 10.3 }),
  INDEXED({ id: 'i-mt' }),
  INDEXED({ id: 'i-bt', voltage: 'BT', prices: { VAZIO: 0.15, FORA_VAZIO: 0.23 }, totalEur: 13.1 }),
];

// Cada chamada corre num scope novo (senão os `const` colidem entre testes).
const run = (body, extra = '') => vm.runInContext(`(() => {
  LAST = ${JSON.stringify(FIXTURE)};
  AVG = 9.5; AT = '2026-10-18T00:00:00.000Z';
  ${extra}
  return (${body});
})()`, ctx);

const semLixo = (h, onde) => {
  const m = h.match(/.{60}(undefined|NaN|\[object).{40}/gs);
  assert.equal(m, null, `${onde} tem lixo:\n  ${(m || []).join('\n  ')}`);
};

describe('smoke do frontend', () => {
  before(() => { ctx.__els = {}; ctx.location.hash = ''; ctx.__favs = null; });

  it('vHome desenha em pt e en, sem undefined nem NaN', () => {
    for (const lang of ['pt', 'en']) {
      const h = run(`vHome()`, `setLang('${lang}', false);`);
      assert.ok(h.length > 500, `${lang}: vHome devolveu ${h.length} chars`);
      semLixo(h, `vHome/${lang}`);
    }
  });

  it('vCmp desenha em pt e en, sem undefined nem NaN', () => {
    for (const lang of ['pt', 'en']) {
      const h = run(`vCmp()`, `setLang('${lang}', false); location.hash = '#/comparar';`);
      assert.ok(h.length > 500, `${lang}: vCmp devolveu ${h.length} chars`);
      semLixo(h, `vCmp/${lang}`);
    }
  });

  it('o detalhe omite a linha do IVA quando o tarifário não traz vat', () => {
    const semVat = FIXED(); delete semVat.vat;
    const h = run(`detail(q)`, `setLang('pt', false); const q = ${JSON.stringify(semVat)};`);
    semLixo(h, 'detail sem vat');
    assert.ok(!h.includes('incluído no total'), 'a linha do IVA não devia aparecer sem vat');
    const comVat = run(`detail(q)`, `setLang('pt', false); const q = ${JSON.stringify(FIXED())};`);
    assert.ok(comVat.includes('23% incluído no total'), 'com vat, a linha tem de aparecer');
  });

  it('os badges de cada tipo de tarifário desenham', () => {
    const casos = {
      simples: FIXED({ schedule: 'SIMPLES', cycle: 'SIMPLES' }),
      bihorario: FIXED(), indexado: INDEXED(), bundle: FIXED({ bundle: 1 }),
      verde: FIXED({ green: 1 }), estimado: FIXED({ estimated: 1 }),
      aviso: FIXED({ warning: 'OMIE_CONT_REF' }), outraRegiao: FIXED({ regions: 'MAD' }),
      egmeStale: FIXED({ activation: 0.1572, egme_legal: 0.1088, activation_stale: true }),
    };
    for (const [nome, q] of Object.entries(casos)) {
      const h = run(`badges(q)`, `const q = ${JSON.stringify(q)};`);
      assert.ok(h.length > 10, `badge ${nome} vazio`);
      semLixo(h, `badge ${nome}`);
    }
  });

  // A correção do "(AC)" da Atlante foi feita só como tooltip de hover, que
  // não se vê sem passar o rato. Passou a ter badge visível + linha na
  // composição do preço.
  // A folha nao tem datas, por isso nao se pode escrever "em vigor desde" —
  // foi o que o seed inventou durante meses ('2025-01-01' nas 128 linhas).
  // A tabela de quartos resumia em "8 mais baratos" — que nao diz nada sobre
  // indexado vs fixo. O resumo certo sao as faixas onde o indexado ganha.
  // Pedido explicito: os "Futuros OMIP" nao servem para nada neste simulador.
  // O endpoint continua de pe para terceiros, mas a interface nao os mostra nem
  // os pede — e um `document.getElementById('cmpFut')` num elemento que ya nao
  // existe nao daria erro nenhum no stub, por isso o teste tem de ser sobre o
  // fonte, nao sobre o DOM.
  it('os futuros OMIP não são exibidos nem pedidos', () => {
    assert.ok(!HTML.includes('cmpFut'), "ainda ha um contentor cmpFut");
    assert.ok(!/v1\/omie\/futures/.test(JS), "a interface ainda pede /v1/omie/futures");
    for (const lang of ['pt', 'en']) {
      const chaves = run(`Object.keys(STR.${lang})`);
      for (const k of ['futures', 'thContract', 'thProduct']) {
        assert.ok(!chaves.includes(k), `chave morta "${k}" continua em STR.${lang}`);
      }
    }
    assert.ok(!/futuros OMIP|OMIP futures/i.test(run(`[STR.pt.cmpSub, STR.en.cmpSub].join(' ')`)),
      'o subtítulo ainda promete os futuros');
  });

  it('ranges() colapsa quartos contiguos e nao inventa faixas', () => {
    const out = run(`[
      ranges([]),
      ranges(['12:00']),
      ranges(['10:30','10:45','11:00']),
      ranges(['09:00','09:15','11:00']),
      ranges(['23:45','' + plus15('23:45')]),
    ]`);
    // JSON.stringify: os arrays do vm context nao passam deepEqual (prototipo)
    const eq = (n, esperado, msg) => assert.equal(JSON.stringify(out[n]), JSON.stringify(esperado), msg);
    eq(0, [], 'lista vazia nao da nenhuma faixa');
    eq(1, ['12:00–12:15'], 'um quarto so fecha com o seguinte');
    eq(2, ['10:30–11:15'], 'tres contiguos = uma faixa so');
    eq(3, ['09:00–09:30', '11:00–11:15'], 'um buraco parte a faixa em duas');
    assert.ok(out[4][0].startsWith('23:45'), `meia-noite tem de funcionar: ${out[4]}`);
  });

  it('a data mostra-se como captura, nunca como inicio do contrato', () => {
    const h = run(`detail(q)`, `const q = ${JSON.stringify(FIXED())};`);
    assert.ok(h.includes('Preços verificados em'), `etiqueta errada:\n  ${h}`);
    assert.ok(!/Em vigor desde|In force since/.test(h), 'a UI ainda afirma "em vigor desde"');
    assert.ok(h.includes('2026-10-15'), 'a data de captura nao aparece');
    const en = run(`detail(q)`, `setLang('en', false); const q = ${JSON.stringify(FIXED())};`);
    assert.ok(en.includes('Prices checked on') && !en.includes('In force since'),
      `EN ainda afirma "in force since"`);
  });

  it('a nota do tarifário é visível, não só um tooltip de hover', () => {
    const comNota = FIXED({ notes: 'AC_DC_FLAT' });
    //lingua explicita: sem isto o teste herda a do teste anterior
    const h = run(`badges(q)`, `setLang('pt', false); const q = ${JSON.stringify(comNota)};`);
    assert.ok(h.includes('só em AC'), `badge visível em falta:\n  ${h}`);
    assert.ok(h.includes('corrente alternada'), 'o tooltip da nota tem de explicar o AC');
    semLixo(h, 'badge com nota');

    const d = run(`detail(q)`, `setLang('pt', false); const q = ${JSON.stringify(comNota)};`);
    assert.ok(d.includes('note-ac') && d.includes('postos DC'), 'a composição tem de mostrar a nota');
    const semNota = run(`detail(q)`, `setLang('pt', false); const q = ${JSON.stringify(FIXED())};`);
    assert.ok(!semNota.includes('note-ac'), 'sem nota, não aparece a linha');

    const en = run(`[badges(q), detail(q)]`, `setLang('en', false); const q = ${JSON.stringify(comNota)};`);
    assert.ok(en[0].includes('AC only') && en[1].includes('alternating-current'),
      `EN sem tradução:\n  ${en[0]}`);

    // código desconhecido mostra-se tal e qual — não se esconde informação
    const desc = run(`badges(q)`, `setLang('pt', false); const q = ${JSON.stringify(FIXED({ notes: 'NOTA_NOVA' }))};`);
    assert.ok(desc.includes('NOTA_NOVA'), `código desconhecido sumiu:\n  ${desc}`);
  });

  it('cycName e perName traduzem sempre (é onde o `t()` por converter vivava)', () => {
    const out = run(`[cycName('DIARIO'), cycName('SEMANAL'), cycName('SIMPLES'),
                      perName('VAZIO'), perName('FORA_VAZIO'), perName('UNICO')]`, `setLang('pt', false);`);
    for (const v of out) {
      assert.ok(typeof v === 'string' && v.length > 0, `tradução vazia: ${v}`);
      semLixo(v, 'tradução');
    }
    assert.equal(JSON.stringify(out), JSON.stringify(['ciclo diário', 'ciclo semanal', 'tarifa simples', 'vazio', 'fora de vazio', 'preço único']));
    const en = run(`[cycName('DIARIO'), perName('VAZIO')]`, `setLang('en', false);`);
    assert.equal(JSON.stringify(en), JSON.stringify(['same every day', 'off-peak']));
  });

  it('renderFavModal desenha a lista (o `.map(t => ...)` sombreava a tradução)', () => {
    const box = makeEl();
    ctx.__els.favModalList = box;
    run(`renderFavModal()`, `setLang('pt', false);
      localStorage.setItem('ceme:favs', JSON.stringify(['f-mt', 'i-mt', 'f-simples']));`);
    assert.ok(box.innerHTML.length > 50, `modal ficou com ${box.innerHTML.length} chars`);
    semLixo(box.innerHTML, 'modal de favoritos');
    assert.ok(box.innerHTML.includes('myAtlante'), 'o tarifário não apareceu na lista');
  });

  it('os dropdowns do comparador não têm duplicados nem item fora de ordem', () => {
    // ramal MT: mais variantes no dropdown, para o teste dodedup e da ordem
    const html = run(`vCmp()`, `setLang('pt', false); location.hash = '#/comparar'; S.ramal = 'MT';`);
    const opcoes = (id) => {
      const bloco = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
      assert.ok(bloco, `não encontrei o select ${id}`);
      return [...bloco[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map(m => ({ v: m[1], text: m[2] }));
    };
    // com ramal MT: LUZiGÁS colapsa as 2 variantes em 1 indexado, e os
    // fixos ficam myAtlante (AC) + myAtlante (AC) Simples
    for (const [id, esperado] of [['cmpIdx', 1], ['cmpFix', 2]]) {
      const ops = opcoes(id);
      const nomes = ops.map(o => o.text);
      assert.equal(nomes.length, esperado, `${id}: esperava ${esperado} opções, obtive ${nomes.length} — ${nomes.join(' | ')}`);
      assert.equal(new Set(nomes).size, nomes.length, `${id}: duplicados — ${nomes.join(' | ')}`);
      assert.equal(JSON.stringify(nomes), JSON.stringify([...nomes].sort((a, b) => a.localeCompare(b, 'pt'))), `${id}: não está alfabético — ${nomes.join(' | ')}`);
    }
  });

  it('a pesquisa não depende da língua e ignora acentos', () => {
    const out = run(`(() => {
      S.q = 'luzigas'; const comAcento = filtered().length;
      S.q = 'LUZIGÁS'; const semAcento = filtered().length;
      S.q = 'indexed tariff'; const emIngles = filtered().length;
      S.q = 'zzzz'; const nada = filtered().length;
      S.q = '';
      return { comAcento, semAcento, emIngles, nada };
    })()`, `setLang('pt', false);`);
    // o dedup BT/MT colapsa os dois indexados LUZiGÁS num só
    assert.equal(out.comAcento, 1, 'luzigas devia encontrar 1');
    assert.equal(out.semAcento, 1, 'LUZiGÁS devia encontrar o mesmo 1');
    assert.equal(out.emIngles, 1, 'a pesquisa em inglês devia funcionar em PT');
    assert.equal(out.nada, 0);
  });

  // O botão dizia "sem condições" e mantinha exactamente os que têm a flag.
  // Já o tinha feito com o rótulo antigo ("sem bundle") — é a mesma linha.
  it('o filtro de condições vai pela forma certa (não ao contrário)', () => {
    // tem de ser BT: com ramal BT a lista não mostra tarifários MT
    const cond = FIXED({ id: 'f-cond', name: 'Condicionado', voltage: 'BT', bundle: 1, totalEur: 8 });
    const out = run(`(() => {
      LAST.push(${JSON.stringify(cond)});
      S.ramal = 'BT';
      S.nobundle = false; const todos = filtered().map(q => q.id);
      S.nobundle = true;  const semCond = filtered().map(q => q.id);
      S.nobundle = false;
      return { todos, semCond };
    })()`, `setLang('pt', false);`);
    assert.ok(out.todos.includes('f-cond'), 'sem filtro, o tarifário condicionado tem de aparecer');
    assert.ok(!out.semCond.includes('f-cond'), '"sem condições" não pode devolver um tarifário condicionado');
  });

  it('o dedup por ramal mantém a lista e troca a variante', () => {
    const out = run(`(() => {
      S.ramal = 'BT'; const bt = filtered().map(q => q.id);
      S.ramal = 'MT'; const mt = filtered().map(q => q.id);
      S.ramal = 'BT';
      return { bt, mt };
    })()`, `setLang('pt', false);`);
    assert.equal(JSON.stringify(out.bt), JSON.stringify(['f-bt', 'i-bt']), `lista BT: ${out.bt}`);
    assert.equal(JSON.stringify(out.mt), JSON.stringify(['f-mt', 'f-simples', 'i-mt']), `lista MT: ${out.mt}`);
  });
});