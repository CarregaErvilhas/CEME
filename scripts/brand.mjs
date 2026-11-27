// Põe em frontend/ o que vem do kit da marca do grupo (submódulo brand/): as
// mascotes, a fonte (com a licença ao lado) e os dados da página /grupo
// (frontend/grupo.js, tirado do group.json). Nada disto se versiona aqui: corre
// no build do Zerops (zerops.yml), no CI e antes do `npm test`, do `npm start`
// e do `npm run dev`.
//
// Sem o submódulo sai com erro, de propósito: um build que falha deixa a versão
// anterior a servir.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const kit = `${root}brand`;
const out = `${root}frontend`;

if (!existsSync(`${kit}/group.json`)) {
  console.error('brand/ está vazio. Corre: git submodule update --init');
  process.exit(1);
}

// As pastas saem de novo do zero, para uma mascote que deixe o kit sair daqui.
for (const dir of ['grupo', 'fonts']) {
  rmSync(`${out}/${dir}`, { recursive: true, force: true });
  mkdirSync(`${out}/${dir}`);
}
const svgs = readdirSync(`${kit}/grupo`).filter(f => f.endsWith('.svg'));
for (const f of svgs) cpSync(`${kit}/grupo/${f}`, `${out}/grupo/${f}`);
for (const f of ['nunito-latin.woff2', 'OFL-Nunito.txt']) cpSync(`${kit}/fonts/${f}`, `${out}/fonts/${f}`);

// Um script clássico, e não um fetch: o prerender do servidor (prerender.js) só
// corre scripts, sem rede.
const data = JSON.parse(readFileSync(`${kit}/group.json`, 'utf8'));
if (data.schema !== 1) {
  console.error(`brand/group.json: schema ${data.schema}, esta página só conhece o 1`);
  process.exit(1);
}
writeFileSync(`${out}/grupo.js`, `// Gerado por scripts/brand.mjs a partir de brand/group.json. Não editar.\nwindow.CEME_GRUPO = ${JSON.stringify(data, null, 2)};\n`);
console.log(`brand: ${svgs.length} mascotes, a fonte e grupo.js em frontend/`);
