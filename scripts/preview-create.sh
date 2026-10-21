#!/usr/bin/env bash
# Cria um preview environment para uma PR.
# Uso: PR_NUMBER=42 ./scripts/preview-create.sh
# Variáveis opcionais: USE_SNAPSHOT=1, CEME_READONLY=1, DOMAIN=...
set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER é obrigatório}"
PROJECT_NAME="ceme-v2-pr-${PR_NUMBER}"
DOMAIN="${DOMAIN:-}"
USE_SNAPSHOT="${USE_SNAPSHOT:-0}"
CEME_READONLY="${CEME_READONLY:-0}"

echo "==> Criar projecto Zerops: $PROJECT_NAME"
# zcli project create "$PROJECT_NAME"
echo "    (comando comentado: descomentar após validar zcli version)"
# export ZEROPS_PROJECT_ID=...

echo "==> Importar serviços db + api"
# zcli project service-import /tmp/preview-import.yaml -P "$ZEROPS_PROJECT_ID"

echo "==> Push do código da PR"
# cd <worktree-da-pr> && zcli push api --setup api -P "$ZEROPS_PROJECT_ID"

if [ "$CEME_READONLY" = "1" ]; then
  echo "==> Modo READONLY: definir DATABASE_URL=prod (readonly) + CEME_READONLY=1 no serviço api"
elif [ "$USE_SNAPSHOT" = "1" ]; then
  : "${PROD_DB_URL:?PROD_DB_URL é obrigatório com USE_SNAPSHOT=1}"
  echo "==> Snapshot da DB de produção"
  # dump selectivo: exclui cache OMIE (re-populado no arranque) para poupar net
  # pg_dump "$PROD_DB_URL" --no-owner --no-acl --format=custom --compress=9 \
  #   --exclude-table=omie_spot --exclude-table=omie_daily \
  #   --exclude-table=omie_quarters --exclude-table=omie_futures \
  #   -f /tmp/ceme-prod.dump
  # pg_restore --clean --if-exists --no-owner --no-acl -d "$PREVIEW_DB_URL" /tmp/ceme-prod.dump
  echo "==> Definir CEME_SKIP_SEED=1 no serviço api do preview e reiniciar"
else
  echo "==> Seed bootstrap (omissão) — nenhum passo extra"
fi

if [ -n "$DOMAIN" ]; then
  echo "==> Registar domínio $DOMAIN (ver docs/preview-envs.md §6)"
fi

echo "==> Comentar a PR com o URL do preview"
# gh pr comment "$PR_NUMBER" --body "Preview: ..."

echo "DONE (skeleton — descomentar comandos após validar)"