# 02 — Motor de cálculo

O motor é o conjunto de funções que, dado um tarifário e um carregamento
(quantos kWh, onde, quando), te dizem quanto custa. São funções puras: não
falam com a BD nem com a rede, por isso testas-las facilmente.

> **Regra deste documento:** explica as regras e diz-te onde vivem os
> valores. Preços, margens, perdas e resultados de testes não se copiam
> para aqui, porque mudam e uma cópia desactualizada engana mais do que
> nenhuma.

## Onde está o quê

| peça | ficheiro |
|---|---|
| Fixos: `quoteFixed(...)` (total + `parts`, a conta linha a linha) | `backend/src/engine/quote.js` |
| Indexados: `indexedPrice(...)`, `breakevenOmie(...)`, `lossFor(...)` | `backend/src/engine/indexed.js` |
| Perdas por quarto de hora: `lossAt(...)`, `lossByPeriod(...)` | `backend/src/engine/losses.js` |
| Períodos: `periodForRegion(...)` (instante) e `periodForWall(...)` (hora de relógio) | `backend/src/engine/regions.js` |
| Indexado vs fixo, quarto a quarto: `compareWithFixed`, `tallyWinners` | `backend/src/engine/compare.js` |
| Ler da BD versões, preços e TAR de uma vez (`loadPricing`) e cotar um tarifário (`quoteOne`) | `backend/src/tariffs.js` |
| Preços, K/CGS/perdas/fórmula por tarifário, campanhas | `backend/src/db/seed-data.js` (`TARIFFS`, `SPLITS`, `VERSIONS`, `CAMPAIGN_END`) |
| TAR | `backend/src/db/tar.js` (`TAR`), tabela `tar` |
| Datas, fusos e mudança de hora partilhados | `backend/src/time.js` |
| Resultados congelados (golden) | `backend/test/golden.test.js` |

## Tempo: instantes, relógios e dias

É aqui que mais bugs nascem, por isso vale a pena perceberes bem. Há três
coisas diferentes, que não se misturam:

- **Instante** — um momento exacto, em UTC (`ts_utc`, ou `at` em ISO
  terminado em `Z`). É a chave de tudo, porque é a única coisa que nunca se
  repete.
- **Hora de relógio da região** — o período (vazio ou fora de vazio) lê-se
  na hora local da **região do carregamento** (`REGIONS[region].tz`). Nunca
  no fuso do browser nem no do servidor. A hora que o utilizador escreve é
  também a da região (`frontend/tz.js`).
- **Dia de calendário** — "hoje" é o dia em Portugal, dado por `civilDay()`
  (`omie/convert.js`). Nunca uses `CURRENT_DATE` da BD nem
  `new Date().toISOString().slice(0, 10)`: os dois dão o dia em UTC, que
  entre a meia-noite e a 01:00 de Verão em Lisboa ainda é ontem. A versão do
  tarifário e a TAR escolhem-se pelo dia **do carregamento**, no relógio da
  região.

**Mudança de hora** (na UE, sempre à 01:00 UTC):

| dia | em Lisboa (e Madeira) | nos Açores |
|---|---|---|
| último domingo de Março | 00:59 → **02:00**: a hora **01:00–02:00 não existe** (dia de 23 h, 92 quartos) | 23:59 de sábado → 01:00: a hora 00:00–01:00 não existe |
| último domingo de Outubro | 01:59 → **01:00**: a hora **01:00–02:00 acontece duas vezes** (dia de 25 h, 100 quartos) | 00:59 → 00:00: a hora 00:00–01:00 repete-se |

Em Madrid a hora que salta é a 02:00–03:00. Isto conta porque o OMIE
organiza os dias pela hora de Madrid ([03](03-omie-ingestao.md)).

Consequência prática: quando precisas de distinguir as duas passagens da
hora repetida, usa o instante e não o texto `HH:MM` (é o que fazem os "8
mais baratos" e as faixas do comparador). Os testes destes casos estão em
`tz.test.js`, `omie-tz.test.js`, `regions.test.js` e
`frontend-smoke.test.js` (`ranges()`). Se mexeres em código de datas, corre-os.

## Regras de período

- **Simples:** sempre `UNICO`.
- **Bi-horário diário** e **semanal:** as horas de cada região estão em
  `regions.js` (função `core()`), e as fontes em [07](07-ilhas.md). No
  Continente, o sábado do ciclo semanal tem horas de Verão e de Inverno,
  conforme a hora legal (DST). Nas ilhas, conforme o mês (Junho a Outubro é
  Verão).
- **Feriados:** contam como o dia da semana em que calham. Em aberto
  ([06](06-roadmap.md)): a regra de feriados para MT no ciclo semanal.

## Perdas

Nos indexados, o OMIE é multiplicado por `(1 + perdas)`. As perdas vêm do
ficheiro oficial da E-REDES, `Perfis_Perdas_E-REDES_<ano>`
(<https://www.e-redes.pt/pt-pt/perfis-de-perdas-2026>), convertido por
`scripts/etl-perdas.py` em `backend/src/engine/losses-<ano>.json`.

O ficheiro dá um valor por quarto de hora para cada nível de tensão (BT,
MT, AT e rede de transporte). As perdas que pagas são em **cascata**,
porque a energia desce por todos os níveis até chegar a ti:

```
BT = (1+BT)(1+MT)(1+AT)(1+AT/RNT) − 1
MT =       (1+MT)(1+AT)(1+AT/RNT) − 1
```

Na hora do ficheiro, o rótulo é o **fim** do quarto de hora.

Como se usam:

- `/v1/indexed/quarters`: cada quarto usa as suas perdas.
- `/v1/simulate` com `useSpot`: as perdas do quarto do carregamento.
- `/v1/simulate` sem `useSpot`: a média das perdas dos quartos de cada
  período, nesse dia (o mesmo conjunto de quartos de onde vem a média do
  OMIE). Vem na resposta em `lossByPeriod`.
- Para um ano sem ficheiro, usa-se `LOSS_PLACEHOLDER` (`indexed.js`), a
  média anual da cascata. Num ano novo, corre o ETL e junta o ano a `YEARS`
  em `losses.js`.

## Fixos

```
// cada parcela arredonda para cima ao cêntimo (como na fatura),
// e o total também, depois do IVA:
base  = ROUNDUP(activação,2) + ROUNDUP(apoio,2) + ROUNDUP(kWh × preço_final,2) + ROUNDUP(kWh × IEC,2)
total = ROUNDUP(base × IVA_região, 2)          // IVA por região: REGIONS (regions.js)
```

O preço final já traz a TAR, por isso a tabela `tar` **não** se soma nos
fixos. Serve para partir a conta em energia + TAR e para os indexados.

**A conta linha a linha (`parts`):** `quoteFixed` devolve as mesmas
parcelas arredondadas que entram no total: `energyTar` (kWh × preço final),
`iec`, `activation`, `support`, `base` (sem IVA) e `vatEur`. Somam o total
ao cêntimo (testado em `engine.test.js`). Quando se conhece a separação
energia/TAR do período, `energyTar` aparece também partido em `energy` +
`tar`: a TAR arredonda ao cêntimo e a energia fica com o resto, para não
se perder nenhum cêntimo. É esta conta que o detalhe de cada tarifário
mostra no simulador.

### O preço final e a separação energia + TAR

O que o CEME publica é, quase sempre, o preço **final** (com a TAR
dentro). Quando o CEME publica a energia à parte, guardamos a separação
(`SPLITS` no seed). Quando só há o final, **não o partimos**: a diferença
seria uma conta nossa, e o CEME pode ter publicado com uma TAR que entretanto
mudou.

Nos indexados a separação é sempre exacta: a TAR é uma parcela da fórmula.

Alguns CEME publicam só a energia e dizem explicitamente que a TAR, os
impostos e as taxas vêm à parte (a Enable é um exemplo). Aí o seed calcula
o final como `energia + TAR`, arredondado para cima a 4 casas
(`regionFinal`). É a conta que o próprio CEME anuncia, e o `golden.test.js`
congela o resultado.

### Taxa de activação (EGME)

Usamos **o valor que o CEME publica**, tal como está. O valor legal em
vigor está em `EGME_LEGAL` (`tariffs.js`) e vai em cada resposta como
`egme_legal`. Quando o CEME ainda publica o valor legal do ano anterior
(`EGME_PREVIOUS`), a API devolve `activation_stale: true` e o cartão mostra
um aviso. Um valor próprio acima do legal (taxas do próprio CEME) é
legítimo e não é marcado.

Para actualizares estes valores, segue a verificação do seed
(`.opencode/commands/ceme-check.md`). Os testes: `poc.test.js` («auditoria
EGME») e, no `golden.test.js`, o «cenário regulatório» (quanto custaria se
o CEME aplicasse o valor legal).

## Indexados

Duas fórmulas (`indexed.js`), escolhidas por tarifário em
`VERSIONS[id].formula` no seed:

```
standard:  preço = (OMIE + K + CGS) × (1 + perdas) + TAR
ynerluz:   preço = (1 + perdas) × (OMIE + K) + CGS + TAR
```

- `OMIE`: em €/kWh (`omie_spot.price_pt_eur_mwh / 1000`).
- `K`, `CGS`: da `tariff_version` (`k_index_eur_mwh`, `cgs_eur_mwh`), que
  vêm de `VERSIONS` no seed. **Atenção à unidade:** apesar do `_eur_mwh` no
  nome, os valores estão em **€/kWh** (somam-se directamente ao OMIE em €/kWh).
- `perdas`: vê «Perdas», acima.
- `TAR`: a da tabela `tar` **para a região do carregamento**, em vigor no
  dia do carregamento. Se não houver TAR para (região, tensão, período), o
  tarifário vai para a quarentena em vez de sair um preço sem rede.

### Que OMIE usar (`tariff_version.omie_aggregation`)

| valor | regra |
|---|---|
| `SPLIT_VAZIO_FORA` | o OMIE de cada período é a média desse período **no ciclo do próprio tarifário** (diário ≠ semanal: ao fim-de-semana as horas são outras) |
| `UNICA` | um só OMIE para os dois períodos |

Todos os indexados do seed são bi-horários e usam `SPLIT_VAZIO_FORA`. Um
indexado SIMPLES (preço único) vai para a quarentena: a TAR é bi-horária e
ainda não há regra para o juntar num preço só ([06](06-roadmap.md)).

O `POST /v1/simulate` aceita:

- `useSpot: true` — cota os indexados ao OMIE **do quarto de hora de
  `at`** (e às perdas desse quarto). É o que o CEME cobra de facto. Se esse
  quarto não existir, usa as médias abaixo. `omieSpot` na resposta diz que
  quarto foi usado. A web envia-o sempre que o OMIE está em automático.
- `omieCycles: { DIARIO: {vazio, fora}, SEMANAL: {vazio, fora} }` — as
  médias por ciclo; cada indexado usa o par do seu ciclo.
- `omie` / `omieVazio` / `omieFora` — valores escolhidos à mão, que valem
  para todos (é o que o slider do comparador manda).

A web tira as médias de `/v1/omie/daily` (`bd_*` = ciclo diário, `bs_*` =
semanal), do **último dia completo** (`complete: true`). Depois das ~13:00
o dia de amanhã já aparece, mas sem a última hora de Lisboa
([03](03-omie-ingestao.md)).

### Nas ilhas

O mercado ibérico não chega às ilhas. Mesmo assim, o motor calcula os
indexados com o OMIE do Continente e marca-os com o aviso `OMIE_CONT_REF`
([07](07-ilhas.md)).

## Resultados congelados (golden)

`backend/test/golden.test.js` congela os totais de um conjunto de fixos
(a 40 kWh, num instante fixo, no Continente). Passa pelo seed e pelo motor
**reais**, por isso apanha erros no motor e alterações acidentais nos dados.
Os valores estão **só** no teste.

Blocos do teste:

- **âncoras dos fixos** — comparação exacta ao cêntimo;
- **cenário regulatório** — quanto daria cada CEME com taxa de activação
  acima do legal se aplicasse o legal;
- **o motor arredonda como a fatura** — um caso de ponta a ponta e a
  prova de que o arredondamento é por parcela;
- **cobertura do seed** — as contagens de CEME e tarifários (apanha um
  tarifário que desapareça) e os preços com no máximo 4 casas decimais.

Uma âncora só muda quando muda um preço publicado, e re-congela-se
**correndo o motor**, nunca à mão. O procedimento está em
`.opencode/commands/ceme-check.md` e no ficheiro que ele indica.

**Os indexados não estão nas âncoras** porque dependem do OMIE do dia.
São testados com OMIE fixo em `indexed.test.js` e `formula.test.js` (que
também garante que a cópia da fórmula no frontend dá o mesmo que o motor).
