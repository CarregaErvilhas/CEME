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

Recursos (ajustáveis depois):
- `api`: 0.5 GB RAM, 1 vCPU, 1 GB disco.
- `db`: 0.5 GB RAM, 1 vCPU, 2 GB disco, backups activos.
- `cache`: 0.25 GB RAM, 0.25 vCPU, 0.5 GB disco.

Rede: todos os serviços estão na mesma rede privada do projeto Zerops. O `api` alcança o `db` pelo hostname interno (ex: `db`) e as credenciais são injetadas via `DATABASE_URL`.

Deploy: `zcli push api --setup api` na raiz do repo (CI: ver secção 4).

---

## 3. DNS e Cloudflare (subdomínio + IPv6)

### Objetivo
- Subdomínio `ceme-beta.ocarroeletrico.com` gerido no Cloudflare.
- Proxy **activo** (orange cloud) no Cloudflare.
- Origem: IPv6 do serviço `api` no Zerops.
- Clientes que só têm IPv4: a Cloudflare termina IPv4 e encaminha para a origem IPv6 (IPv6 Compatibility / pseudo-IPv4).

### Como funciona o IPv4 → IPv6
Quando o proxy está activo e a origem tem apenas IPv6:
- Um cliente com **IPv6** liga directamente ao endereço IPv6 da origem (via Cloudflare).
- Um cliente com **apenas IPv4** liga a um endereço IPv4 da Cloudflare. A Cloudflare faz o reverse proxy e acede à origem pelo IPv6. Não é necessário configurar um “pseudo IPv4” no Zerops; a Cloudflare trata dessa tradução no edge.

### Passos (a executar com cf cli ou MCP Cloudflare)

1. Criar registo DNS `A` ou `AAAA` no subdomínio:
   - Tipo: `AAAA` → valor: IPv6 do serviço `api` no Zerops (obtido após o primeiro push/deploy).
   - Proxy: **activado** (orange cloud).
   - Se quiseres ser explícito para clientes IPv4, podes manter também um registo `A` apontando para um IP da Cloudflare, mas com proxy activo o que interessa é a origem `AAAA`.

2. No Cloudflare, garantir que **IPv6 Compatibility** está activado para a zona (permite que clientes IPv4 alcancem origens IPv6 através do proxy).

3. No Zerops, associar o domínio ao serviço `api` (campo `domains` no `zerops.yml` ou via `zcli`).

Exemplo de registo desejado (ajustar o domínio real):

```
ceme-beta.ocarroeletrico.com  AAAA  <IPv6-do-api-zerops>  proxy: ON
```

> **Nota:** ainda não sabemos o IPv6 do Zerops porque não fizemos deploy. Após o primeiro `zcli push`, obtemos o IP/hostname do serviço e atualizamos o DNS.

---

## 4. CI/CD com GitHub Actions (implementado)

Um único workflow, `.github/workflows/ci.yml`:

- **`test`** — push para `main` e PRs: `npm ci` + `npm test` (Node 24, o mesmo que o `zerops.yml` suporta; testar noutro número daria um verde que a produção não reproduz).
- **`deploy`** — só em push para `main` e com `needs: test`: `zcli login` + `zcli push api --setup api -w clean --version-name $GITHUB_SHA`. Um workflow só é o que garante que o deploy nunca corre com testes vermelhos; dois workflows separados correm em paralelo e o deploy disparava à mesma.

Notas de implementação:
- `ZEROPS_CLI_TERMINAL_MODE=disabled` — o runner não tem TTY; sem isto os spinners/prompts do zcli podem travar o job.
- `-w clean` — sobe só o HEAD do commit. Sem isto, o default `all` inclui ficheiros untracked do checkout (ex.: `node_modules` se algum pass o instalar).
- O projeto tem os serviços managed `db` e `cache`, por isso o serviço tem de ser explícito no push (`zcli push api`). O ID do projeto (`9n1HBsuHT72ZgP2XkXXAIA`) está como env no job de deploy — não é segredo.
- O `zcli` só conhece `login` (token como argumento posicional, não há flag `--token`) e `push` (não existe `zcli deploy`). A instalação é via `https://zerops.io/zcli/install.sh`.

### Secret necessário no GitHub

| Secret | Conteúdo |
|---|---|
| `ZEROPS_API_TOKEN` | Token de API do Zerops — GUI → settings/token-management. É o único segredo: o ID do projeto está no próprio workflow. |

`JWT_SECRET` **não** é secret do GitHub: é env do serviço `api` no Zerops (ver secção 2). O DNS continua a ser configuração única manual na Cloudflare (o IPv6 do Zerops é estático).

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

- [ ] Criar `zerops.yml` (feito).
- [ ] Criar `schema.postgres.sql` e `pg.js`.
- [ ] Adaptar `server.js` para `pg`.
- [ ] `npm install pg` + `npm test` verdes localmente.
- [ ] Criar serviços `api`, `db`, `cache` no projeto Zerops (`zcli service create` ou import YAML).
- [ ] `zcli push` → obter IPv6 do serviço `api`.
- [ ] Criar registo `AAAA` no Cloudflare com proxy activo.
- [x] Criar GitHub Actions (CI + deploy prod; secção 4). Falta o secret `ZEROPS_API_TOKEN` no GitHub.
- [ ] Testar PR preview → destroy on merge.
- [ ] Testar merge to main → update prod.
