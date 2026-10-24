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
a página calcula é a que o TF publica — guarda de regressão em
`omie-tz.test.js`, contra o ficheiro real.

**"Total geral"** não é a média das médias: é a média de **todos** os
quartos da janela (366 dias), pelo que um mês com mais dias (e mais
quartos) pesa mais do que daria a média das 13 linhas.

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
    **dentro da própria linha**, com o branco na **mediana** dos quatro
    valores da linha (não no ponto médio entre o mínimo e o máximo). Assim o
    que se vê é *dentro* do mês: quanto o vazio custou mais do que a
    cheia, sem a distração do nível absoluto do mês.
  - a linha **Total geral** usa a mesma escala divergente, calculada sobre
    as cinco colunas dessa linha (Simples incluído).

  (A folha tinha aqui uma regra com `NUMBER 60` na linha do total que não
  batia com o que se via; o que está implementado é a escala divergente,
  que é o que a folha mostrava.)

  Um mês ainda a decorrer leva um `*` e uma nota por baixo da tabela.

### As seis células da esquerda

Regra geral: **só mercado** (preços publicados pela OMIE). As estimativas
OMIP por quarto do TF **não entram em número nenhum** desta página; a única
fonte de futuro admitida são os futuros **diários** `FPB D` do TF, usados
tal como vêm publicados (um número por dia), e sempre assinalados.

| Célula | O que é |
|---|---|
| Valor OMIE à hora actual | o preço do quarto em curso; se esse ainda não foi publicado, o último publicado (e o cartão diz que não é "ao vivo") |
| Média OMIE de Hoje | média do dia civil de hoje (Lisboa), só com quartos de mercado. Se hoje ainda não tem nenhum, mostra o **último dia de mercado** e o título muda para dizê-lo |
| Média OMIE de Amanhã | se amanhã já tem quartos de mercado (depois das ~13:00), a média deles; senão, o futuro diário `FPB D` dessa data, marcado como futuro, **não** mercado; sem nenhum dos dois, vazio |
| Média OMIE dos últimos 30 dias | média entre `último dia de mercado − 30 dias` e o último quarto de mercado |
| Previsão Futuro de [mês] | o mês em curso até agora (mercado) + `FPB D` × nº de quartos **de cada dia** (92/96/100) para os dias restantes que têm futuro publicado. A cobertura pode ser parcial (`coverageTo`); se faltam dias e nenhum tem futuro, vazio |
| Média OMIE do mês [mês] | a média do mês em curso (só mercado) |

O dia de amanhã, à tarde, tem só 92 quartos de mercado: as 23:00–24:00 de
Lisboa são do dia de mercado **seguinte** de Madrid, que ainda não saiu
(ver docs/03). A média de amanhã é a desses quartos.

Cada cartão tem uma tooltip com a fórmula (soma / nº de quartos, a mistura
mercado vs futuro), a idade do ficheiro do TF e a hora de emissão do
ficheiro da OMIE — para quem quiser conferir o número.

## Como se calcula a "Previsão Futuro de [mês]"

É o único número da página que mistura mercado com futuros. Código:
`aggregate()` em `backend/src/omie/stats.js` (bloco "Previsão do mês" e o
campo `cards.forecast`); testes em `backend/test/omie-stats.test.js`
(procurar "previsão").

### O que é o FPB D

Contrato de futuros do **OMIP** (o mercado a prazo ibérico): `FPB` = futuro
de carga **base** da zona **P**ortugal, `D` = contrato **diário**. Cada dia
tem um único preço (€/MWh) para as 24 horas — é uma média esperada do dia,
**sem forma** (não diz quais quartos são mais caros). O TF republica-os no
ficheiro de futuros (`TF_FUTURES_URL` em `omie/tf.js`), uma linha por
contrato, por exemplo `FPB D Sa24Oct-26,24/10/2026,<preço>,...`. Os
contratos semanais (`FPB Wk..`) e mensais (`FPB M ..`) estão no mesmo
ficheiro mas **não** são usados no cálculo.

### Do ficheiro ao número

1. **Ingestão** (`pipeline.js`, refresh de fundo; TTL em `TTL_FUTURES`):
   `parseTfFutures` lê as tabelas `TABELA_FUTUROS_<zona>`; `parseTfDailyFutures`
   fica com a zona PT, só os contratos `FPB D`, converte a data
   (`dd/mm/aaaa` → ISO) e ordena. O resultado vai para `omie_meta` (chave
   `futures`, campo `daily`).
2. **Dicionário** (`getStats`): `daily` passa a `{ 'AAAA-MM-DD': €/MWh }`
   (`fpbDaily`) e é entregue a `aggregate()`.
3. **Parte já realizada (mercado).** Os quartos de **mercado** do mês civil
   de Lisboa em curso, até ao último dia com preço publicado (`cutoff`).
   Estimativas OMIP por quarto do TF (`est`) ficam de fora.
4. **Parte por realizar (futuro).** Para cada dia do mês **posterior** ao
   `cutoff` que tenha `FPB D` publicado, soma-se `FPB D × nº de quartos
   desse dia` (`expectedQuartersForLisbonDay`: 96, ou 92/100 nos dias de
   mudança de hora). Dias sem `FPB D` ficam de fora.
5. **Média ponderada por quartos:**

```
previsão = ( Σ preço dos quartos de mercado  +  Σ_dias (FPB D × quartos do dia) )
           / ( nº de quartos de mercado       +  Σ_dias quartos do dia )
```

   Pesar por **quartos** (e não por dias) é o que faz a previsão ser
   directamente comparável com a "Média OMIE do mês": é a mesma média de
   quartos, em que os que faltam valem o preço do futuro do seu dia.

### Casos limite (todos com teste)

- **Cobertura parcial.** O OMIP só publica futuros diários para os
  próximos dias. Se o mês ainda tem dias além do último `FPB D`, a previsão
  é calculada só com o que há e `coverageTo` diz até que dia chega — não
  se extrapola o resto do mês.
- **Sem nenhum `FPB D` para os dias em falta.** `value = null`; o cartão
  fica vazio em vez de repetir a média do mês.
- **Mês já fechado** (sem dias por publicar): é só a média de mercado e
  `coverageTo` é o último dia do mês.
- **Dia parcialmente publicado.** Se o `cutoff` é o dia de amanhã (com ~92
  quartos publicados à tarde, ver docs/03) esse dia conta como mercado
  com os quartos que tem; **não** se lhe junta `FPB D`, porque o
  `FPB D` só entra para dias depois do `cutoff`.
- **Mudança de hora.** O peso do dia segue o número real de quartos (por
  isso o último domingo de Outubro pesa 100).
- **Uma fonte de futuro só.** Não há interpolação, nem curvas, nem
  estimativas OMIP por quarto: a regra do projecto é "um número publicado
  por dia, usado tal como vem".

### O período que o cartão mostra

Por baixo do título, o cartão mostra o período coberto: do dia 1 do mês
até `coverageTo` (dias civis de Lisboa). Se `coverageTo` é anterior ao
último dia do mês, acrescenta "parcial": a previsão é só até onde há
`FPB D` publicado, não é o mês todo. Para um número do mês inteiro há o
contrato mensal `FPB M`, mas o OMIP só o publica para meses futuros; o do
mês em curso já foi desdobrado em dias e semanas (ver o ficheiro de
futuros). Código: `forecastPeriod` em `frontend/omie.html`.

### O que a API devolve (`cards.forecast`)

`value` (a previsão), `quarters` (denominador), `mtdQuarters`/`mtdSum` (a
parte de mercado), `fpbDays` (`[{ date, value, quarters }]` — o que entrou
do futuro), `sum` (numerador) e `coverageTo`. A tooltip do cartão em
`frontend/omie.html` mostra a mesma fórmula com estes campos, para quem
quiser conferir à mão.

O cartão "Média OMIE de Amanhã" usa o mesmo `FPB D`, mas isolado: quando
amanhã ainda não tem quartos de mercado, mostra o `FPB D` desse dia
(`source: 'fpbd'`, assinalado como futuro).

## De onde vêm os dados

Duas fontes, reconciliadas por **instante** (ver `03-omie-ingestao.md`):

| fonte | o que traz |
|---|---|
| **omie.es** (primária) | o preço de cada quarto-horário (o dump acumulado público) |
| **dados.tiagofelicia.pt** (TF, CC BY 4.0) | a classificação do período horário (BD/BS, as regras da ERSE), os buracos do omie.es e os futuros diários `FPB D` (amanhã sem mercado e a previsão do mês) |

A atribuição do TF é obrigatória (CC BY 4.0) e é o que a coluna `source` da
API devolve (`omie.es (OMIE/MIBEL) + dados.tiagofelicia.pt (CC BY 4.0)`).

O "último dia de mercado" é o **último instante publicado pelo omie.es**: o
que estiver para além são estimativas OMIP e ficam marcadas como tal.

## As horas: instantes em UTC, dias civis de Lisboa

- **Instantes** (o quarto actual, o início/fim das janelas de 30 dias e do
  mês, o último dado no rodapé) mostram-se no **fuso de quem vê**, no
  formato `aaaa/mm/dd hh:mm` (24 h). O backend manda-os em UTC (`…Utc`,
  terminados em `Z`) e o browser converte.
- **Dias** (hoje, amanhã, a cobertura da previsão) são dias civis de
  **Lisboa** e mostram-se como dia, rotulados "Lisboa" — não são instantes,
  e convertê-los para outro fuso inventava-lhes uma hora.

O agrupamento é por **dia civil de Lisboa**: é por aí que o TF publica os
seus agregados diários e mensais, e é o que o utilizador vê — a média de um
mês na página é a que o TF publica para esse mês. (Antes agrupava-se pelo
dia de mercado de Madrid, o que deslocava os quarters das 23:00–00:00 para
o dia errado e fazia as médias divergir do TF.)

Na alteração do backend cada linha traz:

- `dn`/`mk` — o **dia e o mês civis de Lisboa**, por onde se agrupa;
- `lisbonDn`/`lisbonMin` — a mesma leitura (hora de Lisboa), que é o que se
  mostra ao utilizador;
- `utc` — o instante absoluto, que é o que alinha as duas fontes.

A conversão do período do mercado (Madrid) para o instante é directa:
meia-noite de Madrid no dia do mercado + (N-1) × 15 minutos. O offset da
meia-noite é o **antigo** no dia da mudança de hora, porque a transição
acontece às 01:00 UTC — sempre depois da meia-noite local. É isso que dá
ao dia de Lisboa 23 horas em Março e 25 em Outubro.

## Frescura: três relógios

Os dados estão na **base de dados** (`omie_spot`, `omie_daily`,
`omie_meta`) — não em ficheiros do contentor: a BD persiste entre deploys e
é partilhada por todas as réplicas. O payload das estatísticas é
materializado em `omie_meta`. `GET /v1/omie/stats` (`getStats` em
`pipeline.js`) trata três relógios:

1. **Os dados** — como as outras leituras do OMIE, o pedido chama
   `ensureFresh`: passado o TTL do refresh, dispara a ingestion em segundo
   plano e serve o que há, com `stale: true` (o rodapé diz "a actualizar em
   segundo plano"). É isto que faz o `omie.cocofree.dev` — que só pede
   `/stats` — actualizar sozinho. Sem cron (docs/03).
2. **O dia** — um payload calculado noutro dia civil de Lisboa tem os
   cartões desse dia; nesse caso recalcula-se logo, da BD, sem rede.
3. **O quarto de hora** — o preço "à hora actual" recalcula-se a cada
   pedido, a partir de uma cauda dos últimos quartos guardada no payload. A
   página volta a pedir os dados de minuto a minuto.

O arranque do servidor também recalcula os derivados (`rebuildDerived`); se
a meta dos futuros não existir, vai buscá-los nessa altura.

Em modo readonly (`CEME_READONLY=1`) não há ingestion nem escrita: o
payload calcula-se em memória a partir do que a BD já tem.

Nota sobre o que é "actual": o mercado diário publica a curva inteira do
dia de uma vez (o preço é por quarto, não um tick), por isso o **preço** só
muda quando a OMIE publica — o que muda a cada 15 minutos é **o quarto**
que se mostra.

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
pivô por linha) e foram escolhidas por medição com
`backend/tools/cores.mjs` (simulação de Machado 2009, severidade 1.0, ΔE76
em CIE Lab). Os limiares que se exigem — e sob que tipos de daltonismo — são
os do `omie-cores.test.js`; é aí que estão, não aqui. Em modo daltonismo a tinta das células passa a `#1A1A1A`, o que
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

- `Host: omie.cocofree.dev` + `/` → a página OMIE (com a língua negociada
  pelo `Accept-Language`, como as outras páginas);
- `Host: omie.cocofree.dev` + `/simulador`, `/sobre`, … → o resto do site
  (é a mesma app);
- qualquer outro host + `/` → o simulador/assistente, como antes;
- `/omie` → a página OMIE em qualquer host.

O domínio próprio está registado no L7 balancer do Zerops (com certificado
Let's Encrypt) e o `AAAA` na Cloudflare aponta para o IPv6 dedicado do
projecto, com proxy activo — ver `infra.md` §3.
