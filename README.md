# CEME v2 — simulador moderno de mobilidade eléctrica

Site: <https://ceme-beta.ocarroeletrico.com> · Código: <https://github.com/CarregaErvilhas/CEME>

Favor à comunidade, sem fins lucrativos. Substitui o Google Sheets por uma BD versionada + motor de cálculo testável + API com auth + web mobile-friendly.

## Âmbito (importante)

O simulador calcula **só a parcela de energia** de um carregamento na rede
Mobi.E: tarifário do CEME (com TAR incluída) + IEC + IVA + EGME.

**Não inclui a tarifa de utilização do posto (OPC)** — cada operador define a
sua (€/kWh, €/min ou €/sessão) e publica-a no próprio posto. O valor
mostrado é o mínimo da parcela de energia; a factura final será maior.
Ver [mobie.pt/custo-do-carregamento](https://www.mobie.pt/custo-do-carregamento)
e a [FAQ Mobi.E](https://www.mobie.pt/pt/carregarveiculo/faq).

## Stack

- Backend: Node.js 24 — `node:http`, `node:test`, `node:sqlite` (dev) e `pg`
  (única dependência, para PostgreSQL em produção).
- Frontend: HTML + CSS + JS vanilla (sem build) — o assistente passo-a-passo
  (`frontend/assistente.html`, a porta de entrada), o simulador completo
  (`frontend/index.html`), as estatísticas OMIE (`frontend/omie.html`), as
  páginas institucionais e o guia da API — bilíngues PT/EN (o guia da API é
  só EN), com um dicionário único (`frontend/strings.js`) e `Accept-Language`
  no servidor. PWA instalável (`manifest.webmanifest`, `sw.js`, `pwa.js`).
- BD: PostgreSQL 18 em produção (serviço gerido no Zerops) e SQLite local em
  dev/teste. Schema em SQL directo (`backend/src/db/schema.sql` e
  `schema.postgres.sql`), sem ORM — a seed é o bootstrap do ambiente vazio.
- Auth: HS256 JWT de sessão (24h) + API keys (sha256).
- OMIE: o **omie.es** (fonte oficial, o dump acumulado público) é a
  primária e o **TF** (`dados.tiagofelicia.pt`, CC BY 4.0, com atribuição)
  a secundária; os dois são reconciliados por instante e guardados na BD.
  Sem cron, por decisão (o tráfego não o justifica): a actualização é a
  pedido, com pedido condicional ao omie.es (304 quando o ficheiro não
  mudou). Ver `docs/03`.
- CI: GitHub Actions (Node 24, o mesmo do deploy). O deploy **não** é feito
  pelo GitHub — ver a secção «Deploy».

## Correr localmente

```sh
cd backend
npm ci
npm test
npm start       # http://localhost:3001/
```

`npm run dev` é o `npm start` com `--watch`. Sem `DATABASE_URL` a BD é SQLite
(`backend/data/ceme.db`); com `DATABASE_URL` (PostgreSQL) corre o mesmo
código contra o Postgres — a escolha é do ambiente, não do código.

Para consumidores da API fora do browser, uma `X-API-Key` valida contra o
sha256 em BD: exporta `CEME_API_KEY=<valor>` antes de arrancar (o valor
claro nunca fica na BD — ver `docs/04`). Em produção `JWT_SECRET` é
obrigatória: sem ela o `POST /v1/session` devolve 503 em vez de emitir
tokens fabricáveis. Ver `backend/.env.example`.

## API

Developer guide: <https://ceme-beta.ocarroeletrico.com/api> (also available
locally at `/api`). It covers authentication, endpoints, examples, and
guidance for app developers and AI agents.

Todos os `/v1/*` exigem `Authorization: Bearer <jwt>` ou `X-API-Key: <chave>`.
A excepção é `POST /v1/session`, que emite o token da sessão web. Detalhe em
`docs/04-api-auth.md`.

| Método | Rota | O que devolve |
|---|---|---|
| GET | `/healthz` | liveness do processo (rota interna do Zerops, sem auth) |
| GET | `/readyz` | readiness: processo + BD (a BD só é consultada de loopback) |
| POST | `/v1/session` | JWT `WEB_SESSION` (24h) — sem auth, com rate limit por IP |
| GET | `/v1/health` | estado do serviço e o `kind` da credencial usada |
| GET | `/v1/cemes` | comercializadores |
| GET | `/v1/tariffs` | os tarifários + a versão vigente de cada um |
| GET | `/v1/tar` | TAR em vigor (região, tensão, período) |
| POST | `/v1/simulate` | todos os tarifários cotados para o instante/região pedidos, com a conta linha a linha |
| GET | `/v1/omie/daily?days=60` | agregados diários por dia civil de Lisboa (7..120 dias), com `complete` |
| GET | `/v1/omie/futures` | contratos OMIP |
| GET | `/v1/omie/stats` | estatísticas mensais OMIE (13 meses + total geral) e as células de referência |
| GET | `/v1/indexed/quarters` | quartos-horários de um indexado + `winner` vs. o fixo escolhido (`?tz=` define o fuso das horas mostradas) |

Erros em `{error: {code, message}}`; datas em ISO UTC. Um tarifário com
componentes divergentes entra em quarentena e sai do ranking — os restantes
seguem (nunca um 400 vindo de um seed mau).

## Funcionalidades actuais

- **Bilíngue PT/EN:** detecção pelo cabeçalho `Accept-Language` (servidor), bandeira PT/EN no header, escolha persistida em `localStorage`.
- **Aviso de âmbito** visível no hero + card expansível no topo do ranking, com a tabela das parcelas da Mobi.E e links para a fonte oficial.
- **Regiões:** Portugal Continental, Madeira e Açores, cada uma com o seu IVA, fuso, ciclos bi-horários e DST (docs/07). A TAR da mobilidade é uma tabela única da ERSE para as três.
- **Tarifários fixos + indexados**, BT/MT, bi-horário (diário/semanal) + simples.
- **Agregação do OMIE por tarifário** (`tariff_version.omie_aggregation`): `SPLIT_VAZIO_FORA` usa as médias de vazio e fora-vazio **do ciclo do próprio tarifário** (diário ou semanal); `UNICA` usa um OMIE único.
- **OMIE de referência** por omissão = o último dia **completo** de mercado (médias vazio/fora por ciclo).
- **Data/hora do carregamento** configurável (formato ISO aaaa/mm/dd hh:mm, 24 h), lida e mostrada no **relógio da região** do carregamento; default "agora" (fallback para a hora do servidor se o relógio do browser estiver desviado mais de 5 min).
- **A conta linha a linha** no detalhe de cada tarifário: energia + TAR (separadas quando se sabe a separação), IEC, taxa de activação, IVA e total — as mesmas parcelas arredondadas que dão o total.
- **Bateria %:** capacidade + min/max → kWh calculado.
- **Favoritos** em localStorage, com modal de gestão agrupado por CEME e filtros (pesquisa, popular, bundle, verde).
- **Sessão:** energia/%/bateria/região/favoritos/data-hora persistidos em localStorage (`ceme:S`, `ceme:favs`).
- **Potência do ramal (BT/MT):** selector no cartão de energia — afecta apenas a TAR aplicada, não a lista de tarifários. O dedup por `CEME+nome` (`dedupByRamal()`) é partilhado pelo ranking, pelo modal de favoritos e pelo comparador, por isso cada tarifário aparece uma vez em todo o lado.
- **Pesquisa tolerante:** ignora acentos (`luzigas` → `LUZiGÁS`) e não depende da língua da interface — pesquisa em inglês encontra o tarifário em PT.
- **Páginas Sobre e Contactos** (`/sobre` e `/contactos`, com os aliases
  english `/about` e `/contact`): a história do projecto, o que o simulador faz
  e porque é que é útil também a quem tem um ponto de carregamento (DPC);
  contactos (email, Messenger) e o GitHub issues para reportar problemas e
  sugestões. São HTML estático, sem API, com o mesmo dicionário e a mesma
  negociação de língua das outras páginas.
- **Estatísticas OMIE** (`https://omie.cocofree.dev`, e `/omie` no site
  principal): as tabelas mensais de preços (13 meses + total geral, com as
  séries Simples / Bi-horário Semanal / Bi-horário Diário) e as células de
  referência — valor à hora actual, média de hoje e de amanhã, últimos 30
  dias, previsão e média do mês. As **duas escalas de cor** são a
  informação: a de cima compara os meses entre si (uma escala
  verde→amarelo→vermelho sobre toda a tabela), a de baixo compara dentro de
  cada mês (escala divergente azul↔vermelho por linha). Detalhe em
  `docs/09-omie-estatisticas.md`.

O ranking mostra os tarifários versionados do seed (a folha da ERSE, com as
correcções verificadas depois — ver `.memories/ceme-tarifas-verificacao.md`),
fixos e indexados, deduplicados por CEME + nome em ecrã.

Página **Indexado vs fixo** (`#/comparar`): valor actual lado a lado,
gráfico SVG de 60 dias e tabela de quartos-horários (os 8 mais baratos
marcados, com as faixas em que o indexado bate o fixo de referência).

## Deploy

Serviço `api` (Node.js 24, porta 3001) no Zerops, com o PostgreSQL gerido à
parte (`db`); Cloudflare à frente (só registo AAAA, proxy activo, TLS
strict). Não há cache gerida: o Valkey que existia foi desligado por não ter
uso. O `JWT_SECRET` e o `DATABASE_URL` são env secrets do serviço — nunca
no repositório.

O CI (GitHub Actions) só corre os testes. O deploy é o **webhook do Zerops**:
o serviço puxa o repositório quando o push chega ao `main`, o que evita ter
uma credencial Zerops no GitHub. O gating de qualidade passa a ser a branch
protection do `main` (exige o check `test` verde).

Infra, DNS, armadilhas do `run.start` e o checklist de implementação estão
em [`infra.md`](infra.md), que é o ponto único de verdade de infra.

## Estrutura

```
.
  README.md
  LICENSE                     # PolyForm Noncommercial 1.0.0
  THIRD-PARTY-NOTICES.md      # licenças e atribuições dos dados de terceiros
  infra.md                    # Zerops + Cloudflare + CI/CD
  zerops.yml                  # serviço runtime `api`
  zerops-import.yaml          # criação dos serviços (db, api)
  backend/
    package.json
    src/
      server.js               # HTTP + auth + rate limit + rotas /v1/*
      auth/tokens.js          # JWT HS256 e hash das API keys
      db/                     # db.js, pg.js, schema[.postgres].sql, seed[.postgres].js
      engine/                 # quote, indexed, periods, regions, compare
      omie/                   # omiees (oficial), tf (secundário), store (BD),
                              #   pipeline (ingestão a pedido), stats, convert
    test/                     # node:test (`npm test`)
    tools/cores.mjs           # a régua das cores da página OMIE (também usada nos testes)
    data/                     # gerado: SQLite + cache dos ficheiros do TF (no .gitignore)
  frontend/
    index.html                # simulador completo (tudo num ficheiro)
    assistente.html           # assistente passo-a-passo (3 perguntas)
    about.html                # "Sobre": o projecto, o DPC, de onde vêm os dados
    contact.html              # "Contactos": email, Messenger, GitHub issues
    omie.html                 # "Estatísticas OMIE": as tabelas mensais e as células
    api.html                  # guia da API para developers (EN)
    pages.css                 # estilo partilhado pelas páginas institucionais
    strings.js                # dicionário PT/EN de todas as páginas
    tz.js                     # horas de relógio por região (simulador + assistente)
    manifest.webmanifest, sw.js, pwa.js, icon-*.png   # PWA
  docs/                       # 01-modelo, 02-motor, 03-omie, 04-api-auth,
                              # 05-frontend, 06-roadmap, 07-ilhas, 08-sqlite-postgres,
                              # 09-omie-estatisticas, preview-envs
  scripts/                    # etl-sheets.sh + etl-ceme.js (extracção da folha),
                              # preview-create.sh / preview-destroy.sh (esqueletos; docs/preview-envs.md)
  .github/                    # workflows/ci.yml, dependabot.yml, CODEOWNERS
```

## Licença

O código, a documentação, o motor de cálculo e o seed estão sob
**PolyForm Noncommercial 1.0.0** (`LICENSE`,
`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0`).

> Required Notice: Copyright O Carro Elétrico / Fernando Miguel (https://ceme.ocarroeletrico.com/)

- Uso **não comercial** livre (indivíduos, investigação, escolas,
  organizações de saúde ou de ambiente, entidades públicas): usar, modificar
  e partilhar, com a obrigação de manter o aviso e apontar para o sítio onde
  razoável.
- Qualquer uso **comercial** (incluindo uso por um negócio com vantagem
  comercial, produtos/serviços pagos, ou embutir o software numa oferta
  comercial) exige uma licença comercial separada, acordada caso a caso:
  <info@ocarroeletrico.com>.
- A PolyForm Noncommercial proíbe também usar o software para competir com o
  licensor: um comercializador não pode fazer fork e vender o simulador aos
  consumidores da sua própria energia. É deliberado — um arranjo diferente
  pede-se e escreve-se antes, não se descobre depois.

Os dados de terceiros (lista de CEME da ERSE, séries OMIE/MIBEL) **não** estão
sob a PolyForm: mantêm as suas próprias licenças (CC BY 4.0) e as suas
atribuições. Ver [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
