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
- Frontend: HTML + CSS + JS vanilla (sem build), quatro páginas — o
  assistente passo-a-passo (`frontend/assistente.html`, a porta de entrada), o
  simulador completo (`frontend/index.html`) e as duas páginas institucionais
  (`frontend/about.html`, `frontend/contact.html`) — bilíngues PT/EN, com um
  dicionário único (`frontend/strings.js`) e `Accept-Language` no servidor.
- BD: PostgreSQL 18 em produção (serviço gerido no Zerops) e SQLite local em
  dev/teste. Schema em SQL directo (`backend/src/db/schema.sql` e
  `schema.postgres.sql`), sem ORM — a seed é o bootstrap do ambiente vazio.
- Auth: HS256 JWT de sessão (24h) + API keys (sha256).
- OMIE: séries diária, de quartos-horários e futuros via
  `dados.tiagofelicia.pt` (CC BY 4.0, com atribuição), cache local de 6h. A
  ingestão directa do `omie.es` ainda não está implementada (ver `docs/03`
  e `docs/06`).
- CI: GitHub Actions (Node 24, o mesmo do deploy). O deploy **não** é feito
  pelo GitHub — ver a secção «Deploy».

## Correr localmente

```sh
cd backend
npm ci
npm test        # 111 testes
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

Todos os `/v1/*` exigem `Authorization: Bearer <jwt>` ou `X-API-Key: <chave>`.
A excepção é `POST /v1/session`, que emite o token da sessão web. Detalhe em
`docs/04-api-auth.md`.

| Método | Rota | O que devolve |
|---|---|---|
| POST | `/v1/session` | JWT `WEB_SESSION` (24h) — sem auth, com rate limit por IP |
| GET | `/v1/health` | estado do serviço e o `kind` da credencial usada |
| GET | `/v1/cemes` | comercializadores |
| GET | `/v1/tariffs` | os 128 tarifários + a versão vigente de cada um |
| GET | `/v1/tar` | TAR em vigor (região, tensão, período) |
| POST | `/v1/simulate` | todos os tarifários cotados para o instante/região pedidos |
| GET | `/v1/omie/daily?days=60` | agregados diários (7..120 dias) |
| GET | `/v1/omie/futures` | contratos OMIP |
| GET | `/v1/omie/stats` | estatísticas mensais OMIE (13 meses + total geral) e as células de referência |
| GET | `/v1/indexed/quarters` | quartos-horários de um indexado + `winner` vs. o fixo escolhido |

Erros em `{error: {code, message}}`; datas em ISO UTC. Um tarifário com
componentes divergentes entra em quarentena e sai do ranking — os restantes
seguem (nunca um 400 vindo de um seed mau).

## Funcionalidades actuais

- **Bilíngue PT/EN:** detecção pelo cabeçalho `Accept-Language` (servidor), bandeira PT/EN no header, escolha persistida em `localStorage`.
- **Aviso de âmbito** visível no hero + card expansível no topo do ranking, com a tabela das parcelas da Mobi.E e links para a fonte oficial.
- **Regiões:** Portugal Continental (IVA 23%), Madeira (22%), Açores (16%), com timezones, ciclos bi-horários e DST próprios.
- **Tarifários fixos + indexados**, BT/MT, bi-horário (diário/semanal) + simples.
- **Agregação do OMIE por tarifário** (`tariff_version.omie_aggregation`): `SPLIT_VAZIO_FORA` (LuziGas, MEO, Ynerluz) usa médias separadas de vazio e fora-vazio; `SPOT`/`UNICA` usam o OMIE único.
- **OMIE de referência** por omissão = último OMIE real disponível (com médias vazio/fora separadas).
- **Data/hora do carregamento** configurável (formato ISO aaaa/mm/dd hh:mm); default "agora" com base na hora do browser (fallback servidor se desvio >5 min).
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

O ranking mostra **128 tarifários versionados** (55 ofertas distintas em ecrã) /
24 CEME — seed completo da folha da ERSE, incluindo Atlante, EDP, Galp, 6
indexados LuziGas, MEO Dinâmica, Ynerluz, miio, Via Verde, etc.

Página **Indexado vs fixo** (`#/comparar`): valor actual lado a lado,
gráfico SVG de 60 dias e tabela de quartos-horários (os 8 mais baratos
marcados, com as faixas em que o indexado bate o fixo de referência).

## Deploy

Serviço `api` (Node.js 24, porta 3001) no Zerops, com PostgreSQL 18 e Valkey
7.2 geridos à parte; Cloudflare à frente (só registo AAAA, proxy activo, TLS
strict). O `JWT_SECRET` e o `DATABASE_URL` são env secrets do serviço — nunca
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
  zerops-import.yaml          # criação dos serviços geridos (db, cache)
  backend/
    package.json
    src/
      server.js               # HTTP + auth + rate limit + rotas /v1/*
      auth/tokens.js          # JWT HS256 e hash das API keys
      db/                     # db.js, pg.js, schema[.postgres].sql, seed[.postgres].js
      engine/                 # quote, indexed, periods, regions, compare
      omie/                   # cache, parse, convert, fallback, stats
    test/                     # 15 ficheiros, 177 testes (node:test)
    data/                     # gerado: SQLite + cache OMIE (no .gitignore)
  frontend/
    index.html                # simulador completo (tudo num ficheiro)
    assistente.html           # assistente passo-a-passo (3 perguntas)
    about.html                # "Sobre": o projecto, o DPC, de onde vêm os dados
    contact.html              # "Contactos": email, Messenger, GitHub issues
    omie.html                 # "Estatísticas OMIE": as tabelas mensais e as células
    pages.css                 # estilo partilhado por Sobre/Contactos
    strings.js                # dicionário PT/EN das cinco páginas
  docs/                       # 01-modelo, 02-motor, 03-omie, 04-api-auth,
                              # 05-frontend, 06-roadmap, 07-ilhas, 08-migracao-sqlite-postgres,
                              # 09-omie-estatisticas
  scripts/etl-sheets.sh
  .github/workflows/ci.yml
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
