# 02 — Motor de cálculo

Substitui as ~100 fórmulas `IF(WEEKDAY/TIME(...))` copiadas em `CEME!X:AD`
e os `=0,1+TAR!$C$5` manuais por funções puras, testadas, com fusos IANA
reais (`Intl`, DST automático).

> **Regra deste documento:** explica *as regras* e aponta para *onde vivem
> os valores*. Preços, K/CGS, perdas, âncoras e contagens não se copiam para
> aqui — mudam, e uma cópia desactualizada é pior do que nenhuma. A fonte de
> verdade de cada valor vem indicada.

## Onde está o quê

| peça | ficheiro |
|---|---|
| Fixos: `quoteFixed(...)` (total + `parts`, a conta linha a linha) | `backend/src/engine/quote.js` |
| Indexados: `indexedPrice(...)`, `breakevenOmie(...)`, `lossFor(...)` | `backend/src/engine/indexed.js` |
| Períodos: `periodForRegion(...)` (instante) e `periodForWall(...)` (relógio) | `backend/src/engine/regions.js` |
| Indexado vs fixo, quarto a quarto: `compareWithFixed`, `tallyWinners` | `backend/src/engine/compare.js` |
| Orquestração por tarifário (`quoteOne`), TAR, versões em vigor | `backend/src/server.js` |
| Preços, K/CGS/perdas/fórmula por tarifário, campanhas | `backend/src/db/seed.js` (`TARIFFS`, `SPLITS`, `VERSIONS`, `CAMPAIGN_END`) |
| TAR | `backend/src/server.js` (`TAR_2026`), tabela `tar` |
| Âncoras golden | `backend/test/golden.test.js` |

## Tempo: instantes, relógios e dias

Três coisas diferentes, que não se misturam:

- **Instante** — UTC, a chave de tudo (`ts_utc`, `at` em ISO com `Z`). É a
  única coisa que não se repete.
- **Relógio da região** — o período horário (vazio/fora) lê-se na hora local
  da **região do carregamento** (`REGIONS[region].tz`), nunca no fuso do
  browser nem no do servidor. A hora que o utilizador escreve é também a da
  região (`frontend/tz.js`).
- **Dia civil** — "hoje" é o dia civil em Portugal (`civilDay()` em
  `omie/convert.js`), nunca `CURRENT_DATE` da BD nem
  `toISOString().slice(0, 10)` (ambos dão o dia UTC, que entre as 00:00 e as
  01:00 de Verão ainda é ontem). A versão do tarifário e a TAR escolhem-se
  pelo dia civil **do carregamento**, no relógio da região.

**Mudança de hora (UE: sempre às 01:00 UTC):**

| dia | em Lisboa (e Madeira) | nos Açores |
|---|---|---|
| último domingo de Março | 00:59 → **02:00**: a hora **01:00–02:00 não existe** (dia de 23 h, 92 quartos) | 23:59 de sábado → 01:00: a hora 00:00–01:00 não existe |
| último domingo de Outubro | 01:59 → **01:00**: a hora **01:00–02:00 repete-se** (dia de 25 h, 100 quartos) | 00:59 → 00:00: a hora 00:00–01:00 repete-se |

(As 02:00–03:00 são a hora que salta em **Madrid** — o dia de *mercado* do
OMIE é o de Madrid; o dia civil que se mostra e agrupa é o de Lisboa. Ver
docs/03.)

Consequências no código: o que tem de distinguir as duas passagens da hora
repetida usa o instante, não o rótulo `HH:MM` (ex.: os "8 mais baratos" e as
faixas contíguas do comparador). Testes: `tz.test.js`, `omie-tz.test.js`,
`regions.test.js`, `frontend-smoke.test.js` (`ranges()`).

## Regras de período

- **Simples:** sempre `UNICO`.
- **Bi-horário diário** e **semanal**: as janelas por região estão em
  `regions.js` (`core()`), e as fontes/confiança em docs/07. No Continente,
  a época do sábado no ciclo semanal segue a **hora legal** (DST); nas ilhas,
  o mês (Jun–Out vs resto).
- **Feriados:** o próprio dia (OWN_DAY), sem excepção — igual à folha. Em
  aberto (roadmap): a Diretiva 3/2026 n.º 10 para MT no ciclo semanal.
- **Perdas por quarto de hora (E-REDES 2026)** — `Perdas(h)` vem do ficheiro
  oficial `Perfis_Perdas_E-REDES_2026` (<https://www.e-redes.pt/pt-pt/perfis-de-perdas-2026>),
  convertido por `scripts/etl-perdas.py` em `backend/src/engine/losses-2026.json`
  e lido por `engine/losses.js`. O ficheiro dá perfis *simples* por nível
  (BT, MT, AT, AT/RNT); as perdas que o cliente paga são a **cascata**:
  `BT = (1+BT)(1+MT)(1+AT)(1+AT/RNT) − 1`, `MT = (1+MT)(1+AT)(1+AT/RNT) − 1`.
  Confere com o valor publicado (2026-10-23, quarto que acaba às 23:30:
  BT 0,1484981). A hora do ficheiro é o **fim** do intervalo.
  - `/v1/indexed/quarters`: cada quarto usa o seu valor.
  - `/v1/simulate`: o preço por período usa a média das perdas dos quartos
    desse período no dia de `at` (o mesmo conjunto de quartos das médias do
    OMIE vazio/fora). `lossByPeriod` vem na resposta.
  - A média anual da cascata é BT 0,1531 / MT 0,0713 — era o antigo
    placeholder constante (`LOSS_PLACEHOLDER`), que fica só como fallback
    para anos sem perfil. Anos novos: correr o ETL e juntar o ano a `YEARS`
    em `losses.js`.

## Fixos

```
// ROUNDUP por componente (cada parcela arredonda-se a si mesma, como a
// fatura), e o total também por excesso depois do IVA:
base  = ROUNDUP(act,2) + ROUNDUP(apoio,2) + ROUNDUP(kwh*preço_final,2) + ROUNDUP(kwh*iec,2)
total = ROUNDUP(base × IVA_região, 2)          // IVA por região: REGIONS (regions.js)
```

Segue o `ROUNDUP(...)*1,23` de `CEME!AC/AD`. O preço final já traz a TAR
dentro, por isso a tabela `tar` **não** se soma nos fixos — serve para a
decomposição e para os indexados.

**A conta linha a linha (`parts`):** `quoteFixed` devolve as mesmas parcelas
arredondadas que entram no total — `energyTar` (kWh × preço final), `iec`,
`activation`, `support`, `base` (sem IVA), `vatEur` — e elas somam o total
ao cêntimo (propriedade testada em `engine.test.js`). Quando a separação
energia/TAR do período é conhecida, `energyTar` aparece também partida em
`energy` + `tar` (a TAR arredonda ao cêntimo, a energia fica com o resto,
sem cêntimos perdidos). O detalhe de cada tarifário no simulador mostra esta
conta.

### O preço final e a decomposição energia + TAR

O que o CEME publica é o preço **final** (com a TAR dentro). Onde a folha
tinha a fórmula `=energia + TAR!$x$n` (o CEME publicava a energia à parte),
guardamos a decomposição (`energy_only_eur_kwh` + `tar_eur_kwh`, no `SPLITS`
do seed — recuperada com `scripts/etl-ceme.js`). Onde só há o valor final,
**não se decompõe**: a diferença seria aritmética nossa, e um tarifário pode
ter sido publicado com uma TAR que entretanto mudou.

Nos indexados a decomposição é sempre exacta: a TAR é uma parcela da própria
fórmula.

### EGME / taxa de activação

O `act` é **o que o CEME publica**, à data da verificação — entra na conta
como está, sem substituição. O valor legal em vigor vive em `EGME_LEGAL`
(`server.js`). A API marca `activation_stale: true` (com `egme_legal` como
referência, e o cartão mostra o aviso) **só** quando o publicado é ainda o
valor legal anterior (`EGME_PREVIOUS`, o de 2025): valores próprios acima do
legal (packs, taxas do próprio CEME) são legítimos e não se marcam. Actualizar é tarefa de verificação do seed (ver
`.memories/ceme-tarifas-verificacao.md` e `.opencode/commands/ceme-check.md`),
não de re-derivar preços no código. Auditado em `poc.test.js` («auditoria
EGME»); o cenário «e se o CEME aplicasse o legal» fica no `golden.test.js`
(«cenário regulatório»).

## Indexados

Duas fórmulas (`indexed.js`), escolhidas por tarifário em
`VERSIONS[id].formula` (seed):

```
standard:  PE = (OMIE + K + CGS) × (1 + perdas) + TAR        // célula LuziGas!A3
ynerluz:   PE = (1 + perdas) × (OMIE + K) + CGS + TAR
```

- `OMIE`: €/kWh (`omie_spot.price_pt_eur_mwh / 1000`).
- `K`, `CGS`: da `tariff_version` (`k_index_eur_mwh`, `cgs_eur_mwh`), vindos
  de `VERSIONS` no seed. **Atenção à unidade:** apesar do sufixo `_eur_mwh`
  nas colunas, os valores guardados e usados são **€/kWh** (somam-se
  directamente ao OMIE em €/kWh).
- `Perdas(h)`: perfil E-REDES por quarto de hora e tensão (`engine/losses.js`);
  sem perfil (ano não carregado) cai em `VERSIONS[id].loss` ou
  `LOSS_PLACEHOLDER[tensão]` (`indexed.js`).
- `TAR`: a da tabela `tar` **da região do carregamento**, em vigor no dia do
  carregamento. Sem TAR para (região, tensão, período) o tarifário vai para
  a quarentena em vez de sair um preço sem rede.

**Nota de verificação das perdas por omissão:** o ficheiro oficial
`Perfis_Perdas_E-REDES_2026` («Perfis de Perdas Simples») dá médias anuais
abaixo dos valores de `LOSS_PLACEHOLDER`; estes reproduzem as condições
publicadas pelos CEME indexados, não a média BTN do operador. Ficam como
placeholder até haver perfis por quarto de hora.

### Agregação do OMIE (`tariff_version.omie_aggregation`)

| valor | regra |
|---|---|
| `SPLIT_VAZIO_FORA` | o OMIE de cada período é a média desse período **no ciclo do próprio tarifário** (diário ≠ semanal: ao fim-de-semana as horas são outras) |
| `UNICA` | um só OMIE para os dois períodos |

Todos os indexados do seed são bi-horários, por isso todos usam
`SPLIT_VAZIO_FORA`. `UNICA` fica para um indexado simples.

O pedido `/v1/simulate` aceita:

- `omieCycles: { DIARIO: {vazio, fora}, SEMANAL: {vazio, fora} }` — o que a
  web manda: cada indexado usa o par do seu ciclo;
- `omie` / `omieVazio` / `omieFora` — override explícito, vale para todos
  (é o que o slider do comparador usa).

A web tira as médias de `/v1/omie/daily` (`bd_*` = ciclo diário, `bs_*` =
semanal), do **último dia completo** (`complete: true`): depois das ~13:00
o dia de amanhã já aparece, mas sem a última hora de Lisboa (ver docs/03).

## Âncoras golden

`backend/test/golden.test.js` congela os totais de um conjunto de fixos (a
40 kWh, num instante fixo, no Continente) e passa pelo **seed e pelo motor
reais** — não por valores escritos à mão no teste. Apanha regressões do
motor *e* alterações acidentais do seed. Os valores estão **só** no teste.

O que lá está, por blocos:

- **âncoras dos fixos** — comparação exacta ao cêntimo (`toFixed(2)`);
- **cenário regulatório** — o total que cada CEME com EGME acima do legal
  daria se aplicasse o legal;
- **o motor bate certo com a folha** — um caso de ponta a ponta e a prova de
  que o `ROUNDUP` é por componente (sem ele o total é diferente);
- **cobertura do seed** — as contagens de CEME e tarifários (é isto que
  apanha um tarifário que desapareça), preços com no máximo 4 casas
  arredondados para cima.

Quando uma âncora muda: só por mudança real do preço publicado, e
re-congela-se **com o motor** (não à mão) — o procedimento está no cookbook
`.memories/ceme-tarifas-verificacao.md`. A razão de cada re-congelamento
fica no histórico do git do seed e do teste.

**Os indexados não entram nas âncoras** — dependem do OMIE do dia. Ficam
testados com OMIE fixado: `indexed.test.js` e `formula.test.js` (que também
garante que o `idxPrice` do frontend e o `indexedPrice` do motor dão o
mesmo).
