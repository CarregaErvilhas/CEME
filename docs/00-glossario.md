# 00 — Glossário: o que precisas de saber antes de mexer no código

Se nunca carregaste um carro eléctrico num posto público, ou se nunca ouviste
falar de OMIE, começa aqui. Os outros documentos assumem que já leste isto.

## A ideia em 30 segundos

Quando carregas o carro num posto público em Portugal, pagas a várias
entidades ao mesmo tempo, numa só conta. O simulador calcula **a parte do
Comercializador de Energia (CEME)** dessa conta, para todos os tarifários que existem, e ordena-os do
mais barato para o mais caro. Assim percebes qual te compensa.

O que **não** calculamos é o que o dono do posto cobra pelo uso do posto
(a tarifa OPC, já explicamos). Por isso o valor que mostramos é sempre o
mínimo: a conta final é maior.

## O modelo legal: está a acabar

Tudo o que este simulador faz assenta no modelo Mobi.E: todos os postos
públicos tinham de estar ligados à rede Mobi.E, e a conta de cada carregamento
divide-se entre o CEME (a energia) e o OPC (o posto).

O **Decreto-Lei 93/2025** acaba com esse modelo. Deixa de ser obrigatório
ligar os postos à Mobi.E e deixa de haver CEME: o **OPC passa a cobrar o
carregamento todo**, energia incluída, e o preço é o que ele afixar no
posto. Até **31-12-2027** vale um regime transitório, em que o modelo
antigo continua a funcionar.

Ou seja: os tarifários CEME que comparamos só fazem sentido enquanto durar
esse regime. O que fazer depois está em [06-roadmap.md](06-roadmap.md).

## Quem é quem

**Mobi.E** — a rede pública de carregamento de Portugal. Quase todos os
postos públicos fazem parte dela. É ela que junta as várias parcelas numa só
conta. Site: <https://www.mobie.pt>.

**CEME** — Comercializador de Electricidade para a Mobilidade Eléctrica. É a
empresa que te vende a energia quando carregas: a Galp, a EDP, a Prio, a
Miio, etc. Escolhes o CEME quando tiras o cartão ou instalas a app dele, e
podes usar esse cartão em (quase) qualquer posto da rede. No código, cada
CEME é uma linha da tabela `ceme`.

**Tarifário** — uma oferta de um CEME (ex.: "Cartão EDP Charge
(Bi-Horário)"). Um CEME tem vários. Tabela `tariff`.

**OPC** — Operador do Ponto de Carregamento. É o dono do posto (o
supermercado, a câmara, a empresa da auto-estrada). Cobra uma tarifa pelo
uso do posto, que pode ser por kWh, por minuto, por sessão, ou qualquer combinação destes. **Não está no
simulador**: cada OPC tem a sua e muda de posto para posto.

**DPC** — Detentor de Ponto de Carregamento. Quem tem um posto privado
(em casa ou na empresa) ligado à Mobi.E. Num posto destes não há tarifa OPC,
por isso a parte da energia é quase a conta toda.

**ERSE** — Entidade Reguladora dos Serviços Energéticos. O regulador. Fixa a
TAR, as regras dos horários de vazio e a taxa de activação legal.

**E-REDES** — a empresa dona da rede de distribuição de electricidade no
Continente. Publica os perfis de perdas (já lá vamos).

**EDA / EEM** — as empresas de electricidade dos Açores e da Madeira. As
ilhas têm redes isoladas, que não estão ligadas ao mercado ibérico.

## O carregamento

**Sessão (ou carregamento)** — desde que ligas o carro ao posto até
desligares. É a unidade de cobrança: a taxa EGME é paga uma vez por sessão,
seja ela de 5 ou de 50 kWh.

**AC / DC** — corrente alternada e corrente contínua. Nos postos **AC** (os
"normais", até 22 kW) é o carregador de bordo do carro que converte para
DC, e é ele que limita a potência. Nos postos **DC** a conversão é feita no
posto, e a energia entra directamente na bateria.

**Carregamento rápido** — os postos DC de potência alta (50 kW ou mais; os
ultra-rápidos passam dos 150 kW). Costumam estar em MT (média tensão) e ter tarifas OPC
mais altas.

**Pagamento ad hoc** — pagar no próprio posto, com cartão bancário ou QR
code, sem cartão de nenhum CEME. O regulamento europeu **AFIR** (Alternative
Fuels Infrastructure Regulation) obriga os postos novos e os rápidos a
aceitá-lo. Nesse caso quem vende a energia é o CEME escolhido pelo posto,
não um tarifário que tu escolheste.

**Roaming** — usar na Mobi.E um cartão de um comercializador estrangeiro
(ou um cartão português lá fora). O preço é o que esse comercializador
define, não um tarifário CEME, por isso fica fora do simulador.

## As parcelas da conta (o que calculamos)

**Energia** — o preço que o CEME cobra por cada kWh. É o que muda de tarifário para tarifário.

**TAR** — Tarifas de Acesso às Redes. Pagas pelo uso da rede eléctrica. É
igual para todos os CEME e fixada pela ERSE todos os anos, por região,
tensão e período. Quase sempre o CEME publica o preço da energia **já com a
TAR somada**: é a esse valor que chamamos "preço final".

**IEC** — Imposto Especial de Consumo sobre a electricidade. Um valor fixo
por kWh.

**EGME / taxa de activação** — uma taxa fixa por cada sessão (não
por kWh). Há um valor legal fixado pela ERSE, mas cada CEME publica o seu e
é esse que usamos.

**IVA** — o imposto sobre o total. Muda por região: Continente, Madeira e
Açores têm taxas diferentes.

## Unidades

**kWh** (quilowatt-hora) — a unidade de energia. Uma bateria de 60 kWh leva
60 kWh de 0% a 100% (mais algumas perdas de carregamento). Os preços dos CEME são em €/kWh.

**kW** (quilowatt) — a unidade de **potência**: a que velocidade a energia
entra. Não confundas com kWh: um posto de 50 kW a carregar durante meia
hora mete 25 kWh (na prática menos, porque o carro abranda perto dos 80%).
Importa para a conta porque uma tarifa OPC por minuto sai mais cara por kWh
num posto (ou num carro) de potência baixa: pagas os mesmos minutos por
menos energia.

**MWh** (megawatt-hora) — 1000 kWh. O mercado grossista fala em €/MWh. Para
passar para €/kWh, divides por 1000 (100 €/MWh = 0,10 €/kWh).

**BT / MT** — baixa tensão e média tensão. A maioria dos postos públicos
está em BT; os postos rápidos grandes costumam estar em MT. A TAR é
diferente nas duas, por isso cada tarifário existe no seed em duas variantes.

## Horários: vazio e fora de vazio

A electricidade é mais barata quando há menos procura (maior produção de renováveis, ao
fim-de-semana). Um tarifário pode ter:

- **Simples** — um preço só, a qualquer hora. No código, período `UNICO`.
- **Bi-horário** — dois preços: **vazio** (menos procura, `VAZIO`) e **fora
  de vazio** (às vezes chamado "ponta + cheia" nos tri-horário, `FORA_VAZIO`).

Que horas são vazio depende do **ciclo**, definido pela ERSE:

- **Ciclo diário** — as mesmas horas todos os dias.
- **Ciclo semanal** — dias úteis, sábado e domingo têm horas diferentes
  (o domingo é todo vazio).

As horas exactas mudam também com a região e, no caso do sábado, com a
época do ano. Estão em `backend/src/engine/regions.js` e em
[07-ilhas.md](07-ilhas.md).

## O mercado: OMIE, MIBEL e indexados

**MIBEL** — Mercado Ibérico de Electricidade. Portugal e Espanha compram e
vendem electricidade num mercado comum.

**OMIE** — Operador do Mercado Ibérico de Energia. É quem gere o mercado
diário do MIBEL. Todos os dias, por volta das 13:00 de Madrid, publica o
preço da electricidade para **cada quarto de hora** do dia seguinte
(96 preços por dia, fora mudanças de DST). No código e nos docs, "o OMIE" quer quase sempre dizer
"o preço publicado pelo OMIE". Site: <https://www.omie.es>.

**Tarifário fixo** — o CEME publica um €/kWh que não muda com o mercado.

**Tarifário indexado** — o €/kWh segue o preço do OMIE: muda a cada quarto
de hora. A fórmula é mais ou menos "OMIE + margem do CEME + perdas + TAR"
(a exacta está em [02-motor-calculo.md](02-motor-calculo.md)). Quando o
mercado está barato, ganhas; quando está caro, perdes.

**Perdas** — parte da energia perde-se pelo caminho, nos cabos e nos
transformadores. Nos indexados pagas essas perdas: o OMIE é multiplicado
por (1 + perdas). A E-REDES publica o valor das perdas para cada quarto de
hora do ano.

**K e CGS** — duas das parcelas (para além das perdas e TAR) que os CEME indexados somam ao OMIE: K é a
margem do comercializador e CGS os custos de gestão do sistema.

**OMIP** — o mercado de futuros ibérico, onde se compra energia hoje para
entregar numa data futura. Dá-nos uma estimativa do preço dos próximos
dias. **FPB D** é o nome do contrato diário de carga base para Portugal: um
preço por dia.

**TF** — abreviatura que usamos para <https://dados.tiagofelicia.pt>, um
site que republica os preços do OMIE em CSV, com a classificação de cada
quarto em vazio/fora de vazio e com os futuros do OMIP. Licença CC BY 4.0
(temos de dar o crédito, e damos).

## Tempo: o que te vai morder

O tempo é a maior fonte de bugs deste projecto. Antes de mexeres em código
com datas, lê a secção «Tempo» do [02-motor-calculo.md](02-motor-calculo.md).
O resumo:

- **Instante** — um momento exacto, guardado sempre em UTC
  (`2026-10-25T01:15:00Z`). Nunca se repete.
- **Hora de relógio** — o que um relógio de parede mostra num fuso
  (`01:15` em Lisboa). Pode repetir-se ou não existir.
- **Dia de calendário** (ou dia civil) — `2026-10-25`, num fuso. "Hoje" em
  Lisboa e "hoje" em UTC nem sempre são o mesmo dia.
- **Mudança de hora (DST)** — no último domingo de Março a hora adianta
  (o dia tem 23 h, 92 quartos de hora) e no último domingo de Outubro atrasa
  (25 h, 100 quartos).
- **Dia de mercado** — o OMIE conta os dias pela hora de Madrid, que está
  uma hora à frente de Lisboa. O dia de mercado começa às 23:00 de Lisboa
  da véspera.

## Termos do código

**Seed** — os dados de arranque (CEME, tarifários, preços), escritos à mão
em `backend/src/db/seed-data.js`. O `seed.js` grava-os na BD em cada
arranque do servidor.

**Upsert** — "insere, ou actualiza se já existir". Em SQL:
`INSERT … ON CONFLICT … DO UPDATE`.

**Quarentena** — quando um tarifário tem dados com problemas, sai da
resposta (com um aviso no log) em vez de rebentar o pedido inteiro.

**Golden test** — um teste que congela resultados conhecidos (ex.: "este
tarifário a 40 kWh custa 10,09 €"). Se o número mudar, alguma coisa mudou
no motor ou nos dados.

**JWT** — JSON Web Token, o "bilhete" assinado que o browser usa para falar
com a API. Vê [04-api-auth.md](04-api-auth.md).

**PWA** — Progressive Web App: o site pode ser "instalado" no telemóvel e
abre como uma app.
