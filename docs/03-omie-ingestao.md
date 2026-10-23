# 03 — Ingestão OMIE

> **Estado:** implementada. O backend vai buscar o **omie.es** (a fonte
> oficial) e, em paralelo, os ficheiros do **Tiago Felícia** (CC BY 4.0),
> reconcilia os dois por **instante** e guarda tudo na **base de dados**.
> Não há cron: a actualização é **a pedido** (ver «Quem busca e quando»).

## As duas fontes

| fonte | o que é | para que serve |
|---|---|---|
| **omie.es** | o dump acumulado público (12 meses de quartos-horários, ~2,8 MB) | **primária**: o preço |
| **dados.tiagofelicia.pt** (TF) | o ano corrente + o histórico do ano anterior + os futuros OMIP | **secundária**: a classificação do período horário (BD/BS, as regras da ERSE), os buracos e as estimativas dos dias que a OMIE ainda não publicou |

O ficheiro do omie.es é pedido de forma **condicional** (`If-None-Match` /
`If-Modified-Since`, com o ETag guardado na BD): enquanto o ficheiro não
muda, a resposta é um **304** e não se gasta rede. Os ficheiros do TF são
guardados em disco (`backend/data/`, fora do versionamento) e só são
re-baixados quando envelhecem — o do ano corrente de 24 h em 24 h, o do ano
anterior uma vez por ano.

Antes, o ficheiro do ano corrente (1,8 MB) e o do ano anterior (1,9 MB)
eram re-baixados de duas em duas horas para extrair sempre a mesma
informação: dezenas de MB por dia para dados que mudam uma vez.

## A chave é o instante

Tudo é guardado em **UTC**, indexado pelo **instante** (`ts_utc`).

A hora local nunca é a chave: na mudança de hora de Outono a hora de
relógio repete-se (as 02:00 acontecem duas vezes em Lisboa), e duas linhas
com a mesma hora de relógio colidiam. O instante é a única coisa que não se
repete.

Os dias são **civis de Lisboa** (o bucket `day_utc`), e é assim que se
agrega por dia e por mês — bate certo com os agregados que o TF publica.

## Reescrita (o que cada refresh volta a escrever)

Os upserts são idempotentes, mas nem tudo é reescrito de cada vez:

- **omie.es**: os dias em falta mais os 3 dias antes do último dia do
  ficheiro (é onde a OMIE pode ter corrigido);
- **TF**: os dias em falta mais a janela **[(hoje − 10 dias) … (hoje + 45
  dias)]** em dias civis de Lisboa — é aí que o TF revê os dados (reais que
  substituem estimativas, estimativas revistas). Sem janela explícita, o
  "último dia do lote" seria 31 de Dezembro e as revisões dos dias recentes
  ficavam congeladas na BD depois da primeira ingestão.

## Reconciliação

Por instante:

1. o **preço** é o do omie.es quando existe; o do TF quando o omie.es não
   traz esse instante;
2. a **classificação** (BD/BS) é a do TF — que aplica as regras da ERSE; e
   quando também não há, as do motor (`engine/regions.js`), calculadas a
   partir do instante;
3. o que está **para além do último instante publicado** pelo omie.es é uma
   **estimativa OMIP** (o TF vai mais longe do que o mercado) — e fica
   marcado como tal.

As duas fontes escrevem linhas separadas (a chave primária é
`(ts_utc, source)`); a reconciliação acontece na leitura, o que evita
depender da ordem em que as actualizações chegam.

## Quem busca e quando

**Não há cron.** A actualização é a pedido:

- a idade do que está na BD (`omie_meta.last_refresh`) decide: se está
  fresco (1 h), ninguém vai buscar nada;
- se está velho, o **primeiro pedido** dispara a actualização **em segundo
  plano** e serve-se o que já há — quem chegou não espera;
- se ainda **não há nada** (arranque a frio, BD nova), o primeiro pedido
  **espera** pela ingestion, porque não há o que mostrar.

### Várias réplicas

O refresh é protegido por um **lock na própria BD** (uma linha em
`omie_meta`, com expiração de 10 min): se duas réplicas receberem pedidos
ao mesmo tempo, só uma busca o ficheiro; a outra serve o que já está na
BD. Os upserts são **idempotentes**, por isso quem chegar depois não
estraga nada — a única consequência é trabalho repetido, evitado pelo lock
e pelo pedido condicional.

### Onde ficam os dados

Na **base de dados** (PostgreSQL em produção, SQLite em dev), não em
ficheiros do contentor: a BD é gerida, persiste entre deploys e é
partilhada por todas as réplicas. Com ficheiros, cada réplica tinha a sua
cópia e um deploy deitava tudo fora.

Os ficheiros grandes do TF ficam em disco **como cache** (por réplica) —
são descartáveis e voltam a ser baixados se for preciso.

## O ficheiro do omie.es

`https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT`
(dump acumulado, janela rolante ~12 meses: 367 dias, 35.137 linhas de
dados, 96 períodos/dia em quarto-horário — 92 na Primavera e 100 no
Outono, nos dias de mudança de hora).

Formato (latin1, `;`):
`Fecha(d/m/aaaa);Periodo(1..96);ES(EUR/MWh);PT(EUR/MWh);...`
Decimais com vírgula (`219,86`). Preços PT==ES na maioria das horas
(acoplamento MIBEL); divergem em separação de mercado.

**Credenciais:** não são precisas. O ficheiro é público. A API registada da
OMIE (que dá ficheiros por dia, mais pequenos) exige conta — fica para
quando o volume justificar.

## Conversão hora de mercado → instante

O `Periodo N` é o quarto-horário N do dia de mercado, que corre 00:00-24:00
em **Madrid** (CET/CEST). A conversão para UTC é directa:

```
instante = meia-noite de Madrid no dia de mercado + (N-1) × 15 min
```

e depois o instante é o que se guarda. A meia-noite do dia de mercado usa o
offset **antigo** no dia da mudança de hora (WET/CET às 00:00), porque a
transição acontece às 01:00 UTC — sempre depois da meia-noite local.

O ficheiro do TF, ao contrário, está em **hora de Lisboa** e os seus dias
são dias civis de Lisboa (a média do dia bate com o agregado diário que o
TF publica). O instante de cada linha sai da coluna `hora` (o fim do
quarto), não da posição da linha — se faltar uma linha, as seguintes não se
deslocam. No dia de Outono a hora repete-se (100 linhas) e a ordem das
linhas distingue a primeira passagem da segunda (+60 min a partir do
momento em que o relógio anda para trás).
Por isso os dois ficheiros estão desfasados uma hora e se
alinham pelo **instante**, não pelo período.

## Agregação: o "OMIE de referência" que cada CEME usa

O agregação é um dado por tarifário e não uma regra única:

| média | ciclo | usada por |
|---|---|---|
| `bd_v` / `bd_f` | Vazio / Fora-Vazio no ciclo **bi-diário** | `SPLIT_VAZIO_FORA` em tarifas de ciclo diário |
| `bs_v` / `bs_f` | Vazio / Fora-Vazio no ciclo **bi-semanal** | `SPLIT_VAZIO_FORA` em tarifas de ciclo semanal |
| média única | média de todas as bandas | `UNICA` e `SPOT` |

O frontend lê `bd_v`/`bd_f`/`bs_v`/`bs_f` de `/v1/omie/daily` e envia
`omieVazio`/`omieFora` no `POST /v1/simulate`, para que um indexado de um
CEME que separa bandas não seja comparado contra outro que não separa.
Ver `02-motor-calculo.md`.

## Validação defensiva (erros reais, sobretudo na mudança de hora)

O pipeline nunca rebenta por dados maus — quarentena em vez de crash:

- parse: latin1→utf8, BOM, `,` vs `.` decimais, linhas vazias/rodapé,
  `Periodo` fora de 1..100, preço não-numérico → linha para quarentena +
  `warning` (não aborta o dia);
- dia: a contagem de períodos é a do ficheiro; dias com 92/96/100 são
  normais (mudança de hora);
- preços: gama plausível `-500..3000` €/MWh; fora disso → `suspect`
  (não apaga); `PT vs ES`: divergência > 100 €/MWh fora de separação
  conhecida → `suspect`;
- fetch: timeout 25-60 s, retry 3x com backoff, pedido condicional;
- DST: o instante é a chave, por isso a hora repetida de Outono são duas
  linhas diferentes — e nunca uma hora inexistente em Março.

## Backfill e validação cruzada

- Validação cruzada com o TF: é o que a reconciliação faz todos os dias
  (e o que se vê nas divergências: o omie.es e o TF discordam em ~50
  quartos por dia — o TF serve o dia anterior a um dia de atraso em
  alguns períodos).
- `Perfis Perdas E-REDES` (xlsx anual) e `TAR` (despacho ERSE) entram por
  CSV manual versionado (`backend/src/db/seed.js`, não por scrape).
  Os factores de perdas em uso estão patentes em `engine/indexed.js`
  (`LOSS_PLACEHOLDER`) — ver a nota de verificação em `02-motor-calculo.md`.
