# CEME v2 — simulador de custos de carregamento na rede Mobi.E

Site: <https://ceme-beta.ocarroeletrico.com> · Estatísticas OMIE: <https://omie.cocofree.dev> · Código: <https://github.com/CarregaErvilhas/CEME>

Um projecto da comunidade, sem fins lucrativos. Dizes quanta energia vais
carregar, onde e quando, e o simulador mostra-te quanto custa em cada
tarifário de cada comercializador (CEME), do mais barato para o mais caro.

**Novo na mobilidade eléctrica?** Lê primeiro o
[glossário](docs/00-glossario.md): explica o que são CEME, OPC, TAR, OMIE,
vazio, indexados e o resto do vocabulário que vais encontrar no código.

## O que o simulador calcula (e o que não calcula)

Calcula **só a parcela de energia** de um carregamento na rede Mobi.E: o
tarifário do CEME (com a TAR incluída) + IEC + IVA + taxa de activação
(EGME).

**Não inclui a tarifa de utilização do posto (OPC).** Cada operador define
a sua (€/kWh, €/min ou €/sessão) e publica-a no próprio posto. O valor que
mostramos é o mínimo; a conta final vai ser maior. Vê
[mobie.pt/custo-do-carregamento](https://www.mobie.pt/custo-do-carregamento)
e a [FAQ da Mobi.E](https://www.mobie.pt/pt/carregarveiculo/faq).

## O que tens no site

- **Assistente** (`/assistente`, a página de entrada): três perguntas (onde,
  quanto, quando) e mostra-te o tarifário mais barato.
- **Simulador completo** (`/simulador`): o ranking de todos os tarifários,
  com filtros (verde, populares, sem condições, favoritos, pesquisa), a
  conta parcela a parcela de cada um e o comparador indexado vs fixo
  (`#/comparar`).
- **Estatísticas OMIE** (`/omie` e <https://omie.cocofree.dev>): médias
  mensais do preço do mercado, os preços de hoje e de amanhã e uma previsão
  do mês.
- **Sobre** e **Contactos** (`/sobre`, `/contactos`).
- **Guia da API** (`/api`, em inglês) para quem quer usar os dados noutra app.

Tudo em português e inglês, instalável como app no telemóvel (PWA).

Algumas coisas que o simulador faz por ti:

- **Três regiões**: Continente, Madeira e Açores, cada uma com o seu IVA,
  fuso horário e horários de vazio ([docs/07](docs/07-ilhas.md)).
- **Fixos e indexados**, simples e bi-horários (ciclo diário e semanal), em
  baixa e média tensão.
- **Indexados ao preço real**: cotados ao preço do OMIE do quarto de hora em
  que carregas, com as perdas desse quarto.
- **Hora do carregamento** escrita no relógio da região (escreves 22:00 nos
  Açores e é 22:00 dos Açores, estejas onde estiveres).
- **Energia em kWh ou pela bateria** (capacidade + percentagem inicial e
  final).
- **A conta linha a linha** em cada tarifário: energia e TAR, IEC, taxa de
  activação, IVA e total.
- **Favoritos** guardados no browser, sem conta.
- **Pesquisa** que ignora acentos e funciona nas duas línguas.

## Como funciona por dentro

```
browser ──► server.js ──► http/ (páginas, API) ──► tariffs.js ──► motor (engine/)
                                 │                     │
                                 │                     └──► base de dados
                                 │                          (SQLite em dev,
                                 │                           PostgreSQL em produção)
                                 └──► pipeline OMIE (omie/) ──► omie.es
                                                            └─► dados.tiagofelicia.pt
```

- **Backend:** Node.js 24, sem framework (`node:http`). A única dependência
  é `pg`, o driver do PostgreSQL.
- **Frontend:** HTML, CSS e JavaScript simples, sem build. O servidor serve
  os ficheiros tal como estão em `frontend/`.
- **Base de dados:** SQLite local em dev e testes; PostgreSQL em produção.
  O código escreve o mesmo SQL para as duas ([docs/08](docs/08-sqlite-postgres.md)).
- **Preços OMIE:** vão-se buscar ao omie.es (oficial) e ao
  dados.tiagofelicia.pt, e ficam guardados na BD. Actualizam-se quando
  alguém pede dados e os que lá estão têm mais de uma hora
  ([docs/03](docs/03-omie-ingestao.md)).
- **Autenticação:** toda a API pede um token. O browser pede um sozinho;
  apps de terceiros usam uma API key ([docs/04](docs/04-api-auth.md)).

## Correr localmente

Precisas do Node.js 24.

```sh
cd backend
npm ci
npm test
npm start       # http://localhost:3001/
```

`npm run dev` é o `npm start` a reiniciar sozinho quando mudas um ficheiro.

Sem a variável `DATABASE_URL`, a BD é um ficheiro SQLite em
`backend/data/ceme.db`, criado e preenchido no arranque. Se quiseres
começar do zero, apaga `backend/data/` e arranca outra vez. Com
`DATABASE_URL` a apontar para um PostgreSQL, o mesmo código corre contra o
Postgres.

As variáveis de ambiente estão todas em `backend/.env.example`. As duas que
importam em produção:

- `JWT_SECRET`: o segredo que assina os tokens. Em produção é obrigatório
  (sem ele, `POST /v1/session` devolve 503). Gera um com
  `openssl rand -hex 32`.
- `CEME_API_KEY`: opcional, uma API key para terceiros. Na BD só fica o hash.

## Por onde começar a ler o código

1. [docs/00-glossario.md](docs/00-glossario.md) — o vocabulário.
2. `backend/src/engine/quote.js` — como se calcula o custo de um tarifário
   fixo. É curto e é o coração do simulador.
3. `backend/src/engine/indexed.js` e `regions.js` — indexados e horários.
4. `backend/src/server.js` — o ponto de entrada. Segue um pedido a partir
   daí: `http/api.js` (as rotas da API) e `tariffs.js` (a ponte entre a BD
   e o motor).
5. `backend/src/db/seed-data.js` — os tarifários e preços.
6. `frontend/index.html` — o simulador no browser.

Depois, os documentos em `docs/` aprofundam cada parte.

## API

O guia completo, em inglês, está em
<https://ceme-beta.ocarroeletrico.com/api> (ou `/api` localmente).

Todas as rotas `/v1/*` pedem `Authorization: Bearer <jwt>` ou
`X-API-Key: <chave>`. A excepção é `POST /v1/session`, que é quem te dá o
token. Detalhe em [docs/04](docs/04-api-auth.md).

| Método | Rota | O que devolve |
|---|---|---|
| GET | `/healthz` | se o processo está vivo (sem auth) |
| GET | `/readyz` | se o processo e a BD estão prontos (sem auth) |
| POST | `/v1/session` | um token de sessão (24 h); sem auth, com limite por IP |
| GET | `/v1/health` | estado do serviço e o tipo da credencial que usaste |
| GET | `/v1/cemes` | os comercializadores |
| GET | `/v1/tariffs` | os tarifários e a versão em vigor de cada um |
| GET | `/v1/tar` | a TAR em vigor (região, tensão, período) |
| POST | `/v1/simulate` | todos os tarifários cotados para um carregamento, com a conta linha a linha |
| GET | `/v1/omie/daily?days=60` | médias diárias do OMIE (7 a 120 dias), com `complete` |
| GET | `/v1/omie/futures` | contratos de futuros do OMIP |
| GET | `/v1/omie/stats` | os dados da página de estatísticas OMIE |
| GET | `/v1/indexed/quarters` | os quartos de hora de um dia para um indexado, e quem ganha contra um fixo |

Os erros vêm em `{error: {code, message}}` e as datas em ISO UTC. Um
tarifário com dados inconsistentes sai do ranking ("quarentena"), e os
outros seguem.

## Deploy

Produção no Zerops: um serviço `api` (Node.js 24, porta 3001) e um
PostgreSQL gerido (`db`). A Cloudflare fica à frente. Os segredos
(`JWT_SECRET`, `DATABASE_URL`) são variáveis do serviço, nunca estão no
repositório.

O GitHub Actions só corre os testes. O deploy é automático: cada push para
`main` faz o Zerops puxar o código e publicá-lo. O `main` está protegido e
só aceita merges com os testes verdes.

Tudo o que é infra (Zerops, DNS, CI) está em [infra.md](infra.md).

## Estrutura

```
.
  README.md
  LICENSE                     # PolyForm Noncommercial 1.0.0
  THIRD-PARTY-NOTICES.md      # licenças e créditos dos dados de terceiros
  infra.md                    # Zerops + Cloudflare + CI/CD
  zerops.yml                  # configuração do serviço `api`
  zerops-import.yaml          # criação dos serviços (db, api)
  backend/
    package.json
    src/
      server.js               # ponto de entrada: arranca e encaminha pedidos
      boot.js                 # prepara a BD no arranque (schema, TAR, seed)
      http/                   # pages (site), api (rotas /v1), auth,
                              #   ratelimit, respond
      tariffs.js              # lê tarifários e preços da BD e cota-os
      time.js                 # datas, fusos e mudança de hora
      auth/tokens.js          # JWT e hash das API keys
      db.js                   # escolhe SQLite ou PostgreSQL
      db/                     # sqlite.js, pg.js, schemas, migrate.js,
                              #   seed-data.js, seed.js, tar.js, components.js
      engine/                 # o motor: quote, indexed, regions, losses, compare
      omie/                   # preços OMIE: omiees, tf, fetch, parse, convert,
                              #   store, pipeline, stats
    test/                     # testes (`npm test`)
    tools/cores.mjs           # mede as paletas de cor da página OMIE
    data/                     # gerado: SQLite + cache dos CSV (fora do git)
  frontend/
    assistente.html           # o assistente (três perguntas)
    index.html                # o simulador completo
    omie.html                 # estatísticas OMIE
    about.html, contact.html  # Sobre, Contactos
    api.html                  # guia da API (EN)
    strings.js                # todos os textos PT/EN
    tz.js                     # horas de relógio por região
    pages.css                 # estilo das páginas Sobre/Contactos
    manifest.webmanifest, sw.js, pwa.js, icon-*.png   # PWA
  docs/                       # vê a lista abaixo
  scripts/                    # extracção de dados (etl-*) e previews
  .github/                    # CI, dependabot, CODEOWNERS
```

Documentos em `docs/`:

| | |
|---|---|
| [00-glossario](docs/00-glossario.md) | o vocabulário, para quem chega de novo |
| [01-modelo-dados](docs/01-modelo-dados.md) | as tabelas da BD |
| [02-motor-calculo](docs/02-motor-calculo.md) | como se calcula o preço; tempo e horários |
| [03-omie-ingestao](docs/03-omie-ingestao.md) | como chegam os preços do OMIE |
| [04-api-auth](docs/04-api-auth.md) | a API e a autenticação |
| [05-frontend](docs/05-frontend.md) | as páginas, i18n, PWA |
| [06-roadmap](docs/06-roadmap.md) | o que está por fazer |
| [07-ilhas](docs/07-ilhas.md) | Madeira e Açores |
| [08-sqlite-postgres](docs/08-sqlite-postgres.md) | as duas BD |
| [09-omie-estatisticas](docs/09-omie-estatisticas.md) | a página de estatísticas |
| [preview-envs](docs/preview-envs.md) | ambientes de preview por PR |

## Licença

O código, a documentação, o motor de cálculo e o seed estão sob
**PolyForm Noncommercial 1.0.0** (`LICENSE`,
`SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0`).

> Required Notice: Copyright O Carro Elétrico / Fernando Miguel (https://ceme.ocarroeletrico.com/)

- Uso **não comercial** livre (pessoas, investigação, escolas,
  organizações de saúde ou de ambiente, entidades públicas): podes usar,
  modificar e partilhar, desde que mantenhas o aviso e, onde fizer sentido,
  apontes para o site.
- Qualquer uso **comercial** (incluindo uso por uma empresa com vantagem
  comercial, produtos ou serviços pagos, ou meter o software numa oferta
  comercial) precisa de uma licença comercial à parte, combinada caso a
  caso: <info@ocarroeletrico.com>.
- A licença também proíbe usar o software para concorrer com o licenciador:
  um comercializador não pode fazer fork e vender o simulador aos seus
  clientes.

Os dados de terceiros (lista de CEME da ERSE, preços OMIE/MIBEL) **não**
estão sob a PolyForm: mantêm as suas licenças e créditos. Vê
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
