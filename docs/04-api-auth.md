# 04 — API + auth total

## Princípio

Nenhum `/v1/*` responde sem `Authorization` — **excepção: `POST /v1/session`**,
que é precisamente quem emite o token (obviamente não pode exigir um). As
páginas HTML, os ficheiros estáticos (JS/CSS/PWA/ícones) e as sondas
`/healthz`/`/readyz` também não pedem auth — não são API. Qualquer outro
caminho cai na auth: sem credencial é **401**, não 404.

Web e terceiros usam o mesmo controlo — muda só o tipo de credencial. Os
favoritos continuam sem conta (localStorage), mas o browser envia sempre um
token.

## Credenciais

| cliente | emissão | envia |
|---|---|---|
| Sessão web anónima | `POST /v1/session` → JWT `WEB_SESSION` 24h (sem dados pessoais; `sid` é um identificador aleatório gerado no servidor — *ainda não há IP hash; em produção, uuid + hash de IP anti-abuso*) | `Bearer <jwt>` |
| App terceira | Chave provida via env `CEME_API_KEY` → no arranque, **só o sha256** vai para a BD (`api_key`, id fixo `env-key`); portal de emissão é fase 2 | `X-API-Key: <valor>` |

(Contas de admin/CEME com `USER` + `roles` são **fase 2** — não existem.)

O `X-API-Key` é **validado** contra o hash em BD (chaves revogadas ou
expiradas excluem) — qualquer string desconhecida recebe 401. O lookup tem
índice (`idx_api_key_hash`, nos dois schemas).

**A env é a fonte de verdade da chave `env-key`**, e a BD persiste entre
arranques (Postgres), por isso o arranque sincroniza nos dois sentidos:

- **com** `CEME_API_KEY`: upsert do hash e `revoked_at` limpo — **trocar** o
  valor da env invalida a chave antiga; voltar a pô-la reactiva;
- **sem** `CEME_API_KEY`: a linha `env-key` é **revogada** (`revoked_at`).

Revogar = tirar (ou trocar) a env e reiniciar. Testado em `server.test.js`
(«CEME_API_KEY — tirar a env revoga a chave»). Em `CEME_READONLY` nada disto
corre (a BD é de outro ambiente).

## Secret de sessão (`JWT_SECRET`)

O servidor arranca sempre; sem `JWT_SECRET` usa a secret de dev
(`dev-only-change-me`) com aviso no stdout. Em produção
(`NODE_ENV=production`), com a secret de dev em uso, o `POST /v1/session`
devolve **503** em vez de emitir tokens — `export
JWT_SECRET=<openssl rand -hex 32>` é obrigatório (ver `backend/.env.example`).

O `POST /v1/simulate` rejeita corpos acima de **64 KB** (413), JSON
inválido/não-objecto (400), `kwh` fora de (0, 1000], `at` não-ISO e rates
`omie*`/`omieCycles` não numéricas ou ≤ 0 (400 com `error.code` explícito),
e cada endpoint aceita só o seu método (405 com `Allow`). Um tarifário com
componentes divergentes, dados maus ou sem TAR para a região entra em
**quarentena**: sai da resposta (e fica no log do servidor, com o `id`) — os
restantes seguem; não há 400 vindo de um seed mal.

## Rate limit (em memória)

Janela fixa de 60 s, por processo — em produção, um limitador à frente do
server. Sessão web (Bearer) conta por IP: 60/min. `POST /v1/session` conta
por IP à parte: 10/min (é pré-auth; sem teto era a rota barata para
martelar JWT). Terceiros (X-API-Key) contam pela chave (o bucket é o
prefixo de 8 caracteres): 60/min ou o `api_client.rate_limit` da BD. Exceder devolve **429** com
`x-ratelimit-limit/remaining/reset` e `retry-after`. O mapa de buckets é
podado e tem teto (10 000 chaves) — IPs distintos em enxurrada não crescem
memória sem limite.

`x-content-type-options: nosniff` vai em todas as respostas JSON e no HTML
da UI.

## Endpoints (MVP)

## Endpoints implementados

```
GET  /healthz                           # liveness, sem auth; só o processo
GET  /readyz                            # readiness, sem auth e só de loopback; processo + BD
POST /v1/session                      # emite WEB_SESSION (24h), sem auth
GET  /v1/health                       # exige Authorization; confirma o token
GET  /v1/cemes                        # lista de comercializadores
GET  /v1/tariffs                      # todos os tarifários + a versão vigente
GET  /v1/tar                          # TAR em vigor (region, voltage, period, valid_from)
POST /v1/simulate                     # ver abaixo
GET  /v1/omie/daily?days=60           # agregados diários; days limitado a 7..120
GET  /v1/omie/futures                 # contratos OMIP
     Não é usado pela interface (removido do comparador); mantido para
     consumidores da API.
GET  /v1/omie/stats                   # estatísticas mensais + células de referência (docs/09)
GET  /v1/indexed/quarters?tariff=&region=&date=&fixed=&tz=
     Os quartos de um dia civil de Lisboa (`date`, por omissão hoje em
     Lisboa) para um indexado, cotados com a TAR da região. `tz` (IANA) é o
     fuso das horas `start`/`end` mostradas; cada quarto traz também o
     instante `utc`. `fixed` = id do fixo escolhido no comparador: devolve por
     quarto `fixed` (€/kWh) e `winner` (IDX|FIX|EQ|null), mais `wins` com as
     contagens; sem `fixed`, `winner` é sempre `null`. Um `tariff` que não é
     indexado cai no primeiro indexado. Erros: 400 `bad_region`, 404
     `no_indexed`, 502 `omie_unavailable`.
```

`POST /v1/session` devolve `{ token, expires_in }`; o JWT leva `kind`
(`WEB_SESSION`), `sid` e `exp`.

`/healthz` e `/readyz` são as rotas do Zerops (`run.healthCheck` e
`deploy.readinessCheck`, ver `infra.md`). São as únicas sem auth, porque o
balancer tem de as alcançar de dentro do container. `/readyz` faz um
`SELECT 1` à BD **só quando vem de loopback** (com prazo e cache curta); de
fora responde 200 com `db: unknown` (sem tocar na BD e sem chumbar um deploy
por um probe mal endereçado). BD em baixo: 503 `db_unavailable`.

`POST /v1/simulate` (o que a web usa):

```json
{ "kwh": 40, "at": "2026-10-18T01:00:00Z", "region": "CONT", "omie": 0.081,
  "omieCycles": { "DIARIO":  { "vazio": 0.105, "fora": 0.059 },
                  "SEMANAL": { "vazio": 0.098, "fora": 0.064 } } }
```

Devolve **todos** os tarifários em vigor no dia do carregamento (dia civil na
região), já cotados para o instante e a região pedidos, mais `avg` e
`omieRef`. A filtragem é do cliente. Cada tarifário traz `parts` — a conta
linha a linha (energia + TAR, IEC, activação, sem IVA, IVA), que soma o
`totalEur` ao cêntimo (docs/02).

`region` ∈ `CONT | MAD | AZO`. `at` ausente = agora.

Notas:
- `activation` da resposta é **o que o CEME publica no sheet capturado**
  — nunca substituído pelo regulamentar. Juntamente vão `egme_legal` (o
  valor legal 2026: 0,1088 €/carregamento, Regul. ERSE 7/2026) e
  `activation_stale` (`true` só quando o publicado é ainda o valor legal
  anterior — CEMEs que não actualizaram; taxas próprias acima do legal são
  legítimas e não contam). Actualizar é tarefa de
  verificação do seed, não de substituição no código (ver docs/02).
- OMIE dos indexados (`SPLIT_VAZIO_FORA`): com `omieCycles`, cada indexado
  usa o par vazio/fora **do seu ciclo**; sem ele, `omieVazio`/`omieFora`
  valem para todos (override explícito); sem nenhum, o `omie` único.
- Erros em `{error:{code,message}}`. As **datas devolvidas são UTC** (ISO
  `toISOString()`), independentemente da região; a conversão para a parede
  horária local do carregamento é no cliente. Datas *pedidas* em `at`
  seguem o offset que o cliente escrever.

## Endpoints planeados (fase 2)

```
GET  /v1/tariffs/:id                 # inclui versão vigente + histórico
GET  /v1/tariffs/:id/quote?at=&kwh=   # um só tarifário (a decomposição já vem no /v1/simulate)
POST /v1/suggestions                   # cria suggestion PENDING (sessão ou user)
GET  /v1/suggestions/mine
# portal CEME (role ceme_editor, só o seu ceme_id)
GET  /v1/ceme/tariffs
POST /v1/ceme/tariffs/:id/versions    # cria DRAFT/SCHEDULED (campanha/futuro)
# admin
GET  /v1/admin/suggestions?status=
POST /v1/admin/suggestions/:id/approve  # cria tariff_version
POST /v1/admin/suggestions/:id/reject
```

Erros em `{error:{code,message}}`; datas ISO (UTC);
€/kWh com 4 casas, totais com 2 — `ROUNDUP` por componente antes de somar,
como na fatura.

## Negociação de idioma

As páginas bilíngues (`/`, `/assistente`, `/simulador`, `/sobre`,
`/contactos`, `/omie` e a raiz do `omie.cocofree.dev`) recebem a língua
detectada no HTML: o servidor troca o `<html lang>` e substitui o marcador
`window.__LANG__=null` (espaços tolerados) por `"pt" | "en"`. O guia `/api`
é só em inglês. Vem do
cabeçalho `Accept-Language` (`negotiateLang()`), e a resposta leva
`Vary: Accept-Language` — mais `Cookie`, porque a página servida em `/`
também depende do cookie `ceme_ui` (ver `docs/05`).

Só passa a inglês se o **primeiro** tag da lista ordenada por `q` for `en*` —
um `en;q=0.8` atrás de um `pt;q=0.9` não ganha, porque o público-alvo é
português. O cliente pode sobrepor via bandeira, que persiste em
`localStorage` e tem precedência sobre o cabeçalho.

## Autorização

(Plano de fase 2 — o `kind` do payload só é informativo, ver
`GET /v1/health`; os endpoints de escrita ainda **não** existem.)

- `WEB_SESSION`: só leitura + `POST /suggestions`.
- `USER ceme_editor`: leitura + escrita só em `ceme_id` próprio.
- `USER admin`: tudo + moderação.
- `THIRD_PARTY`: leitura conforme plano da key (MVP: tudo o que a web vê).

Sem OAuth externo nesta fase (custo zero) — desenho permite trocar o
emissor JWT por Auth0/Clerk/Cloudflare Access depois sem mudar rotas.
