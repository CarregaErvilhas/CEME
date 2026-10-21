import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avaliarEscala, cruzar, contraste, hex2rgb } from './cores.mjs';

const HTML = readFileSync(new URL('../../frontend/omie.html', import.meta.url), 'utf8');

function lum(h) {
  const [r, g, b] = hex2rgb(h).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Extrai as paragens (stops) de uma paleta do bloco PALETAS do JS.
function stopsJs(modo, chave) {
  const m = HTML.match(new RegExp(modo + ':\\s*\\{[\\s\\S]*?' + chave + ':\\s*\\[([^\\]]+)\\]'));
  assert.ok(m, `não encontrei PALETAS.${modo}.${chave} em omie.html`);
  return m[1].match(/#[0-9A-Fa-f]{6}/g);
}

// Extrai uma variável CSS do bloco html[data-paleta="daltonismo"].
function cssVar(nome) {
  const bloco = HTML.match(/html\[data-paleta="daltonismo"\]\s*\{([\s\S]*?)\}/);
  assert.ok(bloco, 'bloco daltonismo em falta no CSS');
  const m = bloco[1].match(new RegExp(nome + ':\\s*(#[0-9A-Fa-f]{6})'));
  assert.ok(m, `variável ${nome} em falta`);
  return m[1].toUpperCase();
}

describe('paletas OMIE', () => {
  it('folha: reproduz a folha original (não mudou)', () => {
    assert.deepEqual(stopsJs('folha', 'rampa'), ['#57BB8A', '#FFD666', '#E67C73']);
    assert.deepEqual(stopsJs('folha', 'div'), ['#CFE2F3', '#FFFFFF', '#E6B8AF']);
  });

  it('daltonismo: escala do preço distingue-se sob os três daltonismos', () => {
    const a = avaliarEscala(stopsJs('daltonismo', 'rampa'));
    assert.ok(a.extremos.deuteranopia >= 25, `deuteranopia ${a.extremos.deuteranopia}`);
    assert.ok(a.extremos.protanopia >= 25, `protanopia ${a.extremos.protanopia}`);
    assert.ok(a.extremos.tritanopia >= 25, `tritanopia ${a.extremos.tritanopia}`);
    assert.ok(a.pivo.deuteranopia >= 12, `pivô ${a.pivo.deuteranopia}`);
  });

  it('daltonismo: escala do desvio distingue-se sob os três daltonismos', () => {
    const b = avaliarEscala(stopsJs('daltonismo', 'div'));
    assert.ok(b.extremos.deuteranopia >= 25, `deuteranopia ${b.extremos.deuteranopia}`);
    assert.ok(b.extremos.protanopia >= 25, `protanopia ${b.extremos.protanopia}`);
    assert.ok(b.extremos.tritanopia >= 25, `tritanopia ${b.extremos.tritanopia}`);
    assert.ok(b.pivo.deuteranopia >= 12, `pivô ${b.pivo.deuteranopia}`);
  });

  it('daltonismo: as duas escalas não se confundem', () => {
    const a = avaliarEscala(stopsJs('daltonismo', 'rampa'));
    const b = avaliarEscala(stopsJs('daltonismo', 'div'));
    const c = cruzar(a, b);
    assert.ok(c.pior >= 15, `cruzamento ${c.pior} (${c.par.join('/')})`);
  });

  it('daltonismo: o número lê-se por cima de cada fundo (#1A1A1A)', () => {
    const a = avaliarEscala(stopsJs('daltonismo', 'rampa'));
    const b = avaliarEscala(stopsJs('daltonismo', 'div'));
    for (const e of [a, b]) {
      const pior = Math.min(...e.cores.map((c) => contraste(c, '#1A1A1A')));
      assert.ok(pior >= 4.5, `contraste ${pior}`);
    }
  });

  it('daltonismo: CSS e JS concordam (mesmas paragens)', () => {
    assert.deepEqual(stopsJs('daltonismo', 'rampa'), [cssVar('--ramp-lo'), cssVar('--ramp-mid'), cssVar('--ramp-hi')]);
    assert.deepEqual(stopsJs('daltonismo', 'div'), [cssVar('--div-lo'), cssVar('--div-mid'), cssVar('--div-hi')]);
  });

  it('daltonismo: os cartões são distinguíveis sob os três daltonismos', () => {
    const cores = [cssVar('--card-now'), cssVar('--card-today'), cssVar('--card-rest')];
    const e = avaliarEscala(cores);
    assert.ok(e.extremos.deuteranopia >= 25, `deuteranopia ${e.extremos.deuteranopia}`);
    assert.ok(e.extremos.protanopia >= 25, `protanopia ${e.extremos.protanopia}`);
    assert.ok(e.extremos.tritanopia >= 25, `tritanopia ${e.extremos.tritanopia}`);
  });

  it('daltonismo: tinta #1A1A1A legível nos cartões', () => {
    for (const c of [cssVar('--card-now'), cssVar('--card-today'), cssVar('--card-rest')]) {
      assert.ok(contraste(c, '#1A1A1A') >= 4.5, `${c} = ${contraste(c, '#1A1A1A')}`);
    }
  });
});
