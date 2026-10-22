# Infra — ceme-v2 no Zerops + Cloudflare

Este documento descreve a infraestrutura alvo do projeto. É o ponto único de verdade (source of truth) de infra até que exista algo mais formal.

---

## 1. Princípios

- **Sem painel de admin nem de editor** (desistido). Atualizações de tarifários via seed/MCP server, discutido à parte.
- **Backend e frontend vivem no Zerops.** O serviço `api` (Node.js) serve tanto a API REST em `/v1/*` como o frontend estático em `/`.
- **Base de dados:** PostgreSQL gerenciado no Zerops (substitui o SQLite local). A seed passa a ser bootstrap inicial; a source of truth é a BD ao vivo.
- **Cache:** o OMIE vive na **BD** (`omie_spot`, `omie_daily`, `omie_meta`) — persiste entre deploys e é partilhado entre réplicas. Só os CSV grandes do TF ficam em disco, como cache descartável (por réplica). Sem serviço Redis/Valkey.
- **DNS:** subdomínio no Cloudflare, proxy activo, origem IPv6 no Zerops.

---

## 2. Serviços Zerops (`zerops.yml`)

| Serviço | Tipo | Versão | Função |
|---|---|---|---|
| `api` | nodejs | 24 (topo da base list do Zerops; `nodejs@latest` = 24) | Node.js puro (`src/server.js`). Serve frontend + API. Escuta em `PORT=3001`. |
| `db` | postgresql | 18 | BD principal. Tabelas: `ceme`, `tariff`, `tariff_version`, `price_component`, `tar`, `omie_spot`, `omie_daily`, `omie_meta`, `api_client`, `api_key`, `audit_log`, etc. |


Recursos (fixados via autoscaling, ver abaixo):
- `api`: 1–2 vCPU, 0.25–1 GB RAM, 1–5 GB disco, **1 container em repouso / 2 durante o deploy** (ver "Deploy sem downtime" abaixo).
- `db`: 1–2 vCPU, 0.25–1 GB RAM, 1–5 GB disco (Postgres `:single`).
(serviço `cache` removido — não usado)

### Autoscaling (fixado por API, `PUT /service-stack/{id}/autoscaling`)

Os serviços managed `db` e `cache` herdaram dos perfis `oltp-staging`/`staging` um teto de **8 vCPU / 48 GB RAM / 250 GB de disco**. São tetos e não consumo (a faturação é pelo uso), mas o **disco nunca encolhe** — por isso ficam fixados:

| Serviço | max antes | max agora | min |
|---|---|---|---|
| `api` | 2 CPU / 1 GB / 10 GB, 1–2 containers | 2 CPU / 1 GB / 5 GB | 1 CPU / 0.25 GB / 1 GB, **1–2 containers** |
| `db` | 8 CPU / 48 GB / 250 GB | **2 CPU / 1 GB / 5 GB** | 1 CPU / 0.25 GB / 1 GB |
| `cache` | — | removido | — |

Todos em `SHARED`, `startCpuCoreCount: 1`.

```json
{ "customAutoscaling": { "verticalAutoscaling": {
  "cpuMode": "SHARED",
  "maxResource": { "cpuCoreCount": 2, "memoryGBytes": 1, "diskGBytes": 5 },
  "minResource": { "cpuCoreCount": 1, "memoryGBytes": 0.25, "diskGBytes": 1 },
  "minFreeResource": { "cpuCoreCount": 0.1, "cpuCorePercent": 0, "memoryGBytes": 0.125, "memoryPercent": 0 },
  "startCpuCoreCount": 1, "swapEnabled": true } } }
```

O `horizontalAutoscaling` do `api` é `{ "minContainerCount": 1, "maxContainerCount": 2 }`.
O `minContainerCount: 1` é de propósito: a app é stateless e o custo de um
pod de reserva permanente não se justifica. O `maxContainerCount: 2` é o que
dá a sala de sobreposição ao deploy (o pod novo nasce ao lado do velho).

Duas regras da API que custaram tempo:
- `minFreeResource.memoryGBytes` aceita **no máximo 3 casas decimais** → `0.0625` é rejeitado, tem de ser `0.1` (ou `0.125`).
- O Postgres tem mínimo de RAM próprio (**0.25 GB**); o `minFreeResource` do `db` tem de ser `>= 0.125`, não `0.0625`.

Para ler o estado efectivo: `GET /service-stack/{id}` → `currentAutoscaling` (efectivo) vs `customAutoscaling` (o que foi pedido; `null` = herda do perfil).

Rede: todos os serviços estão na mesma rede privada do projeto Zerops. O `api` alcança o `db` pelo hostname interno (ex: `db`) e as credenciais são injetadas via `DATABASE_URL`.

Deploy: `zcli push api --setup api` na raiz do repo (CI: ver secção 4).

Criação dos serviços: `zerops-import.yaml` na raiz do repo + `zcli project service-import zerops-import.yaml -P <project-id>`. O `JWT_SECRET` do `api` é gerado nesse import (`<@generateRandomString(<32>)>`, precisa de `#yamlPreprocessor=on`).

### Armadilhas do `run.start` (encontradas no primeiro deploy)

- **`run.start` é executado por `exec`, não por um shell.** `start: cd backend && npm start` falha com `exec: cd: not found` (exit 127) e o serviço entra em crash loop. O directório vai em `startCommands[].workingDir` (default `/var/www`); o código, com `deployFiles: [backend, frontend]`, fica em `/var/www/backend`.
- **Health check na rota errada é pior que nenhum.** `/v1/health` está atrás de auth e responde **401 sem token** — usá-la no `healthCheck` marcaria o serviço como unhealthy para sempre. O `healthCheck` aponta a `/healthz` e o `readinessCheck` a `/readyz` (ver abaixo).
- `zcli push` com o default `-w all` faz `git archive`, que falha (exit 128) quando o `zerops.yml` só existe em working tree não-commitado; commitar antes de fazer push.

### Deploy sem downtime (rolling)

O `zerops.yml` do serviço `api` está configurado para **rolling deploy** — o
serviço nunca fica sem um pod a servir:

```yaml
deploy:
  temporaryShutdown: false
  readinessCheck:
    httpGet: { port: 3001, path: /readyz }
    failureTimeout: "120s"
    retryPeriod: "10s"
run:
  healthCheck:
    httpGet: { port: 3001, path: /healthz }
    failureTimeout: "60s"
    disconnectTimeout: "30s"
    recoveryTimeout: "30s"
    execPeriod: "10s"
```

O que acontece, por ordem:

1. O build corre num container temporário — o `api` vivo não se mexe.
2. O artefacto vai para o storage interno do Zerops.
3. O container novo arranca **ao lado** do velho (`temporaryShutdown: false`;
   `maxContainerCount: 2` dá a sala para os dois coexistirem).
4. O `readinessCheck` pergunta a `/readyz` no container novo: 200 só quando o
   processo responde **e a BD responde**.
5. Passando o check, o container novo entra no balancer; o velho sai de lá e é
   apagado.
6. Se o check não passar em 120 s, o container novo é apagado, a appVersion fica
   `DEPLOY_FAILED` e **a versão anterior continua a servir**. Um deploy mau
   não é uma queda do site.

Duas rotas novas no `server.js`, sem auth (o balancer tem de as alcançar de
dentro do container):

| rota | usada por | toca na BD |
|---|---|---|
| `GET /healthz` | `run.healthCheck` (liveness) | não |
| `GET /readyz` | `deploy.readinessCheck` | sim (`SELECT 1`, com prazo de 3 s), **só de loopback** |

Porque não o mesmo check para os dois: com **um só pod**, um health check que
dependa da BD tira o pod do balancer quando a BD tem uma blip — e o site
inteiro cai, em vez de só a API. O liveness responde só "o processo está vivo";
o readiness, que só corre durante o deploy, é que exige a BD.

De fora do loopback, o `/readyz` responde 200 com `db: unknown` e não toca na
BD: é um check interno (ninguém de fora precisa dele) e um `SELECT 1` por
pedido seria um caminho grátis para esgotar o pool. E o 200 (e não 403) é
deliberado — um probe mal endereçado nunca pode chumbar um deploy.

`minContainers: 1` continua a ser de propósito. Com dois pods em repouso o
custo dobra e o gain é só contra a queda de um pod (o health check reinicia-o
em ~1 min); o deploy sem downtime não precisa desse segundo pod permanente.
Aí o que faz o trabalho é o `maxContainerCount: 2`, que é o que dá a
sobreposição.

### Verificado em produção (2026-10-22)

O guard foi testado nos dois sentidos, no serviço real.

**Deploy bom** (PR #29, appVersion `XlHwZJdIQnKfUqaSQ85aoA`):

```
00:45:39  Readiness check: container check failed - attempt 1/12 - connection refused
00:45:40  ceme-v2 http://localhost:3001/ db=postgresql
00:45:49  Readiness check: container check successful - ready after 2 attempts (took 10s)
00:45:55  ✅ exec npm start        (o container velho sai de serviço)
```

O pod novo só entrou no balancer 10 s depois de o app abrir a porta, e o
velho saiu depois disso. O site esteve a 200 durante todo o deploy.

**Deploy mau** (PR #30, appVersion `A7AiBuznT0i5vkaRAIHVAQ`): o
`readinessCheck` apontava para um caminho que não existe, de propósito.

```
00:48:41  Readiness check: container check failed - attempt 1/12
00:50:31  Readiness check: container check failed - attempt 12/12 (failing for 1m50s)
00:50:32  DEPLOY_FAILED
```

- A appVersion ficou `DEPLOY_FAILED`; a anterior (`XlHwZJdIQnKfUqaSQ85aoA`)
  continuou **`ACTIVE`** e a servir.
- Os containers: o velho (`api-runtime-23-645`) `ACTIVE`, o novo `FAILED` —
  o velho **não** foi removido.
- O site respondeu **200** nos dois domínios em todos os 127 polls (2 s de
  intervalo) durante a janela toda, `/healthz` incluído.

Nota: o probe do Zerops aceita códigos em `[200,400)` — 3xx passa, 401/404/503
reprovam. E o `readinessCheck` só corre de dentro do container
(`127.0.0.1:3001/...`), como o `healthCheck`.

Docs: <https://docs.zerops.io/guides/readiness-health-checks> e
<https://docs.zerops.io/guides/deployment-lifecycle>.

### Armadilhas de schema (o `CREATE TABLE IF NOT EXISTS` não é uma migração)

O schema é aplicado no arranque com `CREATE TABLE IF NOT EXISTS`. Isso
cria as tabelas que faltam, mas **nunca acrescenta colunas a uma tabela que
já existe** — e a BD de produção tem as tabelas todas.

> **Ao acrescentar uma coluna a uma tabela que já existe em produção: o
> deploy rebenta com o site em 502.** O seed vai à vida com
> `column "<coluna>" of relation "<tabela>" does not exist`, o serviço entra
> em crash loop e o health check falha — os dois domínios devolvem 502.
> Foi o que aconteceu a 2026-10-22 com `price_component.energy_only_eur_kwh`.

A correcção é uma migração em `backend/src/db/migrate.js`
(`ADDED_COLUMNS` + `migrateAddedColumns()`), que corre no arranque **depois
do schema e antes do seed** e faz o `ALTER TABLE ... ADD COLUMN` do que
falta. Quando se acrescenta uma coluna:

1. acrescentá-la ao schema — `backend/src/db/schema.sql` **e**
   `backend/src/db/schema.postgres.sql` (os dois dialetos);
2. acrescentá-la a `ADDED_COLUMNS` em `backend/src/db/migrate.js`;
3. o teste `backend/test/migrate.test.js` verifica que as duas coisas batem
   certo — se falhar, é porque falta uma das duas.

Duas notas:

- A introspecção das colunas no Postgres usa `to_regclass` (resolve o nome
  pelo `search_path`), e não `information_schema`: é o mesmo caminho pelo
  qual as queries do servidor acedem às tabelas, portanto a migração vê a
  mesma tabela que o seed vai escrever.
- A coluna nova nasce **nula e sem default** — não se inventa valor para as
  linhas que já lá estavam. O seed (que é um upsert) preenche depois o que
  sabe.

---

## 3. DNS e Cloudflare (domínio próprio)

### Estado actual (feito e verificado)
- Domínio: **`https://ceme-beta.ocarroeletrico.com`** → 200, serve o frontend e a API.
- Registos Cloudflare: **só `AAAA`** → o IPv6 dedicado do projecto, **proxy activo**. O endereço **não** está neste documento (ver "Segredo: o IP da origem" abaixo).
- Zeroops: hostname registado no L7 balancer (`public-http-routing`), com certificado Let's Encrypt **ACTIVE** para `ceme-beta.ocarroeletrico.com`.
- **Segundo domínio:** `https://omie.cocofree.dev` → a página das estatísticas
  OMIE (ver `docs/09-omie-estatisticas.md`). Vive no **mesmo** balancer e no
  **mesmo** serviço `api`: o que muda é o `Host` — o servidor passa a ler o
  cabeçalho `Host` e, nesse domínio, a raiz é a página OMIE em vez do
  simulador. A zona `cocofree.dev` (uma zona diferente da do
  `ocarroeletrico.com`) já tinha `ssl: strict`, `ipv6: on` e
  `always_use_https: on` — não foi preciso mexer nas settings.

### IP da origem

**Regra: o IP da origem vive só na Cloudflare e na consola do Zerops — nunca no repositório.**

Para o consultar (sem o escrever no repo):
```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/zerops/cli.data'))['LoginSession']['AccessToken'])")
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.app-prg1.zerops.io/api/rest/public/project/<project-id>" | python3 -c "import sys,json;print(json.load(sys.stdin)['publicIpV6'])"
```

### A ordem certa (e porque é que a ordem errada não funciona)

São **dois** registos em sistemas diferentes, e o Zerops tem de ser o primeiro:

1. **Zerops — registar o hostname no L7 balancer.** Sem isto, o hostname não é roteado: o balancer devolve **404** a qualquer `Host` que não esteja na tabela de routing. É esta tabela que decide que `ceme-beta.ocarroeletrico.com` → serviço `api`, porta 3001.

   ```bash
   POST /api/rest/public/project/<project-id>/public-http-routing
   {
     "domains": ["ceme-beta.ocarroeletrico.com"],
     "locations": [{ "path": "/", "port": 3001, "serviceStackId": "<api-service-id>" }],
     "sslEnabled": true,
     "cdnEnabled": false
   }
   ```

   A resposta fica com `dnsCheckStatus: PENDING` e `sslStatus: WAITING_FOR_DNS` — o Zerops espera pelo registo DNS antes de emitir o certificado (HTTP-01).

   > **Para juntar um domínio a um balancer que já existe:** o `POST` de
   > cima **cria** um routing novo e falha com
   > `publicHttpRoutingDuplicateDomainNameInAnotherRouting` se o hostname já
   > lá estiver. O que se usa é o **PUT** do routing existente:
   >
   > ```bash
   > PUT /api/rest/public/public-http-routing/<routing-id>
   > { "domains": [...], "locations": [...], "sslEnabled": true, "cdnEnabled": false }
   > ```
   >
   > E **depois** de o `PUT`, o routing fica `isSynced: false` — a tabela de
   > routing só entra no balancer depois de um
   > `PUT /api/rest/public/project/<project-id>/sync-public-http-routing`
   > (sem body). Sem esse sync, o balancer continua a responder **404** ao
   > `Host` novo. O `locations` copia-se tal e qual do que já lá está — é
   > onde vive o `accessPolicy` que só aceita tráfego da Cloudflare.

2. **Cloudflare — o registo DNS.** Só depois de o hostname estar registado no Zerops (para o `Host` ser reconhecido) é que o AAAA faz sentido.

   ```
   ceme-beta.ocarroeletrico.com  AAAA  <IPv6 dedicado do projecto>  proxy: ON
   ```

3. **Zerops — validar o DNS.** `PUT /api/rest/public/public-http-routing/<id>/trigger-domains-dns-check` (body: `{"domains": [...]}`). Passa a `dnsCheckStatus: OK` e o certificado é emitido (`sslStatus: ACTIVE`).

### Porquê só `AAAA` e não também o `A` partilhado
O IPv4 partilhado do Zerops faz um **reverse lookup do AAAA** do domínio para decidir se o pedido pertence a este projecto. Se o `AAAA` estiver com proxy activo, o lookup vê o IP da Cloudflare em vez do IPv6 do projecto e o roteamento falha. A doc da Cloudflare é explícita: *"Do not add a proxied A record with shared IPv4"*.

Com proxy activo e origem só IPv6, a Cloudflare faz a tradução IPv4→IPv6 no edge (IPv6 Compatibility da zona, que está `on`) — os clientes IPv4 chegam à mesma origem.

### lockdown da origem (a defesa que não depende de segredo)

Esconder o IP é defense-in-depth, não defense. O L7 balancer do Zerops aceita um `accessPolicy` com lista de CIDRs e política por omissão — usa-se para **só aceitar tráfego da Cloudflare**. Se o IP vazar, quem chegar directamente é rejeitado na origem.

```json
"config": {
  "accessPolicy": {
    "enabled": true,
    "defaultPolicy": "deny",
    "cidr": [ "<ranges IPv4 da Cloudflare>", "<ranges IPv6 da Cloudflare>" ],
    "realIpHeader": "CF-Connecting-IP",
    "setRealIpFrom": [ "<ranges da Cloudflare>" ]
  }
}
```

As listas oficiais estão em `https://www.cloudflare.com/ips-v4` e `https://www.cloudflare.com/ips-v6` (mudam de vez em quando — convém rever).

> **Atenção:** o `accessPolicy` aplica-se ao balancer do projecto. Se ficar mal configurado, o tráfego legítimo também é cortado — activar e depois verificar `https://ceme-beta.ocarroeletrico.com` a responder 200.

### Modo SSL/TLS na zona
`ssl: strict` (Full strict) e `ipv6: on` — o que a doc do Zerops exige. `always_use_https: on` está activo, o que em princípio interfere com a validação HTTP-01 do Let's Encrypt; se o certificado não for emitido, criar uma Configuration Rule para desligar o *Automatic HTTPS Rewrites* em `/.well-known/acme-challenge/`.

### Reproduzir por API
```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/zerops/cli.data'))['LoginSession']['AccessToken'])")
API=https://api.app-prg1.zerops.io/api/rest/public
# ver as rotas
curl -s -H "Authorization: Bearer $TOKEN" "$API/project/<project-id>/public-http-routing"
```
A spec completa está em `GET $API/swagger/openapi.yml` (o `/swagger` faz 301 para o GUI, o `openapi.yml` é o JSON/YAML real).

### Diagnóstico rápido do routing
```bash
# a origem responde com o Host certo? (usar o IP obtained da API, não um literal)
curl -sk -H "Host: ceme-beta.ocarroeletrico.com" "https://[<IPv6 do projecto>]/" -o /dev/null -w '%{http_code}\n'
# 200 = origem OK; 404 = hostname não registado no L7; 502 = cert/origem
# 403 = accessPolicy a bloquear (verificar se o cliente é a Cloudflare)
```

---

## 4. CI/CD — GitHub Actions (testes) + webhook Zerops (deploy)

### 4.1 CI — `.github/workflows/ci.yml`

Um único job `test`, em push para `main` e em PRs: `npm ci` + `npm test` (Node 24, o mesmo que o `zerops.yml` suporta; testar noutro número daria um verde que a produção não reproduz).

### 4.2 Deploy — webhook do Zerops (sem credenciais no GitHub)

O deploy **não** é feito pelo GitHub Actions. É o próprio Zerops que puxa o repositório quando o push chega a `main`:

> Serviço `api` → **Build, Deploy, Run Pipeline Settings** → **Connect with a GitHub repository** → trigger **Push to branch: `main`**.

**Estado: ligado e verificado.** Webhook `701068038` no repo `CarregaErvilhas/CEME` (eventos `push`, activo, com segredo HMAC). A integração do serviço ficou:

```json
{ "repositoryFullName": "CarregaErvilhas/CEME", "eventType": "BRANCH",
  "branchName": "main", "isActive": true, "webhookId": 701068038,
  "zeropsYamlSetup": "api", "authorizationRequired": false }
```

Teste real (merge do PR #9 → `main`): pipeline `J7ngdRp5Q7iuAP4oSgnvuA`, "Build commands from zerops.yml ran successfully", app version `main@9ad8fcf7` criada e serviço actualizado — **1 min 11 s** do push ao deploy. O site respondeu 200 com 128 tarifários logo a seguir.

Notas:
- `zeropsYamlSetup: "api"` tem de corresponder ao `setup:` do `zerops.yml` — é isso que diz ao Zerops qual bloco do YAML usar.
- A integração só se vê na API do **serviço** (`GET /service-stack/{id}` → `githubIntegration`). O endpoint `external-repository-integration-status` responde `githubAuthorizationRequired` a partir de uma sessão que não seja a conta OAuth autorizada — é identidade da sessão, não um sinal de falha.
- O `redirect_uri` do OAuth da Zerops só aceita o callback registado (`https://app.zerops.io/`) — o GitHub recusa `127.0.0.1` com *"The redirect_uri is not associated with this application"*. Por isso esta parte faz-se no GUI, não por API.

Porque é que não é `zcli push` na CI: essa via obrigava a guardar um **token de admin da conta Zerops** como secret do GitHub. Notas sobre o que a Zerops oferece e porque foi descartado:
- Os tokens com escopo existem (**Settings → Access Tokens Management** → acesso *Custom per project*, limitado ao projeto CEME), o que reduz o blast radius face a *Full access to all projects*. Mas mesmo assim continua a ser uma credencial de longa duração, com acesso de leitura a env vars sensíveis (`JWT_SECRET`, `DATABASE_URL`) e a backups, guardada num sítio que qualquer pessoa com push a `main` consegue ler.
- A Zerops não suporta (ainda) tokens efémeros/OIDC federation, portanto não dá para trocar por credenciais de curta duração.

O webhook elimina a credencial no GitHub por completo. Trade-off aceite: perdemos o `needs: test` explícito do lado do deploy — o que garante que nada chega a `main` sem testes verdes passa a ser a **branch protection** (4.3), que é o controlo certo de qualquer forma.

### 4.3 Branch protection do `main` (pré-requisito do gating)

O gating está feito por um **ruleset** (não pela branch protection clássica), porque o GitHub Free não a impõe em repos públicos de organização:

- Ruleset `25509982`, alvo `main`, `enforcement: active`.
- `required_status_checks`: check `test`, com `strict_required_status_checks_policy: true` (o branch tem de estar actualizado com `main`).
- `pull_request` com `required_review_thread_resolution: true` — **qualquer thread de review por resolver bloqueia o merge**. Cuidado: um *suggestion* esquecido (mesmo do próprio autor) trava o PR. Resolver com `mutation { resolveReviewThread(input:{threadId:"..."}) }` pela API.
- `non_fast_forward` e `deletion`: sem force-push nem apagar a branch.

Sem isto, um push direto a `main` (ou um merge com checks vermelhos) chega ao Zerops e é deployado.

### 4.4 Segredos

**Nenhum segredo Zerops no GitHub.** O `JWT_SECRET` (e futuro `CEME_API_KEY`) são env secrets do serviço `api` no Zerops (ver secção 2). O DNS é configuração única manual na Cloudflare (o IPv6 do Zerops é estático).

### Preview por PR

Não implementado (future improvement, ver secção 5). PRs correm apenas os testes.

---

## 5. Dev replica por PR — dá?

**Sim, dá**, com a ressalva de que o Zerops não tem necessariamente uma feature nativa chamada “Preview Environments” como o Vercel. O que se faz é:

1. No GitHub Actions, ao abrir um PR, executar um script que:
   - Cria um projeto (ou ambiente) novo no Zerops com nome baseado no número do PR (`ceme-v2-pr-42`).
   - Faz `zcli push` desse projeto.
   - Aponta um subdomínio de preview (ex: `pr-42.ceme-beta.ocarroeletrico.com`) para o IP/IPv6 desse projeto.
   - Comenta o PR com a URL.

2. Quando o PR é fechado ou mergeado:
   - O mesmo workflow executa `zcli destroy` desse projeto de preview.
   - Remove o registo DNS do subdomínio de preview.

3. Quando se faz merge para `main`:
   - O workflow de produção faz `zcli push` no projeto principal.
   - Atualiza o DNS do subdomínio de produção se necessário.

Isso dá ambientes efémeros por PR, destruídos automaticamente, e produção atualizada no merge para `main`.

**Custo:** cada preview consome recursos do Zerops enquanto está ativo. Como os previews são destruídos ao fechar o PR, o custo fica controlado.

---

## 6. Backups e recuperação

- O serviço `db` (PostgreSQL) no Zerops tem backups automáticos (configurável no `zerops.yml` ou na consola).
- Em caso de perda da BD, restaurar do backup do Zerops. **Não recriar via seed** (a seed é só bootstrap de ambiente vazio).
- Manter um dump ocasional do esquema + dados de referência fora do Zerops (opcional, para pet project).

---

## 7. O que não existe nesta fase (e não vamos construir)

- Painel de admin para tarifários.
- Painel de editor para CEMEs atualizarem os próprios tarifários.
- Autenticação complexa além do JWT HS256 existente.

Substituição futura: MCP server para gestão de tarifários (a discutir depois).

---

## 8. Checklist de implementação

- [x] Criar `zerops.yml` (feito).
- [x] Criar `schema.postgres.sql` e `pg.js`.
- [x] Adaptar `server.js` para `pg`.
- [x] `npm install pg` + `npm test` verdes localmente.
- [x] Criar serviços `api`, `db`, `cache` no projeto Zerops (`zerops-import.yaml`).
- [x] `zcli push api` → deploy verificado: `GET /` 200, `/v1/tariffs` com 128 tarifários e 24 CEMEs do seed.
- [x] Registar `ceme-beta.ocarroeletrico.com` no L7 balancer do Zerops (`public-http-routing`), certificado Let's Encrypt ACTIVE.
- [x] Registo `AAAA` no Cloudflare com proxy activo → `https://ceme-beta.ocarroeletrico.com` a 200.
- [x] Desligar o subdomínio Zerops (o `api` acede ao `db` pelo hostname interno `db`).
- [x] Fixar o autoscaling dos três serviços (tetos de 8 CPU/48 GB/250 GB → 2 CPU/1 GB/5 GB).
- [x] GitHub Actions (só CI; secção 4).
- [x] Ruleset do `main` com o check `test` obrigatório e PR obrigatório.
- [x] Webhook do Zerops ligado ao repo (trigger: push para `main`; secção 4.2) — webhook `701068038`.
- [x] Merge to `main` → build+deploy automático pelo Zerops (1 min 11 s, verificado).
- [x] Deploy sem downtime: `readinessCheck` (`/readyz`) + `temporaryShutdown: false` no `zerops.yml`.
- [x] Rotas de liveness/readiness no `server.js` (`/healthz`, `/readyz`) + testes.
- [x] `maxContainerCount: 2` no serviço `api` (via API) e no `zerops-import.yaml`.
- [ ] (futuro) Preview por PR.
