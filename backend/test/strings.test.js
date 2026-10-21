// O dicionário das interfaces e das páginas institucionais vive num ficheiro
// só (frontend/strings.js) e é a única fonte de texto. Este teste é o que
// impede o divórcio: PT e EN completos e com os mesmos placeholders, nada
// duplicado entre `common` e uma página, nenhuma chave morta e nenhuma chave
// usada que não exista (o runtime imprime a chave em vez de rebentar, por isso
// é aqui que o erro aparece).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../../frontend/${f}`, import.meta.url), 'utf8');
const STRINGS = read('strings.js');
const PAGES = {
  simulador: read('index.html'),
  assistente: read('assistente.html'),
  about: read('about.html'),
  contact: read('contact.html'),
};
const LANGS = ['pt', 'en'];

// strings.js é um IIFE sobre `window`; avalia-se num contexto mínimo.
const sandbox = { window: {} };
vm.runInNewContext(STRINGS, sandbox, { filename: 'strings.js' });
const I18N = sandbox.window.CEME_I18N;
const NS = ['common', 'simulador', 'assistente', 'about', 'contact'];
const chaves = (ns, lang) => Object.keys(I18N[ns][lang]);
const placeholders = (ns, lang) => new Set(
  Object.values(I18N[ns][lang]).flatMap((v) => String(v).match(/\{\w+\}/g) || []));

describe('dicionário partilhado (strings.js)', () => {
  it('expõe as regiões com nome, IVA e fuso nas duas línguas', () => {
    assert.deepEqual(Object.keys(I18N.regions), ['CONT', 'MAD', 'AZO']);
    for (const [k, r] of Object.entries(I18N.regions)) {
      for (const l of LANGS) {
        assert.ok(r[l].nome && r[l].iva && r[l].fuso, `${k}/${l} incompleto`);
      }
      // o IVA é o mesmo número nos dois idiomas — é o que o cálculo usa
      assert.equal(r.pt.vat, r.en.vat, `${k}: vat diferente entre línguas`);
    }
  });

  for (const ns of NS) {
    it(`${ns}: PT e EN têm as mesmas chaves`, () => {
      const pt = chaves(ns, 'pt');
      assert.ok(pt.length > 0, `${ns} está vazio`);
      assert.deepEqual(pt.filter((k) => !chaves(ns, 'en').includes(k)), [], `${ns}: chaves só em PT`);
      assert.deepEqual(chaves(ns, 'en').filter((k) => !pt.includes(k)), [], `${ns}: chaves só em EN`);
    });

    it(`${ns}: os placeholders são iguais entre PT e EN`, () => {
      const p = (l) => Object.entries(I18N[ns][l])
        .filter(([, v]) => /\{\w+\}/.test(String(v)))
        .map(([k, v]) => `${k}:${[...new Set(String(v).match(/\{\w+\}/g))].sort().join(',')}`)
        .sort();
      assert.deepEqual(p('pt'), p('en'), `${ns}: placeholders diferentes`);
      assert.ok(placeholders(ns, 'pt').size >= 0);
    });
  }

  // A chave duplicada entre `common` e a página é um bug silencioso: a página
  // sobreporia o comum e a mesma palavra passaria a ter dois textos. Entre as
  // duas páginas pode repetir o nome desde que o texto não seja o mesmo —
  // nesse caso é coincidência de nome (o `now` do chip e o `nowPrefix` da
  // pílula), não conceito partilhado.
  it('nenhuma chave de common é redefinida por uma página', () => {
    for (const l of LANGS) {
      const dup = chaves('common', l).filter((k) => NS.slice(1).some((ns) => chaves(ns, l).includes(k)));
      assert.deepEqual(dup, [], `${l}: chaves em common e numa página: ${dup}`);
    }
  });

  // A regra "se as duas páginas dizem o mesmo, vive em common" só se mantém se
  // houver um teste a apanhar os duplicados — texto igual em duas chaves de
  // sítios diferentes é exactamente o divórcio que se quer evitar.
  it('não há texto repetido entre sítios diferentes', () => {
    const iguais = [];
    for (const l of LANGS) {
      const vistos = new Map();
      for (const ns of NS) {
        for (const [k, v] of Object.entries(I18N[ns][l])) {
          const t = String(v);
          if (t.length < 4) continue; // "sim"/"não"/"kWh" repetem-se à vontade
          const onde = `${ns}.${k}`;
          if (vistos.has(t)) {
            for (const outro of vistos.get(t)) {
              // dentro do mesmo namespace há sinónimos históricos (kFixed/lFixed)
              if (outro.split('.')[0] !== ns) iguais.push(`${l}: ${outro} == ${onde} ("${t}")`);
            }
            vistos.get(t).push(onde);
          } else vistos.set(t, [onde]);
        }
      }
    }
    assert.deepEqual(iguais, [], `texto repetido:\n  ${iguais.join('\n  ')}`);
  });

  for (const [ns, html] of Object.entries(PAGES)) {
    it(`${ns}: carrega o dicionário partilhado e pede o seu namespace`, () => {
      assert.match(html, /<script src="\/strings\.js"><\/script>/, 'falta o <script src="/strings.js">');
      assert.match(html, new RegExp(`CEME_STR\\('${ns}'\\)`), `não pede CEME_STR('${ns}')`);
      assert.ok(!/const STR = \{\n/.test(html), 'voltou a ter um dicionário inline');
    });

    it(`${ns}: todas as chaves usadas existem`, () => {
      const usadas = new Set([...html.matchAll(/\bi18n\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
      for (const m of html.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) usadas.add(m[1]);
      const existem = new Set([...chaves('common', 'pt'), ...chaves(ns, 'pt')]);
      assert.ok(usadas.size > 0, 'nenhuma chamada de tradução encontrada');
      const falta = [...usadas].filter((k) => !existem.has(k)).sort();
      assert.deepEqual(falta, [], `${ns}: chaves usadas que não existem: ${falta}`);
    });
  }

  it('nenhuma chave é declarada sem uso em nenhuma página', () => {
    const tudo = Object.values(PAGES).join('\n');
    const mortas = [];
    for (const ns of NS) {
      for (const k of chaves(ns, 'pt')) {
        // chaves dinâmicas: montadas a partir de códigos da API/servidor
        if (k.startsWith('note')) continue;
        if (k === 'warnOmieCont') continue;
        const citada = new RegExp(`['"]${k}['"]`).test(tudo);
        if (!citada) mortas.push(`${ns}.${k}`);
      }
    }
    assert.deepEqual(mortas.sort(), [], `chaves mortas: ${mortas.join(', ')}`);
  });

  it('CEME_STR junta common + página (e não perde nada)', () => {
    for (const l of LANGS) {
      const plano = sandbox.window.CEME_STR('assistente')[l];
      assert.equal(plano.fPopular, I18N.common[l].fPopular);
      assert.equal(plano.h1, I18N.assistente[l].h1);
      assert.equal(Object.keys(plano).length, chaves('common', l).length + chaves('assistente', l).length);
    }
    // namespace desconhecido não rebenta: devolve só o comum
    assert.deepEqual(Object.keys(sandbox.window.CEME_STR('nao-existe').pt).sort(), chaves('common', 'pt').sort());
  });
});
