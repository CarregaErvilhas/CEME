# 03 — Ingestão OMIE (fonte oficial omie.es)

## Ficheiro

`https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT`
(dump acumulado, janela rolante ~12 meses verificada em 2026-10-15:
367 dias, 35.137 linhas de dados, 96 períodos/dia em quarto-horário
(exceção: dias de mudança de hora têm 92 na Primavera e 100 no Outono).

Formato (latin1, `;`):
`Fecha(d/m/aaaa);Periodo(1..96);ES(EUR/MWh);PT(EUR/MWh);...`
Decimais com vírgula (`219,86`). Preços PT==ES na maioria das horas
(acoplamento MIBEL); divergem em separação de mercado.

## Conversão hora mercado → Europe/Lisbon

`Periodo N` = quarto-horário N do dia de mercado em CET (hora do leilão).
Conversão:

```
cet_start = DateTime(dia_mercado, CET).startOfDay + (N-1)*15min
lisbon    = cet_start.setZone('Europe/Lisbon')
```

Isto elimina a coluna `Hora em Portugal` calculada à mão
(`=DATEVALUE+TIME(C-1)-1:00`) que hoje falha no DST (`#VALUE!` em
`omie.es source`). Regra: **guardar sempre `ts_lisbon`**, manter
`market_day + market_period` como auditoria.

Casos DST (PT):
- último domingo de março: dia de 23h → 92 quartos;
- último domingo de outubro: dia de 25h → 100 quartos (hora repetida —
  distinguir pelo offset, não só pelo wall-clock).

## Pipeline (`backend/src/omie/`)

1. `fetch` (com `If-Modified-Since`, guarda `raw/` com data de emissão
   do cabeçalho `Fecha Emisión`).
2. `parse` (latin1 → utf8, vírgula → ponto, valida 92|96|100/dia).
3. `convert` (CET → Lisbon, como acima).
4. `upsert` em `omie_spot(ts_lisbon PK)` — idempotente.
5. `aggregate` → `omie_daily` (médias total/Vazio/Fora-Vazio por ciclo;
   alimenta o "OMIE actual" e o comparador D+1/D+2 quando o OMIE publicar
   o dia seguinte ~13h CET).
6. Log em `audit_log` + métricas (dias, quartos, gaps).

Frequência local: cron 2x/dia chega (OMIE publica 1x/dia + ajustes).

## Agregação: o "OMIE de referência" que cada CEME usa

O passo 5 produz `omie_daily` com **quatro** médias por dia, porque a
agregação é um dado por tarifário e não uma regra única:

| coluna | significado | usado por |
|---|---|---|
| `bd_v` / `bd_f` | média Vazio / Fora-Vazio no ciclo **bi-diário** | `SPLIT_VAZIO_FORA` em tarifas de ciclo diário |
| `bs_v` / `bs_f` | média Vazio / Fora-Vazio no ciclo **bi-semanal** | `SPLIT_VAZIO_FORA` em tarifas de ciclo semanal |
| média única | média de todas as bandas | `UNICA` e `SPOT` (este último usa o próprio quarto) |

O frontend lê `bd_v`/`bd_f`/`bs_v`/`bs_f` de `/v1/omie/daily` e envia
`omieVazio`/`omieFora` no `POST /v1/simulate`, para que um indexado de um
CEME que separa bandas não seja comparado contra outro que não separa.
Ver `02-motor-calculo.md`.

## Redundância (omie.es falha com frequência)

Ordem de preferência por quarto-horário, com `source` guardada por linha:

1. `OMIE_ES` — ficheiro oficial (primária, como decidido).
2. `REN` — DataHub (secundária; cobre buracos quando omie.es dá 500/timeout
   ou vem truncado; antes de 2025-10-01 era horária — aí replica-se 1h em
   4 quartos com `source=REN_HOURLY_FILL`).
3. `TF_FALLBACK` — `dados.tiagofelicia.pt/data/omie/omie_dados_atuais.csv` + `historico/omie_historico_AAAA.csv` (CC BY 4.0, com atribuição no `about` e nos metadados da API; já vem em hora PT com classificação de ciclos — óptimo para validação cruzada).

`reconcile()`: para cada `ts_lisbon`, usa a primeira fonte disponível na
ordem acima; regista `sources_used` por dia. Nunca mistura preços de
fontes diferentes dentro do mesmo quarto-horário sem marcar. Se as fontes
divergirem > 5 €/MWh no mesmo quarto, marca `conflict` e prefere a oficial,
mas guarda ambas em `raw/` para auditoria.

## Validação defensiva (erros reais, sobretudo na mudança de hora)

O pipeline nunca rebenta por dados maus — quarentena em vez de crash:

- parse: latin1→utf8, BOM, `,` vs `.` decimais, linhas vazias/rodapé,
  `Periodo` fora de 1..96, preço não-numérico → linha para quarentena +
  `warning` (não aborta o dia).
- dia: contagem esperada pela timezone (92 na primavera, 96 normal,
  100 no outono — calculada via `Europe/Lisbon`, não hardcoded);
  períodos em falta/duplicados → tenta preencher via fonte seguinte;
  se impossível, dia fica `PARTIAL` e o comparador mostra aviso.
- preços: gama plausível `-500..3000` €/MWh; fora disso → `suspect`
  (não apaga); `PT vs ES`: divergência > 100 €/MWh fora de separação
  conhecida → `suspect`; variação homóloga absurda (ex. 10x em 15min)
  → `suspect`.
- DST: hora inexistente (março, 01:00→03:00 Lisboa) nunca deve aparecer
  em `ts_lisbon` — se aparecer, é bug de conversão e vai para quarentena;
  hora repetida (outubro) distingue-se pelo offset (`+01:00` vs `+00:00`),
  nunca só pelo wall-clock.
- fetch: timeout 30s, retry 3x com backoff, `If-Modified-Since`, valida
  `Content-Length` vs corpo; guarda sempre o `raw/` mesmo com erro para
  debug (com data de emissão do cabeçalho quando existir).

## Backfill e validação

- Histórico pré-quarto-horário (REN horário, pre-2025-10-01): importa-se
  como 4 quartos iguais por hora, marcado `source=REN_HOURLY_FILL`.
- Validação cruzada opcional com `dados.tiagofelicia.pt` (CC BY 4.0) —
  fonte secundária, não primária, por decisão do dono.
- `Perfis Perdas E-REDES` (xlsx anual) e `TAR` (despacho ERSE) entram por
  CSV manual versionado em `backend/seed/` (não por scrape).
