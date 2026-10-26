# Preview environments por PR (manual, opcional)

Ambientes temporários para **veres uma PR a correr** sem tocar em
produção. Crias e destróis à mão. Dá jeito para rever PRs que mexem no
frontend.

> Os scripts `scripts/preview-create.sh` e `preview-destroy.sh` ainda têm os
> comandos comentados (falta validar a versão do `zcli`). Hoje, correr o
> script só imprime os passos: segue-os à mão.

## Princípios

- **Produção não é tocada.** O preview tem o seu próprio projecto Zerops
  (`ceme-v2-pr-<N>`), com `api` + `db` próprios.
- **BD a partir de uma cópia da produção** quando queres os mesmos dados
  (incluindo edições feitas à mão), ou **a partir do seed**, que é mais
  simples e não leva dados sensíveis. Escolhes com `USE_SNAPSHOT`.
- **Modo readonly opcional** (`CEME_READONLY=1`) para o preview ler
  directamente a BD de produção, sem escrever. Só para PRs do próprio
  mantenedor, nunca de contribuidores externos (podiam tirar dados).
- **Destrói sempre** o preview quando a PR fecha ou entra no `main`.

## Porque existe `CEME_SKIP_SEED`

O seed (`backend/src/db/seed.postgres.js` e `seed.js`) é **convergente**:
faz `INSERT ... ON CONFLICT (...) DO UPDATE SET ...`, ou seja, volta a
escrever os valores do seed por cima das linhas que já existem. Se o
correres contra uma cópia da produção, **apaga** as edições feitas à mão.

Por isso:
- Preview por seed → deixa o seed correr (comportamento por defeito).
- Preview por snapshot → `CEME_SKIP_SEED=1` (salta o seed, mantém schema +
  tar; o snapshot preserva-se).
- Preview readonly em prod → `CEME_READONLY=1` (salta tudo que escreve).

## Copiar dados da produção

Os backups do Zerops não servem para isto: a chave de encriptação é **por
projecto**, por isso um backup da produção não se restaura noutro projecto,
e o restore é manual (descarregar + `pg_restore`). Faz antes um dump
selectivo.

**Não** copies a BD inteira. Deixa de fora:

- as tabelas do OMIE (`omie_spot`, `omie_daily`, `omie_meta`): o backend
  volta a enchê-las no primeiro pedido ([03](03-omie-ingestao.md)). O
  `omie_meta` tem mesmo de ficar de fora: leva a hora da última
  actualização e o ETag da produção, e o preview achava que os dados
  estavam frescos com as tabelas vazias;
- as tabelas de credenciais e de utilizadores (`api_key`, `api_client`,
  `audit_log`, `suggestion`): um preview não leva hashes de chaves da
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

Com a rede fraca, podes restaurar através da **VPN do Zerops** (acesso
directo à BD do preview) em vez de descarregar e enviar ficheiros.

## Pré-requisitos

- `zcli` instalado e autenticado (`zcli login`).
- `psql`/`pg_dump`/`pg_restore` no PATH (para snapshot).
- Acesso readonly à DB de produção (opcional, só para snapshot/readonly).
- Token Zerops com acesso ao projecto de previews (ou a conta pessoal).
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
- `zerops.yml` define `DATABASE_URL: ${db_connectionString}`; confirma que o
  valor do preview se sobrepõe (a ordem de precedência das variáveis no
  Zerops ainda não foi testada).
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

## Automatizar

Este procedimento é manual. Automatizá-lo no GitHub Actions obrigava a
guardar um token do Zerops no GitHub, que hoje não tem nenhum
(`infra.md` §4.2). Só compensa com muitas PRs.

## Como um agente (OpenCode, Claude Code) deve executar isto

Quando o utilizador pedir "criar preview da PR #N":

1. Ler este documento e `infra.md` §2-3.
2. Perguntar ao utilizador: snapshot ou seed? readonly prod ou não? domínio custom ou URL default do Zerops?
3. Recolher variáveis em falta (PR_NUMBER, PROD_DB_URL se snapshot) **sem** as escrever em ficheiros do repo.
4. Executar os passos de `scripts/preview-create.sh` um a um, parando em cada comando destrutivo ou externo para confirmação (os comandos estão comentados no script; vê a nota no topo).
5. Nunca executar `zcli project delete` ou alterações de DNS sem confirmação explícita.
6. Após criação, comentar a PR com o URL (via `gh pr comment` ou instruir o utilizador).
7. Registar o `ZEROPS_PROJECT_ID` devolvido para posterior destruição (guardar fora do repo, ex: `~/.ceme-previews`).

Quando o utilizador pedir "destruir preview da PR #N":

1. Confirmar o `ZEROPS_PROJECT_ID`.
2. Executar os passos de `scripts/preview-destroy.sh` (também com os comandos comentados).
3. Confirmar destruição (listar projectos Zerops).

## Checklist de segurança

- [ ] Preview não usa a JWT_SECRET de produção.
- [ ] DB de produção só é lida (nunca escrita) a partir de previews.
- [ ] Previews de contribuidores externos não usam readonly prod nem snapshot
  com dados sensíveis (usar seed).
- [ ] Preview destruído após review.
- [ ] Sem segredos no repo (PROD_DB_URL só em shell/env fora do repo).