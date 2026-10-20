# Infra — ceme-v2 no Zerops + Cloudflare

Este documento descreve a infraestrutura alvo do projeto. É o ponto único de verdade (source of truth) de infra até que exista algo mais formal.

---

## 1. Princípios

- **Sem painel de admin nem de editor** (desistido). Atualizações de tarifários via seed/MCP server, discutido à parte.
- **Backend e frontend vivem no Zerops.** O serviço `api` (Node.js) serve tanto a API REST em `/v1/*` como o frontend estático em `/`.
- **Base de dados:** PostgreSQL gerenciado no Zerops (substitui o SQLite local). A seed passa a ser bootstrap inicial; a source of truth é a BD ao vivo.
- **Cache:** Valkey (Redis-compatível) para OMIE (6h) e sessões.
- **DNS:** subdomínio no Cloudflare, proxy activo, origem IPv6 no Zerops.

---

## 2. Serviços Zerops (`zerops.yml`)

| Serviço | Tipo | Versão | Função |
|---|---|---|---|
| `api` | nodejs | 24 (topo da base list do Zerops; `nodejs@latest` = 24) | Node.js puro (`src/server.js`). Serve frontend + API. Escuta em `PORT=3001`. |
| `db` | postgresql | 18 | BD principal. Tabelas: `ceme`, `tariff`, `tariff_version`, `price_component`, `tar`, `omie_spot`, `omie_daily`, `api_client`, `api_key`, `audit_log`, etc. |
| `cache` | valkey | 7.2 (única versão disponível no Zerops) | Cache OMIE (6h) e sessões. Opcional na fase 1. |

Recursos (fixados via autoscaling, ver abaixo):
- `api`: 1–2 vCPU, 0.25–1 GB RAM, 1–5 GB disco, 1 container.
- `db`: 1–2 vCPU, 0.25–1 GB RAM, 1–5 GB disco (Postgres `:single`).
- `cache`: 1 vCPU, 0.25–0.5 GB RAM, 1–2 GB disco.

### Autoscaling (fixado por API, `PUT /service-stack/{id}/autoscaling`)

Os serviços managed `db` e `cache` herdaram dos perfis `oltp-staging`/`staging` um teto de **8 vCPU / 48 GB RAM / 250 GB de disco**. São tetos e não consumo (a faturação é pelo uso), mas o **disco nunca encolhe** — por isso ficam fixados:

| Serviço | max antes | max agora | min |
|---|---|---|---|
| `api` | 2 CPU / 1 GB / 10 GB, 1–2 containers | 2 CPU / 1 GB / 5 GB | 1 CPU / 0.25 GB / 1 GB, 1 container |
| `db` | 8 CPU / 48 GB / 250 GB | **2 CPU / 1 GB / 5 GB** | 1 CPU / 0.25 GB / 1 GB |
| `cache` | 8 CPU / 48 GB / 250 GB | **1 CPU / 0.5 GB / 2 GB** | 1 CPU / 0.25 GB / 1 GB |

Todos em `SHARED`, `startCpuCoreCount: 1`.

```json
{ "customAutoscaling": { "verticalAutoscaling": {
  "cpuMode": "SHARED",
  "maxResource": { "cpuCoreCount": 2, "memoryGBytes": 1, "diskGBytes": 5 },
  "minResource": { "cpuCoreCount": 1, "memoryGBytes": 0.25, "diskGBytes": 1 },
  "minFreeResource": { "cpuCoreCount": 0.1, "cpuCorePercent": 0, "memoryGBytes": 0.125, "memoryPercent": 0 },
  "startCpuCoreCount": 1, "swapEnabled": true } } }
```

Duas regras da API que custaram tempo:
- `minFreeResource.memoryGBytes` aceita **no máximo 3 casas decimais** → `0.0625` é rejeitado, tem de ser `0.1` (ou `0.125`).
- O Postgres tem mínimo de RAM próprio (**0.25 GB**); o `minFreeResource` do `db` tem de ser `>= 0.125`, não `0.0625`.

Para ler o estado efectivo: `GET /service-stack/{id}` → `currentAutoscaling` (efectivo) vs `customAutoscaling` (o que foi pedido; `null` = herda do perfil).

Rede: todos os serviços estão na mesma rede privada do projeto Zerops. O `api` alcança o `db` pelo hostname interno (ex: `db`) e as credenciais são injetadas via `DATABASE_URL`.

Deploy: `zcli push api --setup api` na raiz do repo (CI: ver secção 4).

Criação dos serviços: `zerops-import.yaml` na raiz do repo + `zcli project service-import zerops-import.yaml -P <project-id>`. O `JWT_SECRET` do `api` é gerado nesse import (`<@generateRandomString(<32>)>`, precisa de `#yamlPreprocessor=on`).

### Armadilhas do `run.start` (encontradas no primeiro deploy)

- **`run.start` é executado por `exec`, não por um shell.** `start: cd backend && npm start` falha com `exec: cd: not found` (exit 127) e o serviço entra em crash loop. O directório vai em `startCommands[].workingDir` (default `/var/www`); o código, com `deployFiles: [backend, frontend]`, fica em `/var/www/backend`.
- **Health check na rota errada é pior que nenhum.** `/v1/health` está atrás de auth e responde **401 sem token** — usá-la no `healthCheck` marcaria o serviço como unhealthy para sempre. O check aponta a `/`, que serve o frontend e é pública.
- `zcli push` com o default `-w all` faz `git archive`, que falha (exit 128) quando o `zerops.yml` só existe em working tree não-commitado; commitar antes de fazer push.

---

## 3. DNS e Cloudflare (domínio próprio)

### Estado actual (feito e verificado)
- Domínio: **`https://ceme-beta.ocarroeletrico.com`** → 200, serve o frontend e a API.
- Registos Cloudflare: **só `AAAA`** → o IPv6 dedicado do projecto, **proxy activo**. O endereço **não** está neste documento (ver "Segredo: o IP da origem" abaixo).
- Zeroops: hostname registado no L7 balancer (`public-http-routing`), com certificado Let's Encrypt **ACTIVE** para `ceme-beta.ocarroeletrico.com`.

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

Porque é que não é `zcli push` na CI: essa via obrigava a guardar um **token de admin da conta Zerops** como secret do GitHub. Notas sobre o que a Zerops oferece e porque foi descartado:
- Os tokens com escopo existem (**Settings → Access Tokens Management** → acesso *Custom per project*, limitado ao projeto CEME), o que reduz o blast radius face a *Full access to all projects*. Mas mesmo assim continua a ser uma credencial de longa duração, com acesso de leitura a env vars sensíveis (`JWT_SECRET`, `DATABASE_URL`) e a backups, guardada num sítio que qualquer pessoa com push a `main` consegue ler.
- A Zerops não suporta (ainda) tokens efémeros/OIDC federation, portanto não dá para trocar por credenciais de curta duração.

O webhook elimina a credencial no GitHub por completo. Trade-off aceite: perdemos o `needs: test` explícito do lado do deploy — o que garante que nada chega a `main` sem testes verdes passa a ser a **branch protection** (4.3), que é o controlo certo de qualquer forma.

### 4.3 Branch protection do `main` (pré-requisito do gating)

Sem o `needs: test` do workflow, é a branch protection que impede merges com CI vermelho:

- Settings → Branches → `main`: **Require status checks to pass** → check `test` (do workflow CI); **Require pull request before merging**.

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
- [ ] Ligar o webhook do Zerops ao repositório (trigger: push para `main`; secção 4.2).
- [ ] Testar merge to main → build+deploy automático pelo Zerops.
- [ ] (futuro) Preview por PR.
