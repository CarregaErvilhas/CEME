# 07 — Ilhas (MAD + AZO): IVA, fusos e ciclos

## IVA normal (mobilidade paga taxa normal)

As taxas estão em `REGIONS` (`backend/src/engine/regions.js`). Fontes: art. 18.º CIVA + Ofício-Circulado 25045/2024 (RAM 4/12/22 desde
01-10-2024; RAA 4/9/16). A taxa reduzida dos primeiros 200 kWh (Lei 38/2024)
é do fornecimento doméstico regulado, não da mobilidade Mobi.E — o motor
usa sempre a taxa normal da região do carregamento. (`quoteFixed` aceita um
`vatRate` para o caso de um CEME insular faturar diferente, mas não há coluna
para isso na `tariff_version` nem caso conhecido — só se liga se aparecer.)

## Fusos

- Portugal Continental: `Europe/Lisbon`; Madeira: `Atlantic/Madeira` (mesmo relógio
  que Lisboa, mas zona própria); Açores: `Atlantic/Azores` (UTC-1, DST nas
  mesmas datas UE com horas locais próprias).
- Todo o cálculo usa a hora **local da região do carregamento**; DST
  automático via IANA (dias de 23/25 horas também nas ilhas — a tabela das
  mudanças de hora está em docs/02). A hora que o utilizador escreve no
  simulador e no assistente é também a da região (`frontend/tz.js`), não a do
  browser.

## Ciclos bi-horários BTN (fontes: ERSE `periodos-horarios` + precário EDA BTN)

Comum às ilhas — dias úteis: Fora 07:00–24:00 ano todo; domingo: Vazio 24h.

| ciclo | Portugal Continental | Madeira | Açores | confiança |
|---|---|---|---|---|
| Diário bi | Fora 08–22 | Fora 09–23 | Fora 08–22 | alta / alta / **média** |
| Semanal útil | Fora 07–24 | Fora 07–24 | Fora 07–24 | alta |
| Semanal sábado (Verão, hora legal) | Fora 09–14 + 20–22 | Fora 11–14:30 + 19:30–23 | Fora 11–14:30 + 19:30–23 | alta |
| Semanal sábado (Inverno, hora legal) | Fora 09:30–13 + 18:30–22 | Fora 11:30–14 + 18–22:30 | Fora 11:30–13:30 + 18–23 | alta / **média** |
| Semanal domingo | Vazio | Vazio | Vazio | alta |

Notas de confiança: o diário dos Açores e o fecho da noite de sábado de
inverno (23:00) vêm de extracção do PDF da ERSE — estrutura confirmada
pelo precário EDA (`11:30/13:30 18:00/23:00`), mas validar com factura EDA
antes de publicar. Época = mês 6–10 vs resto (critério ERSE, não DST) para as ilhas; no Portugal Continental a época do sábado segue a **hora legal** (DST: último domingo de março → último domingo de outubro).

Perdas: o mesmo `LOSS_PLACEHOLDER` do Continente (`engine/indexed.js`) —
não é a média anual BTN do operador; ver a nota de verificação em
`02-motor-calculo.md`.

## Feriados

Regra da v2: **feriado = próprio dia** (sem excepção), igual ao sheet.
Aberto: Diretiva 3/2026 n.10 manda domingos nos feriados para MT em ciclo
semanal (períodos de rede, novo regime) — validar se os ciclos de energia
dos CEME em MT seguem a mesma regra; até lá, OWN_DAY com hook de config.

## OMIE nas ilhas

MIBEL não cobre os sistemas isolados (EDA/EEM): as regiões MAD/AZO têm
`REGIONS[].omieIndexed=false`. Mesmo nas ilhas o motor **calcula** os
indexados — com o OMIE continental de referência — e marca: `quoteOne`
devolve `warning: 'OMIE_CONT_REF'` (badge no cartão) e
`/v1/indexed/quarters` devolve o mesmo `warning` para MAD/AZO. O valor é
**ilustrativo, não contractual** (a ilha não compra no MIBEL).

Disponibilidade: todos os tarifários do seed estão marcados `regions='CONT'`,
mas isso é **informação, não filtro** — todos se cotam em qualquer região,
com o IVA e os ciclos dessa região, e o cartão diz onde o tarifário é
comercializado.

## TAR nas ilhas

A ERSE publica **uma** tabela de TAR da mobilidade eléctrica para o
Continente, a RAA e a RAM — no livro de tarifas da ERSE, «Tarifas de Acesso
às Redes da Mobilidade Elétrica em Portugal continental, RAA e RAM»
(Diretiva n.º 1/2026, art. 23.º; sem alterações na actualização de Outubro,
Diretiva n.º 4/2026). Os valores são, portanto, os mesmos nas três regiões.
Cada região tem as suas linhas na tabela `tar` (`TAR_2026` em `server.js`),
e a TAR procura-se sempre pela região do carregamento: uma região sem TAR é
um erro (quarentena), não um zero.

O que a ERSE publica **à parte** para as ilhas é a **TE/Com** (tarifa de
energia e comercialização aplicável à mobilidade, que a EDA/EEM cobram ao
CEME) — não é TAR, não entra na tabela `tar` e não se soma à TAR.

Âmbito: estas tarifas aplicam-se no regime transitório do DL 93/2025, até
31-12-2026 (ver roadmap).

## Reforma 2027 (fora do MVP)

Diretiva 3/2026 muda os períodos do Portugal Continental (BTN bi diário 08:30–22:30,
sábado semanal bloco único, etc., faseado Abr–Dez 2027). Os períodos de
`regions.js` **não** são versionados por data — versioná-los é tarefa do
roadmap.
