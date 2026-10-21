# 09 — Estatísticas OMIE (`omie.cocofree.dev`)

A folha de cálculo de onde veio isto é a **"Comparador Mobie CEME"**
(`https://docs.google.com/spreadsheets/d/1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84`,
separador **"OMIE (via TF)"**, `gid=791994773`). Com a migração da parte de
CEME para a app, aquele separador ia ficar para trás. Esta página é a
versão web dele: as mesmas tabelas, as mesmas cores e as mesmas células de
referência — mas calculadas, não copiadas.

- **URL:** `https://omie.cocofree.dev` (raiz) e `/omie` no site principal.
- **Código:** `backend/src/omie/stats.js` (dados), `frontend/omie.html`
  (página), `GET /v1/omie/stats` (API).

## O que a folha tinha, e o que é que cada coisa significava

O painel da folha ocupava a mesma grelha que os dados de quartos-horários
(que começavam na linha 3), por isso as tabelas e os cartões estavam
**escritos por cima** dos dados. Só as fórmulas de classificação é que
eram vivas; os números das tabelas e dos cartões eram valores fixos,
escritos por um script exterior. Este documento é a reconstrução do que
aqueles valores queriam dizer.

### As duas tabelas

Cada linha é um mês (do mais recente para o mais antigo, 13 meses) e cada
coluna uma série de médias:

| Coluna | O que é |
|---|---|
| `Simples / Média` | média de todos os quartos do mês |
| `Bi-horário Semanal / Vazio` | média dos quartos que o TF classifica como vazio no ciclo **semanal** (`BS=V`) |
| `Bi-horário Semanal / Cheia` | o resto do ciclo semanal (`BS=F`) |
| `Bi-horário Diário / Vazio` | idem para o ciclo **diário** (`BD=V`) |
| `Bi-horário Diário / Cheia` | idem para o ciclo diário (`BD=F`) |

A classificação vem das colunas `BD`/`BS` do ficheiro do TF, que aplicam
as regras de período horário da ERSE. Bate certo com os agregados mensais
publicados pelo TF (`omie_mensal.csv`): para um mês fechado, a média que
a página calcula é a que o TF publica (ex.: Setembro de 2026 — 143,91 no
Simples, 160,55 / 130,76 no semanal, 191,36 / 110,02 no diário).

**"Total geral"** não é a média das médias: é a média de **todos** os
quarts da janela (366 dias), pelo que um mês com mais dias pesa mais. É a
diferença entre 78,46 e o que daria a média das 13 linhas.

### As duas escalas de cor

São formatação condicional na folha, e são a informação — não são
decoração. As duas regras são diferentes **de propósito**:

- **Tabela de cima ("Coloração de média Anual").** Uma escala
  verde→amarelo→vermelho (`#57BB8A` → `#FFD666` → `#E67C73`) aplicada
  **sobre todas as células da tabela ao mesmo tempo**, com o ponto médio
  no percentil 50 do conjunto. Serve para comparar meses entre si: o
  vermelho é o mês mais caro de todos, o verde o mais barato.

- **Tabela de baixo ("Coloração mês-a-mês, expondo vazio vs cheias").** Aqui
  a escala é **por linha**:
  - a coluna Simples usa a escala verde→amarelo→vermelho com o ponto
    médio **fixo em 60 €/MWh** (um marco absoluto: acima de 60 é caro);
  - as quatro colunas Vazio/Cheia usam uma escala divergente
    azul→branco→vermelho (`#CFE2F3` → `#FFFFFF` → `#E6B8AF`) calculada
    **dentro da própria linha**, com o branco no meio da linha. Assim o
    que se vê é *dentro* do mês: quanto o vazio custou mais do que a
    cheia, sem a distração do nível absoluto do mês.

  (A folha tinha aqui uma regra com `NUMBER 60` na linha do total que não
  batia com o que se via; o que está implementado é a escala divergente
  por linha, que é o que a folha mostrava.)

### As seis células da esquerda

| Célula | O que é |
|---|---|
| Valor OMIE à hora actual | o preço do quarter em curso (o último publicado, se o de agora ainda não saiu) |
| Média OMIE de Hoje | média do dia de **calendário** de hoje |
| Média OMIE de Amanhã (até às 23h) | média do dia de **calendário** de amanhã (estimativa OMIP) |
| Média OMIE dos últimos 30 dias | média entre `último dia de mercado − 30 dias` e o último quarto de mercado |
| Previsão Futuro de [mês] | a média do mês **completo**, com o resto estimado a partir dos futuros OMIP |
| Média OMIE do mês [mês] | a média do mês em curso (só o que já é mercado) |

A distinção entre "calendário" e "último dia de mercado" importa: o dia de
hoje pode ainda não ter sido publicado (a OMIE publica o dia D na manhã
de D+1), e nesse caso o valor de "hoje" é a estimativa OMIP.

## De onde vêm os dados

Fonte: **`dados.tiagofelicia.pt`** (Tiago Felícia, CC BY 4.0) — atribuição
obrigatória, e é o que a coluna `source` da API devolve.

| Ficheiro | Para que serve |
|---|---|
| `data/omie/omie_dados_atuais.csv` | o ano corrente: preços de mercado **e** as datas futuras estimadas a partir dos futuros OMIP |
| `data/omie/historico/omie_historico_<ano>.csv` | o ano anterior (a janela de 366 dias atravessa sempre dois anos) |
| `data/omie/futuros_omip.csv` | o `Data_Valores_OMIE`, que separa o mercado das estimativas |

O "último dia de mercado" é o `Data_Valores_OMIE` do ficheiro de futuros —
a mesma regra que o resto do backend usa (`backend/src/omie/cache.js`), e
que o próprio TF documenta ("as datas posteriores à `ultima_data_real` são
estimativas OMIP, não preços de mercado").

## As horas: o ficheiro está em CET, não em hora de Lisboa

**O dia de mercado corre de 00:00 a 24:00 em CET (Madrid)**, e Madrid está
sempre uma hora à frente de Lisboa — as duas zonas seguem a regra de mudança
de hora da UE, no mesmo instante, por isso a diferença é sempre de uma hora
(verdade no Inverno como no Verão).

Consequências, que são as que se vêem na página:

- O **primeiro** quarter do dia de mercado (`[00:00-00:15[`) são as **23:00
  de Lisboa do dia anterior**.
- O **último** quarter (`[23:45-00:00[`) são as **22:45 de Lisboa**. O dia
  tem 96 quartos, mas o último só chega às 22:45 — é o que se vê na página.
- Por isso a janela que aparece no cartão dos 30 dias começa às 23:00 do
  dia anterior, e o mês em curso começa às 23:00 do último dia do mês
  anterior.

No `backend/src/omie/stats.js` cada linha guarda as duas leituras:

- `dn`/`mk` — o **dia e o mês de mercado** (a coluna `dia` do ficheiro). É
  por esta coluna que se agrupa, e é assim que o TF publica os seus
  agregados diários e mensais (o `omie_diario.csv` e o `omie_mensal.csv`
  batem com os números da tabela);
- `lisbonDn`/`lisbonMin` — o mesmo quarter em **hora de Lisboa**, que é o
  que se mostra ao utilizador (o preço da hora actual, as janelas, a data
  do último dado).

Isto já estava escrito no código do motor (`backend/src/omie/convert.js`,
`marketPeriodToLisbon`) e nas réguas do OMIE oficial — o que faltava era
aplicá-lo aos dados do TF.

> Nota: a folha original rotulava a coluna com as horas como "Hora em
> Portugal", mas os dados lá copiados são os do ficheiro do TF, em CET. As
> tabelas (que agrupam por dia de mercado) batem com a folha; as horas
> mostradas é que estão uma hora adiantadas. A página mostra as horas
> certas.

## Cache

`backend/data/omie-stats.json`, gerado, TTL de **2 h**.

Um cache vencido é **devolvido na mesma** e a actualização corre em
segundo plano: a primeira visita depois do prazo não espera por ~4 MB de
CSV, e mesmo assim os dados não ficam velhos. A resposta diz a idade dos
dados (`dataThrough`) e se estão a ser actualizados (`stale`).

### O preço "à hora actual" é calculado a cada pedido

O cache é de horas, mas o **quarter em curso muda a cada 15 minutos** — por
isso o preço à hora actual **não vem do cache**. O payload guarda uma cauda
com os últimos quartos (o dia de mercado e o seguinte) e o preço é
recalculado a cada pedido, contra o relógio do servidor. A página volta a
pedir os dados de minuto a minuto, para o cartão acompanhar o quarter.

Nota sobre o que é "actual": o mercado à vista de dia publica a curva
inteira do dia de uma vez (o preço é por quarter, não um tick), por isso o
**preço** só muda quando a OMIE publica ou quando o TF vai buscar o
ficheiro — o que muda a cada 15 minutos é **a hora** que se mostra. Quando o
dia de mercado ainda não foi publicado, o cartão acrescenta "estimativa
OMIP".

## Modo daltonismo

A página reproduz as cores da folha por omissão. Como as cores da folha
(verde↔vermelho nas tabelas, vermelho↔laranja nos cartões) são
praticamente indistinguíveis para quem tem protanopia ou deuteranopia, há
um botão no fundo da página ("Cores para daltonismo" / "Colour-blind
friendly colours") que troca as paletas por versões escolhidas por
medição:

- escala do preço (verde→amarelo→vermelho) → azul → creme → laranja;
- escala do desvio (azul claro→branco→salmão) → azul claro → branco →
  vermelho claro;
- cartões: vermelho/amarelo/laranja → vermelho/amarelo/azul claro.

As paletas mantêm a estrutura da folha (mesma rampa de 3 paragens, mesmo
pivô por linha) e cumprem, sob simulação de protanopia, deuteranopia e
tritanopia (matrizes de Machado 2009, severidade 1.0): extremos com
ΔE ≥ 25, pivô com ΔE ≥ 12, e as duas escalas não se confundem entre si
(ΔE ≥ 15). Em modo daltonismo a tinta das células passa a `#1A1A1A`, o que
garante contraste ≥ 4,5:1 sobre todos os fundos. A escolha é persistida em
`localStorage` (`ceme:paleta`) e é reposta ao voltar à página.

Não existe (ainda) um standard em que o browser comunique ao site que o
utilizador é daltónico: `color-vision-adjustment` é apenas uma proposta do
CSSWG. A página tem um gancho preparado para essa proposta (via
`matchMedia`), que hoje é um no-op e activará o modo daltonismo
automaticamente assim que os browsers o implementarem. Até lá, o botão
manual é o único mecanismo fiável.

## Routing por domínio

Até agora o servidor só olhava para o *path* do pedido. Com dois domínios
a servir a mesma app, é o `Host` que decide o que é a raiz:

- `Host: omie.cocofree.dev` + `/` → a página OMIE;
- `Host: omie.cocofree.dev` + `/simulador`, `/sobre`, … → o resto do site
  (é a mesma app);
- qualquer outro host + `/` → o simulador/assistente, como antes;
- `/omie` → a página OMIE em qualquer host.

O domínio próprio está registado no L7 balancer do Zerops (com certificado
Let's Encrypt) e o `AAAA` na Cloudflare aponta para o IPv6 dedicado do
projecto, com proxy activo — ver `infra.md` §3.
