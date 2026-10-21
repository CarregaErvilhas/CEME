# 01 — Modelo de dados

## Fontes

- **Sheet** `1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84` (34 tabs) — export
  integral em `ceme-v2-deep/fonte/simulador-original.xlsx` + dumps TSV.
- **ERSE** — diretivas de TAR/EGME/IEC/IVA (introduzidas manualmente 1×/ano).
- **OMIE / REN / tiagofelicia.pt** — séries de preço (ver `03`).

## Tabelas

| tabela | conteúdo |
|---|---|
| `ceme` | 24 comercializadores (nome, cor, site) |
| `tariff` | 128 tarifários (CEME, nome, fixo/indexado, tensão, ciclo, verde, bundle, regiões, URL fonte) |
| `tariff_version` | versão com `valid_from`/`valid_to`, `k_index_eur_mwh`, `cgs_eur_mwh`, `omie_aggregation`, estado. Chave única `(tariff_id, valid_from)`: uma versão por tarifário e data. `valid_from` no seed é a **data de captura** (`SHEET_SNAPSHOT`), não a data de início do contrato — a folha CEME não tem coluna de datas |
| `price_component` | preço €/kWh por período + `activation_eur` (EGME) + `support_eur` + `iec_eur_kwh` |
| `tar` | TAR por região/tensão/período, versionada |
| `omie_daily` | agregados diários materializados a partir de `omie_spot`: `avg_pt`, `min_pt`, `max_pt` e as quatro médias por ciclo (`bd_v`/`bd_f`/`bs_v`/`bs_f`) — é o que serve `/v1/omie/daily` |
| `omie_spot` | quartos-horários, um por linha, indexados pelo **instante UTC** (`ts_utc`) e pela fonte (`source`: `OMIE_ES` ou `TF`) |
| `omie_meta` | estado da ingestion: quando foi o último refresh, o ETag do ficheiro oficial (para o pedido condicional), o payload das estatísticas e o lock entre réplicas |

`omie_spot`, `omie_daily` e `omie_meta` são o **store** do OMIE: o backend
busca o omie.es (primária) e o TF (secundária), reconcilia por instante e
guarda aqui — ver `03-omie-ingestao.md`.

Criadas no schema mas ainda sem uso (fase 2):

| tabela | para quê |
|---|---|
| `loss_profile` | perdas E-REDES por DSO, tensão e quarto de hora |
| `suggestion` | sugestões da comunidade / portal CEME (fila de moderação) |
| `api_client`, `api_key` | chaves para terceiros (só o hash fica na BD) |
| `audit_log` | quem mudou o quê, e quando |

Nota: `omie_quarter` nunca existiu no schema — o nome certo é `omie_spot`.
## Decisões

1. **Versionamento temporal.** Um tarifário é um conjunto de versões com
   validade; passado, presente e futuro resolvem-se com a mesma query. Uma
   campanha é uma versão com `valid_to`.
2. **`omie_aggregation` é dado, não constante.** Ver `02-motor-calculo.md`:
   uns CEME usam média por banda (`SPLIT_VAZIO_FORA`), outros média única
   (`UNICA`), outros o spot do quarto (`SPOT`).
3. **A EGME (`activation_eur`) é o que a CEME publica no sheet, à data da
   captura** — um único significado, sem substituição no código. A
   referência regulamentar fica em metadados: o valor legal 2026 é
   **0,1088 €** (Regul. ERSE 7/2026, desde 2026-01-01; os 0,1572 € que
   Charge2Go, EVPower, Via Verde e parte da EVIO ainda mostravam à data de
   captura são o valor de 2025 — a maior parte das restantes já estava em
   0,1088 no sheet). Quando o publicado está acima do
   legal, a API devolve `activation_stale: true` e `egme_legal`; o cartão
   mostra o aviso, e a actualização vem de **nova captura da folha** (nova
   `tariff_version`), não de re-derivar preços a cada regulamento.
   Excepções publicadas: 0,11 € Atlante, 0,15 € ACP e parte da EVIO. O miio
   não cobra. Auditado por teste — ver `backend/test/poc.test.js`.
4. **Fixos incluem a TAR.** O `energy_eur_kwh` do sheet é o preço final
   (energia + TAR), pelo que a tabela `tar` **não** se soma aos fixos; serve
   para auditoria e para os indexados. Só o indexado compõe
   `(OMIE + K + CGS) × (1 + perdas) + TAR`.
5. **Ativação = EGME, e é o valor do sheet.** O seed tinha um bug que zerava
   `act`/`support`/`iec` nos indexados — corrigido em 2026-10-18, com teste de
   auditoria.
6. **Regiões como dimensão de primeira classe** (`regions` no tarifário +
   `region` na API): IVA, fuso, janelas e TAR próprias.

## Migração do sheet

`backend/src/db/seed.js` é idempotente (`INSERT OR IGNORE`); `rm -rf data`
e arrancar o servidor recria a BD do zero. Recontagens esperadas: **24 CEME,
128 tarifários** — cobertas por teste.
