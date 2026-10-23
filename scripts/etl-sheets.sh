#!/bin/sh
# Dumps da folha em TSV (idempotente). Requer o `gog` autenticado.
# Uso: sh scripts/etl-sheets.sh
#
# Traz os VALORES e as FÓRMULAS: nas fórmulas está a decomposição
# energia + TAR dos tarifários em que o CEME publicava a energia à parte.
# A seguir: node scripts/etl-ceme.js (lê estes ficheiros por omissão).
# Os dumps ficam em backend/seed/, que está no .gitignore: são dados de
# terceiros e não entram no repositório. O seed (backend/src/db/seed.js) é
# escrito à mão a partir deles.
ID="1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84"
mkdir -p backend/seed
gog sheets get "$ID" "'CEME'!A1:AJ101" --plain > backend/seed/ceme.tsv
gog sheets get "$ID" "'CEME'!A4:S101" --plain > backend/seed/ceme-valores.tsv
gog sheets get "$ID" "'CEME'!A4:S101" --render=FORMULA --plain > backend/seed/ceme-formulas.tsv
gog sheets get "$ID" "'TAR'!A1:G13" --plain > backend/seed/tar.tsv
gog sheets get "$ID" "'Contactos CEME'!A1:E37" --plain > backend/seed/contactos-ceme.tsv
gog sheets get "$ID" "'LuziGas'!A1:N8" --plain > backend/seed/luzigas-formula.tsv
wc -l backend/seed/*.tsv
