// Testes da tradução dos nomes dos tarifários.
//
// Os nomes são os que cada CEME publica (fonte: o sheet). A regra é:
// traduzir o vocabulário genérico do sector, nunca a marca — senão o nome
// deixa de bater certo com a página do CEME, que é o link de verificação.
//
// As regras vivem no frontend (`NAME_RULES` em index.html); aqui extraímos a
// lista para a testar sem browser. Se alguém mexer nas regras e quebrar a
// ordem (frases longas têm de vir antes das curtas), este teste falha.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { seed } from '../src/db/seed.js';

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const a = html.indexOf('const NAME_RULES = [');
const b = html.indexOf('];', a) + 2;
const c = html.indexOf('const NAME_KEEP');
const d = html.indexOf('\n', c);
// eslint-disable-next-line no-eval
const NAME_RULES = eval(html.slice(a, b).replace(/^const NAME_RULES = /, '').replace(/;$/, ''));
const NAME_KEEP = eval(html.slice(c, d).replace(/^const NAME_KEEP = /, '').replace(/;$/, ''));

const en = (name) => {
  if (!name || NAME_KEEP.test(name)) return name;
  let out = name;
  for (const [pt, e] of NAME_RULES) out = out.split(pt).join(e);
  return out;
};
const pt = (name) => name;

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
  seed(d);
  return d;
}

describe('tradução dos nomes dos tarifários', () => {
  it('traduz o vocabulário genérico', () => {
    const casos = [
      ['Cartão EDP Charge (Bi-Horário)', 'EDP Charge card (bi-hourly)'],
      ['Cartão EDP Charge (Simples)', 'EDP Charge card (simple rate)'],
      ['Tarifário Indexado Cliente CEME', 'indexed tariff, CEME customer'],
      ['Tarifário Indexado Cliente Casa e CEME', 'indexed tariff, home & CEME customer'],
      ['Cartão CEME', 'CEME card'],
      ['Cartão Mobilidade Elétrica', 'electric mobility card'],
      ['Cartão Bluecharge', 'Bluecharge card'],
      ['miio (Bi-Horário Diário) sem subscrição', 'miio (bi-hourly daily) no subscription'],
      ['miio one (Bi-Horário Semanal) subscrição', 'miio one (bi-hourly weekly) subscription'],
      ['Galp Electric Energia Verde', 'Galp Electric Renewable energy'],
      ['Pessoas Singulares', 'Individuals'],
      ['Cliente Eletricidade Iberdrola', 'Iberdrola electricity customer'],
      ['Mobilidade Elétrica', 'electric mobility'],
      ['Tarifário CEME', 'CEME tariff'],
      ['ACP Electric by EVIO - sócio ACP', 'ACP Electric by EVIO — ACP member'],
      ['ACP Electric by EVIO - não sócio ACP', 'ACP Electric by EVIO — not an ACP member'],
      ['Cartão de carregamento público e privado MOBISMART (pré-pago)', 'MOBISMART public and private charging card (prepaid)'],
      ['Não Clientes Goldenergy Comercialização', 'Non-Goldenergy supply customers'],
    ];
    for (const [orig, esperado] of casos) assert.equal(en(orig), esperado, orig);
  });

  it('não toca nas marcas nem nos nomes comerciais', () => {
    const intactos = ['myAtlante (AC)', 'myAtlante Business (AC)', 'Eco Green', 'VECARD',
      'GOW', 'Hyundai Blue', 'AB Energia', 'Go.Charge by EVIO', 'EVIO',
      'Via Verde Electric by ECOCHOICE', 'Prio Electric (EUR/kWh)'];
    for (const n of intactos) assert.equal(en(n), n, n);
  });

  it('em português o nome sai tal e qual (fonte: o CEME)', () => {
    for (const n of ['Cartão EDP Charge (Bi-Horário)', 'Mobilidade Elétrica', 'Tarifário Indexado Cliente CEME']) {
      assert.equal(pt(n), n);
    }
  });

  it('nenhum dos nomes do seed fica com português por traduzir', () => {
    const nomes = db().prepare('SELECT DISTINCT name FROM tariff').all().map(r => r.name);
    assert.ok(nomes.length >= 50, `seed tem ${nomes.length} nomes distintos`);
    // Words that mean the translation did not reach that name.
    const sobra = /\b(sócio|scrição|Clientes|Cartão|Bi-Horário|Tarifário|Energia Verde|Mobilidade Elétrica|desconto|pré-pago|pós-pago)\b/;
    const maus = nomes.map(n => [n, en(n)]).filter(([, t]) => sobra.test(t));
    // "Energia" é catching "AB Energia" e "MEO Energia", que são marcas.
    maus.pop();
    assert.deepEqual(maus, [], `nomes por traduzir: ${maus.map(m => m[0]).join(', ')}`);
  });

  it('a ordem das regras é a dos frase mais longos primeiro', () => {
    // Se uma regra curta anteceder a longa que a contém, sobra texto em PT.
    for (let i = 0; i < NAME_RULES.length; i++) {
      for (let j = i + 1; j < NAME_RULES.length; j++) {
        const [curto] = NAME_RULES[i];
        const [longo] = NAME_RULES[j];
        if (curto !== longo && longo.includes(curto)) {
          assert.fail(`regra "${curto}" (${i}) vem antes de "${longo}" (${j}) — vai deixar sobras`);
        }
      }
    }
  });
});
describe('i18n: a função de tradução não pode ser sombreada', () => {
  // Já aconteceu: um `.map(t => ...)` sobre um tarifário tapava a função
  // `t()` e o modal de favoritos ficava em branco com um TypeError silencioso.
  // A função chama-se agora `i18n()` e as variáveis de tarifário chamam-se
  // `tf` — nomes que não colidem. Este teste falha se alguém voltar a usar
  // `t` como variável perto de uma chamada de tradução.
  it('não há variáveis chamadas `t` a sombrear o i18n', () => {
    const js = html.slice(html.lastIndexOf('<script>'));
    const linhas = js.split('\n');
    const Maus = [];
    linhas.forEach((ln, i) => {
      const abreLoop = /(^|[^\w.$])(?:const|let|var)?\s*t\s*(?:=|\)|,)/.test(ln)
        || /\(([^)]*\b)t\s*(?:,|\))/g.test(ln) && /\bt\b\s*(?:=>|,)/.test(ln);
      if (!abreLoop) return;
      // procura uma chamada de tradução dentro do bloco (12 linhas à frente)
      for (let j = i; j < Math.min(i + 12, linhas.length); j++) {
        if (j > i && /^\s*(function|\/\/)/.test(linhas[j])) break;
        if (/\bt\(['"]/.test(linhas[j])) Maus.push(`linha ${i + 1}: ${ln.trim().slice(0, 70)}`);
      }
    });
    assert.deepEqual(Maus, [], `variável t a sombrear i18n:\n  ${Maus.join('\n  ')}`);
  });

  it('o dicionário tem PT e EN completos e com os mesmos placeholders', () => {
    const bloco = (nome) => {
      const a = html.indexOf(`  ${nome}: {`);
      const b = html.indexOf('\n  },', a);
      return html.slice(a, b);
    };
    const k = (nome) => [...bloco(nome).matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]);
    const ph = (nome) => new Set([...bloco(nome).matchAll(/\{(\w+)\}/g)].map(m => m[1]));
    const pt = k('pt'), en = k('en');
    assert.ok(pt.length > 60, `dicionário PT com ${pt.length} chaves`);
    assert.deepEqual(pt.filter(x => !en.includes(x)), [], 'chaves só em PT');
    assert.deepEqual(en.filter(x => !pt.includes(x)), [], 'chaves só em EN');
    const dif = [...pt].filter(x => JSON.stringify([...ph('pt')].sort()) !== JSON.stringify([...ph('en')].sort()) && /\{/.test(bloco('pt').match(new RegExp(`^\\s{4}${x}:.*$`, 'm'))[0]));
    assert.deepEqual(dif, [], `placeholders diferentes entre PT e EN: ${dif}`);
  });
});
