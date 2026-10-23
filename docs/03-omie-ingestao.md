# 03 — Ingestão OMIE

> **Estado:** implementada. O backend vai buscar o **omie.es** (a fonte
> oficial) e, em paralelo, os ficheiros do **Tiago Felícia** (CC BY 4.0),
> reconcilia os dois por **instante** e guarda tudo na **base de dados**.
> Não há cron — **por decisão**: o tráfego não o justifica; revê-se se um dia
> justificar. A actualização é **a pedido** (ver «Quem busca e quando»).

## As duas fontes

| fonte | o que é | para que serve |
|---|---|---|
| **omie.es** | o dump acumulado público (uma janela rolante de ~12 meses de quartos-horários) | **primária**: o preço |
| **dados.tiagofelicia.pt** (TF) | o ano corrente + o histórico do ano anterior + os futuros OMIP | **secundária**: a classificação do período horário (BD/BS, as regras da ERSE), os buracos, as estimativas OMIP por quarto dos dias que a OMIE ainda não publicou, e os futuros diários `FPB D` |

O ficheiro do omie.es é pedido de forma **condicional** (`If-None-Match` /
`If-Modified-Since`, com o ETag guardado na BD): enquanto o ficheiro não
muda, a resposta é um **304** e não se gasta rede. Os ficheiros do TF são
guardados em disco (`backend/data/`, fora do versionamento) e só são
re-baixados quando envelhecem — os TTLs estão em `omie/tf.js`
(`TTL_DAILY` para o ano corrente, `TTL_HISTORY` para o anterior,
`TTL_FUTURES` para os futuros).

## A chave é o instante

Tudo é guardado em **UTC**, indexado pelo **instante** (`ts_utc`).

A hora local nunca é a chave: na mudança de hora de Outubro a hora de
relógio repete-se (a hora **01:00–02:00** passa duas vezes em Lisboa), e
duas linhas com a mesma hora de relógio colidiam. O instante é a única coisa
que não se repete. (Tabela das mudanças de hora em docs/02.)

Ao lado do instante, cada linha guarda o **dia civil de Lisboa**
(`day_lisbon`) e os **minutos desde a meia-noite de Lisboa** (`min_lisbon`)
— é por eles que se agrega por dia e por mês, e bate certo com os agregados
que o TF publica. (Estas colunas chamavam-se `day_utc`/`min_utc`, um nome
que mentia sobre o fuso; a migração renomeia-as sem perder dados.)

"Hoje" é sempre o dia civil de Lisboa (`civilDay()` em `omie/convert.js`),
nunca o dia UTC.

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

**Não há cron.** A actualização é a pedido, em **todas** as leituras do
OMIE (`/v1/omie/daily`, `/v1/indexed/quarters`, `/v1/omie/stats`):

- a idade do que está na BD (`omie_meta.last_refresh`) decide: se está
  fresca (menos que o TTL do refresh, `REFRESH_TTL_MS` em `pipeline.js`),
  ninguém vai buscar nada;
- se está velha, o pedido dispara a actualização **em segundo plano** e
  serve-se o que já há — quem chegou não espera (o `/stats` responde com
  `stale: true` enquanto isso);
- se ainda **não há nada** (arranque a frio, BD nova), o pedido **espera**
  pela ingestion, porque não há o que mostrar.

Os futuros (`/v1/omie/futures`) têm o seu próprio TTL (`TTL_FUTURES`). As
estatísticas também se recalculam quando muda o dia de Lisboa (docs/09).

### Várias réplicas

O refresh é protegido por um **lock na própria BD**: uma linha
`refresh_lock` em `omie_meta` cujo valor é `<epoch ms>:<token do dono>`.

- **tomar**: `INSERT … ON CONFLICT DO NOTHING`; se já existe e expirou
  (`LOCK_TTL_MS`), rouba-se com um compare-and-swap (`UPDATE … WHERE value =
  <o que se leu>`) — e só é nosso se o UPDATE mudou a linha. Duas réplicas a
  roubar o mesmo lock expirado: uma ganha, a outra desiste;
- **largar**: `DELETE … WHERE value = <o nosso token>` — se o nosso expirou
  e outra réplica o tomou, não se apaga o dela.

Testado em `omie-lock.test.js`. Os upserts são **idempotentes**, por isso
mesmo uma corrida não estraga dados — só gasta rede.

### Modo readonly

Com `CEME_READONLY=1` (a BD é de outro ambiente, ex. um preview contra a
produção) não há ingestion, nem escrita de derivados, nem de futuros: o
`ensureFresh` não faz nada e as estatísticas calculam-se em memória. A guarda
de fundo está em `db.js`: qualquer `run()` em readonly rebenta.

### Onde ficam os dados

Na **base de dados** (PostgreSQL em produção, SQLite em dev), não em
ficheiros do contentor: a BD é gerida, persiste entre deploys e é
partilhada por todas as réplicas. Com ficheiros, cada réplica tinha a sua
cópia e um deploy deitava tudo fora.

Os ficheiros grandes do TF ficam em disco **como cache** (por réplica) —
são descartáveis e voltam a ser baixados se for preciso.

## O ficheiro do omie.es

`https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT`
(dump acumulado, janela rolante de ~12 meses, 96 períodos/dia em
quarto-horário — 92 no dia de mudança de hora de Março e 100 no de
Outubro). O corpo tem de ter um tamanho mínimo (`omiees.js`), senão é tratado
como erro — uma página de erro com 200 não pode passar por dados.

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
offset **antigo** no dia da mudança de hora (em Madrid: CET +1 no dia de
Março, CEST +2 no de Outubro), porque a transição acontece às 01:00 UTC —
sempre depois da meia-noite local.

**Dia de mercado ≠ dia de Lisboa.** O dia de mercado de Madrid começa às
23:00 de Lisboa da véspera. Por isso, quando a OMIE publica o dia D+1 (por
volta das 13:00), o dia civil de Lisboa D+1 fica com **92** quartos — as
23:00–24:00 de Lisboa são do dia de mercado D+2, que ainda não saiu. O
`/v1/omie/daily` marca cada dia com `complete` (nº de quartos = o esperado
para esse dia de Lisboa) e a web usa como referência o último dia completo.

O ficheiro do TF, ao contrário, está em **hora de relógio de Lisboa** e os
seus dias são dias civis de Lisboa (a média do dia bate com o agregado
diário que o TF publica). O instante de cada linha **não** se calcula
somando minutos de relógio à meia-noite (no dia de Março, depois do salto
das 00:59 para as 02:00, isso punha os quartos uma hora ao lado — foi um bug
real); procura-se o quarto na lista real de quartos desse dia de Lisboa
(`lisbonDayQuarters`), pela hora de início (coluna `intervalo`), a seguir ao
quarto da linha anterior. Isso resolve o buraco de Março e a hora repetida
de Outubro da mesma maneira, e uma linha em falta não desloca as seguintes.
(Os dias de Março já gravados com o parser antigo são reparados uma vez,
na ingestion seguinte — `fix_tf_spring_dst_v1` em `omie_meta`.)

Os dois ficheiros alinham-se pelo **instante**, não pelo período.

## Agregação: o "OMIE de referência" que cada indexado usa

| média | ciclo | usada por |
|---|---|---|
| `bd_v` / `bd_f` | Vazio / Fora-Vazio no ciclo **diário** | `SPLIT_VAZIO_FORA`, tarifários de ciclo diário |
| `bs_v` / `bs_f` | Vazio / Fora-Vazio no ciclo **semanal** | `SPLIT_VAZIO_FORA`, tarifários de ciclo semanal |
| média única | todas as bandas | `UNICA` |

A web lê `bd_*`/`bs_*` do último dia **completo** de `/v1/omie/daily` e
envia `omieCycles` no `POST /v1/simulate`: cada indexado usa o par do seu
ciclo. Ver `02-motor-calculo.md`.

## Validação defensiva (erros reais, sobretudo na mudança de hora)

O pipeline nunca rebenta por dados maus — quarentena em vez de crash:

- parse: latin1→utf8, BOM, `,` vs `.` decimais, linhas vazias/rodapé;
  `Periodo` fora de 1..100 ou preço não-numérico → a linha vai para a
  quarentena (não aborta o dia); período repetido no mesmo dia → `warning`;
- dia: a contagem de períodos é a do ficheiro; dias com 92/96/100 são
  normais (mudança de hora). Um dia com menos períodos do que o esperado
  fica marcado como incompleto (`omie_meta.omie_partial_days`) — não se
  deita nada fora;
- preços (gamas em `parse.js`): preço PT fora da gama plausível →
  `suspect_range`; divergência PT vs ES acima do limiar →
  `suspect_pt_es_split` (sem distinguir separação de mercado legítima). As
  flags ficam na linha; não apagam nada;
- fetch: timeout 25-60 s, retry 3x com backoff, pedido condicional;
- DST: o instante é a chave, por isso a hora repetida de Outono são duas
  linhas diferentes — e nunca uma hora inexistente em Março.

## Backfill e validação cruzada

- **Não há validação cruzada automática** com o TF: a reconciliação usa o
  preço do omie.es sempre que existe e deita fora o do TF para esse
  instante, sem comparar nem contar divergências. (Se um dia interessar, é
  aí que se mede.)
- Perdas e TAR entram à mão, versionadas no código, não por scrape: perdas
  em `engine/indexed.js` (`LOSS_PLACEHOLDER`) e no `VERSIONS` do seed; TAR em
  `server.js` (`TAR_2026`). Ver `02-motor-calculo.md`.
