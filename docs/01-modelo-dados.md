# 01 — Modelo de dados

Aqui tens as tabelas da base de dados e o que cada uma guarda. As colunas
estão comentadas nos schemas, `backend/src/db/schema.sql` (SQLite) e
`schema.postgres.sql` (PostgreSQL). Se algum termo te soar estranho, vê o
[glossário](00-glossario.md).

## De onde vêm os dados

| dados | origem | como entram |
|---|---|---|
| CEME, tarifários, preços | páginas públicas de cada CEME | escritos à mão em `backend/src/db/seed-data.js` |
| TAR | ERSE | escrita à mão em `backend/src/db/tar.js` (`TAR`) |
| taxa de activação legal | ERSE | constante `EGME_LEGAL` em `backend/src/tariffs.js` |
| IVA por região | Código do IVA | `REGIONS` em `engine/regions.js` |
| perdas na rede | E-REDES | `engine/losses-<ano>.json`, gerado por `scripts/etl-perdas.py` |
| preços OMIE | omie.es e dados.tiagofelicia.pt | ingestão automática ([03](03-omie-ingestao.md)) |

## As tabelas

### Tarifários

| tabela | o que guarda |
|---|---|
| `ceme` | os comercializadores: nome, cor da marca, site |
| `tariff` | os tarifários: CEME, nome, fixo/indexado, tensão, ciclo, as etiquetas (verde, com condições, popular), as regiões onde é vendido e o URL onde o preço está publicado |
| `tariff_version` | as versões de cada tarifário no tempo (vê abaixo), com os parâmetros dos indexados (K, CGS) |
| `price_component` | os preços de cada versão, uma linha por período, para o Continente |
| `price_component_region` | preços próprios das ilhas, só para os CEME que cobram diferente lá |
| `tar` | a TAR por região, tensão e período, com validade |

### OMIE

| tabela | o que guarda |
|---|---|
| `omie_spot` | um preço por quarto de hora e por fonte, com a chave no instante UTC |
| `omie_daily` | resumo de cada dia: média, mínimo, máximo e as médias de vazio e fora de vazio em cada ciclo (é o que `/v1/omie/daily` devolve) |
| `omie_meta` | pares chave/valor com o estado da ingestão: hora da última actualização, ETag do ficheiro oficial, estatísticas já calculadas, futuros, o lock entre instâncias |

### API

| tabela | o que guarda |
|---|---|
| `api_client` | clientes da API (apps de terceiros), com o rate limit de cada um |
| `api_key` | as chaves de cada cliente; só o hash sha256, nunca a chave |

### Por usar

Estas tabelas existem no schema mas o código ainda não as usa. Estão aqui
para funcionalidades do [roadmap](06-roadmap.md):

| tabela | para quê |
|---|---|
| `loss_profile` | perfis de perdas na BD (hoje vêm de um ficheiro JSON) |
| `suggestion` | sugestões de correcção enviadas pela comunidade |
| `audit_log` | registo de quem mudou o quê |

## Como funcionam as versões

Um tarifário pode mudar de preço. Em vez de apagares o preço antigo, crias
uma versão nova com datas:

- `valid_from`: o primeiro dia em que a versão vale;
- `valid_to`: o dia em que deixa de valer (exclusivo), ou vazio se ainda
  vale.

A versão em vigor num dia é a que tem `valid_from <= dia` e
(`valid_to` vazio ou `dia < valid_to`). "Dia" é sempre o dia de calendário
na região do carregamento, calculado pelo código (`civilDay()`), nunca o
`CURRENT_DATE` da BD (que dá o dia em UTC).

Uma **campanha** é uma versão com fim marcado (`campaign = 1`). As que já
acabaram estão em `CAMPAIGN_END` (`seed-data.js`), ficam com `status = 'EXPIRED'` e
desaparecem do simulador no dia a seguir ao fim.

Hoje todas as versões do seed têm o mesmo `valid_from`: a data em que os
preços foram verificados (`PRICES_VERIFIED_ON`). Não sabemos quando cada
contrato começou, e a interface mostra "preços verificados em", não "em
vigor desde".

Para corrigires um valor, mudas o seed e o próximo arranque actualiza a
versão existente. Só crias uma versão nova quando interessa guardar o preço
antigo com a sua validade (por exemplo, uma campanha).

## Os preços (`price_component`)

Cada versão tem uma linha por período: `VAZIO` e `FORA_VAZIO` nos
bi-horários, `UNICO` nos simples.

- **`energy_eur_kwh`** é o preço **final** que o CEME publica, já com a TAR
  dentro e sem IVA. É o que entra na conta dos fixos.
- **`energy_only_eur_kwh`** e **`tar_eur_kwh`** são o mesmo preço partido
  em energia + TAR. Só existem quando o CEME publica a separação; senão
  ficam NULL. Não inventamos a separação, porque a diferença seria uma
  conta nossa e o CEME pode ter usado uma TAR diferente da actual.
- **`activation_eur`** é a taxa de activação por carregamento, tal como o
  CEME a publica.
- **`support_eur`** e **`iec_eur_kwh`**: o apoio por carregamento e o IEC.

A taxa de activação, o apoio e o IEC são do tarifário, não do período, mas
repetem-se em todas as linhas. Se divergirem entre linhas, os dados estão
errados e o tarifário vai para a quarentena (`db/components.js`).

Os indexados não têm preço guardado (é calculado na hora), mas têm uma
linha `VAZIO` com a taxa de activação, o apoio e o IEC.

## Preços das ilhas (`price_component_region`)

Quando um CEME cobra diferente na Madeira ou nos Açores, as linhas dessa
região ficam em `price_component_region`, com as mesmas colunas. Na
leitura, sobrepõem-se às do Continente (`loadPricing(region)` e
`comps(vid, region)` em `tariffs.js`). Um tarifário sem linhas aqui usa o preço do Continente em
qualquer região.

## Regiões

As três regiões (`CONT`, `MAD`, `AZO`) têm IVA, fuso e horários próprios
([07](07-ilhas.md)). A coluna `tariff.regions` diz onde o tarifário é
**vendido**, mas é só informação: o simulador cota todos os tarifários em
qualquer região e o cartão mostra onde cada um é vendido.

## O seed

Os dados estão em `backend/src/db/seed-data.js`: os CEME e os tarifários
como objectos com campos nomeados (a legenda de cada campo está por cima de
`TARIFFS`). Quem os grava é `backend/src/db/seed.js`, o mesmo código para
SQLite e PostgreSQL. Corre em cada arranque e é **convergente**: insere o
que falta e actualiza o que mudou. Não mexe em `valid_to`, para não reabrir
uma versão que alguém fechou à mão.

A TAR tem o seu próprio ficheiro, `backend/src/db/tar.js`, com uma entrada
por ano; o arranque também a grava por upsert.

Se apagares `backend/data/` e arrancares o servidor, a BD local é recriada
do zero. As contagens esperadas de CEME e tarifários estão no
`golden.test.js` («cobertura do seed»).
