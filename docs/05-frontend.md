# 05 — Frontend

Tudo o que corre no browser está em `frontend/`: HTML, CSS e JavaScript
simples, sem framework e sem build. O servidor (`backend/src/http/pages.js`) serve os
ficheiros tal como estão. Para mudares uma página, editas o ficheiro e recarregas.

Há duas interfaces para a mesma API:

- o **assistente** (`assistente.html`): três perguntas até ao tarifário
  mais barato. É a porta de entrada;
- o **simulador completo** (`index.html`): o ranking com filtros, a conta
  de cada tarifário e o comparador indexado vs fixo.

E ainda: as páginas **Sobre** e **Contactos** (texto, sem API), as
**estatísticas OMIE** ([09](09-omie-estatisticas.md)) e o **guia da API**
(`/api`, só em inglês).

## Rotas

| Rota | O que serve |
|---|---|
| `GET /` | a interface guardada no cookie `ceme_ui`; **sem cookie**, o assistente |
| `GET /assistente` | o assistente, e grava `ceme_ui=assistente` |
| `GET /simulador` | o simulador completo, e grava `ceme_ui=completo` |
| `GET /index.html` | o mesmo que `/` |
| `GET /sobre`, `GET /about` | página Sobre |
| `GET /contactos`, `GET /contact` | página Contactos |
| `GET /omie`, `GET /omie.html` | estatísticas OMIE (e a raiz de `omie.cocofree.dev`) |
| `GET /api` | guia da API (EN) |
| `GET /strings.js` | os textos PT/EN de todas as páginas |
| `GET /tz.js` | conversão de horas de relógio por região |
| `GET /pages.css` | estilo das páginas Sobre e Contactos |
| `GET /manifest.webmanifest` (`/manifest.json`), `/sw.js` (`/service-worker.js`), `/pwa.js`, `/icon-*.png` | PWA |

JS, CSS e HTML vão com `cache-control: no-store`, para o browser nunca
ficar com uma versão antiga depois de um deploy. Os ícones vão com
`immutable`.

### A escolha entre assistente e simulador

Cada interface tem um link para a outra. Quando abres `/assistente` ou
`/simulador`, o **servidor** grava a escolha num cookie (`ceme_ui`, 1 ano,
`Path=/`, `SameSite=Lax`, e `Secure` quando o pedido veio por https). A
rota `/` só **lê** o cookie, nunca o escreve, por isso quem chega pela
primeira vez vê sempre o assistente.

Ser um cookie lido pelo servidor (e não `localStorage` lido por JS) faz com
que `GET /` responda logo com a página certa, sem piscar nem redireccionar,
e funcione mesmo sem JavaScript. Um valor desconhecido no cookie dá o
assistente.

## O assistente

Quatro ecrãs, navegados pelo hash do URL: `#/onde` → `#/quanto` →
`#/quando` → `#/resultados`.

- **onde:** a região, escolhida num mapa;
- **quanto:** a bateria, em % e kWh, com duas pegas numa barra;
- **quando:** agora, esta noite, amanhã ou uma data à escolha;
- **resultados:** o mais barato em destaque e a lista dos outros, com os
  mesmos filtros do simulador (populares, sem condições, verde) e um
  "Mostrar todos".

As respostas ficam em `sessionStorage['ceme:wizard']` (sobrevivem a um
reload, desaparecem quando fechas o separador), e o tema em
`sessionStorage['ceme:theme']`.

## O simulador completo

Duas vistas, também pelo hash:

- `#/` — o ranking (`POST /v1/simulate`): energia em kWh ou pela bateria,
  região, data e hora do carregamento, pesquisa e filtros (verde,
  populares, sem condições, favoritos), o aviso de âmbito e o detalhe da
  conta de cada tarifário.
- `#/comparar` — indexado vs fixo: o preço actual lado a lado, um gráfico
  de 60 dias e a tabela de quartos de hora com o preço do indexado **e do
  fixo**, marcando onde cada um ganha.

O comparador ignora a pesquisa e os filtros (verde, com condições,
favoritos): é uma ferramenta para comparar dois tarifários quaisquer, não
uma vista filtrada. A escolha guarda-se por `ceme|nome` e não por `id`,
porque o `id` muda entre BT e MT e o tarifário é o mesmo.

### O que recalcula e o que só redesenha

Uns controlos mudam o número (e têm de pedir ao servidor), outros só mudam
o que se mostra. A regra, em `route()`:

| controlo | acção | porquê |
|---|---|---|
| modo kWh ⇄ bateria | `refresh()` | muda a energia, logo o preço |
| valor de kWh, capacidade | `refresh()` | idem |
| slider mín/máx (a arrastar) | actualiza **só** os números que dependem dele | redesenhar tudo substituía o próprio slider a meio do gesto |
| slider mín/máx (ao largar) | `refresh()` | o gesto acabou |
| região | `refresh()` | muda o IVA e os horários |
| BT ⇄ MT | `route()` | a resposta já traz as duas variantes; só muda qual se mostra |
| pesquisa, filtros, favoritos | `route()` | só filtram a lista que já está em memória |

`refresh()` pede ao servidor e redesenha; `route()` só redesenha.

### Funcionalidades

- **Energia:** kWh directo ou bateria (capacidade + % mínima e máxima). O
  valor efectivo é `effKwh()`; é esse que aparece em todo o lado, nunca o
  `S.kwh` cru. No ecrã sai sempre com **uma casa decimal** (`kwhTxt()`); o
  valor bruto só vai para as contas. O campo de edição fica cru, para
  poderes escrever `40` e não `40,0`.
- **Data e hora:** formato `aaaa/mm/dd hh:mm` (24 h), escrito e mostrado no
  **relógio da região** do carregamento (`frontend/tz.js`, funções
  `fromWall`/`toWall`). Nos dias de mudança de hora, uma hora que não existe
  passa para depois do salto e uma hora repetida fica na primeira passagem
  (testes em `tz.test.js`). Por omissão é "agora"; se o relógio do browser
  estiver desviado mais de 5 minutos, usa a hora do servidor. O assistente
  usa as mesmas funções.
- **OMIE de referência:** por omissão, as médias de vazio/fora de vazio por
  ciclo do último dia **completo** de `/v1/omie/daily`. No ranking, em
  automático, a web manda também `useSpot` e cada indexado é cotado ao
  quarto de hora do carregamento. O slider do comparador desliga o
  automático e passa a valer para todos.
- **Ramal (BT/MT):** a tensão escolhida no cartão de energia.
  `dedupByRamal()` deixa uma entrada por `ceme|nome`, na variante dessa
  tensão. É a mesma função no ranking, no modal de favoritos e no
  comparador.
- **A conta linha a linha:** o detalhe de cada tarifário mostra o `parts`
  do motor: energia + TAR (separadas quando se sabe), IEC, activação, total
  sem IVA, IVA e total ([02](02-motor-calculo.md)). O período usado na conta
  vem assinalado.
- **Favoritos:** a estrela nos cartões e o modal "Gerir favoritos",
  agrupado por CEME, com pesquisa e filtros. Guardados em
  `localStorage['ceme:favs']`, sem conta nem BD.
- **Barra de preço com cor:** o comprimento é proporcional ao preço; a cor
  vai de verde a vermelho numa escala **logarítmica** entre o mais barato e
  o mais caro de **toda** a lista (`heatColor()`/`heatOf()`), por isso não
  muda quando filtras. É logarítmica porque, com uma escala linear, quase
  tudo ficava verde (os mais caros estão muito acima da mediana).
- **Pesquisa:** ignora acentos (`deaccent()`: "luzigas" encontra
  "LUZiGÁS") e procura nas duas línguas ao mesmo tempo (`searchText()`).
- **Telemóvel:** abaixo de 520 px o layout fica compacto e o cabeçalho
  passa a duas linhas (logo e bandeiras em cima, navegação por baixo, a
  deslizar na horizontal).
- **Sessão:** energia, região, favoritos, data e hora ficam em
  `localStorage['ceme:S']`. Ao ler, cada campo é validado (`loadS()`), para
  dados velhos ou editados à mão não partirem a página.

### O aviso de âmbito

O custo de um carregamento Mobi.E tem várias parcelas e o simulador só
calcula a **parte da energia**. Para ninguém se enganar, o aviso aparece em
três sítios:

1. no topo da página, sempre visível, numa linha (clicar leva-te ao cartão);
2. num cartão expansível no topo do ranking, com a tabela das parcelas:

   | Parcela | Calculada? |
   |---|---|
   | Tarifário do CEME | ✅ |
   | TAR | ✅ incluída no €/kWh |
   | IEC | ✅ |
   | IVA | ✅ (taxa da região) |
   | Taxa de activação do CEME | ✅ |
   | **Tarifa OPC (uso do posto)** | ❌ |
   | Taxa cobrada pelo OPC | ❌ |
   | Outros serviços | ❌ |

   com o aviso "o valor apresentado é o mínimo da parcela de energia" e
   links para a Mobi.E;
3. no rodapé, numa versão curta.

O estado aberto/fechado do cartão fica em `localStorage['ceme:S'].scopeClosed`.

### A tabela de quartos de hora do comparador

Marca duas coisas diferentes:

| marca | significado |
|---|---|
| ★ | os 8 quartos com o OMIE mais baixo do dia (`cheap`, calculado no servidor) |
| colunas **Fixo €/kWh** e **Melhor** | se o indexado ou o fixo é mais barato **nesse quarto** (`winner`) |

`/v1/indexed/quarters` recebe `?fixed=<id>` (o fixo escolhido) e devolve
`fixed` e `winner` por quarto. Sem `fixed`, a página esconde essas duas
colunas: um vencedor calculado contra o tarifário errado engana mais do que
nenhum.

As regras da comparação estão em `backend/src/engine/compare.js`:

- cada tarifário é cotado **no seu período** (um bi-horário tem preço de
  vazio e de fora de vazio, e os ciclos dos dois podem ser diferentes);
- um fixo **simples** só tem `UNICO`, que vale para todos os períodos;
- os dois lados arredondam a 4 casas **antes** de comparar;
- a taxa de activação fica de fora (cobra-se uma vez, não por quarto);
- um período sem preço no fixo dá `null`, nunca 0.

As faixas de quartos seguidos ("10:30–12:30") calculam-se pelo instante
(`ranges()`), por causa da hora repetida de Outubro.

O gráfico de 60 dias usa uma cópia da fórmula dos indexados escrita no
browser (`idxPrice`). O `formula.test.js` garante que dá o mesmo que o
motor: se mudares uma, muda a outra.

### Notas dos tarifários

Alguns tarifários têm uma nota (`tariff_version.notes`). Chega do servidor
como um **código** (ex.: `AC_DC_FLAT`) e é traduzida no browser
(`NOTE_KEY`); um código desconhecido mostra-se tal e qual. A nota aparece em
três sítios: tooltip no nome, um badge visível no cartão e uma linha no
detalhe da conta. Tem de se ler sem passar o rato.

Hoje só os tarifários `myAtlante (AC)` da Atlante têm nota: o preço é o dos
postos AC (corrente alternada); nos postos DC o CEME tem um preço com a
tarifa do posto incluída, que o simulador não calcula.

### A etiqueta "com condições" (`bundle`)

`tariff.bundle` é um booleano: o preço só vale se tiveres outra relação com
o CEME. Na prática junta casos diferentes:

| exemplos | a condição |
|---|---|
| LUZiGÁS *Cliente Casa e CEME*, eVaz *Plano Move HOME*, Goldenergy *Clientes Comercialização* | ser cliente de electricidade em casa |
| miio one | ter uma subscrição |
| ACP *sócio ACP*, EDP *Associados UVE* | ser sócio de uma associação |
| EDP/MEO *Colaboradores* | trabalhar na empresa |
| EDP *Clientes energia*, EVIO *Hyundai Blue*, Galp Plano, FactorEnergia *VECARD* | desconto por já ser cliente |
| Atlante *myAtlante Business (AC)* | ser cliente empresarial |

Na interface chama-se, nos três sítios onde aparece (badge, filtro e modal
de favoritos):

| | |
|---|---|
| PT | **preço com condições** / *sem condições* / *com condições* |
| EN | **conditional price** / *no conditions* / *conditional* |

O filtro do modal de favoritos é independente do do ranking: `FM.bundle`
quer dizer "mostrar os com condições".

## Arranque da página

`init()` desenha logo com um OMIE por omissão e só depois vai buscar o OMIE
de referência, em segundo plano (`loadOmieRef()`). Com a BD vazia esse
pedido pode demorar dezenas de segundos, e a página não fica à espera.

Se o **primeiro** `refresh()` falhar (servidor a arrancar, rede em baixo),
aparece um cartão de erro com um botão para tentar outra vez. O `api()`
trata o token expirado: num 401, pede uma sessão nova e repete o pedido uma
vez. Os outros erros HTTP viram uma mensagem de erro, nunca uma lista vazia.

## Línguas (PT / EN)

PT por omissão. Ordem de prioridade:

1. `localStorage['ceme:lang']`, a bandeira que escolheste;
2. o cabeçalho **`Accept-Language`**, lido pelo servidor ([04](04-api-auth.md));
3. português.

Como funciona no browser:

- **Um dicionário para todas as páginas**: `frontend/strings.js`. Cada
  página pede o seu bloco com `CEME_STR('<página>')`, que devolve `{pt, en}`
  já com o vocabulário **comum** (`common`: filtros, etiquetas, logo,
  navegação) junto. `CEME_I18N.regions` tem o nome, o IVA e o fuso de cada
  região (com um nome longo e um curto).
- `i18n('chave', {vars})` no simulador e `t('chave', {vars})` no assistente
  fazem a substituição e usam o PT se a chave faltar em EN. No simulador
  chama-se `i18n` e os tarifários chamam-se `tf`, para nenhuma variável
  tapar a função.
- `setLang(id, persist)` (simulador) muda a língua, o `<html lang>`, as
  bandeiras e as partes fixas da página (`applyChrome()`). O assistente
  redesenha o ecrã.
- No simulador as bandeiras são SVG (os emojis de bandeira não aparecem em
  Windows); no assistente, `PT` / `EN` em texto.
- O `backend/test/strings.test.js` garante que PT e EN têm as mesmas chaves
  e os mesmos placeholders, que nenhuma página redefine uma chave de
  `common`, que não há chaves usadas que não existam nem chaves que ninguém
  usa, e que o mesmo texto não aparece em dois sítios (se duas páginas dizem
  o mesmo, vai para `common`).

O inglês é **britânico** (`en-GB`). Os textos escrevem-se como um nativo
diria, e não como tradução palavra a palavra. Exemplos:

| PT | EN |
|---|---|
| Comparador CEME | EV Tariff Comparison |
| Quanto custa carregar agora? | How much does it cost to charge right now? |
| Indexado OMIE | Tracks the OMIE price |
| comercializado em: | only sold in: |
| O valor apresentado é o mínimo… | What you see here is the cheapest the energy component can be. |
| A fatura final será maior | Your final bill will be higher |
| Favoritos | saved |
| Indexado vs fixo | Indexed to OMIE vs fixed tariff |

`OPC` aparece como `OPC / CPO` (o site da Mobi.E em inglês usa *Charging
Point Operator*).

O português é **europeu**, nunca do Brasil: `utilizador`, `ecrã`,
`ficheiro`, `fatura`, `electricidade`. Nada de `usuário`, `tela`,
`arquivo`, `celular`, `você`.

### O que não se traduz

- As **marcas** e "@ O Carro Elétrico".
- `~` e as siglas `BT`/`MT` (o significado está no tooltip).
- Topónimos: `Madeira` fica, `Açores` passa a `Azores`.
- `IVA` passa a `VAT`; `€/kWh` e o formato de data `aaaa/mm/dd hh:mm` ficam.

O que chega do servidor tem de vir **neutro ou como código**, nunca como
frase numa língua: o aviso das ilhas (`OMIE_CONT_REF`), as notas dos
tarifários (`notes`) e o rótulo das fontes do OMIE (`SOURCE_LABEL`). É o
browser que traduz.

### Nomes dos tarifários

São os nomes que cada CEME publica, por isso **não se traduzem por
inteiro**: ficavam irreconhecíveis e impossíveis de conferir na página do
CEME. Traduz-se o vocabulário genérico e a marca fica.

`NAME_RULES` (em `index.html`) é uma lista de substituições aplicada **por
ordem**, as frases mais longas primeiro. Os nomes que são só marca ficam
como estão (`NAME_KEEP`). Exemplos:

| original | em inglês |
|---|---|
| Cartão EDP Charge (Bi-Horário) | EDP Charge card (bi-hourly) |
| Cartão CEME | CEME card |
| Tarifário Indexado Cliente CEME | indexed tariff, CEME customer |
| miio (Bi-Horário Diário) sem subscrição | miio (bi-hourly daily) no subscription |
| ACP Electric by EVIO - não sócio ACP | ACP Electric by EVIO — not an ACP member |

Repara que "Cartão" é prefixo em PT e sufixo em EN, por isso há regras por
marca. A pesquisa procura nas duas formas: quem escreve "indexed tariff"
com a interface em português encontra o tarifário.

Testado em `backend/test/i18n.test.js`: casos fixos, marcas intactas,
nenhum nome do seed por traduzir, e uma regra curta nunca antes da frase
longa que a contém.

## Testes do frontend

`backend/test/frontend-smoke.test.js` corre o script do simulador num
contexto isolado (sem browser, com um `document` falso) e chama as funções
que desenham cada vista (`vHome()`, `vCmp()`, `badges()`, `detail()`,
`renderFavModal()`). Apanha erros de JavaScript que os testes de texto não
vêem. O `assistente-smoke.test.js` faz o mesmo para o assistente. Se
criares um script partilhado novo, tens de o carregar também nesses testes.

## PWA

O site pode ser instalado no telemóvel: `manifest.webmanifest`, `sw.js` (o
service worker) e `pwa.js` (o banner "Instalar"). O service worker usa
**rede primeiro** para tudo o que muda com um deploy (`strings.js`,
`tz.js`, `pages.css`, manifest): a cópia guardada só serve sem rede. Os
ícones, que não mudam, vão **cache primeiro**. Não guarda páginas nem
`/v1/*`. Se mudares a estratégia ou a lista, sobe o nome da cache (`CACHE`
em `sw.js`): o service worker novo apaga as caches antigas.

## O que vem a seguir

Vê o [roadmap](06-roadmap.md).
