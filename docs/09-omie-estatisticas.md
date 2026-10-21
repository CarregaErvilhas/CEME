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

## Cache

`backend/data/omie-stats.json`, gerado, TTL de **24 h** — a página é
refrescada uma vez por dia, que é o que se pediu.

Um cache vencido é **devolvido na mesma** e a actualização corre em
segundo plano: a primeira visita depois do prazo não espera por ~4 MB de
CSV, e mesmo assim os dados não ficam velhos. A resposta diz a idade dos
dados (`dataThrough`) e se estão a ser actualizados (`stale`).

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
