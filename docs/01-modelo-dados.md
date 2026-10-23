# 01 — Modelo de dados

## Fontes

- **Sheet** `1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84` (34 tabs) — export
  integral em `ceme-v2-deep/fonte/simulador-original.xlsx` + dumps TSV.
- **ERSE** — diretivas de TAR/EGME/IEC/IVA (introduzidas manualmente 1×/ano).
- **OMIE / REN / tiagofelicia.pt** — séries de preço (ver `03`).

## Tabelas

| tabela | conteúdo |
|---|---|
| `ceme` | 24 comercializadores (nome, cor, site) |
| `tariff` | os tarifários (CEME, nome, fixo/indexado, tensão, ciclo, verde, bundle, regiões, URL fonte) |
| `tariff_version` | versão com `valid_from`/`valid_to`, `k_index_eur_mwh`, `cgs_eur_mwh`, `omie_aggregation`, estado. Chave única `(tariff_id, valid_from)`: uma versão por tarifário e data. `valid_from` no seed é a **data de captura** (`SHEET_SNAPSHOT`), não a data de início do contrato — a folha CEME não tem coluna de datas |
| `price_component` | preço €/kWh por período + `activation_eur` (EGME) + `support_eur` + `iec_eur_kwh`. `energy_eur_kwh` é o preço **final** que o CEME publica (já com a TAR dentro); `energy_only_eur_kwh` + `tar_eur_kwh` são a decomposição **quando a folha a tinha** (o CEME publicava a energia à parte) — NULL quando não a temos, porque não se inventa |
| `tar` | TAR por região/tensão/período, versionada |
| `omie_daily` | agregados diários materializados a partir de `omie_spot`: `avg_pt`, `min_pt`, `max_pt` e as quatro médias por ciclo (`bd_v`/`bd_f`/`bs_v`/`bs_f`) — é o que serve `/v1/omie/daily` |
| `omie_spot` | quartos-horários, um por linha, indexados pelo **instante UTC** (`ts_utc`) e pela fonte (`source`: `OMIE_ES` ou `TF`) |
| `omie_meta` | estado da ingestion: quando foi o último refresh, o ETag do ficheiro oficial (para o pedido condicional), o payload das estatísticas e o lock entre réplicas |

`omie_spot`, `omie_daily` e `omie_meta` são o **store** do OMIE: o backend
busca o omie.es (primária) e o TF (secundária), reconcilia por instante e
guarda aqui — ver `03-omie-ingestao.md`.

Criadas no schema mas ainda sem uso (fase 2):

| tabela | para quê | em uso? |
|---|---|---|
| `loss_profile` | perdas E-REDES por DSO, tensão e quarto de hora | não (roadmap) |
| `suggestion` | sugestões da comunidade / portal CEME (fila de moderação) | não (fase 2) |
| `api_client`, `api_key` | chaves para terceiros (só o hash fica na BD) | **sim** — a chave da env (docs/04) |
| `audit_log` | quem mudou o quê, e quando | não (fase 2) |

Nota: `omie_quarter` nunca existiu no schema — o nome certo é `omie_spot`.
## Decisões

1. **Versionamento temporal.** Um tarifário é um conjunto de versões com
   validade; passado, presente e futuro resolvem-se com a mesma query. A
   versão em vigor é a de `valid_from <= dia < valid_to` (ou `valid_to`
   nulo), com o dia civil em Portugal (nunca `CURRENT_DATE` da BD). Uma
   campanha é uma versão com `valid_to`: as que acabaram estão em
   `CAMPAIGN_END` (seed), com `campaign = 1` e `status = 'EXPIRED'` — e
   saem do simulador no dia seguinte ao fim.
2. **`omie_aggregation` é dado, não constante.** Ver `02-motor-calculo.md`:
   `SPLIT_VAZIO_FORA` (média por banda, no ciclo do tarifário) ou `UNICA`
   (média única).
3. **A EGME (`activation_eur`) é o que o CEME publica**, à data da
   verificação — um único significado, sem substituição no código. O valor
   legal em vigor fica como referência (`EGME_LEGAL` em `server.js`); quando
   o publicado é ainda o valor legal anterior (`EGME_PREVIOUS`), a API
   devolve `activation_stale: true` e `egme_legal`, e o cartão mostra o
   aviso. Valores próprios acima do legal são legítimos e não se marcam. Quem cobra o quê está no seed
   (`TARIFFS`), não aqui. Auditado por teste — ver `backend/test/poc.test.js`.

   Correcções de valores: hoje são feitas **na versão existente** (o seed é
   convergente — ver abaixo), com a razão no histórico do git do seed. Uma
   nova `tariff_version` só quando interessa guardar o preço antigo com a sua
   validade (ex. campanhas).
4. **Fixos incluem a TAR.** O `energy_eur_kwh` do sheet é o preço final
   (energia + TAR), pelo que a tabela `tar` **não** se soma aos fixos; serve
   para auditoria e para os indexados. Só o indexado compõe
   `(OMIE + K + CGS) × (1 + perdas) + TAR`.
5. **Ativação = EGME, e é o valor do sheet.** O seed tinha um bug que zerava
   `act`/`support`/`iec` nos indexados — corrigido em 2026-10-18, com teste de
   auditoria.
6. **Regiões como dimensão de primeira classe** (`region` na API e na tabela
   `tar`): IVA, fuso e janelas próprias; a TAR procura-se pela região (os
   valores da ERSE são os mesmos nas três — docs/07). O `regions` do
   tarifário é informação ("comercializado em"), não filtro.

## Migração do sheet

`backend/src/db/seed.js` é **convergente**: um upsert
(`ON CONFLICT … DO UPDATE`) que actualiza os valores que mudaram em cada
arranque — e que deixa `valid_to` em paz, para não reabrir o que um operador
fechou. `rm -rf backend/data` e arrancar o servidor recria a BD do zero. As
contagens esperadas de CEME e tarifários estão congeladas no
`golden.test.js` («cobertura do seed»); o `seed-parity.test.js` garante que
o seed do Postgres tem os mesmos dados.
