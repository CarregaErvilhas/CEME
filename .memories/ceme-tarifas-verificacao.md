# Memória: verificação de tarifas CEME publicadas vs seed/DB (ceme-v2)

Projecto: `/Users/fernando.pereira/tmp/opencode/ceme-v2/`. Ficheiros-chave:
- `backend/src/db/seed.js` — CEMES, SPLITS (energia+TAR), TARIFFS (finais c/ TAR, act), @@@ act.
- `backend/src/db/seed.postgres.js` — duplicado de TARIFFS; **SPLITS é importado do seed.js** (`import { SPLITS } from './seed.js'`) — só editar TARIFFS aqui.
- `backend/data/ceme.db` — SQLite: `ceme(id, website)`, `tariff(id, ceme_id, kind, voltage, source_url)`, `tariff_version(id, tariff_id→tariff.id, k_index_eur_mwh, cgs_eur_mwh)`, `price_component(tariff_version_id, period, energy_eur_kwh=final c/ TAR, activation_eur, energy_only_eur_kwh, tar_eur_kwh)`.
- Última verificação completa: **2026-10-22** (ver o histórico do git do seed.js: `git log -p backend/src/db/seed.js`).

## Comando
Existe o comando `/ceme-check` (`.opencode/commands/ceme-check.md`) que carrega esta memória. Argumentos opcionais: `/ceme-check galp` (só um CEME) ou `/ceme-check update` (aplicar updates autorizadas).

## Filosofia do seed
- `energy_eur_kwh` = preço **final** (energia + TAR, s/ IVA). `energy_only`/`tar` só quando o CEME/sheet separava; "não se inventa" decomposição.
- `act` = taxa por carregamento **publicada pelo CEME** (às vezes ≥ legal 0.1088 → flag `activation_stale` na API; intencional, não "corrigir" por razões regulatórias — só actualizar se a página do CEME passar a publicar outro valor).
- Página ≠ sheet: quando drift confirmado E o utilizador autoriza, actualiza-se seed+DB e comenta-se no cabeçalho do seed.js a data/fonte.

## Valores de referência (2026)
- TAR mobilidade (cõ TAR por kWh): BT Vazio **0.0266** / Fora **0.1192**; MT V **0.0157** / F **0.0812**; AT 0.0140/0.0692; MAT 0.0134/0.0664.
- EGME legal: **0.1088 €/carregamento** (Regul. ERSE 7/2026, 2026-01-01). Valor 2025 antigo: 0.1572.
- IVA 23% (CONT).

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
(⚠️ usar caminho absoluto ou cd correcto — já falhou por cwd.)

## Classificação dos CEMEs (método × CEME, verificado 2026-10-22)
curl estático (valores no HTML): edp(nov 2026? valores só via JS — usar browser), enable (página /condutores, 2026-10-24: publica ENERGIA — 0,12 €/kWh no Continente e 0,15 €/kWh na Madeira/Açores, "exclui tarifa OPC, taxas e impostos (TAR, EGME, IEC e IVA)"; ciclo bi-horário semanal; o final vem do somatório energia+TAR — REGION_SPLITS no seed), evaz (tabela PricesTable no HTML), goldenergy (0,2222/0,2778 em goldenergy.pt/**mobilidade-eletrica/** — não no blog), luzigas (K's: 0.05 ceme / 0.005 casa; CGS), meo (0,2250 M5/M4 + 0,2500 M3/M2; base 0.195=Colaboradores só no sheet/app), repsol (0,2868), viaverde (energia 0,148), bluecharge (home).

Imagens PNG de tarifário (download + read da imagem): charge2go (`/tarifarios/` → img desktop `TARIFARIOS-*.png`, energia 0,1697 s/ TAR; ⚠️ há `mobile_image` antigo a par, ignorar), evpower (`/particulares/` → `tarifario_janeiro_2026.png`), acp (página mostra só nota TAR; valores via screenshot do user).

PDFs (pypdf, em subagent se conveniente): galp (`galp-electric-tabela-precos-descontos-MMYY.pdf`, ligado de cartao-galpelectric-info), prio (prio.pt/downloads/file422_pt.pdf), factorenergia (`Tabela-precos-vecard-jan-2026-novo-logo.pdf`, ligado em factorenergia.pt/servicos/cartao-mobilidade-eletrica/), mobismart (`mobismart.pt/precos/EVCE-Tabela-precos-CEME-energia_PT.pdf`).

JS/React (browser `tools.browser.evaluate` + `document.body.innerText`): miio (`/pt/prices/charging`, energia fixa 0,24; miio one = −0,07), atlante (`atlante.energy/pt-pt/tarifas-de-energia/`; Business separada em `/pt-pt/myatlante-business/`), evio (`ceme.go-evio.com/pt/site-ceme`), edp (`edp.pt/particulares/.../carregar-fora-de-casa/`).

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
   Regras do re-freeze: actualiza só as âncoras dos tarifários cujos valores mudaram; cenário regulatório (EGME) exige `act > 0.1088` no seed — se o CEME passou a publicar 0.1088, sai da lista (ex.: Charge2Go saído a 2026-10-22; Via Verde ainda tinha 0.1572). Sempre atualizar os comentários dos testes.
7. Relatório final: tabela batem certo / drift aplicado / sem publicação; nunca push (local apenas).

## Estado a 2026-10-22 (âncoras de comparação)
- Galp: 0.2149/0.2895 (tabela 01/10/2026); -3/-4=×0.82, -5/-6=×0.80 recalculados.
- Atlante: AC energia 0.12 único; Business 0.08 (página própria myatlante-business).
- ACP: sócio 0.1506 (0.1315 era erro no gsheets); não-sócio = EVIO 0.169 final 0.1956/0.2882.
- Bluecharge act 0.2608 (taxa deles, não EGME); Charge2go act 0.1088.
- eVaz Move HOME: user disse "mantem" (página diz "até 11%"; seed aplica 5%).
- miio/goldenergy URLs: `/pt/prices/charging` e `/mobilidade-eletrica/`.
- EVPower, Prio, FactorEnergia, EDP, EVIO, GoCharge, EZU, Repsol, Viaverde, Enable, LUZiGÁS, Mobismart, miio, meo(-2): batem certo.
