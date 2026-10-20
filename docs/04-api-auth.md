# 04 — API + auth total

## Princípio

Nenhum `/v1/*` responde sem `Authorization` — **excepção: `POST /v1/session`**,
que é precisamente quem emite o token (obviamente não pode exigir um). E o
ficheiro estático (`GET /`), que não é API.

Web e terceiros usam o mesmo controlo — muda só o tipo de credencial. Os
favoritos continuam sem conta (localStorage), mas o browser envia sempre um
token.

## Credenciais

| cliente | emissão | envia |
|---|---|---|
| Sessão web anónima | `POST /v1/session` → JWT `WEB_SESSION` 24h (sem dados pessoais; `sid` é um identificador aleatório gerado no servidor — *no POC não há IP hash; em produção, uuid + hash de IP anti-abuso*) | `Bearer <jwt>` |
| Conta (admin/CEME) | registo com email + magic link local (sem SendGrid; token impresso no log em dev) → JWT `USER` com `roles` | `Bearer <jwt>` |
| App terceira | POC: chave provida via env `CEME_API_KEY` → inserida no arranque com **só o sha256** na BD (`api_key`); portal de emissão fica para fase 2 | `X-API-Key: <valor>` |

O `X-API-Key` é **validado** contra o hash em BD (chaves revogadas ou
expiradas excluem) — qualquer string desconhecida recebe 401. O lookup
tem índice (`idx_api_key_hash`). Em POC, a chave vem da env
(`CEME_API_KEY`), inserida em cada arranque: sem `UNIQUE` em
`api_key.prefix` e com `INSERT OR REPLACE` no id fixo, **a revogação
real é remover a env** — a BD não sobrevive ao restart.

## Secret de sessão (`JWT_SECRET`)

O POC arranca sempre; sem `JWT_SECRET` usa a secret de dev
(`dev-only-change-me`) com aviso no stdout. Em produção
(`NODE_ENV=production`), com a secret de dev em uso, o `POST /v1/session`
devolve **503** em vez de emitir tokens — `export
JWT_SECRET=<openssl rand -hex 32>` é obrigatório (ver `backend/.env.example`).

O `POST /v1/simulate` rejeita corpos acima de **64 KB** (413), JSON
inválido/não-objecto (400), `kwh` fora de (0, 1000], `at` não-ISO e rates
`omie*` não numéricas ou ≤ 0 (400 com `error.code` explícito), e cada
endpoint aceita só o seu método (405 com `Allow`). com componentes divergentes ou dados maus entra em **quarentena**
(`skipped`, fora do ranking, com `id` no output) — os restantes seguem;
não há 400 vindo de um seed mal.

## Rate limit (POC, em memória)

Janela fixa de 60 s, por processo — em produção, um limitador à frente do
server. Sessão web (Bearer) conta por IP: 60/min. `POST /v1/session` conta
por IP à parte: 10/min (é pré-auth; sem teto era a rota barata para
martelar JWT). Terceiros (X-API-Key) contam pela chave: 60/min ou o
`api_client.rate_limit` da BD. Exceder devolve **429** com
`x-ratelimit-limit/remaining/reset` e `retry-after`. O mapa de buckets é
podado e tem teto (10 000 chaves) — IPs distintos em enxurrada não crescem
memória sem limite.

`x-content-type-options: nosniff` vai em todas as respostas JSON e no HTML
da UI.

## Endpoints (MVP)

## Endpoints implementados (POC)

```
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
GET  /v1/indexed/quarters?tariff=&region=&date=&fixed=
     `fixed` = id do tarifário fixo escolhido no comparador. Devolve por
     quarto `fixed` (€/kWh) e `winner` (IDX|FIX|EQ|null), mais `wins` com as
     contagens. Sem `fixed`, `winner` é sempre `null` e a UI esconde as
     colunas — não há vencedor por omissão.
                                     # quartos de um indexado; 400 se region ≠ CONT|MAD|AZO
```

`POST /v1/simulate` (o que a web usa):

```json
{ "kwh": 40, "at": "2026-10-18T01:00:00Z", "region": "CONT",
  "omie": 0.081, "omieVazio": 0.105, "omieFora": 0.059 }
```

Devolve **todos** os tarifários (24 CEME, 128), já cotados para o instante e a
região pedidos, mais `avg` e `omieRef`. A filtragem é do cliente.

`region` ∈ `CONT | MAD | AZO`. `at` ausente = agora (na região).

Notas:
- `POST /v1/simulate` devolve **todos** os tarifários (24 CEME, 128
  tarifários), para qualquer região — a filtragem é do cliente.
- `omieVazio`/`omieFora` alimentam a agregação `SPLIT_VAZIO_FORA` dos
  indexados; sem eles o motor usa o `omie` único para todas as bandas.
- Erros em `{error:{code,message}}`. As **datas devolvidas são UTC** (ISO
  `toISOString()`), independentemente da região; a conversão para a parede
  horária local do carregamento é no cliente. Datas *pedidas* em `at`
  seguem o offset que o cliente escrever.

## Endpoints planeados (fase 2)

```
GET  /v1/tariffs/:id                 # inclui versão vigente + histórico
GET  /v1/tariffs/:id/quote?at=&kwh=   # decomposto: energia/TAR/IEC/IVA/EGME
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

Erros em `{error:{code,message}}`; datas ISO (UTC, como no POC);
€/kWh com 4 casas, totais com 2 — `ROUNDUP` por componente antes de somar,
como na fatura.

## Negociação de idioma

`GET /` injecta a língua detectada no HTML: troca o `<html lang>` e escreve
`window.__LANG__ = "pt" | "en"`. Vem do cabeçalho `Accept-Language`
(`negotiateLang()`), e a resposta leva `Vary: Accept-Language`.

Só passa a inglês se o **primeiro** tag da lista ordenada por `q` for `en*` —
um `en;q=0.8` atrás de um `pt;q=0.9` não ganha, porque o público-alvo é
português. O cliente pode sobrepor via bandeira, que persiste em
`localStorage` e tem precedência sobre o cabeçalho.

## Autorização

(Plano de fase 2 — no POC o `kind` do payload só é informativo, ver
`GET /v1/health`; os endpoints de escrita ainda existem.)

- `WEB_SESSION`: só leitura + `POST /suggestions`.
- `USER ceme_editor`: leitura + escrita só em `ceme_id` próprio.
- `USER admin`: tudo + moderação.
- `THIRD_PARTY`: leitura conforme plano da key (MVP: tudo o que a web vê).

Sem OAuth externo nesta fase (custo zero) — desenho permite trocar o
emissor JWT por Auth0/Clerk/Cloudflare Access depois sem mudar rotas.
