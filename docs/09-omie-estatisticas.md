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

Duas fontes, reconciliadas por **instante** (ver `03-omie-ingestao.md`):

| fonte | o que traz |
|---|---|
| **omie.es** (primária) | o preço de cada quarto-horário (o dump acumulado público) |
| **dados.tiagofelicia.pt** (TF, CC BY 4.0) | a classificação do período horário (BD/BS, as regras da ERSE) e as estimativas OMIP dos dias que a OMIE ainda não publicou |

A atribuição do TF é obrigatória (CC BY 4.0) e é o que a coluna `source` da
API devolve (`omie.es (OMIE/MIBEL) + dados.tiagofelicia.pt (CC BY 4.0)`).

O "último dia de mercado" é o **último instante publicado pelo omie.es**: o
que estiver para além são estimativas OMIP e ficam marcadas como tal.

## As horas: tudo em UTC

A página mostra as horas no **fuso de quem a vê** (o browser converte os
instantes; o backend guarda tudo em UTC e nunca converte para o fuso de
Madrid nem para o de Lisboa).

Isto importa porque o dia de mercado do OMIE corre 00:00-24:00 em
**Madrid** (uma hora à frente de Lisboa) e o ficheiro do TF está em hora de
**Lisboa**. Os dois alinham pelo instante, e não pelo período — o dia civil
de Lisboa tem 96 quartos, de 00:00 a 23:45, ao passo que o dia de mercado
de Madrid tem 96 quartos, de 00:00 a 23:45 *dele*.

Na alteração do backend cada linha passou a guardar as duas leituras:

- `dn`/`mk` — o **dia e o mês civis** (em UTC), por onde se agrupa;
- `lisbonDn`/`lisbonMin` — a mesma leitura na hora local, que é o que se
  mostra ao utilizador.

A conversão do período do mercado (Madrid) para o instante é directa:
meia-noite de Madrid no dia do mercado + (N-1) × 15 minutos. O offset da
meia-noite é o **antigo** no dia da mudança de hora, porque a transição
acontece às 01:00 UTC — sempre depois da meia-noite local. É isso que dá
ao dia de Lisboa 23 horas em Março e 25 em Outubro.

## Cache

Os dados estão na **base de dados** (`omie_spot`, `omie_daily`,
`omie_meta`) — não em ficheiros do contentor: a BD persiste entre deploys e
é partilhada por todas as réplicas.

O payload das estatísticas é materializado em `omie_meta` na ingestion (e
recalculado a cada refresh, que acontece **a pedido**, sem cron — ver
`03-omie-ingestao.md`).

### O preço "à hora actual" é calculado a cada pedido

O payload guarda uma cauda com os últimos quartos (400) e o preço é
recalculado a cada pedido, contra o relógio do servidor. A página volta a
pedir os dados de minuto a minuto, para o cartão acompanhar o quarter.

Nota sobre o que é "actual": o mercado à vista de dia publica a curva
inteira do dia de uma vez (o preço é por quarter, não um tick), por isso o
**preço** só muda quando a OMIE publica — o que muda a cada 15 minutos é
**a hora** que se mostra. Quando o dia ainda não foi publicado, o cartão
acrescenta "estimativa OMIP".

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
