# 07 — Ilhas (MAD + AZO): IVA, fusos e ciclos

## IVA normal (mobilidade paga taxa normal)

| região | taxa normal | multiplier |
|---|---|---|
| Portugal Continental | 23% | 1.23 |
| Madeira | 22% | 1.22 |
| Açores | 16% | 1.16 |

Fontes: art. 18.º CIVA + Ofício-Circulado 25045/2024 (RAM 4/12/22 desde
01-10-2024; RAA 4/9/16). A taxa reduzida dos primeiros 200 kWh (Lei 38/2024)
é do fornecimento doméstico regulado, não da mobilidade Mobi.E — o motor
usa sempre a taxa normal da região do carregamento. Se algum CEME insular
faturar diferente, regista-se como `vatRate` na versão do tarifário.

## Fusos

- Portugal Continental: `Europe/Lisbon`; Madeira: `Atlantic/Madeira` (mesmo relógio
  que Lisboa, mas zona própria); Açores: `Atlantic/Azores` (UTC-1, DST nas
  mesmas datas UE com horas locais próprias).
- Todo o cálculo usa a hora **local da região do carregamento**; DST
  automático via IANA (dias de 92/96/100 quartos também nas ilhas).

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

Perdas E-REDES 2026 (média anual BTN): BT 0,1531 / MT 0,0713 — mesmo
placeholder do Continente; ver a nota de verificação dos factores em
`02-motor-calculo.md` (os valores por quarto de hora do operador, quando
entrarem em `loss_profile`, aplicam-se às ilhas também).

## Feriados

Regra da v2: **feriado = próprio dia** (sem excepção), igual ao sheet.
Aberto: Diretiva 3/2026 n.10 manda domingos nos feriados para MT em ciclo
semanal (períodos de rede, novo regime) — validar se os ciclos de energia
dos CEME em MT seguem a mesma regra; até lá, OWN_DAY com hook de config.

## OMIE nas ilhas

MIBEL não cobre os sistemas isolados (EDA/EEM); tarifários indexados ao
OMIE são, por omissão, só `CONT` (`REGIONS[].omieIndexed=false`). Mesmo
nas ilhas o motor **calcula** — com o OMIE continental de referência — e
marca: `quoteOne` devolve `warning: 'OMIE_CONT_REF'` (badge no cartão) e
`/v1/indexed/quarters` devolve o mesmo `warning` para MAD/AZO. O valor é
**ilustrativo, não contractual** (a ilha não compra no MIBEL). TAR
insular tem valores próprios (mecanismo de convergência ERSE) — tabela
`tar` já leva `region`.

## Reforma 2027 (fora do MVP)

Diretiva 3/2026 muda os períodos do Portugal Continental (BTN bi diário 08:30–22:30,
sábado semanal bloco único, etc., faseado Abr–Dez 2027). O motor suporta
tabelas versionadas por data; codificar `CONT_2027` é tarefa do roadmap.
