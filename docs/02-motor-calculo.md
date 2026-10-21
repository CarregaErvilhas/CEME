# 02 — Motor de cálculo

Substitui as ~100 fórmulas `IF(WEEKDAY/TIME(...))` copiadas em `CEME!X:AD`
e os `=0,1+TAR!$C$5` manuais por uma função pura, testada, com
`Europe/Lisbon` real (DST automático via `Intl` / `Temporal`).

> **Estado:** a assinatura `quote()` abaixo é o **alvo da fase 2**.
> Hoje o motor é `quoteFixed(...)` + `indexedPrice(...)` +
> `breakevenOmie(...)` (`src/engine/quote.js`, `src/engine/indexed.js`), com
> `compareWithFixed`/`tallyWinners` (quarter a quarto) em `engine/compare.js`
> — mesmas regras, entrada desdobrada.

## Assinatura

```ts
quote(input: {
  tariff: TariffKind; version: TariffVersion;
  components: PriceComponent[];   // FIXED
  at: Date;                       // instante da simulação
  kwh: number;                    // ex. 40
  tar: TarTable;                  // TAR vigente em `at`
  omieSlice?: OmieQuarter[];      // INDEXED: quartos do período de facturação
  losses?: LossTable;
}): { period: 'VAZIO'|'FORA_VAZIO'|'UNICO'; eurKwhNoIva: number;
      totalEur: number; breakdown: {...} }
```

## Regras de período (BT, ERSE — hoje hardcoded nas fórmulas)

- **Simples:** sempre `UNICO`.
- **Bi-horário Diário:** Fora-Vazio 08:00–22:00, Vazio resto.
  (fórmula actual: `$X$3 >= TEXT+TIME(8;0;0) AND < TIME(22;0;0)`).
- **Bi-horário Semanal (Continente):**
  - domingo = Vazio o dia todo;
  - dias úteis: Fora-Vazio 07:00–24:00, Vazio 00:00–07:00;
  - sábado, **época = hora legal (DST)** — é sazonal, não fixo:
    - Verão (último domingo de março → último domingo de outubro):
      Fora-Vazio 09:00–14:00 e 20:00–22:00;
    - Inverno: Fora-Vazio 09:30–13:00 e 18:30–22:00;
- Feriados PT: *a decidir* (sheet trata como dia útil — manter até ERSE dizer o contrário; registar como issue).
- DST: usar tz `Europe/Lisbon` — dias com 92/96/100 quartos; a hora `02:00–03:00` de 2026-03-29 não existe, 2026-10-25 repete-se.
- Regiões: `region` em `CONT|MAD|AZO` (ver docs/07-ilhas.md) — timezone,
  IVA (1.23/1.22/1.16) e janelas bi-horárias próprias; época das ilhas por
  mês (6–10 vs resto). Feriados = próprio dia (OWN_DAY), sem excepção.
- **Perdas E-REDES 2026 (BTN): BT 0,1531 / MT 0,0713** — *factor de
  proveniência incerta (ver nota abaixo)*. Os valores por DSO e por
  quarto de hora entram quando a ingestão de perfis existir
  (`loss_profile`, roadmap 06).

**Nota de verificação desta escolha:** o ficheiro
oficial `Perfis_Perdas_E-REDES_2026` ("Perfis de Perdas Simples") dá médias
anuais **BT 0,0765** / **MT 0,0364** e máximo BT **0,1268** — nenhum destes
pontos justifica 0,1531/0,0713, que provavelmente reproduzem as condições
publicadas pelos CEME indexados (e não a média BTN do operador). Mantêm-se
por serem o que fecha com as condições publicadas, marcados como
placeholder a substituir por `loss_profile` por quarto de hora (ver 06).

## Fixos

```
// ROUNDUP por componente (cada parcela arredonda-se a si mesma, como a
// fatura), e o total também por excesso depois do IVA:
base  = ROUNDUP(act,2) + ROUNDUP(apoio,2) + ROUNDUP(kwh*preço_final,2) + ROUNDUP(kwh*iec,2)
total = ROUNDUP(base × (1+IVA_região), 2)     // CONT 0,23 / MAD 0,22 / AZO 0,16
```

Segue o `ROUNDUP(...)*1,23` de `CEME!AC/AD`. A tabela `tar`
**não** se soma nos fixos — serve para auditoria e para os indexados.
Ex. Atlante MT fora-vazio: `40*0,1812=7,25 + 0,11 + 0,04 → 7,40*1,23 =
9,11€` (bate certo com o sheet).

O `act` (taxa de activação) **é o que a CEME publica no sheet, à data da
captura** — um único significado, invariante: o valor entra no cálculo como
está, sem substituição. Algumas CEMEs trocam-lhe o nome de EGME, e à conta
disso há uma referência regulamentar útil: o valor legal em vigor 2026 é
**0,1088 €** (Regul. ERSE 7/2026, desde 2026-01-01; os 0,1572 € do sheet são
o valor de 2025). Vários CEMEs, na prática, não actualizam — e nenhum pode
ser substituído pelo legal no código: se o publicado está acima do legal, a
API marca `activation_stale: true` (e o `egme_legal` dá o valor de
referência), o cartão mostra o aviso, e a actualização é tarefa de **nova
captura da folha** (nova `tariff_version` — o schema já tem valid_from),
não de re-derivar preços a cada mudança de regulamento. Valores próprios
que a CEME publica para os seus packs ficam como estão (0,11 € Atlante,
0,15 € ACP e parte da EVIO); o miio não cobra. Auditado em
`backend/test/poc.test.js` ("auditoria EGME") — e o delta do cenário legal
fica congelado no `golden.test.js` ("cenário regulatório").

## Indexados

Fórmula oficial (célula `LuziGas!A3`):

```
PE(h) = (OMIE(h) + K + CGS) * (1 + Perdas(h)) + TAR(periodo(h))
```

- `OMIE(h)`: €/kWh do quarto-horário (fonte `omie_spot.price_pt / 1000`).
- `K`, `CGS`: da `tariff_version` vigente (ex. Luzigas Casa+CEME
  K=0,005; só CEME K=0,05; CGS 0,02 em 2025/01/01).
- `Perdas(h)`: `loss_profile` por tensão.
- `TAR`: da tabela `tar` vigente, por período horário de `h`.
- **Agregação do OMIE** — nem todos os CEME usam a mesma regra. É um dado versionado (`tariff_version.omie_aggregation`), não uma constante do motor:
  | valor | regra | quem usa |
  |---|---|---|
  | `SPLIT_VAZIO_FORA` | média dos `PE(h)` de Vazio vs Fora-Vazio | Luzigas, MEO Dinâmica, Ynerluz |
  | `SPOT` | o próprio `OMIE(h)` do quarto | (teleoctel) |
  | `UNICA` | média única do período de facturação | restantes CEME |
  O pedido `/v1/simulate` aceita `omie` (único), `omieVazio` e `omieFora`.
  O frontend calcula as médias do dia a partir de `/v1/omie/daily`
  (`bd_v`/`bd_f` para bi-diário, `bs_v`/`bs_f` para bi-semanal).
- "OMIE actual" do sheet = `omie_daily` mais recente ou média dos
  últimos N quartos — o motor aceita `omieSlice` explícito para
  histórico ("preços actuais, históricos e próximos 2 dias").

## Vectores golden (sheet de 2026-10-15, 40 kWh, 22:09, Continente)

Congelados em `backend/test/golden.test.js`. Passam pelo **seed e pelo motor
reais** — não por valores escritos à mão no teste — por isso protect contra
regressão do motor *e* contra uma alteração acidental no seed.

| tarifário | tensão/ciclo | banda às 22:09 | total | €/kWh s/ IVA |
|---|---|---|---|---|
| Atlante myAtlante (AC) | MT/BS | fora-vazio | **9,11 €** | 0,19 |
| Atlante myAtlante (AC) | BT/BS | fora-vazio | **10,98 €** | 0,23 |
| Atlante myAtlante Business (AC) | MT/BS | fora-vazio | 8,12 € | 0,17 |
| Atlante myAtlante Business (AC) | BT/BS | fora-vazio | 9,99 € | 0,21 |
| Charge2Go Eco Green | MT/BD | vazio | **9,38 €** | 0,19 |
| Via Verde Electric | MT/**BD** | vazio | **8,31 €** | 0,17 |
| EZU AB Energia | MT/**BD** | vazio | 5,84 € | 0,12 |
| miio sem subscrição (BD) | MT/BD | vazio | 12,64 € | 0,26 |

Todas as oito âncoras são **externas**: vêm da folha de captura
(2026-10-15), incluem a activação publicada por cada CEME (Charge2Go e Via
Verde ainda com o EGME 2025 de 0,1572 € — ver nota de EGME acima).

O **9,11 €** é o valor que a folha dava — é o que valida o motor de ponta a
ponta (a folha, o `ROUNDUP` por componente e o IVA a 23%). O cenário
«aplicada a EGME legal 2026» (0,1088 €) fica num teste separado no
`golden.test.js`: Charge2Go **9,32 €** e Via Verde **8,25 €** — é o que a
fatura daria se o CEME actualizar o valor; não são âncoras do seed.

Testes que acompanham: o `ROUNDUP` é por componente e não no fim (sem ele o
mesmo tarifário daria 9,10 €); os 24 CEME / 128 tarifários; nenhum fixo sem
componente de preço; nenhum indexado sem K/CGS; e a EGME só a faltar no miio.

**Os indexados não entram na tabela** — dependem do OMIE do dia. São testados
à parte com um OMIE fixado (ver `engine.test.js`), não com um total em euros.

### O que estes testes não apanham

Um tarifário que **desapareça** do seed passa todos eles. Isso apanha-se a
comparar com o sheet, tarifa a tarifa. (Já apanhou um caso, entretanto
resolvido: o `myAtlante (AC)` **BT** — hoje `atlante-bt-myatlanteac`,
10,98 € na tabela acima.)

Tolerância: 0,01 € (diferenças de ROUNDUP). Mudanças de TAR/OMIE criam novas
versões do tarifário; não se mexa nestes valores.
