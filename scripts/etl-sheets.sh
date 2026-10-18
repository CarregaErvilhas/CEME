#!/bin/sh
# ETL do Sheets para seed CSV (idempotente). Requer gog autenticado.
# Uso: sh scripts/etl-sheets.sh
ID="1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84"
mkdir -p backend/seed
gog sheets get "$ID" "'CEME'!A1:AJ101" --plain > backend/seed/ceme.tsv
gog sheets get "$ID" "'TAR'!A1:G13" --plain > backend/seed/tar.tsv
gog sheets get "$ID" "'Contactos CEME'!A1:E37" --plain > backend/seed/contactos-ceme.tsv
gog sheets get "$ID" "'LuziGas'!A1:N8" --plain > backend/seed/luzigas-formula.tsv
wc -l backend/seed/*.tsv
