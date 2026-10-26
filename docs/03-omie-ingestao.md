# 03 — Como chegam os preços do OMIE

Os tarifários indexados e a página de estatísticas precisam do preço do
mercado grossista (o OMIE) para cada quarto de hora. Este documento
explica de onde vêm esses preços, como se guardam e quando se actualizam.
O código está em `backend/src/omie/`.

Se "OMIE", "MIBEL" ou "quarto de hora" não te dizem nada, lê primeiro o
[glossário](00-glossario.md).

## As duas fontes

| fonte | o que é | para que serve |
|---|---|---|
| **omie.es** | o ficheiro público do OMIE, com os últimos ~12 meses de preços por quarto de hora | **principal**: o preço |
| **dados.tiagofelicia.pt** (TF) | CSV do ano corrente e do anterior, mais os futuros do OMIP (licença CC BY 4.0) | **secundária**: diz se cada quarto é vazio ou fora de vazio (nos ciclos diário e semanal, pelas regras da ERSE), preenche buracos, estima os dias que o OMIE ainda não publicou e traz os futuros diários `FPB D` |

O ficheiro do omie.es pede-se de forma **condicional**: mandas o ETag (e o
Last-Modified) da última vez, guardados na BD, e se o ficheiro não mudou a
resposta é um **304** sem corpo. Assim não descarregas ~2,8 MB à toa.

Os CSV do TF guardam-se em disco (`backend/data/`, fora do git) e só se
voltam a descarregar quando ficam velhos. As idades máximas estão em
`omie/tf.js`: `TTL_DAILY` (ano corrente), `TTL_HISTORY` (ano anterior) e
`TTL_FUTURES` (futuros).

| ficheiro | o que faz |
|---|---|
| `omiees.js` | descarrega e lê o ficheiro do omie.es |
| `tf.js` | descarrega (com cache) e lê os CSV do TF |
| `parse.js` | lê as linhas do ficheiro do omie.es, com validação |
| `convert.js` | contas de datas e fusos (dia de mercado → instante, dias de Lisboa) |
| `store.js` | grava e lê na BD; junta as duas fontes (`reconcile`) |
| `pipeline.js` | orquestra tudo: quando actualizar, o lock, as leituras da API |
| `stats.js` | calcula os números da página de estatísticas ([09](09-omie-estatisticas.md)) |

## A chave é o instante

Tudo se guarda em **UTC**, com a chave no **instante** (`ts_utc`).

A hora local nunca é a chave: na mudança de hora de Outubro, a 01:00–02:00
de Lisboa acontece duas vezes, e duas linhas com a mesma hora de relógio
chocavam. O instante nunca se repete. (A tabela das mudanças de hora está
em [02](02-motor-calculo.md).)

Ao lado do instante, cada linha guarda o **dia de Lisboa** (`day_lisbon`) e
os **minutos desde a meia-noite de Lisboa** (`min_lisbon`). É por eles que
se agrupa por dia e por mês, e assim os números batem com os que o TF
publica.

"Hoje" é sempre o dia de Lisboa (`civilDay()` em `omie/convert.js`), nunca o
dia UTC.

## Quando se actualiza

**Não há tarefa agendada (cron).** A actualização acontece quando alguém
lê dados do OMIE (`/v1/omie/daily`, `/v1/indexed/quarters`,
`/v1/omie/stats`). Cada leitura chama `ensureFresh()`, que olha para a hora
da última actualização (`omie_meta.last_refresh`):

- se tem menos de uma hora (`REFRESH_TTL_MS` em `pipeline.js`), não faz nada;
- se é mais velha, lança a actualização **em segundo plano** e responde logo
  com o que já há (o `/stats` responde com `stale: true` enquanto isso);
- se a BD **ainda está vazia**, o pedido **espera** pela actualização, porque
  não há nada para mostrar.

Os futuros (`/v1/omie/futures`) têm a sua própria idade máxima
(`TTL_FUTURES`). As estatísticas também se recalculam quando muda o dia de
Lisboa ([09](09-omie-estatisticas.md)).

Uma actualização (`refreshAll()`) faz, por ordem: omie.es, TF, futuros e,
no fim, recalcula os resumos (`omie_daily` e as estatísticas). Se uma fonte
falhar, fica escrito no log e as outras continuam.

### O que se reescreve em cada actualização

Os upserts não duplicam nada, mas também não vale a pena reescrever tudo:

- **omie.es**: os dias que faltam na BD mais os 3 dias antes do último dia
  do ficheiro (onde o OMIE ainda pode corrigir valores);
- **TF**: os dias que faltam mais tudo entre **hoje − 10 dias** e **hoje +
  45 dias** (dias de Lisboa). É aí que o TF troca estimativas por valores
  reais e revê estimativas. O ficheiro do TF vai até ao fim do ano, por
  isso a janela tem de ser à volta de hoje e não à volta do último dia do
  ficheiro.

### Várias instâncias do servidor

Pode haver mais do que uma instância a correr. Para não irem todas buscar
os ficheiros ao mesmo tempo, há um **lock na própria BD**: a linha
`refresh_lock` em `omie_meta`, com o valor `<hora em ms>:<texto aleatório>`.

- **Ficar com o lock**: `INSERT … ON CONFLICT DO NOTHING`. Se já existir e
  estiver expirado (`LOCK_TTL_MS`), tiras-o com um *compare-and-swap*: um
  `UPDATE … WHERE value = <o que leste>`, que só muda a linha se ninguém lhe
  mexeu entretanto. Se duas instâncias tentarem ao mesmo tempo, só uma ganha.
- **Largar o lock**: `DELETE … WHERE value = <o teu token>`. Se o teu lock
  expirou e outra instância ficou com ele, não lho apagas.

Testado em `omie-lock.test.js`. Mesmo que duas instâncias actualizassem ao
mesmo tempo, os dados não se estragavam: só se gastava rede.

### Modo readonly

Com `CEME_READONLY=1` (a BD não é tua, por exemplo um preview a ler a
produção) não se actualiza nem se grava nada: `ensureFresh` não faz nada e
as estatísticas calculam-se em memória. Como rede de segurança, qualquer
`run()` em `db.js` atira um erro neste modo.

### Onde ficam os dados

Na **base de dados**, não em ficheiros: a BD sobrevive aos deploys e é
partilhada por todas as instâncias. Os CSV do TF em disco são só cache (cada
instância tem a sua) e podes apagá-los à vontade.

## Juntar as duas fontes

As duas fontes escrevem linhas separadas (a chave é `(ts_utc, source)`).
Juntam-se só na leitura, em `reconcile()` (`store.js`), instante a
instante:

1. o **preço** é o do omie.es quando existe, senão o do TF;
2. a **classificação** vazio/fora de vazio é a do TF; se não houver, calcula-se
   com as regras do motor (`engine/regions.js`);
3. o que vem **depois do último instante publicado** pelo omie.es é uma
   **estimativa** e leva a marca `est`.

Juntar na leitura, e não na escrita, faz com que a ordem em que as fontes
chegam não importe.

## O ficheiro do omie.es

`https://www.omie.es/sites/default/files/dados/NUEVA_SECCION/INT_PBC_EV_H_ACUM.TXT`

Uma janela dos últimos ~12 meses, com 96 períodos por dia (92 no dia da
mudança de hora de Março, 100 no de Outubro). Se o corpo vier abaixo de um
tamanho mínimo (`omiees.js`), é tratado como erro: uma página de erro
servida com 200 não pode passar por dados.

Formato (latin1, separador `;`):
`Fecha(d/m/aaaa);Periodo(1..100);ES(€/MWh);PT(€/MWh);...`
Decimais com vírgula (`219,86`). Na maioria das horas o preço PT é igual ao
ES; só diferem quando a ligação entre os dois países está saturada.

Não precisas de credenciais: o ficheiro é público.

## Do período de mercado ao instante

O `Periodo N` é o N-ésimo quarto de hora do **dia de mercado**, que vai das
00:00 às 24:00 de **Madrid** (CET/CEST). A conversão é directa:

```
instante = meia-noite de Madrid no dia de mercado + (N − 1) × 15 min
```

No dia da mudança de hora, a meia-noite ainda está no offset **antigo**
(CET +1 em Março, CEST +2 em Outubro), porque a mudança é à 01:00 UTC, depois
da meia-noite local.

**Dia de mercado ≠ dia de Lisboa.** O dia de mercado de Madrid começa às
23:00 de Lisboa da véspera. Por isso, quando o OMIE publica o dia D+1 (por
volta das 13:00), o dia de Lisboa D+1 fica só com **92** quartos: as
23:00–24:00 de Lisboa pertencem ao dia de mercado D+2, que ainda não saiu.
O `/v1/omie/daily` marca cada dia com `complete` (tem o número de quartos
esperado), e a web usa como referência o último dia completo.

## O ficheiro do TF

O ficheiro do TF, ao contrário, está em **hora de relógio de Lisboa**, e os
dias são dias de Lisboa. Calcular o instante como "meia-noite + hora de
relógio" falha nos dias de mudança de hora (em Março o relógio salta das
00:59 para as 02:00). Por isso o código gera a lista real de quartos desse
dia (`lisbonDayQuarters`) e procura, a seguir ao quarto da linha anterior, o
primeiro com a mesma hora de início (coluna `intervalo`). Assim, a segunda
"01:00" de Outubro cai na segunda passagem, e uma linha em falta não
desloca as seguintes.

Os dois ficheiros alinham-se pelo **instante**, nunca pelo número do período.

## O "OMIE de referência" de cada indexado

| média | ciclo | usada por |
|---|---|---|
| `bd_v` / `bd_f` | vazio / fora de vazio no ciclo **diário** | indexados de ciclo diário |
| `bs_v` / `bs_f` | vazio / fora de vazio no ciclo **semanal** | indexados de ciclo semanal |
| média única (`avg_pt`) | o dia todo | `UNICA` |

A web lê estas médias do último dia **completo** de `/v1/omie/daily` e
envia-as em `omieCycles` no `POST /v1/simulate`. São o plano B: com o OMIE
em automático, a web envia também `useSpot` e o indexado é cotado ao quarto
de hora do carregamento ([02](02-motor-calculo.md)).

## Validação (dados maus não rebentam nada)

A regra é: uma linha má vai para a **quarentena** (uma lista à parte, com o
motivo), e o resto segue.

- **Leitura:** latin1, BOM, vírgula vs ponto decimal, linhas vazias e de
  rodapé. Um `Periodo` fora de 1..100 ou um preço que não é número vão para
  a quarentena. Um período repetido no mesmo dia também, com um aviso.
- **Dias:** 92, 96 e 100 quartos são normais. Um dia com menos do que devia
  fica marcado como incompleto (`omie_meta.omie_partial_days`); não se
  deita nada fora.
- **Preços:** fora da gama plausível (`parse.js`) leva a flag
  `suspect_range`; uma diferença grande entre PT e ES leva
  `suspect_pt_es_split` (pode ser legítima). As flags ficam na linha e não
  apagam nada.
- **Rede:** timeout de 25 a 60 s (incluindo ler o corpo), até 3
  tentativas com espera crescente (`omie/fetch.js`), pedido condicional ao
  omie.es.

O preço do TF não é comparado com o do omie.es: quando o omie.es tem o
instante, o do TF simplesmente não se usa. Medir essas diferenças está no
[roadmap](06-roadmap.md).
