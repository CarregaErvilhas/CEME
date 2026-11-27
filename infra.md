# Infra — CEME v2 no Zerops + Cloudflare

Aqui está a infraestrutura do CEME: onde corre o serviço, como chega lá o código, o DNS e o CI. O que é comum aos projectos do grupo está no repositório [Architecture](https://github.com/CarregaErvilhas/Architecture), em inglês: [como se expõe um serviço Zerops](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/zerops-exposure.md) e [as regras da zona Cloudflare](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/cloudflare-zone.md).

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

- **Um serviço serve tudo.** O `api` (Node.js) serve a API em `/v1/*` e o frontend em `/`.
- **A base de dados é PostgreSQL gerido pelo Zerops.** O seed só preenche uma BD vazia e actualiza os tarifários; a fonte de verdade é a BD.
- **Os preços do OMIE ficam na BD** (`omie_spot`, `omie_daily`, `omie_meta`): sobrevivem aos deploys e são partilhados entre instâncias. Só os CSV do TF ficam em disco, como cache descartável. Não há Redis nem outra cache gerida.
- **Os tarifários actualizam-se pelo seed** (e por verificação com um agente; vê `.opencode/commands/ceme-check.md`). Não há painel de administração.
- **DNS na Cloudflare**, com proxy activo e a origem em IPv6 no Zerops.
- **Nenhuma credencial do Zerops no GitHub.**

---

## 2. Serviços Zerops

A configuração do runtime está em `zerops.yml`; a criação dos serviços em `zerops-import.yaml`.

| Serviço | Tipo | Versão | Função |
|---|---|---|---|
| `api` | nodejs | 24 | `backend/src/server.js`: serve frontend + API na porta 3001 |
| `db` | postgresql | 18 | a BD (tabelas em `docs/01-modelo-dados.md`) |

Todos os serviços estão na mesma rede privada do projecto. O `api` chega ao `db` pelo nome interno (`db`), com duas ligações: `DATABASE_APP_URL` (a role `ceme_app`, só DML, a do processo da API) e `DATABASE_MIGRATE_URL` (a role dona, só nos `initCommands`). Vê «Privilégios da base de dados».

Para criares os serviços de raiz: `zcli project service-import zerops-import.yaml -P <project-id>`. O `JWT_SECRET` do `api` é gerado nesse import (`<@generateRandomString(<32>)>`, precisa de `#yamlPreprocessor=on`).

Deploy à mão, só em último recurso: `zcli push api --setup api` na raiz do repo (vê a secção 4 para o deploy normal). O `zcli push` usa `git archive`, por isso faz commit antes de fazer push.

### Recursos (autoscaling)

| Serviço | mínimo | máximo | containers |
|---|---|---|---|
| `api` | 1 CPU / 0,25 GB / 1 GB disco | 2 CPU / 1 GB / 5 GB | 1 a 2 |
| `db` | 1 CPU / 0,25 GB / 1 GB disco | 2 CPU / 1 GB / 5 GB | 1 (`single`) |

Todos em `SHARED`, `startCpuCoreCount: 1`. Os máximos estão fixados por API (`PUT /service-stack/{id}/autoscaling`) porque, sem isso, o `db` herda um tecto de 8 vCPU / 48 GB / 250 GB. Paga-se pelo uso, mas o disco nunca encolhe.

```json
{ "customAutoscaling": { "verticalAutoscaling": {
  "cpuMode": "SHARED",
  "maxResource": { "cpuCoreCount": 2, "memoryGBytes": 1, "diskGBytes": 5 },
  "minResource": { "cpuCoreCount": 1, "memoryGBytes": 0.25, "diskGBytes": 1 },
  "minFreeResource": { "cpuCoreCount": 0.1, "cpuCorePercent": 0, "memoryGBytes": 0.125, "memoryPercent": 0 },
  "startCpuCoreCount": 1, "swapEnabled": true } } }
```

O `horizontalAutoscaling` do `api` é `{ "minContainerCount": 1, "maxContainerCount": 2 }`: um container chega (a app não guarda estado), e o segundo só existe durante um deploy (vê abaixo).

Regras da API do Zerops que convém saberes:

- `minFreeResource.memoryGBytes` aceita **no máximo 3 casas decimais** (`0.0625` é recusado; usa `0.1` ou `0.125`).
- O Postgres tem um mínimo de RAM de **0,25 GB**, e o `minFreeResource` do `db` tem de ser `>= 0.125`.
- Para veres o estado: `GET /service-stack/{id}` → `currentAutoscaling` (o que está em vigor) vs `customAutoscaling` (o que foi pedido; `null` = herda do perfil).

### Cuidados com o `zerops.yml`

- **`run.start` corre sem shell** (`exec`). `start: cd backend && npm start` falha com `exec: cd: not found`. A pasta vai em `startCommands[].workingDir`; o código, com `deployFiles: [backend, frontend]`, fica em `/var/www/backend`.
- **O health check tem de apontar a uma rota sem auth.** `/v1/health` responde 401 sem token e marcaria o serviço como avariado para sempre. Usa `/healthz` (health check) e `/readyz` (readiness check).

### Deploy sem interrupção (rolling)

O `api` está configurado para ter sempre um container a servir durante um deploy:

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
3. O container novo arranca **ao lado** do actual (`temporaryShutdown: false`; `maxContainerCount: 2` dá espaço aos dois).
4. O readiness check pergunta a `/readyz` no container novo: 200 só quando o processo **e a BD** respondem.
5. Se passar, o novo entra no balanceador e o antigo sai e é apagado.
6. Se não passar em 120 s, o novo é apagado, a versão fica `DEPLOY_FAILED` e **a anterior continua a servir**. Um deploy mau não deita o site abaixo.

As duas rotas, sem auth (o balanceador chama-as de dentro do container):

| rota | usada por | toca na BD |
|---|---|---|
| `GET /healthz` | `run.healthCheck` (o processo está vivo?) | não |
| `GET /readyz` | `deploy.readinessCheck` (pode receber tráfego?) | sim (`SELECT 1`, 3 s de prazo), **só a partir da própria máquina** |

Porque não usar o mesmo check para os dois: com um só container, um health check que dependa da BD tirava o container do balanceador sempre que a BD tivesse um soluço, e o site inteiro caía em vez de só a API. O health check só pergunta se o processo está vivo; o readiness, que só corre no deploy, é que exige a BD.

De fora da máquina, `/readyz` responde 200 com `db: unknown` e não toca na BD: ninguém de fora precisa dele, e um `SELECT 1` por pedido era uma forma de esgotar as ligações. É 200 (e não 403) para um pedido vindo de outro sítio nunca chumbar um deploy.

Os dois checks correm de dentro do container (`127.0.0.1:3001/...`). Os códigos que o Zerops aceita e o resto do padrão estão em [Readiness and health checks](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/zerops-exposure.md#readiness-and-health-checks).

### Privilégios do processo

O processo da API corre como `cocofree`, um utilizador de sistema criado nos `prepareCommands`, sem shell, sem casa e **sem sudo** ([porquê e como](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/zerops-exposure.md#non-root-process)).

O que o `cocofree` pode e não pode:

- lê o código em `/var/www` (que é do `zerops`), mas não o escreve;
- escreve em `/tmp`, onde fica a cache dos CSV do TF (`CEME_CACHE_DIR`);
- chega à BD pela `DATABASE_APP_URL` (a role `ceme_app`), que está no ambiente do processo.

O que isto **não** resolve: a `DATABASE_APP_URL` e o `JWT_SECRET` estão no ambiente do processo, por isso quem executar código na app lê-os e fala com a BD. O que se ganha é não poder alterar o código nem a imagem, não poder instalar nada e não escalar para root. O estrago na BD limita-se com uma role só com os privilégios de que a app precisa (secção seguinte).

Depois de um deploy que mexa nisto, confirma na consola do Zerops (terminal do container):

```bash
ps -o user,pid,args | grep node   # user = cocofree
curl -s localhost:3001/readyz # 200
```

### Privilégios da base de dados

O `api` liga à BD com a `ceme_app`, uma role **só com DML**, e não com o utilizador principal do serviço `db`. O DDL (criar tabelas, acrescentar colunas) corre à parte, com a role dona, antes de o processo da API arrancar.

| quem | role | ligação | o que faz |
|---|---|---|---|
| `db/migrate-cli.js` (`initCommands`) | dona (utilizador principal do `db`) | `DATABASE_MIGRATE_URL` | schema, `ALTER TABLE`, aplica `db/grants.postgres.sql` |
| `server.js` (o processo `cocofree`) | `ceme_app` | `DATABASE_APP_URL` | seed, TAR, OMIE, chave da API, leituras |

O que a `ceme_app` pode (`db/grants.postgres.sql`, que corre a cada deploy):

- `SELECT`, `INSERT` e `UPDATE` nas tabelas que a app usa (todas fazem upsert); `DELETE` só em `omie_meta` (o lock do OMIE);
- `USAGE` no sequence de `tariff_version`;
- nenhum acesso a `ceme_contact` (contactos internos), `suggestion` e `audit_log`, que a API não usa;
- sem `CREATE` no schema, sem `TRUNCATE`/`REFERENCES`/`TRIGGER`, sem `SUPERUSER`/`CREATEDB`/`CREATEROLE`.

Uma tabela nova nos schemas tem de entrar em `grants.postgres.sql` (ou na lista «sem acesso» de `test/grants.test.js`): o teste falha se ficar de fora.

**O que isto fecha.** Uma injecção de SQL, ou código da app com a ligação aberta, deixa de poder apagar ou alterar tabelas (`DROP`, `TRUNCATE`, `ALTER`), ler os contactos internos, criar roles ou ler ficheiros do servidor. Só consegue o que a app já faz: ler e escrever nas tabelas dela.

**O que não fecha.** Quem consegue **executar código** na app continua a poder ler e reescrever os dados de produção (tarifários, preços, chaves da API, `omie_meta`) com a `ceme_app`. Para a role dona o ganho depende de ela nunca chegar ao processo: o `DATABASE_MIGRATE_URL` só existe nos `initCommands`, e o arranque da API corre com `env -u DATABASE_MIGRATE_URL`, por isso não está nem no ambiente do `cocofree` nem em `/proc/self/environ`. Não impede, tão-pouco, o abuso de uma credencial da `ceme_app` que vaze por outro lado (logs, backups); limita-o ao mesmo que a app faz.

Com `CEME_SCHEMA_EXTERNAL=1` o `boot.js` não faz DDL: só confirma que as tabelas e as colunas de `ADDED_COLUMNS` existem e recusa-se a arrancar se faltar alguma (com `migrate-cli` não corrido, o deploy falha no readiness e a versão anterior continua a servir). Sem a variável (dev, testes, SQLite) o arranque faz tudo.

#### Criar a role `ceme_app` (projecto novo, ou para lhe trocar a palavra-passe)

Em produção já está feito: o `zerops.yml` corre o `migrate-cli` nos `initCommands` e a API liga com a `DATABASE_APP_URL`, uma variável secreta do serviço `api`. Sem ela, a API não tem BD e o deploy chumba no readiness (a versão anterior continua a servir). Num projecto novo, ou para rodar a palavra-passe, segue estes passos.

Cada passo seguinte é seguro de interromper. Variáveis secretas ficam como **Secret** na consola do Zerops; nunca as imprimas nem as cole em chats.

1. **Criar a role** (no teu computador, com acesso à rede privada, por exemplo `zcli vpn up`; troca o host `db` do URL pelo que a VPN resolver). Copia o `connectionString` do serviço `db` da consola do Zerops:

   ```bash
   read -rs MAIN_URL            # cola o connectionString e Enter (não aparece)
   APP_PW=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)
   psql "$MAIN_URL" -Atc "SHOW log_statement"   # tem de ser none ou ddl sem passwords; ver nota
   psql "$MAIN_URL" -v ON_ERROR_STOP=1 -v app_pw="$APP_PW" -f backend/src/db/role.postgres.sql
   ```

Se o `CREATE ROLE` der `permission denied`, o utilizador principal não tem `CREATEROLE`: repete com o `superUser` do serviço `db` (variáveis do serviço na consola). Nota: com `log_statement = ddl` ou `all`, o Postgres regista a palavra-passe em claro no log do `db`; se for o caso, roda-a depois com `\password ceme_app` no `psql`.

2. **Dar os privilégios** (idempotente; corre também em cada deploy):

   ```bash
   cd backend && DATABASE_URL="$MAIN_URL" node src/db/migrate-cli.js
   ```

Tem de acabar com `privilégios de ceme_app aplicados`.

3. **Testar a role antes de a ligar à app:**

   ```bash
   APP_URL=$(printf %s "$MAIN_URL" | sed -E "s#^(postgres(ql)?://)[^@]*@#\1ceme_app:${APP_PW}@#")
   psql "$APP_URL" -Atc "SELECT count(*) FROM tariff"            # funciona
   psql "$APP_URL" -Atc "CREATE TABLE _x(i int)"                 # permission denied
   psql "$APP_URL" -Atc "SELECT count(*) FROM ceme_contact"      # permission denied
   ```

4. **Variável no serviço `api`** (consola → `api` → variáveis de ambiente → Secret): `DATABASE_APP_URL` com o valor de `$APP_URL`.

   ```bash
   printf %s "$APP_URL" | pbcopy   # cola na consola e depois: pbcopy </dev/null
   unset MAIN_URL APP_PW APP_URL
   ```

5. **Verificar** (depois do próximo deploy, ou de reiniciar o `api`), na consola do container do `api`:

   ```bash
   curl -s localhost:3001/readyz                  # 200, db: ok
   ps -o user,pid,args | grep node                # user = cocofree
   tr '\0' '\n' < /proc/$(pgrep -n node)/environ | cut -d= -f1 | grep -c DATABASE_MIGRATE_URL   # 0
   ```

E no `psql` com a role dona: `SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1;` deve mostrar ligações da `ceme_app`.

6. **Voltar atrás** (a API a ligar com o utilizador principal): no `zerops.yml`, troca a `DATABASE_MIGRATE_URL` por `DATABASE_URL: ${db_connectionString}` e tira o `CEME_SCHEMA_EXTERNAL`, o `initCommands` e o `env -u` (commit em `main`). A variável `DATABASE_APP_URL` tem de sair, porque tem prioridade sobre a `DATABASE_URL`. Para apagar a role: `REASSIGN OWNED BY ceme_app TO <dono>; DROP OWNED BY ceme_app; DROP ROLE ceme_app;`.

### Colunas novas e o schema

O schema (`CREATE TABLE IF NOT EXISTS`) **não acrescenta colunas** a tabelas que já existem, e a BD de produção já tem todas. Uma coluna nova numa tabela existente tem de entrar também em `ADDED_COLUMNS` (`db/migrate.js`), que o `migrate-cli` aplica nos `initCommands`. Se te esqueceres, o arranque da API não a encontra, recusa-se a arrancar e o deploy chumba no readiness (a versão anterior continua a servir). O procedimento está em `docs/08-sqlite-postgres.md` («Para acrescentares uma coluna»).

### Actualizar o Postgres (recriar o `db`)

O `db` é `postgresql:single`, e o Zerops **não actualiza** um serviço `single`: fica na versão menor com que foi criado, sem patches de segurança. Para passares para a versão menor mais recente tens de criar o serviço de novo e repor os dados. (Num serviço HA o Zerops troca os containers um a um, mas o projecto fica em `single` por custo; a BD só se alcança pela rede privada, por isso o risco de ficar atrás é pequeno.)

Fá-lo quando sair um aviso de segurança do PostgreSQL que te afecte, e de vez em quando mesmo sem aviso. Conta com **alguns minutos sem API**: o serviço novo tem de se chamar `db` (o `zerops.yml` lê `${db_connectionString}` e a `DATABASE_APP_URL` aponta ao host `db`), e dois serviços não podem ter o mesmo nome, por isso o antigo sai antes de o novo entrar.

Precisas de acesso à rede privada (`zcli vpn up`; troca o host `db` dos URLs pelo que a VPN resolver) e de um `psql`/`pg_dump` da **mesma versão maior** que o serviço. Como na criação da `ceme_app`: credenciais com `read -rs`, nunca impressas nem coladas em chats.

1. **Congelar as escritas.** No serviço `api`, acrescenta `CEME_READONLY=1` às variáveis de ambiente e reinicia o `api`. A partir daqui a app não escreve (nem o OMIE), por isso o dump apanha tudo e nada se perde entre o dump e o fim. As leituras continuam a funcionar; o que precisar de escrever dá erro (`CEME_READONLY: escrita recusada`, em `db.js`) até ao passo 8.

2. **Fazer o dump** (o `connectionString` do `db` está nas variáveis do serviço, na consola):

   ```bash
   read -rs OLD_URL                     # connectionString do db actual
   psql "$OLD_URL" -Atc "SELECT version()"
   psql "$OLD_URL" -Atc "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY 1" > antes.txt
   pg_dump "$OLD_URL" -Fc --no-owner --no-privileges -f ceme.dump
   pg_restore --list ceme.dump | grep -c 'TABLE DATA'   # uma linha por tabela
   ```

`--no-owner --no-privileges` porque as roles não vão no dump: o dono é o utilizador principal do serviço novo, e os privilégios da `ceme_app` voltam pelo `migrate-cli`.

3. **Testar o dump antes de apagares seja o que for.** Repõe-no num Postgres local da mesma versão e compara as contagens com `antes.txt`:

   ```bash
   createdb ceme_teste && pg_restore -d ceme_teste --no-owner ceme.dump
   psql -d ceme_teste -Atc "SELECT count(*) FROM tariff"
   ```

O backup automático do Zerops é a segunda rede, não a primeira: confirma na consola que tens um recente, mas não contes que sobreviva a apagares o serviço. O `ceme.dump` que acabaste de testar é o que garante a reposição.

4. **Apagar o `db` antigo** (consola → `db` → apagar o serviço). A API fica sem BD a partir daqui: `/healthz` continua 200, os pedidos a `/v1/*` dão erro.

5. **Criar o `db` novo.** Copia o bloco `db` de `zerops-import.yaml` (só esse, com o `#yamlPreprocessor=on` e o `services:`) para um ficheiro temporário e importa-o:

   ```bash
   zcli project service-import db-only.yaml -P <project-id>
   ```

Depois confirma os limites de recursos (`GET /service-stack/{id}`, «Recursos» acima): se o `customAutoscaling` vier `null`, fixa-os com o `PUT` dessa secção.

6. **Repor os dados** no serviço novo (o `connectionString` é outro):

   ```bash
   read -rs NEW_URL                     # connectionString do db novo
   psql "$NEW_URL" -Atc "SELECT version()"   # a versão menor nova
   pg_restore -d "$NEW_URL" --no-owner --no-privileges -v ceme.dump
   psql "$NEW_URL" -Atc "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY 1" > depois.txt
   diff antes.txt depois.txt            # as mesmas tabelas e contagens
   ```

O `n_live_tup` é uma estimativa e pode vir a 0 logo a seguir à reposição; corre `ANALYZE;` no `psql` antes do segundo `SELECT` se o `diff` mostrar diferenças.

7. **Recriar a `ceme_app`** com uma palavra-passe nova: passos 1 a 4 de «Criar a role `ceme_app`», com `MAIN_URL="$NEW_URL"`. O passo 4 actualiza a `DATABASE_APP_URL` do `api`.

8. **Descongelar e fazer deploy.** Tira a `CEME_READONLY` do `api` e faz um deploy (consola, ou `zcli push api --setup api`), para os `initCommands` correrem o `migrate-cli` contra o `db` novo e o processo ler a `DATABASE_APP_URL` nova. Um reinício não chega: não corre os `initCommands`.

9. **Verificar**, como no passo 5 de «Criar a role `ceme_app`»: `/readyz` com `db: ok`, o processo como `cocofree`, e `SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1;` com ligações da `ceme_app`. No fim:

   ```bash
   unset OLD_URL NEW_URL
   rm ceme.dump antes.txt depois.txt && dropdb ceme_teste
   ```

**Se algo correr mal depois do passo 4**, o caminho de volta é o mesmo para a frente: o serviço antigo já não existe, por isso repetes os passos 5 a 8 com o mesmo `ceme.dump`. Enquanto a `CEME_READONLY` estiver ligada não há escritas novas a perder.

---

## 3. DNS e Cloudflare

Domínios em produção:

- **`https://ceme.ocarroeletrico.com`** — o site e a API.
- **`https://omie.cocofree.dev`** — a página de estatísticas OMIE (`docs/09-omie-estatisticas.md`). Mesmo balanceador e mesmo serviço `api`: o servidor lê o cabeçalho `Host` e, neste domínio, a raiz é a página OMIE.

O procedimento é o comum, em [How a Zerops service is exposed](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/zerops-exposure.md): um só registo `AAAA` com proxy, o registo do domínio no balanceador L7 (a ordem conta), o certificado Let's Encrypt, a *Access Policy* só para a Cloudflare, como verificar e como consultar o IP da origem (que **nunca** vai para o repositório). Os valores do CEME:

| | |
|---|---|
| Rota no balanceador | `/` → `api`, porta 3001 |
| Região do Zerops (host da API) | `prg1` |
| Caminho para verificar | `/healthz` |

As duas zonas têm `ssl: strict`, `ipv6: on` e `always_use_https: on`, e a Cloudflare acrescenta o HSTS (`Strict-Transport-Security`) às respostas. As regras da zona `ocarroeletrico.com` que afectam outros projectos estão em [Cloudflare: zone-wide rules](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/cloudflare-zone.md). Os outros cabeçalhos de segurança das páginas (CSP e companhia) põe-nos o servidor (`PAGE_SECURITY` em `backend/src/http/pages.js`).

### O CSP e o que a Cloudflare injecta

O CSP só deixa correr scripts do próprio domínio e os inline cujo hash vai no cabeçalho. A *Email Address Obfuscation* (ligada na zona do domínio OMIE, desligada na `ocarroeletrico.com`) passa: injecta um script de `/cdn-cgi/` (do próprio domínio) e não mexe nos scripts inline. O link do *AI Labyrinth* é só um link. Uma funcionalidade que injecte scripts inline ou de outro domínio (Rocket Loader, Zaraz, Web Analytics automático, as *JS detections* do Bot Fight Mode) fica bloqueada pelo CSP: se ligares alguma, acrescenta-a lá primeiro.

### O IP do cliente

Os rate limits por IP (`docs/04-api-auth.md`) precisam do IP real do cliente, e a ligação TCP chega sempre do balanceador. Há dois proxies à frente: a Cloudflare acrescenta o IP do cliente ao `X-Forwarded-For`, e o balanceador L7 do Zerops acrescenta o de quem lhe ligou (a Cloudflare). A entrada que a Cloudflare escreveu é a 2.ª a contar da direita, por isso o `zerops.yml` define `CEME_TRUST_PROXY: 2`.

Se o valor estiver errado, todos os visitantes partilham um contador e um só cliente com chaves erradas bloqueia as API keys de todos:

- se o balanceador substituir o `X-Forwarded-For` por uma só entrada, não há 2.ª entrada e o servidor cai para o IP da ligação (o do balanceador);
- se o balanceador acrescentar o IP da Cloudflare e o valor for `1`, o contador é por nó da Cloudflare.

Para confirmar, de duas redes diferentes (o telemóvel em dados móveis e casa), um pedido de cada:

```bash
curl -s -o /dev/null -D - -X POST https://ceme.ocarroeletrico.com/v1/session | grep -i x-ratelimit-remaining
```

O primeiro pedido de cada rede tem de mostrar `9`. Se o segundo mostrar `8`, o contador é partilhado e o valor está errado.

O valor só é de confiança com a [Access Policy](https://github.com/CarregaErvilhas/Architecture/blob/main/Docs/zerops-exposure.md#access-policy) activa (`defaultPolicy: deny`): sem ele, quem vá directo à origem escreve o `X-Forwarded-For` que quiser. E se a variável estiver também definida na GUI do serviço, as duas têm de dizer o mesmo.

---

## 4. CI/CD — GitHub Actions (testes) + webhook do Zerops (deploy)

### 4.1 CI — `.github/workflows/ci.yml`

Um único job, `test`, em cada push para `main` e em cada PR: `npm ci` + `npm test`, em Node 24 (a mesma versão da produção). Tem `permissions: contents: read` e `concurrency` com `cancel-in-progress` (um push novo cancela a corrida anterior do mesmo ramo).

### 4.2 Deploy — webhook do Zerops

O deploy **não** é feito pelo GitHub Actions. É o Zerops que vai buscar o código quando há um push para `main`:

> Serviço `api` → **Build, Deploy, Run Pipeline Settings** → **Connect with a GitHub repository** → trigger **Push to branch: `main`**.

A integração do serviço:

```json
{ "repositoryFullName": "CarregaErvilhas/CEME", "eventType": "BRANCH",
  "branchName": "main", "isActive": true,
  "zeropsYamlSetup": "api", "authorizationRequired": false }
```

Do push ao deploy demora cerca de um minuto.

Notas:

- `zeropsYamlSetup: "api"` tem de ser igual ao `setup:` do `zerops.yml`.
- A integração só se vê na API do **serviço** (`GET /service-stack/{id}` → `githubIntegration`). O endpoint `external-repository-integration-status` responde `githubAuthorizationRequired` a quem não for a conta que autorizou o GitHub; não quer dizer que esteja avariada.
- Ligar o GitHub faz-se na interface web do Zerops: o OAuth só aceita o endereço de retorno `https://app.zerops.io/`.

Porque não `zcli push` no CI: obrigava a guardar um token do Zerops no GitHub. Mesmo um token limitado ao projecto é uma credencial de longa duração, que dá acesso de leitura a variáveis sensíveis (`JWT_SECRET`, `DATABASE_URL`) e aos backups, guardada onde qualquer pessoa com push a `main` a consegue ler. O Zerops ainda não tem tokens de curta duração (OIDC). Com o webhook, não há credencial nenhuma no GitHub. O que garante que nada chega a `main` sem testes verdes é a protecção do `main` (4.3).

### 4.2.1 Aviso ao IndexNow depois do deploy

Com `INDEXNOW: "on"` (no `zerops.yml`), um minuto depois de arrancar o processo envia ao IndexNow os URLs do sitemap de cada domínio público (`backend/src/http/indexnow.js`). É assim que o Bing sabe que há páginas novas sem esperar pelo rastreio. A chave é pública e é servida em `/<chave>.txt`. Uma falha só aparece no log. Em local e nas previews a variável não está definida, por isso não se envia nada.

### 4.3 Protecção do `main`

Feita com um **ruleset** do GitHub (e não com a branch protection clássica: os rulesets juntam-se por camadas, têm lista de bypass e vê-os quem lê o repositório):

- alvo `main`, `enforcement: active`;
- `required_status_checks`: o check `test`, com `strict_required_status_checks_policy: true` (o ramo tem de estar actualizado com o `main`);
- `pull_request` com `required_review_thread_resolution: true`: **qualquer conversa de review por resolver bloqueia o merge**. Até uma sugestão esquecida do próprio autor. Resolves pela API com `mutation { resolveReviewThread(input:{threadId:"..."}) }`;
- `non_fast_forward` e `deletion`: sem force-push nem apagar o ramo.

Sem isto, um push directo a `main` (ou um merge com testes vermelhos) chegava ao Zerops e ia para produção.

### 4.4 Segredos

**Nenhum segredo do Zerops no GitHub.** O `JWT_SECRET` e o `CEME_API_KEY` (opcional; tirá-lo revoga a chave, `docs/04-api-auth.md`) são variáveis secretas do serviço `api` no Zerops. O `CEME_API_KEY_RATE_LIMIT` (pedidos por minuto dessa chave) não é segredo: pode ser uma variável normal. O DNS é configurado à mão na Cloudflare (o IPv6 do Zerops não muda).

### 4.5 Previews por PR

**Não automatizados.** As PRs correm só os testes. O procedimento manual está em [`docs/preview-envs.md`](docs/preview-envs.md).

### 4.6 Dependências e dono

- `.github/dependabot.yml`: npm e GitHub Actions, semanal, com um intervalo mínimo entre actualizações. As actions do `ci.yml` estão fixadas por SHA (com a versão em comentário), que o Dependabot também actualiza.
- `.github/CODEOWNERS`: um dono para o repositório todo.

---

## 5. Backups e recuperação

- O `db` (PostgreSQL) tem backups automáticos, configurados na consola do Zerops.
- Se perderes a BD, restaura do backup do Zerops. **Não recries com o seed**: o seed só tem os tarifários, não os preços do OMIE nem as chaves.
- Opcionalmente, guarda de vez em quando um dump do schema e dos dados de referência fora do Zerops.

---

## 6. O que vem a seguir

- Previews por PR automatizados (vê 4.5).
- Um servidor MCP para gerir os tarifários.

O resto está em `docs/06-roadmap.md`.
