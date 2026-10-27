# 07 — Madeira e Açores: IVA, fusos, horários e preços

O simulador trabalha com três regiões: Portugal Continental (`CONT`),
Madeira (`MAD`) e Açores (`AZO`). Cada uma tem o seu IVA, o seu fuso e os
seus horários de vazio. Está tudo em `backend/src/engine/regions.js`
(`REGIONS` e `core()`).

## IVA

A mobilidade eléctrica paga a **taxa normal** de IVA da região onde
carregas. As taxas estão em `REGIONS`. Fontes: art. 18.º do Código do IVA
e o Ofício-Circulado 25045/2024.

A taxa reduzida dos primeiros 200 kWh (Lei 38/2024) é só para o
fornecimento de electricidade em casa, não para a Mobi.E. (`quoteFixed`
aceita um `vatRate` próprio, para o caso de um CEME das ilhas faturar com
outra taxa, mas hoje não há nenhum.)

## Fusos

- Continente: `Europe/Lisbon`.
- Madeira: `Atlantic/Madeira` (o mesmo relógio que Lisboa, mas é outro fuso
  IANA).
- Açores: `Atlantic/Azores` (uma hora atrás de Lisboa; muda a hora nos
  mesmos dias, às suas horas locais).

Todas as contas usam a hora local **da região do carregamento**. A mudança
de hora é automática (a tabela está em [02](02-motor-calculo.md)). A hora
que escreves no simulador e no assistente é também a da região
(`frontend/tz.js`), não a do browser.

## Horários bi-horários (baixa tensão)

Fontes: a página `periodos-horarios` da ERSE e o tarifário BTN da EDA.

Comum às ilhas: nos dias úteis, fora de vazio das 07:00 às 24:00 todo o
ano; ao domingo, vazio o dia todo.

| ciclo | Continente | Madeira | Açores | confiança |
|---|---|---|---|---|
| Diário | fora 08–22 | fora 09–23 | fora 08–22 | alta / alta / **média** |
| Semanal, dias úteis | fora 07–24 | fora 07–24 | fora 07–24 | alta |
| Semanal, sábado (Verão) | fora 09–14 e 20–22 | fora 11–14:30 e 19:30–23 | fora 11–14:30 e 19:30–23 | alta |
| Semanal, sábado (Inverno) | fora 09:30–13 e 18:30–22 | fora 11:30–14 e 18–22:30 | fora 11:30–13:30 e 18–23 | alta / **média** |
| Semanal, domingo | vazio | vazio | vazio | alta |

**Verão e Inverno:** no Continente seguem a hora legal (Verão do último
domingo de Março ao último domingo de Outubro). Nas ilhas seguem o mês
(Junho a Outubro é Verão), que é o critério da ERSE para elas.

**Confiança média:** o ciclo diário dos Açores e o fim da noite de sábado
de Inverno (23:00) vêm do PDF da ERSE. A estrutura bate com o tarifário da
EDA (`11:30/13:30 18:00/23:00`), mas ainda falta confirmar com uma fatura
([06](06-roadmap.md)).

**Feriados:** contam como o dia da semana em que calham (vê
[06](06-roadmap.md) para a questão em aberto em MT).

**Perdas:** usam-se os mesmos perfis do Continente ([02](02-motor-calculo.md)).

## OMIE nas ilhas

As redes da Madeira e dos Açores são isoladas e não estão ligadas ao
mercado ibérico (MIBEL). Por isso `REGIONS[].omieIndexed` é `false` em `MAD`
e `AZO`.

Mesmo assim, o motor **calcula** os indexados nas ilhas, com o OMIE do
Continente, e marca-os: `quoteOne` devolve `warning: 'OMIE_CONT_REF'` (que
aparece como badge no cartão), e `/v1/indexed/quarters` devolve o mesmo
aviso. O valor serve para teres uma ideia, não é o que o contrato diria.

## Onde se vende cada tarifário

Cada tarifário do seed diz em que regiões é vendido (`tariff.regions`).
Isso é **informação, não filtro**: todos se cotam em qualquer região, com o
IVA e os horários dessa região, e o cartão diz onde o tarifário é vendido.

## Preços diferentes nas ilhas

Quando um CEME cobra diferente nas ilhas, as linhas dessa região ficam em
`price_component_region` e sobrepõem-se às do Continente
(`price_component`). Só existem onde há diferença publicada: sem elas, o
preço é o do Continente em qualquer região. No seed, estes preços estão em
`REGION_SPLITS` (`seed-data.js`); na leitura, em `loadPricing(region)`
(`tariffs.js`).

## TAR nas ilhas

A ERSE publica **uma** tabela de TAR da mobilidade eléctrica para o
Continente, os Açores e a Madeira («Tarifas de Acesso às Redes da
Mobilidade Elétrica em Portugal continental, RAA e RAM», Diretiva
n.º 1/2026, art. 23.º). Os valores são os mesmos nas três regiões.

Mesmo assim, cada região tem as suas linhas na tabela `tar` (`TAR` em
`backend/src/db/tar.js`), porque a TAR procura-se sempre pela região do
carregamento: uma região sem TAR é um erro (quarentena), nunca um zero.

A ERSE publica à parte, para as ilhas, a **TE/Com** (tarifa de energia e
comercialização que a EDA e a EEM cobram aos CEME). Não é TAR, não entra na
tabela `tar` e não se soma à TAR.

Estas tarifas valem no regime transitório do DL 93/2025, até 31-12-2027
(vê o [roadmap](06-roadmap.md)).
