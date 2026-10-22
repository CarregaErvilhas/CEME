#!/usr/bin/env node
// ETL da folha "CEME" -> a decomposição energia + TAR que o seed guarda.
//
// A folha tem, para cada tarifário, três grupos de colunas de preço:
//   K/L/M  "Valores ERSE"          Ponta / Cheias / Vazio
//   N/O/P  "Valores outras fontes"  Ponta / Cheias / Vazio
//   Q/R/S  o display: "outras fontes" se houver, senão ERSE
//
// Quando a célula de "outras fontes" é uma fórmula `=0,1+TAR!$B$5`, o CEME
// publicava a ENERGIA à parte e a folha compunha o total. Essa é a
// decomposição que o site mostra — e que o seed tinha perdido (guardava só o
// valor final).
//
// Uso (precisa do gog autenticado e dos dumps da folha):
//   gog sheets get "$ID" "'CEME'!A4:S101" --plain                 > ceme-v.tsv
//   gog sheets get "$ID" "'CEME'!A4:S101" --render=FORMULA --plain > ceme-f.tsv
//   gog sheets get "$ID" "'TAR'!A1:G13"   --plain                 > tar-plain.tsv
//   node scripts/etl-ceme.js ceme-v.tsv ceme-f.tsv tar-plain.tsv > splits.json
//
// A saída é o objecto `SPLITS` do seed (a chave é o id do tarifário; o
// casamento é por CEME + nome + tensão + preço, porque há nomes repetidos).
const fs = require('node:fs');

const readTsv = (p) => fs.readFileSync(p, 'utf8').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
const values = readTsv(process.argv[2]);
const formulas = readTsv(process.argv[3]);
const tarValues = readTsv(process.argv[4]);

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
