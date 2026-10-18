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
| `omie_daily` | agregados diários: `bd_v`/`bd_f` (bi-diário) e `bs_v`/`bs_f` (bi-semanal) |
| `omie_spot` | quartos-horários (preço, instante, origem) — em construção |

Criadas no schema mas ainda sem uso no POC (fase 2):

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
3. **A EGME (`activation_eur`) é o que a CEME publica**, não um valor
   regulado único. Varia por CEME (0,1088 legal, 0,11 Atlante, 0,15
   ACP/EVIO, 0,1572 Charge2Go/EVPower/Via Verde); o miio não cobra.
   Auditado por teste — ver `backend/test/poc.test.js`.
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
