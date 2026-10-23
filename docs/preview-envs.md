# Preview environments por PR (manual, opcional)

Ambientes efémeros para **ver o conteúdo de uma PR a correr** sem tocar em
produção. Trigger manual, destruição manual. Pensado para review de PRs de
novos frontends.

## Princípios

- **Produção não é tocada.** O preview tem o seu próprio projeto Zerops
  (`ceme-v2-pr-<N>`), com `api` + `db` próprios.
- **DB por snapshot, não por seed**, quando se quer paridade com a produção
  (edições manuais via MCP). Alternativa: seed bootstrap (mais simples, sem
  dados sensíveis). Escolher com o flag `USE_SNAPSHOT`.
- **Modo readonly opcional** (`CEME_READONLY=1`) para apontar o preview a uma
  DB de produção readonly — só para PRs do próprio mantenedor, nunca para
  contribuidores externos (risco de exfiltração).
- **Destruição obrigatória** ao fechar/merge a PR.

## Porque existe `CEME_SKIP_SEED` (o seed não é "ignore")

O seed (`backend/src/db/seed.postgres.js` e `seed.js`) é **convergente**:
faz `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` — re-aplica os valores do
seed sobre as linhas existentes. Não é "só insere se não existir". Correr o
seed contra uma DB com snapshot (ou com edições manuais via MCP)
**sobrescreve** os tarifários com os valores do seed, apagando as edições.

Daí:
- Preview por seed → deixa o seed correr (comportamento por defeito).
- Preview por snapshot → `CEME_SKIP_SEED=1` (salta o seed, mantém schema +
  tar; o snapshot preserva-se).
- Preview readonly em prod → `CEME_READONLY=1` (salta tudo que escreve).

## Zerops backup vs. dump manual (net fraca)

O Zerops tem backups nativos por serviço (UI + `zcli backup create`), mas:
- A chave de encriptação é **por projecto** (X25519). Quando o projecto é
  apagado, a chave é destruída após 7 dias → backups do projecto prod não
  são restauráveis noutro projecto.
- O restore é "download + ferramentas do serviço" (pg_restore), via VPN ou
  durante deploy. Não há restore cross-project automático.

**Não** faças dump da DB inteira. Exclui:

- as tabelas do OMIE (`omie_spot`, `omie_daily`, `omie_meta`) — o backend
  re-ingere-as **a pedido**, no primeiro pedido OMIE (docs/03). O
  `omie_meta` tem mesmo de ficar de fora: leva o `last_refresh` e o ETag da
  produção, e o preview achava-se "fresco" com as tabelas vazias (e o omie.es
  respondia 304 sem dados);
- as tabelas de credenciais e de utilizadores (`api_key`, `api_client`,
  `audit_log`, `suggestion`) — um preview não leva hashes de chaves da
  produção.

Só precisas das tabelas de referência (ceme, tariff, tariff_version,
price_component, tar). Com `--format=custom` + compressão, o dump é pequeno.

```sh
pg_dump "$PROD_DB_URL" --no-owner --no-acl --format=custom --compress=9 \
  --exclude-table=omie_spot --exclude-table=omie_daily \
  --exclude-table=omie_meta \
  --exclude-table=api_key --exclude-table=api_client \
  --exclude-table=audit_log --exclude-table=suggestion \
  -f /tmp/ceme-prod.dump
```

Se a net for mesmo fraca, podes restaurar via **VPN do Zerops** (acesso
directo ao db do preview) em vez de download/upload de ficheiros.

## Pré-requisitos

- `zcli` instalado e autenticado (`zcli login`).
- `psql`/`pg_dump`/`pg_restore` no PATH (para snapshot).
- Acesso readonly à DB de produção (opcional, só para snapshot/readonly).
- Token Zerops com escopo ao projecto de previews (ou usar a conta pessoal).
- IPv6 do projecto de produção **não** é necessário para previews.

## Variáveis de ambiente (shell)

```sh
export PR_NUMBER=42
export PROJECT_NAME="ceme-v2-pr-${PR_NUMBER}"
export DOMAIN="pr-${PR_NUMBER}.ceme-beta.ocarroeletrico.com"   # opcional
export PROD_DB_URL="postgres://readonly:...@host:5432/db"      # só para snapshot
export USE_SNAPSHOT=1                                          # 0 = seed
export CEME_READONLY=0                                         # 1 = DB prod readonly
```

Nunca escrevas `PROD_DB_URL` num ficheiro do repo. Exporta na shell ou num
ficheiro fora do repo (ex: `~/.ceme-preview.env`, gitignored).

## Criar o preview

Passos (executar em ordem; parar em qualquer erro):

### 1. Criar o projecto Zerops

```sh
zcli project create "$PROJECT_NAME"
# anota o project-id devolvido
export ZEROPS_PROJECT_ID=<id>
```

### 2. Importar os serviços (db + api)

Usar um import adaptado de `zerops-import.yaml`, com hostname `db` e `api`,
autoscaling mínimo (1 CPU / 0.25 GB / 1 GB disco). Copiar `zerops-import.yaml`
para `/tmp/preview-import.yaml` (fora do repo) e ajustar o projecto:

```sh
zcli project service-import /tmp/preview-import.yaml -P "$ZEROPS_PROJECT_ID"
```

### 3. Push do código da PR

Fazer checkout da branch da PR num worktree, depois:

```sh
cd <worktree>
zcli push api --setup api -P "$ZEROPS_PROJECT_ID"
```

O `zerops.yml` do repo já define build/run. O serviço arranca com seed por
omissão (a menos que `CEME_SKIP_SEED=1` ou `CEME_READONLY=1`).

### 4. Restaurar snapshot (se `USE_SNAPSHOT=1`)

```sh
# dump selectivo da produção (readonly) — sem o OMIE (re-ingerido a pedido) nem credenciais
pg_dump "$PROD_DB_URL" --no-owner --no-acl --format=custom --compress=9 \
  --exclude-table=omie_spot --exclude-table=omie_daily \
  --exclude-table=omie_meta \
  --exclude-table=api_key --exclude-table=api_client \
  --exclude-table=audit_log --exclude-table=suggestion \
  -f /tmp/ceme-prod.dump

# connection string do db do preview (obtida na consola Zerops ou via API)
export PREVIEW_DB_URL="postgres://...@...:5432/..."

# restore
pg_restore --clean --if-exists --no-owner --no-acl \
  -d "$PREVIEW_DB_URL" /tmp/ceme-prod.dump

# reiniciar o api do preview em modo skip-seed (para não sobrescrever)
# definir env CEME_SKIP_SEED=1 no serviço api do preview (GUI ou API)
```

Após restore, reiniciar o serviço `api` do preview (GUI: restart) para que
o bootstrap com `CEME_SKIP_SEED=1` corra (schema idempotente + tar, sem
seed).

### 5. (Opcional) Modo readonly em vez de snapshot

Se preferires não copiar dados (só leitura da BD de produção):

- Definir `DATABASE_URL=$PROD_DB_URL` e `CEME_READONLY=1` no serviço `api`
  do preview.
- Nada é escrito na BD: o bootstrap salta schema/seed/TAR/chave, o OMIE não
  ingere nem grava derivados (as estatísticas calculam-se em memória), e o
  `run()` do `db.js` recusa qualquer escrita que escape (docs/03).
- `zerops.yml` define `DATABASE_URL: ${db_connectionString}`; confirmar que o
  valor do preview se sobrepõe (precedência das envs do Zerops — não
  verificado).
- **Atenção:** o preview passa a ler dados de produção. Só para PRs do
  próprio mantenedor, nunca para contribuidores externos.

### 6. Registar domínio (opcional)

Se quiseres `pr-<N>.ceme-beta.ocarroeletrico.com` em vez do URL default do
Zerops:

1. Registar o hostname no L7 balancer do projecto preview (API Zerops,
   `POST .../public-http-routing`), apontando para o serviço `api`, porta 3001.
2. Criar registo `AAAA` no Cloudflare para `pr-<N>...` → IPv6 do projecto
   preview, proxy activo.
3. Validar DNS (`PUT .../trigger-domains-dns-check`).

Ver `infra.md` §3 para a sequência exacta (Zerops primeiro, depois
Cloudflare, depois validar).

### 7. Comentar a PR com o URL

```sh
gh pr comment "$PR_NUMBER" --body "Preview: https://<url-do-preview>"
```

Ou manualmente no GitHub.

## Destruir o preview

**Obrigatório** ao fechar ou fazer merge da PR.

```sh
# 1. Remover registo DNS (se foi criado)
#    Cloudflare: apagar o AAAA de pr-<N>...

# 2. Remover hostname do L7 balancer (se foi registado)
#    API Zerops: DELETE/PUT conforme a rota (ver infra.md §3)

# 3. Destruir o projecto
zcli project delete "$ZEROPS_PROJECT_ID" --confirm

# 4. Limpar ficheiros temporários
rm -f /tmp/ceme-prod.dump /tmp/preview-import.yaml
```

Se o projecto não for destruído, continua a consumir recursos (e a custar
dinheiro) enquanto existir.

## Automação futura

Este roteiro é manual. Se o volume de PRs justificar, automatizar via
GitHub Actions (`workflow_dispatch` ou `pull_request`) com um token Zerops
de escopo mínimo guardado como secret do repositório — contraria o princípio
"sem credencial Zerops no GitHub" (infra.md §4.2), por isso só vale a pena
com volume alto.

## Como o agent (OpenCode) deve executar

Quando o utilizador pedir "criar preview da PR #N":

1. Ler este documento e `infra.md` §2-3.
2. Perguntar ao utilizador: snapshot ou seed? readonly prod ou não? domínio custom ou URL default do Zerops?
3. Recolher variáveis em falta (PR_NUMBER, PROD_DB_URL se snapshot) **sem** as escrever em ficheiros do repo.
4. Executar os passos de `scripts/preview-create.sh` um a um, parando em cada comando destrutivo/externo para confirmação. **Atenção:** os scripts são **esqueletos** — os comandos `zcli`/`pg_dump`/`pg_restore`/`gh` estão comentados (falta validar a versão do `zcli`); correr o script tal como está só imprime os passos.
5. Nunca executar `zcli project delete` ou alterações de DNS sem confirmação explícita.
6. Após criação, comentar a PR com o URL (via `gh pr comment` ou instruir o utilizador).
7. Registar o `ZEROPS_PROJECT_ID` devolvido para posterior destruição (guardar fora do repo, ex: `~/.ceme-previews`).

Quando o utilizador pedir "destruir preview da PR #N":

1. Confirmar o `ZEROPS_PROJECT_ID`.
2. Executar os passos de `scripts/preview-destroy.sh` (também um esqueleto — ver acima).
3. Confirmar destruição (listar projectos Zerops).

## Checklist de segurança

- [ ] Preview não usa a JWT_SECRET de produção.
- [ ] DB de produção só é lida (nunca escrita) a partir de previews.
- [ ] Previews de contribuidores externos não usam readonly prod nem snapshot
  com dados sensíveis (usar seed).
- [ ] Preview destruído após review.
- [ ] Sem segredos no repo (PROD_DB_URL só em shell/env fora do repo).