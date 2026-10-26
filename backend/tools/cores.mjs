// A régua com que se medem as cores das tabelas.
//
// Não é código da app: é o instrumento. O teste backend/test/omie-cores.test.js
// usa-o para vigiar que as paletas que vão para a página continuam a cumprir.
//
// A simulação usa as matrizes de Machado, Oliveira & Fernandes (2009) na
// severidade 1.0, aplicadas em RGB linear; a distância entre cores é o ΔE76
// em CIE Lab (a métrica que o pessoal de cor usa para dizer "isto é isto
// outro"). As matrizes são as publicadas em "A Physiologically-based Model for
// Simulation of Color Vision Deficiency", IEEE TVCG 15(6).
//
//   node backend/tools/cores.mjs
//

// --- conversão de cor ---------------------------------------------------
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const rgb2hex = (rgb) =>
  '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

// --- matrizes de Machado 2009 (severidade 1.0) ---------------------------
const MAT = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

export const DALTONISMOS = Object.keys(MAT);

/** Simula como a cor é vista por quem tem o defeito indicado. */
export function simular(hex, tipo) {
  const lin = hex2rgb(hex).map(srgb2lin);
  const m = MAT[tipo];
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return rgb2hex(out.map(lin2srgb));
}

/** Simula a visão acromatopsia (monocromia) — o pior caso de todos. */
export function acromatopsia(hex) {
  const lin = hex2rgb(hex).map(srgb2lin);
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return rgb2hex([y, y, y].map(lin2srgb));
}

/** A transformação a aplicar, conforme o tipo de visão. */
export const visao = (tipo) => (tipo === 'acromatopsia' ? acromatopsia : (c) => simular(c, tipo));

// --- CIE Lab (D65) ------------------------------------------------------
export function hex2lab(hex) {
  const [r, g, b] = hex2rgb(hex).map(srgb2lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** ΔE76: distância perceptual entre duas cores. */
export function deltaE(a, b) {
  const A = hex2lab(a), B = hex2lab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// --- contraste WCAG 2.x --------------------------------------------------
export const luminancia = (hex) => {
  const [r, g, b] = hex2rgb(hex).map(srgb2lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contraste = (a, b) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** A tinta que o número da célula usa: a que dá mais contraste com o fundo. */
export const tintaPara = (bg) =>
  contraste(bg, '#FFFFFF') >= contraste(bg, '#1A1A1A') ? '#FFFFFF' : '#1A1A1A';

// --- a mistura de cores que a página faz (interpolação simples em sRGB) ---
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const mix = (a, b, t) => {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
};

/** Amostra a rampa min -> pivô -> max, tal como a página a desenha. */
export function amostrar(stops, n = 33) {
  const cores = [];
  for (let i = 0; i < n; i++) cores.push(mix(stops[0], stops[1], i / (n - 1)));
  for (let i = 1; i < n; i++) cores.push(mix(stops[1], stops[2], i / (n - 1)));
  return cores;
}

/** Distância mínima entre um conjunto de cores, sob um tipo de visão. */
export function sep(cores, tipo) {
  const v = visao(tipo);
  let pior = Infinity;
  for (let i = 0; i < cores.length; i++) {
    for (let j = i + 1; j < cores.length; j++) {
      const d = deltaE(v(cores[i]), v(cores[j]));
      if (d < pior) pior = d;
    }
  }
  return pior;
}

/**
 * Avalia uma escala de três paragens (mín, pivô, máx).
 *
 * O que interessa medir, porque é o que se tenta ler:
 *  - "extremos": as duas pontas da escala têm de se distinguir (é o que
 *    diz "isto está acima do pivô" e "isto está abaixo");
 *  - "pivo": o tom do meio tem de se distinguir das pontas (é o que diz
 *    "está no meio");
 *  - "contraste": o número da célula tem de se ler por cima do fundo,
 *    incluindo os tons interpolados, que são a maioria das células.
 */
export function avaliarEscala(stops) {
  const cores = amostrar(stops);
  const extremos = [stops[0], stops[2]];
  const vizinhos = [[stops[0], stops[1]], [stops[1], stops[2]]];
  const p = (pares, tipo) => Math.min(...pares.map(([a, b]) => sep([a, b], tipo)));
  return {
    stops,
    // a rampa amostrada (é o que aparece nas células)
    cores,
    extremos: {
      deuteranopia: sep(extremos, 'deuteranopia'),
      protanopia: sep(extremos, 'protanopia'),
      tritanopia: sep(extremos, 'tritanopia'),
      acromatopsia: sep(extremos, 'acromatopsia'),
    },
    pivo: {
      deuteranopia: p(vizinhos, 'deuteranopia'),
      protanopia: p(vizinhos, 'protanopia'),
      tritanopia: p(vizinhos, 'tritanopia'),
    },
    contraste: Math.min(...cores.map((c) => Math.max(contraste(c, '#1A1A1A'), contraste(c, '#FFFFFF')))),
  };
}

/**
 * Distância mínima entre as cores de duas escalas diferentes.
 *
 * Os dois meios (pivôs) não contam: os dois representam "o meio" e é
 * aceitável que se pareçam (amarelo e branco).
 */
export function cruzar(a, b) {
  let pior = Infinity, par = null;
  for (let i = 0; i < a.stops.length; i++) {
    for (let j = 0; j < b.stops.length; j++) {
      if (i === 1 && j === 1) continue; // os dois meios
      for (const t of DALTONISMOS) {
        const d = deltaE(simular(a.stops[i], t), simular(b.stops[j], t));
        if (d < pior) { pior = d; par = [a.stops[i], b.stops[j], t]; }
      }
    }
  }
  return { pior, par };
}

// =========================================================================
// CLI
// =========================================================================
if (process.argv[1] && process.argv[1].endsWith('cores.mjs')) {
  const fmt = (e) =>
    `extremos d/p/t=${e.extremos.deuteranopia.toFixed(0)}/${e.extremos.protanopia.toFixed(0)}/${e.extremos.tritanopia.toFixed(0)}` +
    ` cinza=${e.extremos.acromatopsia.toFixed(0)}` +
    ` pivô=${e.pivo.deuteranopia.toFixed(0)}` +
    ` AA=${e.contraste.toFixed(2)}`;
  const folha = {
    preco: ['#57BB8A', '#FFD666', '#E67C73'],
    desvio: ['#CFE2F3', '#FFFFFF', '#E6B8AF'],
  };
  const p = avaliarEscala(folha.preco);
  const d = avaliarEscala(folha.desvio);
  console.log('=== a paleta da folha (referência) ===');
  console.log('preço :', fmt(p));
  console.log('desvio:', fmt(d));
  console.log('cruzamento:', cruzar(p, d).pior.toFixed(1));
  console.log('\nΔE < 10 = indistinguível; 10-25 = difícil; > 25 = distinguível.');
}
