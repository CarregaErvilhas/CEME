# Verificar as tarifas publicadas pelos CEME contra o seed

Guia para um agente (ou para ti) confirmar que os preços do seed batem com o
que cada CEME publica. Usado pelo comando `/ceme-check`
(`.opencode/commands/ceme-check.md`). Caminhos relativos à raiz do repo.

Ficheiros-chave:
- `backend/src/db/seed.js` — CEMES, SPLITS (energia+TAR), TARIFFS (finais c/ TAR, act), @@@ act.
- `backend/src/db/seed.postgres.js` — duplicado de TARIFFS; **SPLITS é importado do seed.js** (`import { SPLITS } from './seed.js'`) — só editar TARIFFS aqui.
- `backend/data/ceme.db` — SQLite: `ceme(id, website)`, `tariff(id, ceme_id, kind, voltage, source_url)`, `tariff_version(id, tariff_id→tariff.id, k_index_eur_mwh, cgs_eur_mwh)`, `price_component(tariff_version_id, period, energy_eur_kwh=final c/ TAR, activation_eur, energy_only_eur_kwh, tar_eur_kwh)`.
- Quando foi a última verificação e o que mudou: `git log -p backend/src/db/seed.js`.

## Comando
Existe o comando `/ceme-check` (`.opencode/commands/ceme-check.md`) que carrega esta memória. Argumentos opcionais: `/ceme-check galp` (só um CEME) ou `/ceme-check update` (aplicar updates autorizadas).

## Regras do seed
- `energy_eur_kwh` = preço **final** (energia + TAR, s/ IVA). `energy_only`/`tar` só quando o CEME/sheet separava; "não se inventa" decomposição.
- `act` = taxa por carregamento **publicada pelo CEME**. Pode estar acima do valor legal (`EGME_LEGAL` em `server.js`); não se "corrige" por razões regulatórias. Só muda se a página do CEME passar a publicar outro valor.
- Quando a página diverge do seed E o utilizador autoriza, actualiza-se o seed (os dois ficheiros) e a BD. A fonte e a data ficam na mensagem do commit.

## Valores de referência
- TAR da mobilidade: `TAR_2026` em `backend/src/server.js`.
- Taxa de activação legal: `EGME_LEGAL` em `backend/src/server.js`.
- IVA por região: `REGIONS` em `backend/src/engine/regions.js`.

## Dump de expectativas da DB (primeiro passo)
```sh
sqlite3 backend/data/ceme.db "
SELECT t.ceme_id, t.id, t.voltage, p.period, round(p.energy_eur_kwh,4) AS final,
       p.activation_eur AS act, p.energy_only_eur_kwh AS eo, p.tar_eur_kwh AS tar
FROM tariff t
LEFT JOIN tariff_version tv ON tv.tariff_id = t.id
LEFT JOIN price_component p ON p.tariff_version_id = tv.id
ORDER BY t.ceme_id, t.id, p.period COLLATE NOCASE;"
```
(Corre a partir da raiz do repo, ou usa o caminho absoluto da BD.)

## Como ler os preços de cada CEME
curl estático (valores no HTML): enable (página /condutores: publica só a ENERGIA, um valor no Continente e outro nas ilhas, e diz que exclui TAR, EGME, IEC e IVA; o final é energia + TAR, com REGION_SPLITS no seed), evaz (tabela PricesTable no HTML), goldenergy (em goldenergy.pt/**mobilidade-eletrica/**, não no blog), luzigas (K e CGS), meo (preços por escalão; o tarifário "Colaboradores" não aparece no site), repsol, viaverde (publica a energia), bluecharge (página inicial).

Imagens PNG de tarifário (download + read da imagem): charge2go (`/tarifarios/` → imagem desktop `TARIFARIOS-*.png`, energia sem TAR; ⚠️ há uma `mobile_image` desactualizada ao lado, ignora-a), evpower (`/particulares/` → imagem `tarifario_*.png`), acp (a página só mostra uma nota sobre a TAR; os valores vêm de um screenshot pedido ao utilizador).

PDFs (pypdf, em subagent se conveniente): galp (`galp-electric-tabela-precos-descontos-MMYY.pdf`, ligado de cartao-galpelectric-info), prio (prio.pt/downloads/file422_pt.pdf), factorenergia (`Tabela-precos-vecard-jan-2026-novo-logo.pdf`, ligado em factorenergia.pt/servicos/cartao-mobilidade-eletrica/), mobismart (`mobismart.pt/precos/EVCE-Tabela-precos-CEME-energia_PT.pdf`).

JS/React (browser `tools.browser.evaluate` + `document.body.innerText`): edp (`edp.pt/particulares/.../carregar-fora-de-casa/`), miio (`/pt/prices/charging`; o miio one tem desconto), atlante (`atlante.energy/pt-pt/tarifas-de-energia/`; Business separada em `/pt-pt/myatlante-business/`), evio (`ceme.go-evio.com/pt/site-ceme`).

Sem valores a comparar (app-only/documentos): iberdrola (app), moeve (app GOW), hgp (site sem tarifário), ynerluz (só fórmulas indexadas; preços de referência são de eletricidade doméstica).

## Gotchas de extracção
- JS/React: `browser.screenshot` precisa de tab visível (falha se janela escondida); `browser.find` pode vir vazio; **usar `browser.evaluate` com `document.body.innerText`** (com `try/catch`).
- Tabs obtidas via `tabs.open` podem ganhar IDs novos ao reconectar (usar `tabs.list` para reconciliar).
- `miio.com` dá `ERR_TUNNEL_CONNECTION_FAILED` no browser; curl passa.
- HTML cru: valores podem estar em `<script>` JSON (não limpar scripts antes de grep); ruído frequente: coords geo (0.187/0.2928...) e gradientes CSS rgb (0,240/0,209...).
- Sítios WP põem data/versão no nome do ficheiro (`TARIFARIOS-01-04-2024_V2.png`) — não confiar na data; confiar no texto publicado ("em vigor a partir de…").
- PDFs: extrair com pypdf (pip install --user pypdf). Galp/Mobismart confirmam validade no 1.º parágrafo.
- Procurar sempre o valor **no formato publicado** (vírgula PT e ponto EM JSON podem coexistir no mesmo site: "0,169" e "0.2635"!!).

## Fluxo de update autorizada (seed+DB+testes)
1. `cp backend/data/ceme.db backend/data/ceme.db.bak-YYYYMMDD`.
2. `seed.js`: SPLITS (energia) e TARIFFS (finais + act) — edit tool, replaceAll onde os substrings são únicos (ex.: `0.269}, 0.1088` é bluecharge; `0.2889}, 0.1572` charge2go). Cuidado com colisões: galp e bluecharge ambos têm `0.1088` → incluir o valor do preço no padrão do replace.
3. `seed.postgres.js`: mesmas linhas TARIFFS (não tem SPLITS).
4. Comentário no cabeçalho do seed.js: data, fonte, o que mudou.
5. DB UPDATEs (JOIN tariff_version→tariff por t.id; activation por ceme_id com subquery):
   ```sql
   UPDATE price_component SET energy_eur_kwh = CASE period WHEN 'VAZIO' THEN X ELSE Y END,
          energy_only_eur_kwh = Z
   WHERE tariff_version_id IN (SELECT tv.id FROM tariff_version tv JOIN tariff t ON t.id=tv.tariff_id WHERE t.id='...');
   UPDATE price_component SET activation_eur = V
   WHERE tariff_version_id IN (SELECT tv.id FROM tariff_version tv JOIN tariff t ON t.id=tv.tariff_id WHERE t.ceme_id='...');
   ```
   + UPDATE `ceme` SET website / `tariff` SET source_url quando os URLs mudam. Verificar com SELECT depois.
6. `cd backend && npm test` (`node --test test/*.test.js`). Testes com âncoras: `test/golden.test.js` (GOLDEN, cenário regulatório, ROUNDUP), `test/preco-split.test.js` (decomposição). Re-congelar âncoras com o motor, não à mão:
   ```sh
   node --input-type=module -e "
   import { DatabaseSync } from 'node:sqlite';
   import { readFileSync } from 'node:fs';
   import { seed } from './src/db/seed.js';
   import { quoteFixed } from './src/engine/quote.js';
   import { pickComponents } from './src/db/components.js';
   const db = new DatabaseSync(':memory:');
   db.exec(readFileSync('src/db/schema.sql', 'utf8')); seed(db);
   const KWH = 40, AT = new Date('2026-10-15T22:09:00+01:00');
   for (const id of ['...']) {
     const t = db.prepare('SELECT * FROM tariff WHERE id=?').get(id);
     const v = db.prepare('SELECT * FROM tariff_version WHERE tariff_id=? ORDER BY id DESC LIMIT 1').get(id);
     const rows = db.prepare('SELECT * FROM price_component WHERE tariff_version_id=?').all(v.id);
     const { price, act, sup, iec } = pickComponents(rows);
     const q = quoteFixed({ schedule: t.schedule, cycle: t.cycle, at: AT, kwh: KWH, price, activation: act, support: sup, iec, region: 'CONT' });
     console.log(id, q.totalEur.toFixed(4), q.eurKwhNoIva.toFixed(4));
   }"
   ```
   Regras do re-freeze: actualiza só as âncoras dos tarifários cujos valores mudaram; cenário regulatório (EGME) só leva tarifários com `act` acima do legal no seed — se o CEME passou a publicar o valor legal, sai da lista. Sempre atualizar os comentários dos testes.
7. Relatório final: tabela batem certo / drift aplicado / sem publicação; nunca push (local apenas).
