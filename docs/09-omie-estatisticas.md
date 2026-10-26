# 09 — Estatísticas OMIE (`omie.cocofree.dev`)

Uma página à parte do simulador, só sobre o preço do mercado (o OMIE): as
médias mensais do último ano e meia dúzia de cartões com os números do dia.
Serve a quem tem um tarifário indexado e quer perceber se o mercado está
caro ou barato.

- **Onde:** <https://omie.cocofree.dev> (raiz) e `/omie` no site principal.
- **Código:** `backend/src/omie/stats.js` (os números), `frontend/omie.html`
  (a página), `GET /v1/omie/stats` (a API).

## As duas tabelas

Cada linha é um mês (do mais recente para o mais antigo, 13 meses) e cada
coluna uma média:

| Coluna | O que é |
|---|---|
| `Simples / Média` | média de todos os quartos de hora do mês |
| `Bi-horário Semanal / Vazio` | média dos quartos que são vazio no ciclo **semanal** (`BS=V`) |
| `Bi-horário Semanal / Cheia` | o resto do ciclo semanal (`BS=F`) |
| `Bi-horário Diário / Vazio` | o mesmo para o ciclo **diário** (`BD=V`) |
| `Bi-horário Diário / Cheia` | idem (`BD=F`) |

A classificação de cada quarto vem do TF (colunas `BD`/`BS`), que aplica as
regras da ERSE. Para um mês fechado, a média calculada aqui é a mesma que o
TF publica no `omie_mensal.csv`; o `omie-tz.test.js` confirma-o contra o
ficheiro real.

**"Total geral"** não é a média das médias: é a média de **todos** os
quartos da janela (366 dias). Um mês com mais dias pesa mais.

Um mês ainda a decorrer leva um `*` e uma nota por baixo da tabela.

### As escalas de cor

As cores são a informação, não decoração. As duas tabelas usam regras
diferentes de propósito:

- **Tabela de cima ("média anual").** Uma escala verde → amarelo →
  vermelho (`#57BB8A` → `#FFD666` → `#E67C73`) aplicada a **todas** as
  células da tabela ao mesmo tempo, com o meio no percentil 50. Serve para
  comparar meses: o vermelho é o mês mais caro de todos, o verde o mais
  barato.
- **Tabela de baixo ("mês a mês").** A escala é **por linha**:
  - a coluna Simples usa verde → amarelo → vermelho com o meio **fixo em
    60 €/MWh** (um marco absoluto: acima de 60 é caro);
  - as quatro colunas Vazio/Cheia usam uma escala azul → branco → vermelho
    (`#CFE2F3` → `#FFFFFF` → `#E6B8AF`) calculada **dentro da linha**, com o
    branco na **mediana** dos quatro valores. Assim vês, dentro de cada
    mês, quanto o vazio custou a menos (ou a mais) do que a cheia, sem
    ruído do nível geral do mês;
  - a linha **Total geral** usa a mesma escala azul ↔ vermelho, sobre as
    cinco colunas dessa linha.

## Os cartões

Regra geral: **só preços reais do mercado**. As estimativas do TF para dias
ainda não publicados **não entram em número nenhum** desta página. A única
fonte de futuro admitida são os futuros **diários** `FPB D`, usados tal
como vêm (um número por dia) e sempre assinalados.

| Cartão | O que mostra |
|---|---|
| Valor OMIE à hora actual | o preço do quarto de hora em curso; se esse ainda não foi publicado, o último publicado (e o cartão diz que não é "ao vivo") |
| Média OMIE de hoje | média do dia de hoje (Lisboa), só com preços reais. Se hoje ainda não tem nenhum, mostra o último dia com preços e o título diz-te isso |
| Média OMIE de amanhã | se amanhã já tem preços (depois das ~13:00), a média deles; senão, o futuro diário `FPB D` dessa data, marcado como futuro; sem nenhum dos dois, vazio |
| Média OMIE dos últimos 30 dias | média desde 30 dias antes do último dia com preços até ao último quarto publicado |
| Previsão do mês | o mês até agora (preços reais) + os futuros diários dos dias que faltam (vê abaixo) |
| Média OMIE do mês | a média do mês em curso, só preços reais |

À tarde, o dia de amanhã tem só 92 quartos publicados: as 23:00–24:00 de
Lisboa pertencem ao dia de mercado **seguinte** (o de Madrid começa uma
hora antes), que ainda não saiu ([03](03-omie-ingestao.md)). A média de
amanhã é a desses quartos.

Cada cartão tem uma tooltip com a conta (soma ÷ número de quartos, quantos
são preços reais e quantos são futuro), a idade do ficheiro do TF e a hora a
que o OMIE emitiu o ficheiro. Assim podes confirmar o número.

## Como se calcula a previsão do mês

É o único número da página que mistura preços reais com futuros. Código:
`aggregate()` em `backend/src/omie/stats.js` (o bloco "Previsão do mês" e o
campo `cards.forecast`); testes em `backend/test/omie-stats.test.js`
(procura "previsão").

### O que é o FPB D

Um contrato de futuros do **OMIP** (o mercado ibérico onde se compra
energia para datas futuras): `FPB` = carga **base** (as 24 horas) da zona
**P**ortugal, `D` = **diário**. Cada dia tem um único preço (€/MWh), uma
média esperada do dia, **sem forma** (não diz que horas serão mais caras).
O TF republica-os no ficheiro de futuros (`TF_FUTURES_URL` em `omie/tf.js`),
uma linha por contrato, por exemplo `FPB D Sa24Oct-26,24/10/2026,<preço>,...`.
Os contratos semanais (`FPB Wk..`) e mensais (`FPB M ..`) estão no mesmo
ficheiro mas **não** se usam.

### Do ficheiro ao número

1. **Ingestão** (`pipeline.js`, em cada actualização; idade máxima em
   `TTL_FUTURES`): `parseTfFutures` lê as tabelas `TABELA_FUTUROS_<zona>`;
   `parseTfDailyFutures` fica com a zona PT e os contratos `FPB D`, converte
   a data (`dd/mm/aaaa` → ISO) e ordena. O resultado guarda-se em
   `omie_meta` (chave `futures`, campo `daily`).
2. **Dicionário** (`rebuildDerived`): `daily` passa a
   `{ 'AAAA-MM-DD': €/MWh }` (`fpbDaily`) e vai para `aggregate()`.
3. **A parte real.** Os quartos com preço real do mês de Lisboa em curso,
   até ao último dia com preços publicados (`cutoff`).
4. **A parte futura.** Para cada dia do mês **depois** do `cutoff` que tenha
   `FPB D`, soma-se `FPB D × número de quartos desse dia`
   (`expectedQuartersForLisbonDay`: 96, ou 92/100 nos dias de mudança de
   hora). Dias sem `FPB D` ficam de fora.
5. **Média ponderada por quartos:**

```
previsão = ( Σ preços dos quartos reais  +  Σ_dias (FPB D × quartos do dia) )
           / ( nº de quartos reais        +  Σ_dias quartos do dia )
```

   Pesar por **quartos** (e não por dias) torna a previsão comparável com a
   "Média OMIE do mês": é a mesma média, em que os quartos que faltam valem
   o futuro do seu dia.

### Casos especiais (todos com teste)

- **Cobertura parcial.** O OMIP só publica futuros diários para os próximos
  dias. Se o mês tem dias depois do último `FPB D`, a previsão usa só o que
  há e `coverageTo` diz até que dia chega. O resto do mês não se inventa.
- **Nenhum `FPB D` para os dias que faltam.** `value = null`: o cartão fica
  vazio em vez de repetir a média do mês.
- **Mês já fechado.** É só a média real, e `coverageTo` é o último dia do mês.
- **Dia publicado a meio.** Se o `cutoff` é amanhã (com ~92 quartos à
  tarde), esse dia conta como real com os quartos que tem, sem `FPB D`: o
  futuro só entra para dias depois do `cutoff`.
- **Mudança de hora.** O peso do dia é o número real de quartos (o último
  domingo de Outubro pesa 100).
- **Uma só fonte de futuro.** Sem interpolações nem curvas: um número
  publicado por dia, usado tal como vem.

### O período que o cartão mostra

Por baixo do título, o cartão mostra o período coberto: do dia 1 até
`coverageTo` (dias de Lisboa). Se `coverageTo` é antes do fim do mês,
acrescenta "parcial". (Existe um contrato mensal `FPB M`, mas o OMIP só o
publica para meses futuros.) Código: `forecastPeriod` em `frontend/omie.html`.

### O que a API devolve (`cards.forecast`)

`value` (a previsão), `quarters` (o denominador), `mtdQuarters`/`mtdSum` (a
parte real), `fpbDays` (`[{ date, value, quarters }]`, o que entrou de
futuro), `sum` (o numerador) e `coverageTo`. A tooltip do cartão mostra a
mesma conta com estes campos.

O cartão "Média OMIE de amanhã" usa o mesmo `FPB D`, sozinho: quando amanhã
ainda não tem preços reais, mostra o `FPB D` desse dia (`source: 'fpbd'`,
assinalado como futuro).

## De onde vêm os dados

Das duas fontes do OMIE, juntas pelo instante ([03](03-omie-ingestao.md)):

| fonte | o que traz |
|---|---|
| **omie.es** (principal) | o preço de cada quarto de hora |
| **dados.tiagofelicia.pt** (TF, CC BY 4.0) | a classificação vazio/fora de vazio, os buracos do omie.es e os futuros diários `FPB D` |

O crédito ao TF é obrigatório (CC BY 4.0) e vai no campo `source` da API
(`omie.es (OMIE/MIBEL) + dados.tiagofelicia.pt (CC BY 4.0)`).

O "último dia com preços" é o do **último instante publicado pelo omie.es**:
o que vem depois são estimativas, marcadas como tal.

## Horas e dias

- **Instantes** (o quarto actual, o início e fim das janelas, o último dado
  no rodapé) mostram-se no **fuso de quem está a ver**, no formato
  `aaaa/mm/dd hh:mm` (24 h). O backend manda-os em UTC (campos `…Utc`,
  terminados em `Z`) e o browser converte.
- **Dias** (hoje, amanhã, a cobertura da previsão) são dias de **Lisboa**,
  mostram-se como dia e levam o rótulo "Lisboa". Não são instantes, e
  convertê-los para outro fuso inventava-lhes uma hora.

Agrupa-se por **dia de Lisboa**: é assim que o TF publica os seus resumos
diários e mensais, e é o que o utilizador vê.

Cada linha que `stats.js` recebe (montada em `rebuildDerived`) traz:

- `dn`/`mk` — o **dia e o mês de Lisboa**, por onde se agrupa;
- `min` — os minutos desde a meia-noite de Lisboa, para mostrar;
- `utc` — o instante, que é o que alinha as duas fontes.

## Frescura

Os dados estão na **base de dados** (`omie_spot`, `omie_daily`,
`omie_meta`) e o payload da página guarda-se pronto em `omie_meta`.
`GET /v1/omie/stats` (`getStats` em `pipeline.js`) trata de três coisas que
o podem deixar desactualizado:

1. **Os dados** — como nas outras leituras do OMIE, o pedido chama
   `ensureFresh`: passada uma hora, lança a actualização em segundo plano e
   responde com o que há, com `stale: true` (o rodapé diz "a actualizar em
   segundo plano"). É isto que mantém o `omie.cocofree.dev`, que só pede
   `/stats`, actualizado.
2. **O dia** — um payload calculado noutro dia de Lisboa tem os cartões
   errados; nesse caso recalcula-se logo, a partir da BD, sem ir à rede.
3. **O quarto de hora** — o preço "à hora actual" calcula-se a cada pedido,
   a partir dos últimos quartos guardados no payload (`recent`). A página
   volta a pedir os dados de minuto a minuto.

O arranque do servidor também recalcula tudo (`rebuildDerived`); se os
futuros ainda não estiverem na BD, vai buscá-los nessa altura.

Em modo readonly (`CEME_READONLY=1`) não se actualiza nem se grava nada: o
payload calcula-se em memória a partir do que a BD já tem.

O mercado diário publica o dia inteiro de uma vez (um preço por quarto,
não um valor ao segundo). Por isso o **preço** só muda quando o OMIE
publica; o que muda a cada 15 minutos é **o quarto** que se mostra.

## Modo daltonismo

Por omissão, a página usa as cores descritas acima. Verde ↔ vermelho e
vermelho ↔ laranja são quase indistinguíveis para quem tem protanopia ou
deuteranopia, por isso há um botão no fundo da página ("Cores para
daltonismo" / "Colour-blind friendly colours") que troca as paletas:

- escala do preço (verde → amarelo → vermelho) → azul → creme → laranja;
- escala do desvio (azul claro → branco → salmão) → azul claro → branco →
  vermelho claro;
- cartões: vermelho/amarelo/laranja → vermelho/amarelo/azul claro.

As paletas mantêm a mesma estrutura (rampa de 3 cores, mesmo meio por
linha) e foram escolhidas por medição com `backend/tools/cores.mjs`
(simulação de Machado 2009, severidade 1.0, ΔE76 em CIE Lab). Os limites
exigidos estão no `omie-cores.test.js`. Em modo daltonismo, o texto das
células passa a `#1A1A1A`, com contraste de pelo menos 4,5:1 em todos os
fundos. A escolha guarda-se em `localStorage` (`ceme:paleta`).

Ainda não há forma de o browser dizer ao site que o utilizador é daltónico
(`color-vision-adjustment` é só uma proposta). A página já está preparada
para essa proposta (via `matchMedia`) e liga o modo sozinha quando os
browsers a suportarem. Até lá, o botão é a forma de o ligar.

## Dois domínios, uma app

O servidor olha para o cabeçalho `Host` para decidir o que é a raiz:

- `omie.cocofree.dev` + `/` → a página OMIE (com a língua negociada, como
  as outras páginas);
- `omie.cocofree.dev` + `/simulador`, `/sobre`, … → o resto do site (é a
  mesma app);
- qualquer outro domínio + `/` → o assistente ou o simulador;
- `/omie` → a página OMIE em qualquer domínio.

O domínio está registado no balanceador do Zerops (com certificado Let's
Encrypt), e o registo `AAAA` na Cloudflare aponta para o IPv6 do projecto,
com proxy activo. Vê `infra.md` §3.
