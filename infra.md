# Infra — CEME v2 no Zerops + Cloudflare

Este é o único sítio onde está documentada a infraestrutura: onde corre o
serviço, como chega lá o código, o DNS e o CI.

Visão geral:

```
browser ──► Cloudflare (proxy, TLS) ──► balanceador L7 do Zerops ──► serviço `api` (Node.js)
                                                                        │
                                                                        └──► serviço `db` (PostgreSQL)
GitHub (push para main) ──webhook──► Zerops faz build + deploy do `api`
GitHub Actions ──► só corre os testes
```

---

## 1. Princípios

- **Um serviço serve tudo.** O `api` (Node.js) serve a API em `/v1/*` e o
  frontend em `/`.
- **A base de dados é PostgreSQL gerido pelo Zerops.** O seed só preenche
  uma BD vazia e actualiza os tarifários; a fonte de verdade é a BD.
- **Os preços do OMIE ficam na BD** (`omie_spot`, `omie_daily`,
  `omie_meta`): sobrevivem aos deploys e são partilhados entre instâncias.
  Só os CSV do TF ficam em disco, como cache descartável. Não há Redis nem
  outra cache gerida.
- **Os tarifários actualizam-se pelo seed** (e por verificação com um
  agente; vê `.opencode/commands/ceme-check.md`). Não há painel de
  administração.
- **DNS na Cloudflare**, com proxy activo e a origem em IPv6 no Zerops.
- **Nenhuma credencial do Zerops no GitHub.**

---

## 2. Serviços Zerops

A configuração do runtime está em `zerops.yml`; a criação dos serviços em
`zerops-import.yaml`.

| Serviço | Tipo | Versão | Função |
|---|---|---|---|
| `api` | nodejs | 24 | `backend/src/server.js`: serve frontend + API na porta 3001 |
| `db` | postgresql | 18 | a BD (tabelas em `docs/01-modelo-dados.md`) |

Todos os serviços estão na mesma rede privada do projecto. O `api` chega ao
`db` pelo nome interno (`db`) e recebe as credenciais em `DATABASE_URL`.

Para criares os serviços de raiz:
`zcli project service-import zerops-import.yaml -P <project-id>`. O
`JWT_SECRET` do `api` é gerado nesse import
(`<@generateRandomString(<32>)>`, precisa de `#yamlPreprocessor=on`).

Deploy à mão, só em último recurso: `zcli push api --setup api` na raiz do
repo (vê a secção 4 para o deploy normal). O `zcli push` usa `git archive`,
por isso faz commit antes de fazer push.

### Recursos (autoscaling)

| Serviço | mínimo | máximo | containers |
|---|---|---|---|
| `api` | 1 CPU / 0,25 GB / 1 GB disco | 2 CPU / 1 GB / 5 GB | 1 a 2 |
| `db` | 1 CPU / 0,25 GB / 1 GB disco | 2 CPU / 1 GB / 5 GB | 1 (`single`) |

Todos em `SHARED`, `startCpuCoreCount: 1`. Os máximos estão fixados por
API (`PUT /service-stack/{id}/autoscaling`) porque, sem isso, o `db` herda
um tecto de 8 vCPU / 48 GB / 250 GB. Paga-se pelo uso, mas o disco nunca
encolhe.

```json
{ "customAutoscaling": { "verticalAutoscaling": {
  "cpuMode": "SHARED",
  "maxResource": { "cpuCoreCount": 2, "memoryGBytes": 1, "diskGBytes": 5 },
  "minResource": { "cpuCoreCount": 1, "memoryGBytes": 0.25, "diskGBytes": 1 },
  "minFreeResource": { "cpuCoreCount": 0.1, "cpuCorePercent": 0, "memoryGBytes": 0.125, "memoryPercent": 0 },
  "startCpuCoreCount": 1, "swapEnabled": true } } }
```

O `horizontalAutoscaling` do `api` é `{ "minContainerCount": 1, "maxContainerCount": 2 }`:
um container chega (a app não guarda estado), e o segundo só existe durante
um deploy (vê abaixo).

Regras da API do Zerops que convém saberes:

- `minFreeResource.memoryGBytes` aceita **no máximo 3 casas decimais**
  (`0.0625` é recusado; usa `0.1` ou `0.125`).
- O Postgres tem um mínimo de RAM de **0,25 GB**, e o `minFreeResource` do
  `db` tem de ser `>= 0.125`.
- Para veres o estado: `GET /service-stack/{id}` → `currentAutoscaling` (o
  que está em vigor) vs `customAutoscaling` (o que foi pedido; `null` =
  herda do perfil).

### Cuidados com o `zerops.yml`

- **`run.start` corre sem shell** (`exec`). `start: cd backend && npm start`
  falha com `exec: cd: not found`. A pasta vai em
  `startCommands[].workingDir`; o código, com
  `deployFiles: [backend, frontend]`, fica em `/var/www/backend`.
- **O health check tem de apontar a uma rota sem auth.** `/v1/health`
  responde 401 sem token e marcaria o serviço como avariado para sempre. Usa
  `/healthz` (health check) e `/readyz` (readiness check).

### Deploy sem interrupção (rolling)

O `api` está configurado para ter sempre um container a servir durante um
deploy:

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

O que acontece num deploy:

1. O build corre num container temporário; o `api` em produção não mexe.
2. O resultado vai para o armazenamento interno do Zerops.
3. O container novo arranca **ao lado** do actual (`temporaryShutdown:
   false`; `maxContainerCount: 2` dá espaço aos dois).
4. O readiness check pergunta a `/readyz` no container novo: 200 só quando
   o processo **e a BD** respondem.
5. Se passar, o novo entra no balanceador e o antigo sai e é apagado.
6. Se não passar em 120 s, o novo é apagado, a versão fica `DEPLOY_FAILED`
   e **a anterior continua a servir**. Um deploy mau não deita o site abaixo.

As duas rotas, sem auth (o balanceador chama-as de dentro do container):

| rota | usada por | toca na BD |
|---|---|---|
| `GET /healthz` | `run.healthCheck` (o processo está vivo?) | não |
| `GET /readyz` | `deploy.readinessCheck` (pode receber tráfego?) | sim (`SELECT 1`, 3 s de prazo), **só a partir da própria máquina** |

Porque não usar o mesmo check para os dois: com um só container, um health
check que dependa da BD tirava o container do balanceador sempre que a BD
tivesse um soluço, e o site inteiro caía em vez de só a API. O health check
só pergunta se o processo está vivo; o readiness, que só corre no deploy, é
que exige a BD.

De fora da máquina, `/readyz` responde 200 com `db: unknown` e não toca na
BD: ninguém de fora precisa dele, e um `SELECT 1` por pedido era uma forma
de esgotar as ligações. É 200 (e não 403) para um pedido vindo de outro
sítio nunca chumbar um deploy.

Notas: o Zerops aceita como bons os códigos `[200, 400)` (3xx passa;
401/404/503 chumbam). Os dois checks correm de dentro do container
(`127.0.0.1:3001/...`). Docs:
<https://docs.zerops.io/guides/readiness-health-checks> e
<https://docs.zerops.io/guides/deployment-lifecycle>.

### Privilégios do processo

O processo da API corre como `ceme`, um utilizador de sistema criado nos
`prepareCommands`, sem shell, sem casa e **sem sudo**. O utilizador por
omissão do Zerops (`zerops`) tem sudo, e é isso que queremos longe do
processo: quem conseguisse executar código na app ficava root no container.

O que o `ceme` pode e não pode:

- lê o código em `/var/www` (que é do `zerops`), mas não o escreve;
- escreve em `/tmp`, onde fica a cache dos CSV do TF (`CEME_CACHE_DIR`);
- chega à BD pela `DATABASE_URL`, que continua no ambiente do processo.

O que isto **não** resolve: a `DATABASE_URL` e o `JWT_SECRET` estão no
ambiente do processo, por isso quem executar código na app lê-os e fala com
a BD. O que se ganha é não poder alterar o código nem a imagem, não poder
instalar nada e não escalar para root. Para limitar o estrago da BD, o
passo seguinte é um utilizador Postgres só com os privilégios de que a app
precisa.

Depois de um deploy que mexa nisto, confirma na consola do Zerops (terminal
do container):

```bash
ps -o user,pid,args -C node   # user = ceme
curl -s localhost:3001/readyz # 200
```

### Colunas novas e o schema

O schema corre no arranque com `CREATE TABLE IF NOT EXISTS`, que **não
acrescenta colunas** a tabelas que já existem (e a BD de produção já tem
todas). Se acrescentares uma coluna a uma tabela existente e te esqueceres
da migração, o seed falha a escrever nessa coluna, o serviço não arranca e
o site dá 502. O procedimento está em `docs/08-sqlite-postgres.md`
(«Para acrescentares uma coluna»).

---

## 3. DNS e Cloudflare

Domínios em produção:

- **`https://ceme-beta.ocarroeletrico.com`** — o site e a API.
- **`https://omie.cocofree.dev`** — a página de estatísticas OMIE
  (`docs/09-omie-estatisticas.md`). Mesmo balanceador e mesmo serviço
  `api`: o servidor lê o cabeçalho `Host` e, neste domínio, a raiz é a
  página OMIE.

Nos dois: na Cloudflare, **só um registo `AAAA`** para o IPv6 dedicado do
projecto, com **proxy activo**; no Zerops, o domínio registado no
balanceador L7 (`public-http-routing`) com certificado Let's Encrypt.
As zonas têm `ssl: strict`, `ipv6: on` e `always_use_https: on`.

### O IP da origem

**O IP da origem está só na Cloudflare e na consola do Zerops, nunca no
repositório.** Para o consultares:

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/zerops/cli.data'))['LoginSession']['AccessToken'])")
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.app-prg1.zerops.io/api/rest/public/project/<project-id>" | python3 -c "import sys,json;print(json.load(sys.stdin)['publicIpV6'])"
```

### Acrescentar um domínio (a ordem conta)

São dois registos em sistemas diferentes, e o Zerops vem primeiro:

1. **Zerops: registar o domínio no balanceador.** Sem isto, o balanceador
   responde **404** a qualquer `Host` que não conheça.

   Se o projecto ainda não tem nenhum routing:

   ```bash
   POST /api/rest/public/project/<project-id>/public-http-routing
   {
     "domains": ["ceme-beta.ocarroeletrico.com"],
     "locations": [{ "path": "/", "port": 3001, "serviceStackId": "<api-service-id>" }],
     "sslEnabled": true,
     "cdnEnabled": false
   }
   ```

   Para juntar um domínio a um routing que já existe, usa o **PUT** desse
   routing (o `POST` falha com
   `publicHttpRoutingDuplicateDomainNameInAnotherRouting`):

   ```bash
   PUT /api/rest/public/public-http-routing/<routing-id>
   { "domains": [...], "locations": [...], "sslEnabled": true, "cdnEnabled": false }
   ```

   Copia o `locations` tal como está (é lá que vive o `accessPolicy`, vê
   abaixo). Depois do `PUT` o routing fica `isSynced: false` e só entra em
   vigor com `PUT /api/rest/public/project/<project-id>/sync-public-http-routing`
   (sem body). Sem esse sync, o domínio novo continua a dar 404.

   No fim deste passo fica `dnsCheckStatus: PENDING` e
   `sslStatus: WAITING_FOR_DNS`: o Zerops espera pelo DNS para emitir o
   certificado.

2. **Cloudflare: o registo DNS.**

   ```
   <domínio>  AAAA  <IPv6 do projecto>  proxy: ON
   ```

3. **Zerops: validar o DNS.**
   `PUT /api/rest/public/public-http-routing/<id>/trigger-domains-dns-check`
   (body: `{"domains": [...]}`). Passa a `dnsCheckStatus: OK` e o
   certificado é emitido (`sslStatus: ACTIVE`).

### Porquê só `AAAA` (e não também o `A` partilhado)

O IPv4 partilhado do Zerops descobre a que projecto pertence um pedido
olhando para o `AAAA` do domínio. Com o proxy da Cloudflare activo, esse
`AAAA` aponta para a Cloudflare e o encaminhamento falha. A própria
documentação diz para não usar um `A` com proxy no IPv4 partilhado.

Com proxy activo e origem só em IPv6, a Cloudflare trata da tradução: os
clientes IPv4 chegam à mesma origem.

### Só aceitar tráfego da Cloudflare

Esconder o IP é uma camada extra, não uma defesa. A defesa é o
`accessPolicy` do balanceador do Zerops, que **só aceita pedidos vindos da
Cloudflare**. Se o IP vazar, quem tentar ir directo é recusado.

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

As listas oficiais estão em `https://www.cloudflare.com/ips-v4` e
`https://www.cloudflare.com/ips-v6` e mudam de vez em quando: revê-as.

> **Cuidado:** um `accessPolicy` mal configurado corta também o tráfego
> legítimo. Depois de mexeres, confirma que o site responde 200.

### SSL e o certificado

`ssl: strict` e `ipv6: on` são o que o Zerops pede. Com
`always_use_https: on`, a validação HTTP-01 do Let's Encrypt pode falhar; se
o certificado não for emitido, cria uma Configuration Rule na Cloudflare
que desligue o *Automatic HTTPS Rewrites* em `/.well-known/acme-challenge/`.

### Ferramentas

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/zerops/cli.data'))['LoginSession']['AccessToken'])")
API=https://api.app-prg1.zerops.io/api/rest/public
# ver as rotas
curl -s -H "Authorization: Bearer $TOKEN" "$API/project/<project-id>/public-http-routing"
```

A especificação completa da API está em `GET $API/swagger/openapi.yml`.

Diagnóstico rápido:

```bash
# a origem responde com o Host certo? (usa o IP obtido pela API)
curl -sk -H "Host: ceme-beta.ocarroeletrico.com" "https://[<IPv6 do projecto>]/" -o /dev/null -w '%{http_code}\n'
# 200 = origem OK; 404 = domínio não registado no balanceador; 502 = certificado/origem
# 403 = accessPolicy a bloquear (o pedido não veio da Cloudflare)
```

---

## 4. CI/CD — GitHub Actions (testes) + webhook do Zerops (deploy)

### 4.1 CI — `.github/workflows/ci.yml`

Um único job, `test`, em cada push para `main` e em cada PR: `npm ci` +
`npm test`, em Node 24 (a mesma versão da produção). Tem
`permissions: contents: read` e `concurrency` com `cancel-in-progress` (um
push novo cancela a corrida anterior do mesmo ramo).

### 4.2 Deploy — webhook do Zerops

O deploy **não** é feito pelo GitHub Actions. É o Zerops que vai buscar o
código quando há um push para `main`:

> Serviço `api` → **Build, Deploy, Run Pipeline Settings** → **Connect with
> a GitHub repository** → trigger **Push to branch: `main`**.

A integração do serviço:

```json
{ "repositoryFullName": "CarregaErvilhas/CEME", "eventType": "BRANCH",
  "branchName": "main", "isActive": true,
  "zeropsYamlSetup": "api", "authorizationRequired": false }
```

Do push ao deploy demora cerca de um minuto.

Notas:

- `zeropsYamlSetup: "api"` tem de ser igual ao `setup:` do `zerops.yml`.
- A integração só se vê na API do **serviço** (`GET /service-stack/{id}` →
  `githubIntegration`). O endpoint `external-repository-integration-status`
  responde `githubAuthorizationRequired` a quem não for a conta que
  autorizou o GitHub; não quer dizer que esteja avariada.
- Ligar o GitHub faz-se na interface web do Zerops: o OAuth só aceita o
  endereço de retorno `https://app.zerops.io/`.

Porque não `zcli push` no CI: obrigava a guardar um token do Zerops no
GitHub. Mesmo um token limitado ao projecto é uma credencial de longa
duração, que dá acesso de leitura a variáveis sensíveis (`JWT_SECRET`,
`DATABASE_URL`) e aos backups, guardada onde qualquer pessoa com push a
`main` a consegue ler. O Zerops ainda não tem tokens de curta duração
(OIDC). Com o webhook, não há credencial nenhuma no GitHub. O que garante
que nada chega a `main` sem testes verdes é a protecção do `main` (4.3).

### 4.3 Protecção do `main`

Feita com um **ruleset** do GitHub (a branch protection clássica não se
aplica a repos públicos de organizações no plano gratuito):

- alvo `main`, `enforcement: active`;
- `required_status_checks`: o check `test`, com
  `strict_required_status_checks_policy: true` (o ramo tem de estar
  actualizado com o `main`);
- `pull_request` com `required_review_thread_resolution: true`: **qualquer
  conversa de review por resolver bloqueia o merge**. Até uma sugestão
  esquecida do próprio autor. Resolves pela API com
  `mutation { resolveReviewThread(input:{threadId:"..."}) }`;
- `non_fast_forward` e `deletion`: sem force-push nem apagar o ramo.

Sem isto, um push directo a `main` (ou um merge com testes vermelhos)
chegava ao Zerops e ia para produção.

### 4.4 Segredos

**Nenhum segredo do Zerops no GitHub.** O `JWT_SECRET` e o `CEME_API_KEY`
(opcional; tirá-lo revoga a chave, `docs/04-api-auth.md`) são variáveis
secretas do serviço `api` no Zerops. O DNS é configurado à mão na
Cloudflare (o IPv6 do Zerops não muda).

### 4.5 Previews por PR

**Não automatizados.** As PRs correm só os testes. O procedimento manual
está em [`docs/preview-envs.md`](docs/preview-envs.md).

### 4.6 Dependências e dono

- `.github/dependabot.yml`: npm e GitHub Actions, semanal, com um intervalo
  mínimo entre actualizações.
- `.github/CODEOWNERS`: um dono para o repositório todo.

---

## 5. Backups e recuperação

- O `db` (PostgreSQL) tem backups automáticos, configurados na consola do
  Zerops.
- Se perderes a BD, restaura do backup do Zerops. **Não recries com o
  seed**: o seed só tem os tarifários, não os preços do OMIE nem as chaves.
- Opcionalmente, guarda de vez em quando um dump do schema e dos dados de
  referência fora do Zerops.

---

## 6. O que vem a seguir

- Previews por PR automatizados (vê 4.5).
- Um servidor MCP para gerir os tarifários.

O resto está em `docs/06-roadmap.md`.
