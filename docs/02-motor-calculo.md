# 02 — Motor de cálculo

Substitui as ~100 fórmulas `IF(WEEKDAY/TIME(...))` copiadas em `CEME!X:AD`
e os `=0,1+TAR!$C$5` manuais por uma função pura, testada, com
`Europe/Lisbon` real (DST automático via `Intl` / `Temporal`).

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
- **Perdas E-REDES 2026** (média anual BTN): BT 0,1531 / MT 0,0713.
  Substituíram o placeholder 0,10/0,07. Os valores por DSO e por
  quarto de hora entram quando a ingestão de perfis existir.

## Fixos

```
preço_final(periodo) = valor ERSE/outras-fontes (base CEME + TAR incluída)
total = ROUNDUP(act + apoio + kwh*preço_final + kwh*iec) * 1,23
```

Segue o `ROUNDUP(...)*1,23` de `CEME!AC/AD` (IVA 23%). A tabela `tar`
**não** se soma nos fixos — serve para auditoria e para os indexados.
Ex. Atlante MT fora-vazio: `40*0,1812=7,25 + 0,11 + 0,04 → 7,40*1,23 =
9,11€` (bate certo com o sheet).

O `act` (tarifa de ativação) é a **EGME** — a taxa por carregamento que a
CEME cobra ao cliente e que já cobre o seu custo junto da EGME. Não é um
valor regulado único: cada CEME publica o seu (0,1088 € legal, 0,11 €
Atlante, 0,15 € ACP/EVIO, 0,1572 € Charge2Go/EVPower/Via Verde). O único
que não cobra é o miio. Auditado em `backend/test/poc.test.js`
("auditoria EGME").

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
| Atlante myAtlante Business (AC) | MT/BS | fora-vazio | 8,12 € | 0,17 |
| Atlante myAtlante Business (AC) | BT/BS | fora-vazio | 9,99 € | 0,21 |
| Charge2Go Eco Green | MT/BD | vazio | 9,38 € | 0,19 |
| Via Verde Electric | MT/BS | vazio | 8,31 € | 0,17 |
| EZU AB Energia | MT/BS | vazio | 5,84 € | 0,12 |
| miio sem subscrição | MT/BD | vazio | 12,64 € | 0,26 |

O **9,11 €** é o valor que a folha dava — é o que valida o motor de ponta a
ponta (a folha, o `ROUNDUP` por componente e o IVA a 23%).

Testes que acompanham: o `ROUNDUP` é por componente e não no fim (sem ele o
mesmo tarifário daria 9,10 €); os 24 CEME / 128 tarifários; nenhum fixo sem
componente de preço; nenhum indexado sem K/CGS; e a EGME só a faltar no miio.

**Os indexados não entram na tabela** — dependem do OMIE do dia. São testados
à parte com um OMIE fixado (ver `engine.test.js`), não com um total em euros.

### O que estes testes não apanham

Um tarifário que **desapareça** do seed passa todos eles. Isso apanha-se a
comparar com o sheet, e é assim que se encontrou um buraco: o
`myAtlante (AC)` **BT** está no sheet (`CEME!` linha 92, final 0,1266) e não
está no seed. Ver `06-roadmap.md`.

Tolerância: 0,01 € (diferenças de ROUNDUP). Mudanças de TAR/OMIE criam novas
versões do tarifário; não se mexa nestes valores.
