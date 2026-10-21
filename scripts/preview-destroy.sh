#!/usr/bin/env bash
# Destrói um preview environment de uma PR.
# Uso: PR_NUMBER=42 ZEROPS_PROJECT_ID=... ./scripts/preview-destroy.sh
set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER é obrigatório}"
: "${ZEROPS_PROJECT_ID:?ZEROPS_PROJECT_ID é obrigatório}"
DOMAIN="${DOMAIN:-}"

echo "==> Remover registo DNS (se existir): $DOMAIN"
# Cloudflare: apagar AAAA de $DOMAIN

echo "==> Remover hostname do L7 balancer (se registado)"
# API Zerops

echo "==> Destruir projecto Zerops $ZEROPS_PROJECT_ID"
# zcli project delete "$ZEROPS_PROJECT_ID" --confirm

echo "==> Limpar ficheiros temporários"
rm -f /tmp/ceme-prod.dump /tmp/preview-import.yaml

echo "DONE (skeleton — descomentar comandos após validar)"