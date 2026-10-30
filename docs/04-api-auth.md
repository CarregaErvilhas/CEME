# 04 — API e autenticação

O guia para quem usa a API de fora (em inglês) está em `/api`
(`frontend/api.html`). Este documento é a versão para quem mexe no código:
como funciona a autenticação, os limites, e o que cada rota faz.

## A regra

Nenhuma rota `/v1/*` responde sem credencial, com uma excepção:
`POST /v1/session`, que é quem te dá o token (não pode pedir um).

Também não pedem credencial as páginas HTML, os ficheiros estáticos (JS,
CSS, PWA, ícones) e as verificações `/healthz` e `/readyz`, porque não são
API. Qualquer outro caminho desconhecido cai na autenticação: sem
credencial recebes **401**, não 404.

O site e as apps de terceiros passam pelo mesmo controlo; só muda o tipo de
credencial. Os favoritos do site não precisam de conta (ficam no browser),
mas o browser manda sempre um token.

## Credenciais

| quem | como obtém | o que envia |
|---|---|---|
| o site (sessão anónima) | `POST /v1/session` → um JWT do tipo `WEB_SESSION`, válido 24 h, sem dados pessoais (`sid` é um identificador aleatório) | `Authorization: Bearer <jwt>` |
| uma app de terceiros | uma API key definida na variável `CEME_API_KEY` do servidor; no arranque, só o sha256 vai para a BD (tabela `api_key`, id `env-key`) | `X-API-Key: <chave>` |

Um JWT é um texto em três partes (`cabeçalho.conteúdo.assinatura`). O
servidor assina-o com `JWT_SECRET` (HMAC-SHA256); se alguém alterar o
conteúdo, a assinatura deixa de bater. Na validação, o cabeçalho tem de
dizer `alg: HS256` e a assinatura compara-se em tempo constante
(`timingSafeEqual`), para o tempo de resposta não dar pistas sobre ela. Um
token estragado é só um 401, nunca um erro do servidor. O código está em
`backend/src/auth/tokens.js`; quem lê a credencial de cada pedido é
`backend/src/http/auth.js`.

Uma `X-API-Key` valida-se comparando o seu hash com os da BD (ignoram-se
chaves revogadas ou expiradas). Qualquer chave desconhecida recebe 401.

Todos os 401 têm o código `unauthorized`; a mensagem diz o que correu mal
(credencial em falta, `X-API-Key` inválida, token expirado ou inválido). Uma
chave revogada, expirada ou que nunca existiu dá a mesma mensagem, para não
revelar quais chaves já existiram. As mensagens estão em `AUTH_MESSAGES`
(`backend/src/http/api.js`).

### A chave da variável de ambiente

A variável `CEME_API_KEY` manda na linha `env-key` da BD. Como a BD
sobrevive aos reinícios, o arranque sincroniza nos dois sentidos:

- **com** `CEME_API_KEY`: grava o hash e reactiva a chave. Mudar o valor da
  variável invalida a chave antiga;
- **sem** `CEME_API_KEY`: revoga a chave que estiver na BD.

`CEME_API_KEY_RATE_LIMIT` (pedidos por minuto, inteiro positivo) define o
limite dessa chave a cada arranque. Sem ela, ou com um valor inválido (fica
um aviso no log), o limite volta aos 60. Testado em `server.test.js`
(«CEME_API_KEY_RATE_LIMIT»).

Para revogar, tiras (ou trocas) a variável e reinicias. Testado em
`server.test.js` («CEME_API_KEY — tirar a env revoga a chave»). Em modo
`CEME_READONLY` isto não corre.

### Chaves de outros clientes (`tools/api-key.mjs`)

Cada app de terceiros tem o seu cliente em `api_client` (com o seu
`rate_limit`) e as suas chaves em `api_key`. Não escreves SQL: com a VPN do
Zerops ligada e a URL da BD exportada (`DATABASE_URL`, ou a
`DATABASE_APP_URL` da role `ceme_app`, que chega), corres a partir de
`backend/`:

```sh
node tools/api-key.mjs create <cliente> --limit 60   # cliente novo + chave
node tools/api-key.mjs rotate <cliente>              # mais uma chave
node tools/api-key.mjs revoke <cliente|id-da-chave>  # revoga
node tools/api-key.mjs limit <cliente> 120           # muda o limite
node tools/api-key.mjs list                          # clientes e chaves
```

`create` e `rotate` copiam a chave para o clipboard (só o prefixo aparece
no ecrã) e testam-na contra `/v1/health` do site (`--base` para outro,
`--no-check` para saltar). Guarda-a logo: na BD só fica o hash. Ao rodar, a
chave antiga continua activa até a revogares, para o cliente trocar sem
ficar sem serviço. O limite vale logo, sem reiniciar: o servidor lê-o a cada
pedido.

O cliente é sempre `THIRD_PARTY`: com outro `kind` a chave entrava, mas o
rate limit passava a ser por IP. Sem URL da BD o script recusa-se a correr
(senão escrevia no SQLite local, onde o servidor de produção nunca a via);
`--local` força o SQLite, para dev. A linha `env-key` é da variável e o
script não lhe mexe. A lógica está em `backend/src/auth/apikeys.js`, testada
em `apikeys.test.js`.

### O segredo das sessões (`JWT_SECRET`)

O servidor arranca sempre. Sem `JWT_SECRET`, usa um segredo de dev
conhecido (`dev-only-change-me`) e avisa no log. Em produção
(`NODE_ENV=production`) com esse segredo, recusa emitir tokens
(`POST /v1/session` → **503**) e recusa os que receber. Em produção tens de
definir `JWT_SECRET` (por exemplo `openssl rand -hex 32`); vê
`backend/.env.example`.

## Validação dos pedidos

- `POST /v1/simulate` recusa corpos acima de **64 KB** (413), JSON inválido
  ou que não seja um objecto (400), `kwh` fora de ]0, 1000], `at` que não
  seja uma data ISO e valores `omie*`/`omieCycles` que não sejam números
  positivos (400, com um `error.code` próprio).
- Cada rota aceita só o seu método HTTP (405, com o cabeçalho `Allow`).
- Um tarifário com dados inconsistentes, ou sem TAR para a região, vai para
  a **quarentena**: sai da resposta (com um aviso no log com o `id`) e os
  outros seguem. Um seed com um erro nunca dá um 400.

## Rate limit

Uma janela fixa de 60 segundos, contada em memória por cada instância do
servidor.

- Sessão web (Bearer): por IP, 60 pedidos por minuto.
- `POST /v1/session`: por IP, à parte, 10 por minuto (é a única rota sem
  auth, por isso tem um limite mais apertado).
- API key: pela chave (os primeiros 8 caracteres), 60 por minuto ou o
  `api_client.rate_limit` da BD. Para a chave da env, quem manda nesse
  valor é `CEME_API_KEY_RATE_LIMIT` (vê abaixo).

Ao passar o limite recebes **429**, com os cabeçalhos
`x-ratelimit-limit/remaining/reset` e `retry-after`. O mapa de contadores
tem um tecto (10 000 entradas), para um monte de IPs diferentes não encher
a memória.

**O IP atrás de proxies.** Em produção, os pedidos chegam através da
Cloudflare e do balanceador, por isso o IP da ligação é sempre o do proxy.
A variável `CEME_TRUST_PROXY=N` diz quantos proxies de confiança há à
frente: o IP do cliente passa a ser a N-ésima entrada a contar da direita
do cabeçalho `X-Forwarded-For` (as da esquerda o cliente pode inventar).
Sem a variável, usa-se o IP da ligação.

Todas as respostas JSON e o HTML levam `x-content-type-options: nosniff`.

## Rotas

```
GET  /healthz                    # o processo está vivo; sem auth
GET  /readyz                     # processo + BD; sem auth; só testa a BD a partir da própria máquina
POST /v1/session                 # dá-te um WEB_SESSION (24 h); sem auth
GET  /v1/health                  # confirma a credencial e diz de que tipo é
GET  /v1/cemes                   # comercializadores
GET  /v1/tariffs                 # todos os tarifários + a versão em vigor
GET  /v1/tar                     # TAR em vigor (region, voltage, period, valid_from)
GET  /v1/promos                  # promoções que ainda não acabaram (vê abaixo)
POST /v1/simulate                # vê abaixo
GET  /v1/omie/daily?days=60      # médias diárias; days entre 7 e 120
GET  /v1/omie/futures            # contratos de futuros do OMIP (a interface não os usa)
GET  /v1/omie/stats              # dados da página de estatísticas (docs/09)
GET  /v1/indexed/quarters?tariff=&region=&date=&fixed=&tz=
```

`POST /v1/session` devolve `{ token, expires_in }`; o JWT leva `kind`
(`WEB_SESSION`), `sid` e `exp`.

### `/healthz` e `/readyz`

São as verificações da plataforma (vê `infra.md`). `/healthz` só diz que o
processo responde. `/readyz` também faz um `SELECT 1` à BD, mas **só quando
o pedido vem da própria máquina** (com 3 s de prazo e a resposta guardada
5 s). De fora responde 200 com `db: unknown`, sem tocar na BD. Com a BD em
baixo: 503 `db_unavailable`.

### `/v1/indexed/quarters`

Os quartos de hora de um dia de Lisboa (`date`, por omissão hoje) para um
indexado (`tariff`), cotados com a TAR da região (`region`). `tz` (nome de
fuso IANA, ex. `Europe/Lisbon`) é o fuso das horas `start`/`end`
devolvidas; cada quarto traz também o instante `utc`.

Com `fixed=<id de um fixo>`, cada quarto traz ainda `fixed` (o €/kWh do
fixo nesse quarto) e `winner` (`IDX`, `FIX`, `EQ` ou `null`), e a resposta
traz `wins` com as contagens. Sem `fixed`, `winner` é sempre `null`.

Um `tariff` que não seja indexado é trocado pelo primeiro indexado. Erros:
400 `bad_region`, 404 `no_indexed`, 502 `omie_unavailable`.

### `POST /v1/simulate`

É o que o site usa para o ranking.

```json
{ "kwh": 40, "at": "2026-10-18T01:00:00Z", "region": "CONT", "useSpot": true,
  "omieCycles": { "DIARIO":  { "vazio": 0.105, "fora": 0.059 },
                  "SEMANAL": { "vazio": 0.098, "fora": 0.064 } } }
```

`region` ∈ `CONT | MAD | AZO`. Sem `at`, usa agora.

Devolve **todos** os tarifários em vigor no dia do carregamento (o dia na
região), já cotados, do mais barato para o mais caro, mais a média (`avg`)
e o OMIE usado (`omieRef`). Filtrar é com o cliente. Cada tarifário traz
`parts`, a conta linha a linha (energia + TAR, IEC, activação, sem IVA,
IVA), que soma o `totalEur` ao cêntimo ([02](02-motor-calculo.md)).

Notas:

- `activation` é a taxa de activação **que o CEME publica**. Vai
  acompanhada de `egme_legal` (o valor legal em vigor) e
  `activation_stale` (`true` quando o CEME ainda publica o valor legal do
  ano anterior).
- `useSpot: true`: os indexados são cotados ao OMIE do quarto de hora de
  `at` (e às perdas desse quarto). `omieRef` passa a ser esse OMIE e
  `omieSpot` (`{utc, eurKwh}`) diz qual foi. Se o quarto não existir,
  usam-se as médias (`omieCycles` ou `omie*`) e `omieSpot` vem `null`.
- Sem `useSpot`, com `omieCycles`, cada indexado usa o par vazio/fora **do
  seu ciclo**; sem `omieCycles`, `omieVazio`/`omieFora` valem para todos;
  sem nenhum, o `omie` único.
- `profile` (opcional): o carregamento partido em fatias no tempo, para
  quem sabe quanto tempo ele demora (um carregamento lento atravessa o
  início do vazio, vários quartos de hora OMIE, a meia-noite ou a mudança
  da hora):

  ```json
  { "region": "CONT", "useSpot": true, "detail": true,
    "profile": [ { "at": "2026-10-21T20:30:00Z", "kwh": 9.6 },
                 { "at": "2026-10-21T20:45:00Z", "kwh": 9.6 }, ... ] }
  ```

  Cada fatia é cotada no **seu** instante: período vazio/fora, OMIE do seu
  quarto de hora (com `useSpot`), perdas desse quarto e TAR do seu dia. A
  activação, o apoio e o IVA contam uma vez. Quando há `profile`, ele manda:
  `kwh` é a soma das fatias e `at` a primeira. Parte o carregamento nas
  fronteiras dos quartos de hora (:00, :15, :30, :45 UTC), porque uma
  fatia que atravesse uma fronteira é cotada toda no início. Até 400
  fatias, por ordem de tempo, `kwh` ≥ 0 em cada uma e a soma entre 0 e
  1000; senão `400 bad_profile`.

  A resposta traz `profile` (`{ slices, from, to, withSpot }`, quantas
  fatias tiveram OMIE do quarto) e, em cada tarifário com mais de uma
  fatia, `kwhByPeriod`. `period`, `prices` e `omieRef` continuam a ser os
  do início. Com `detail: true`, cada tarifário traz também `slices`: o
  instante, os kWh, o período e o preço final (sem IVA) de cada fatia, e,
  nos indexados, o OMIE usado e se era do quarto (`omieSpot`). Sem
  `detail`, as fatias não vêm (são N fatias × cada tarifário).
- `promos` (só nos tarifários que as têm nesse dia e região): as promoções
  do CEME, quase sempre numa **rede de postos** (`network`: Powerdot, EDP…;
  `null` = qualquer posto MOBI.E). O simulador não sabe em que posto
  carregas, por isso uma promoção nunca muda o `totalEur`: vai à parte, e
  quem sabe o posto escolhe as da rede certa. Cada uma traz os campos de
  `GET /v1/promos` e, conforme o `target`:
  - `"ENERGIA"`: `totalEur` com o desconto (o mesmo carregamento, com
    `eurKwh` a menos no preço final de cada fatia, antes de IEC, EGME e
    IVA). Como o do tarifário, sem OPC;
  - `"OPC"`: só `pct`, o desconto na taxa do operador, que este simulador
    não cota;
  - `"FINAL"`: `totalEur` = kWh × `eurKwh`, o carregamento **todo** (CEME,
    OPC, taxas e IVA), arredondado para cima ao cêntimo;
  - `"KWH_GRATIS"`: os primeiros `freeKwh` de cada mês civil não pagam
    energia nem TAR (o IEC, a activação e o IVA pagam-se). `freeKwhLeft` é
    o que ainda sobra deles e `totalEur` o CEME com esses kWh grátis no
    início do carregamento. O simulador não guarda nada sobre ninguém: quem
    chama diz quanto já carregou este mês em `monthKwh` (`{ "id do
    tarifário": kWh }`, até 100 entradas, senão `400 bad_month_kwh`). Sem
    entrada para o tarifário, conta-se o mês todo por gastar e
    `monthKwhKnown` vem `false`.

  `newCustomers: true` quer dizer que só vale para quem adere durante a
  promoção (e `maxHours`, se vier, quanto tempo dura depois da adesão), por
  isso nunca deve entrar no preço por omissão.
- As **datas devolvidas são UTC** (`toISOString()`), seja qual for a região.
  Passar para a hora local é com o cliente. As datas que **envias** em `at`
  seguem o offset que escreveres.

### `GET /v1/promos`

As promoções que ainda não acabaram, com `active` = já em vigor hoje. Os
campos: `id`, `ceme`, `name`, `network`, `target` (`ENERGIA`, `OPC`, `FINAL` ou `KWH_GRATIS`),
`eurKwh`, `pct` ou `freeKwh`, `from` e `to` (dias, inclusive), `newCustomers`,
`maxHours`, `tariffs` (ids; `null` = todos os do CEME), `regions`, `url` e
`checked` (o dia em que a lemos). Vêm de `PROMOS` em
`backend/src/db/seed-data.js`.

### Formatos gerais

Erros em `{error:{code,message}}`. Datas em ISO UTC. €/kWh com 4 casas,
totais com 2, com o arredondamento por parcela da fatura.

## Língua das páginas

As páginas bilingues (`/`, `/assistente`, `/simulador`, `/sobre`,
`/contactos`, `/privacidade`, `/omie` e a raiz de `omie.cocofree.dev`) chegam ao
browser já com a língua escolhida: o servidor troca o `<html lang>` e o
marcador `window.__LANG__=null` por `"pt"` ou `"en"`. O guia `/api` é só em
inglês.

A escolha vem do cabeçalho `Accept-Language` (`negotiateLang()`), e a
resposta leva `Vary: Accept-Language` (mais `Cookie` nas páginas que
dependem do cookie `ceme_ui`, vê [05](05-frontend.md)). Só passa a inglês
se a língua **preferida** (a de maior `q`) for inglês: um `en;q=0.8` atrás
de um `pt;q=0.9` fica em português. No browser, a bandeira escolhida
(guardada em `localStorage`) tem prioridade sobre o cabeçalho.

## Planos

Nada disto existe ainda; está no [roadmap](06-roadmap.md):

```
GET  /v1/tariffs/:id                    # versão em vigor + histórico
```

- `POST /v1/simulate` com filtro opcional `tariffs` (lista de ids) ou
  `ceme`, para cotar só alguns tarifários em vez de todos.
- `ETag`/`Last-Modified` em `GET /v1/cemes`, `/v1/tariffs` e `/v1/tar`
  (com `304` em `If-None-Match`/`If-Modified-Since`), para quem guarda em
  cache não gastar pedidos nem rate limit.

O `kind` do token é só informativo (aparece em `GET /v1/health`). O
desenho permite trocar quem emite os JWT por um serviço externo (Auth0,
Clerk, Cloudflare Access) sem mudar as rotas.
