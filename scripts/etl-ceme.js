#!/usr/bin/env node
// Extrai, da folha de cálculo "Comparador Mobie CEME" (Google Sheets), a
// separação energia + TAR dos preços, para o SPLITS do seed.
//
// A folha tem, para cada tarifário, três grupos de colunas de preço:
//   K/L/M  "Valores ERSE"          Ponta / Cheias / Vazio
//   N/O/P  "Valores outras fontes"  Ponta / Cheias / Vazio
//   Q/R/S  o display: "outras fontes" se houver, senão ERSE
//
// Quando a célula de "outras fontes" é uma fórmula `=0,1+TAR!$B$5`, o CEME
// publica a ENERGIA à parte e a folha compõe o total. É essa separação que
// o site mostra no detalhe da conta.
//
// Uso (depois de `sh scripts/etl-sheets.sh`, que deixa os dumps em
// backend/seed/):
//   node scripts/etl-ceme.js > splits.json
//   node scripts/etl-ceme.js <valores.tsv> <formulas.tsv> <tar.tsv>   # outros ficheiros
//
// A saída é um objecto com chave `ceme|nome|tensão` e, por período, a
// energia, a TAR, o preço final e a referência da célula da TAR. Passar
// isto para o `SPLITS` do seed (chave = id do tarifário) é à mão: há nomes
// repetidos entre tensões e ciclos, e o casamento confere-se a olho.
const fs = require('node:fs');

const readTsv = (p) => fs.readFileSync(p, 'utf8').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
const SEED = require('node:path').join(__dirname, '..', 'backend', 'seed');
const arg = (i, file) => process.argv[i] || require('node:path').join(SEED, file);
const values = readTsv(arg(2, 'ceme-valores.tsv'));
const formulas = readTsv(arg(3, 'ceme-formulas.tsv'));
const tarValues = readTsv(arg(4, 'tar.tsv'));

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(/€/g, '').replace(/\s/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// A aba TAR: as células com valor. "B5" -> 0,1192
const tarCells = {};
{
  const cols = 'ABCDEFG'.split('');
  tarValues.forEach((row, r) => row.forEach((v, c) => {
    if (c >= cols.length) return;
    const n = num(v);
    if (n != null) tarCells[`${cols[c]}${r + 1}`] = n;
  }));
}

// "=0,1+TAR!$B$5" -> { energy: 0.1, ref: 'B5', tar: 0.1192 }
const ERSE = /^=\s*([\d.,]+)\s*\+\s*TAR!\s*\$?([A-Z])\$?(\d+)\s*$/i;
function parseErse(cell) {
  if (!cell) return null;
  const m = ERSE.exec(String(cell).trim());
  if (!m) return null;
  const energy = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(energy)) return null;
  const ref = `${m[2]}${m[3]}`;
  return { energy, ref, tar: tarCells[ref] ?? null };
}

const PERIODS = [
  { key: 'PONTA', other: 13, erse: 10, disp: 16 },
  { key: 'CHEIAS', other: 14, erse: 11, disp: 17 },
  { key: 'VAZIO', other: 15, erse: 12, disp: 18 },
];
// A folha tem "BT/MT" numa linha (o mesmo preço nos dois níveis).
const PARA_SEED = { PONTA: 'FORA_VAZIO', VAZIO: 'VAZIO' };

const out = {};
for (let i = 0; i < values.length; i++) {
  const v = values[i] || [];
  const f = formulas[i] || [];
  const ceme = (v[2] || '').trim();
  const name = (v[3] || '').trim();
  const volt = (v[4] || '').trim();
  if (!ceme || !name) continue;          // linhas de grupo/continuação
  for (const vo of (volt === 'BT/MT' ? ['BT', 'MT'] : [volt])) {
    if (!vo) continue;
    const prices = {};
    for (const p of PERIODS) {
      const per = PARA_SEED[p.key];
      if (!per) continue;
      const other = num(v[p.other]);
      const erseVal = num(v[p.erse]);
      const display = num(v[p.disp]);
      const final = other != null ? other : (erseVal != null ? erseVal : display);
      if (final == null) continue;
      const er = parseErse(f[p.other]) || parseErse(f[p.erse]);
      prices[per] = {
        final: Math.round(final * 1e6) / 1e6,
        energy: er ? er.energy : null,
        tar: er ? er.tar : null,
        tarRef: er ? `TAR!${er.ref}` : null,
      };
    }
    if (Object.keys(prices).length) out[`${ceme}|${name}|${vo}`] = prices;
  }
}

console.log(JSON.stringify(out, null, 1));
