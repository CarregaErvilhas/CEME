# 05 — Frontend

Duas interfaces, o mesmo motor e a mesma API: o **assistente** (três perguntas
até ao tarifário mais barato) e o **simulador completo** (ranking, filtros,
comparador indexado vs fixo). HTML + CSS + JS vanilla, sem build, servidos
pelo próprio `server.js`.

A este par juntam-se as **páginas institucionais** estáticas — **Sobre** e
**Contactos** — que não usam a API (a explicação do projecto e o sítio onde
se reporta um problema), a página das **estatísticas OMIE** (docs/09) e o
**guia da API** (`/api`, só em inglês, para developers).

## Duas interfaces e a escolha do utilizador

| Rota | O que serve |
|---|---|
| `GET /` | a interface que o cookie `ceme_ui` indicar; **sem cookie**, o assistente |
| `GET /assistente` | assistente + grava `ceme_ui=assistente` |
| `GET /simulador` | simulador completo + grava `ceme_ui=completo` |
| `GET /index.html` | alias de `/` (segue o cookie) |
| `GET /strings.js` | dicionário partilhado (ver i18n) |
| `GET /tz.js` | horas de relógio por região (simulador + assistente) |
| `GET /pages.css` | estilo partilhado pelas páginas institucionais |
| `GET /sobre`, `GET /about` | página "Sobre" (aliases PT/EN) |
| `GET /contactos`, `GET /contact` | página "Contactos" (aliases PT/EN) |
| `GET /omie`, `GET /omie.html` | estatísticas OMIE (e a raiz do host `omie.cocofree.dev`) |
| `GET /api` | guia da API (EN) |
| `GET /manifest.webmanifest` (`/manifest.json`), `/sw.js` (`/service-worker.js`), `/pwa.js`, `/icon-*.png` | PWA |

Os JS/CSS/HTML vão com `cache-control: no-store` (são código partilhado: não
podem ficar presos numa versão velha depois de um deploy); os ícones vão
`immutable`.

O assistente é a porta de entrada: é a página que um visitante novo vê em `/`.
Cada interface tem um link para a outra (`Abrir o simulador completo` /
nav `Assistente`), e é o **servidor** que grava a escolha, num cookie de
preferência (`ceme_ui`, 1 ano, `Path=/`, `SameSite=Lax`, `Secure` quando o
pedido chegou por https). `/` só **lê** o cookie — nunca o escreve — para a
primeira visita ficar sempre no assistente mesmo que alguém partilhe um link
para `/`.

Guardar no cookie (e não em `localStorage`) resolve dois problemas de uma vez:
`GET /` responde logo com a página certa (sem flash nem redirect) e a escolha
vale mesmo sem JS. Um valor desconhecido no cookie cai no assistente; um
`<script>` não decide nada.

O fluxo de cada interface:

- **Assistente** (`#/onde` → `#/quanto` → `#/quando` → `#/resultados`): região
  (mapas), bateria (% e kWh, duas pegas sobre uma barra), quando (agora, esta
  noite, amanhã, data à escolha). O estado vive em `sessionStorage['ceme:wizard']`
  (sobrevive a um reload de separador em segundo plano) e o tema em
  `sessionStorage['ceme:theme']`. Nos resultados: o mais barato em destaque,
  lista dos restantes com os mesmos filtros do simulador — **populares**,
  sem condições, verde — e o `Mostrar todos`.
- **Simulador completo** (`#/`, `#/comparar`): ranking com filtros (verde,
  populares, sem condições, favoritos, pesquisa), aviso de âmbito, detalhe da
  composição do preço e o comparador indexado vs fixo.

## Rotas do simulador completo (hash)

- `#/` — ranking "neste momento" (`POST /v1/simulate`), com kWh ou bateria %,
  região, pesquisa, filtros (verde, populares, sem condições, favoritos), data/hora do
  carregamento configurável (ISO aaaa/mm/dd hh:mm, no relógio da região).
- `#/comparar` — indexado vs fixo: valor actual, gráfico SVG de 60 dias,
  tabela de quartos-horários com o preço do indexado **e do fixo**, marcando
  todos os quartos em que cada um ganha.
  Os dropdowns usam `dedupByRamal(LAST)`: **sem** duplicados BT/MT (o bug
  anterior listava cada tarifário duas vezes) e o comparador ignora os filtros
  de cor/bundle/favoritos e a pesquisa — o comparador é uma ferramenta de
  comparação, não uma vista filtrada. A selecção guardar-se por
  `ceme|nome` e não por `id`, para sobreviver à troca BT ⇄ MT (o id muda, o
  tarifário não).

## Páginas institucionais (Sobre, Contactos)

HTML estático, sem API e sem estado — a única coisa dinâmica é a língua. O
servidor serve-os com a mesma negociação de `Accept-Language` das interfaces
(`<html lang>` + `window.__LANG__`), injectados da mesma forma, e **sem
cookie**: a escolha do cookie `ceme_ui` é só da interface (assistente vs
simulador), não da página.

| rota | ficheiro | conteúdo |
|---|---|---|
| `/sobre` (`/about`) | `frontend/about.html` | a história (a folha de cálculo do `@ofelgueiras2` que inspirou o projecto), porque é que comparar um carregamento é difícil, o que o simulador faz, **a secção dos DPC** (Detentor de Ponto de Carregamento: o que é, e porque é que no ponto dele não há OPC — logo a energia é quase toda a factura), de onde vêm os dados e o que o projecto **não** é |
| `/contactos` (`/contact`) | `frontend/contact.html` | GitHub issues (caminho mais rápido para uma correcção), email `info@ocarroeletrico.com`, Messenger, os sítios onde nos encontrar (O Carro Elétrico, Mobi.E, simulador da ERSE) e o que vale a pena escrever para se poder reproduzir um erro |

Duas decisões que valem a pena registar:

- **O texto vive em `strings.js`**, como em todas as outras páginas — os
  namespaces `about` e `contact` entram no teste de sincronia PT/EN
  (`backend/test/strings.test.js`) como os restantes. (Excepção: o guia
  `/api`, só em inglês, tem o texto no próprio HTML.)
- **O chrome (logo e navegação) vive em `common`**, porque as páginas
  mostram as mesmas coisas. As chaves `logoA`/`logoB` e `navSim`/`navAssistant`/
  `navSobre`/`navContactos` saíram do namespace `simulador` para `common` — o
  texto repetido entre páginas é a coisa que o teste apanha.

Em telefone o header passa a duas linhas (logo + bandeiras em cima, nav por
baixo, a deslizar na horizontal): com cinco links na nav do simulador já não
cabia tudo numa linha, e espremer os rótulos ficava ilegível.

## Aviso de âmbito (a peça mais importante da UI)

O custo de um carregamento Mobi.E tem várias parcelas; nós só calculamos a
**parcela de energia**. Para não haver interpretação errada, o aviso aparece
em **dois sítios**:

1. **Hero**, sempre visível, uma linha (clica ⇒ faz scroll para o card):
   "Simula só a parcela de energia (CEME + IEC + IVA + EGME). Não inclui a
   tarifa de utilização do posto (OPC)."
2. **Card expansível** no topo do ranking ("Isto é só uma parte do custo de
   carregamento") com a tabela das parcelas:

   | Parcela | Calculada? |
   |---|---|
   | Tarifário do CEME | ✅ |
   | TAR | ✅ incluída no €/kWh |
   | IEC | ✅ |
   | IVA | ✅ (taxa dinâmica por região) |
   | EGME — ativação da CEME | ✅ embutida no tarifário |
   | **Tarifa OPC — utilização do posto** | ❌ |
   | EGME cobrada pelo OPC | ❌ |
   | Outros serviços | ❌ |

   Com o aviso destacado ("o valor apresentado é o mínimo da parcela de
   energia") e links para [mobie.pt/custo-do-carregamento](https://www.mobie.pt/custo-do-carregamento)
   e para a [FAQ Mobi.E](https://www.mobie.pt/pt/carregarveiculo/faq).
3. **Rodapé**, versão curta com os mesmos links.

O estado aberto/fechado persiste em `localStorage['ceme:S'].scopeClosed`.

## Funcionalidades

### Quando é que cada controlo obriga a recalcular

A página tem de distinguir "muda o que se mostra" de "muda o número". Regra
usada em `route()`:

| controlo | acção | porque |
|---|---|---|
| modo kWh ⇄ bateria | **`refresh()`** | muda a energia — o preço é todo diferente |
| valor de kWh, capacidade | **`refresh()`** | idem |
| slider mín/máx (arrasto) | actualiza **só** os números dependentes | durante o arrasto não se re-renderiza |
| slider mín/máx (ao largar) | **`refresh()`** | o gesture acabou, pode re-renderizar |
| região | **`refresh()`** | muda o IVA |
| BT ⇄ MT | `route()` | `LAST` já traz as duas variantes; `filtered()` escolhe a da tensão. Não precisa de ir ao servidor |
| pesquisa, filtros, favoritos | `route()` | só filtram a lista já em memória |

O slider é o caso delicado: `oninput` re-renderizava a vista inteira e
**destruía o próprio slider a meio do arrasto** — o rato continuava a mover-se
sobre um elemento já substituído. Agora o `oninput` escreve só no número
grande e na nota (`liveKwh()`) e o render completo fica para o `change`.
Durante o arrasto os cartões mostram o preço antigo, mas imprimem o **seu**
kWh, portanto estão internamente coerentes; ao largar, tudo é recalculado.

- **Energia a carregar:** modo kWh direto ou bateria (capacidade + min/max %).
  O valor efectivo (`effKwh()`) é o que aparece no hero, nas tabelas e nos
  cartões — nunca o `S.kwh` cru, que fica desatualizado no modo bateria.
  No ecrã sai sempre com **uma casa decimal** (`kwhTxt()` → `30,3 kWh` em PT,
  `30.3 kWh` em EN); o valor bruto só vai para os cálculos. O campo de
  edição fica cru, para se poder escrever `40` e não `40,0`.
- **Data/hora:** input ISO 24h, escrito e mostrado no **relógio da região**
  do carregamento (`frontend/tz.js`: `fromWall`/`toWall`), não no do browser
  — quem simula os Açores a partir de Lisboa fala das horas dos Açores. Nos
  dias de mudança de hora, uma hora que não existe resolve-se para depois do
  salto (testes em `tz.test.js`). Default "agora" (fallback para a hora do
  servidor se o relógio do browser estiver desviado mais de 5 min). O
  assistente usa as mesmas funções.
- **OMIE de referência:** por omissão = o último dia **completo** de
  `/v1/omie/daily`, com as médias vazio/fora **por ciclo** (`omieCycles`:
  diário e semanal) — cada indexado usa as do seu ciclo. O slider manual do
  comparador desliga o modo automático e passa a valer para todos.
- **Potência do ramal (BT/MT):** selector no cartão de energia. O dedup por
  `ceme|nome` (`dedupByRamal()`) é **o mesmo** no ranking, no modal de
  favoritos e no comparador: tira os tarifários que não servem o ramal
  escolhido e, entre variantes, prefere a da tensão do ramal.
- **A conta linha a linha:** o detalhe de cada tarifário mostra o `parts` do
  motor — energia + TAR (separadas quando se sabe), IEC, taxa de activação,
  total sem IVA, IVA e total (docs/02).
- **Favoritos:** estrela nos cartões, modal "Gerir favoritos" agrupado por
  CEME com pesquisa e filtros (popular, bundle, verde). Persistido em
  `localStorage['ceme:favs']`.
- **Barra de preço com cor térmica:** o comprimento é proporcional e linear;
  a cor vai de verde a vermelho numa rampa logarítmica entre o tarifário mais
  barato e o mais caro de **toda** a lista (`heatColor()`/`heatOf()`), por isso
  não muda ao filtrar. A escala é logarítmica porque com uma linear quase
  tudo ficava verde — há tarifários 5× mais caros que a mediana.
- **Pesquisa sem acentos e bilíngue:** `deaccent()` + `searchText()` — pesquisar
  "luzigas" encontra "LUZiGÁS", e "indexed tariff" encontra o tarifário mesmo
  em português (mostrando sempre o nome original do CEME).
- **Mobile:** media query (≤520px) com layout compacto; o logo encolhe com
  ellipsis para não empurrar a nav.

## Internacionalização (PT / EN)

Duas línguas, PT por omissão. Precedência:

1. `localStorage['ceme:lang']` — escolha explícita na bandeira;
2. cabeçalho **`Accept-Language`** — detectado pelo servidor;
3. português.

O servidor injecta o valor detectado em `window.__LANG__` e põe o `<html lang>`
certo no HTML servido (`negotiateLang()` em `server.js`), **nas duas
interfaces**. Só passa a inglês se
o **primeiro** tag da lista ordenada por `q` for `en*` — um `en;q=0.8` atrás
de um `pt;q=0.9` não ganha, porque o público-alvo é português. Resposta
inclui `Vary: Accept-Language` (e `Vary: Cookie` no HTML, que também depende
do cookie da interface).

No cliente:
- **Um dicionário para todas as páginas bilíngues**: `frontend/strings.js`,
  carregado com `<script src="/strings.js">`. Cada página pede o seu
  namespace com `CEME_STR('<página>')` (a lista é a do `strings.test.js`),
  que devolve `{pt, en}` já com o vocabulário **comum**
  (filtros e etiquetas dos tarifários, `Agora`, `Energia a carregar`,
  `Tentar outra vez`, e o logo + a navegação) por cima.
  `CEME_I18N.regions` tem nome, IVA e fuso de cada região — a UI do simulador
  usa o nome longo, o assistente o `curto` (a mesma fonte, duas larguras).
- `i18n('chave', {vars})` (simulador) e `t('chave', {vars})` (assistente)
  fazem a substituição e caem para PT se a chave faltar.
- **Sincronia garantida por teste** (`backend/test/strings.test.js`): PT e EN
  com as mesmas chaves e os mesmos placeholders em todos os namespaces,
  nenhuma chave de `common` redefinida por uma página, nenhuma chave usada que
  não exista, nenhuma chave morta, e **nenhum texto igual em dois sítios** —
  se duas páginas dizem o mesmo, a chave passa para `common`. É a regra
  que impede o divórcio entre os dois dicionários.
- `setLang(id, persist)` (simulador) muda a linguagem, actualiza `<html lang>`,
  as bandeiras e o chrome estático (`applyChrome()`: `<title>`, logo, nav,
  título/rodapé do modal de favoritos, rodapé). O assistente re-renderiza:
  só tem três ecrãs e o `document.title` também vem do dicionário.
- Seletor com **bandeiras SVG** (PT e GB desenhadas em CSS/SVG — emoji não
  renderiza em Windows) no header do simulador; o assistente usa `PT` / `EN`
  em texto, que cabe na moldura estreita.
- Persistência em `localStorage['ceme:lang']` — sem isto a bandeira parecia
  não funcionar, porque cada visita voltava ao português.

Traduzido: chrome, hero, aviso de âmbito, cartões, badges, detalhe, filtros,
modal de favoritos, comparador, rodapé, e também os **ciclos**
(diário/semanal/simples → same every day / day and night / single rate) e as
**bandas** (vazio/fora de vazio → off-peak / peak).

O inglês é **britânico** (o cabeçalho HTTP manda `en-GB` como fallback),
por ser o contexto europeu — mas sem saudade do inglês clássico: a UI
diz `saved`, não `favourites` (os "Favoritos" viram "saved", o que o
utilizador faz com eles).

### Lingue natural, não tradução literal

As strings foram revistas uma a uma para não serem calcadas do português.
Exemplos do que mudou e porquê:

| PT | antes (calcado) | agora |
|---|---|---|
| Comparador CEME | CEME Comparator | **EV Tariff Comparison** |
| Simular | Simulate | **Simulation** |
| Quanto custa carregar agora? | What does it cost to charge now? | **How much does it cost to charge right now?** |
| Indexado OMIE | OMIE indexed | **Tracks the OMIE price** |
| comercializado em: | sold in: | **only sold in:** |
| O valor apresentado é o mínimo… | The figure shown is the minimum… | **What you see here is the cheapest the energy component can be.** |
| A fatura final será maior | Your final invoice will be higher | **Your final bill will be higher** |
| OMIE de referência | Reference OMIE | **OMIE reference price** |
| ~ = vazio estimado no seed | estimated in the seed | **estimated — not from the retailer's published tariff** |
| Favoritos | favourites | **saved** (o utilizador "guarda", não "favorita") |

`OPC` aparece como `OPC / CPO`: o site da Mobi.E em inglês usa *Charging Point
Operator*, o acrónimo português não é CRP.

### A flag "Bundles" — porque é que NÃO é "cliente casa"

A coluna chama-se **Bundles** e é um booleano simples do sheet (coluna `AI`
da folha CEME).

O workbook não dá mais definição: a única ocorrência de "bundle" em todas as
folhas é o cabeçalho da coluna. Mas olhando as linhas marcadas, cobrem pelo
menos seis relações diferentes:

| marcado como `Bundles=True` | o que é na verdade |
|---|---|
| LUZiGÁS *Cliente Casa e CEME*, eVaz *Plano Move HOME*, GoldEnergy *Clientes Comercialização* | cliente de electricidade doméstica |
| miio one (subscrição) | subscrição |
| ACP *sócio ACP*, EDP *Associados UVE* | associação |
| EDP/MEO *Colaboradores* | colaborador |
| EDP *Clientes energia*, EVIO *Hyundai Blue* / *Go.Charge*, Galp Plano, FactorEnergia *VECARD* | desconto por já ser cliente |
| Atlante *myAtlante Business (AC)* | ser cliente business |

O único denominador é: **o preço está condicionado a ter outra relação com a
CEME**. Para o *myAtlante Business* é quase tautológico, o que é porque
parecia errado. Existe uma folha "Sem_Bundles__MT__Cheias", o que confirma que
a flag existe para **filtrar** ofertas bundled.

Rótulo usado, igual nos três sítios onde o conceito aparece (badge, filtro e
modal de favoritos), com tooltip a explicar:

| | |
|---|---|
| PT | **preço com condições** / *sem condições* / *com condições* |
| EN | **conditional price** / *no conditions* / *conditional* |

**A coluna na BD continua a ser só um booleano** (`tariff.bundle`), fiel à
fonte. Não foi criada uma coluna por categoria.

O filtro do modal de favoritos é **independente** e está correcto:
`FM.bundle` significa "mostrar os com condições", logo `(!FM.bundle ||
tf.bundle)`. Não confundir os dois.

### Nomes dos tarifários — tradução parcial, por regras

São os nomes que cada CEME publica, por isso **não se traduzem wholesale**:
traduzir tudo tornava-os irreconhecíveis e impossíveis de conferir na página
do CEME (que é o link de cada cartão). O que se traduz é o vocabulário
genérico do sector; a marca fica intacta.

`NAME_RULES` é uma lista de substituições aplicada **por ordem**, frases mais
longas primeiro. 44 dos 55 nomes distintos ficam traduzidos; os restantes são marca
pura e passam intactos (`NAME_KEEP`).

| original (o que o CEME publica) | em inglês |
|---|---|
| Cartão EDP Charge (Bi-Horário) | EDP Charge card (bi-hourly) |
| Cartão EDP Charge Frota (Simples) Clientes Energia | EDP Charge card fleet (simple rate) energy customers |
| Cartão EDP Charge (Bi-Horário) Associados UVE (10%) | EDP Charge card (bi-hourly) UVE members (10%) |
| Cartão CEME | CEME card |
| Cartão Mobilidade Elétrica | electric mobility card |
| Cartão Bluecharge / Cartão EVpower | Bluecharge card / EVpower card |
| Tarifário Indexado Cliente CEME | indexed tariff, CEME customer |
| Tarifário Indexado Cliente Casa e CEME | indexed tariff, home & CEME customer |
| miio (Bi-Horário Diário) sem subscrição | miio (bi-hourly daily) no subscription |
| Galp Electric Energia Verde | Galp Electric Renewable energy |
| Clientes / Não Clientes Goldenergy Comercialização | Goldenergy / Non-Goldenergy supply customers |
| Cartão de carregamento público e privado MOBISMART (pré-pago) | MOBISMART public and private charging card (prepaid) |
| ACP Electric by EVIO - não sócio ACP | ACP Electric by EVIO — not an ACP member |
| Pessoas Singulares | Individuals |
| Mobilidade Elétrica | electric mobility |

**"Cartão" muda de posição**: é prefixo em PT ("Cartão EDP Charge") e sufixo
em EN ("EDP Charge card"). São necessárias regras explícitas por marca, não
uma substituição genérica.

Marcas que ficam intactas: `myAtlante (AC)`, `Eco Green`, `VECARD`, `GOW`,
`Hyundai Blue`, `AB Energia`, `Via Verde Electric by ECOCHOICE`, `Prio Electric`.

A **pesquisa ignora a língua da interface** (`searchText()` compara contra as
duas formas): quem escreve "indexed tariff" em português encontra o tarifário,
e mostra-o com o nome original do CEME. Sem isto, o utilizador ficava a
pesquisar no escuro depois de mudar de língua.

Testado em `backend/test/i18n.test.js`: casos fixos, marcas intactas, nenhum
nome do seed fica por traduzir, e — o mais útil — um teste que falha se
alguém puser uma regra curta antes da frase longa que a contém (já apanhou
uma regra morta: `Clientes Energia` antes de `Frota Clientes Energia`). As
mesmas chaves e os mesmos placeholders em PT e EN são o `strings.test.js`.

### A função de tradução chama-se `i18n()`, não `t()`

Porque já aconteceu duas vezes: um `.map(t => ...)` sobre um tarifário sombreava a função
`t()` e o modal de favoritos ficava em branco com um `TypeError` silencioso.
Quando se renomeou para `i18n()`, ficou um `t(cond ? 'a' : 'b')` por converter
dentro de um ternário — e a página deixou de renderizar. Agora os nomes não
colidem: `i18n()` para traduzir, `tf` para um tarifário.

`backend/test/frontend-smoke.test.js` corre o frontend de facto num
contexto isolado, sem browser, e chama `vHome()`, `vCmp()`, `badges()`,
`detail()` e `renderFavModal()` — e falha se injectarmos qualquer um dos dois
bugs. É o que apanha o que os testes de texto não apanham.

### Português europeu, não brasileiro

Varredura por marcadores de pt-BR (`usuário`, `tela`, `arquivo`, `celular`,
`equipe`, `senha`, `conexão`, `você`, `atualizar`, `salvar`, `cadastro`,
`faturamento`, `equipe`, `time`) — **zero ocorrências**. O português está em
pt-PT pós-AO90: `fatura`, `utilizador`, `electricidade`, `ecrã`, `ficheiro`
e **`ativação`** (não `activação`), `diretamente` (não `directamente`).

O qualificador entra **uma vez**, onde não há contexto, e o resto
fica curto:

| sítio | texto |
|---|---|
| nav + título do comparador | **Indexed to OMIE** vs fixed tariff |
| badge do cartão | Tracks the OMIE price *(mantido)* |
| KPI do comparador | **indexed tariff** (longe do título, tem de se explicar sozinho) |
| legenda do gráfico | indexed tariff, peak / off-peak *(mantido)* |

Em português fica **Indexado vs fixo** — é o termo de mercado e não precisa
de qualificador. A assimetria com o inglês é deliberada: cada lado fica
natural na sua língua.

### O que NÃO é traduzido

- As **marcas** e `@ O Carro Elétrico` (marca-irmã).
- **`~`** e as siglas `BT`/`MT` (significado no tooltip).

**Mantido por decisão:** nomes de marca dos tarifários (`myAtlante`,
`Eco Green`, …) e topónimos — `Madeira` mantém-se, `Açores` passa a `Azores`.
`BT`/`MT` mantêm as siglas, com o significado no tooltip do selector
("BT = baixa tensão, MT = média tensão" / "BT = low voltage, MT = medium voltage").
`IVA` → `VAT`, `EUR`/`€/kWh` inalterados, formato de data `aaaa/mm/dd hh:mm`
mantido (é ISO, não é PT-PT).

Avisos, notas e rótulos que chegam do servidor têm de chegar **neutros ou
como código** — nunca como prosa num único idioma:

- aviso das ilhas: `OMIE_CONT_REF` (código, traduzido no cliente);
- nota do tarifário: `tariff_version.notes` (código, traduzido no cliente);
- `source` do OMIE: o rótulo das fontes (`SOURCE_LABEL` em
  `omie/pipeline.js`), sem prosa em português.

### Futuros OMIP: fora da interface, não fora da API

A tabela de contratos OMIP (D+1/D+2) foi removida do comparador: não respondia
a nada que o simulador calcule. O preço mostrado é sempre o do momento, e
nenhuma previsão entra nele — mostrar OMIP ao lado dava a impressão de que a
previsão afectava o preço apresentado.

`/v1/omie/futures` **continua de pé** para consumidores da API (`getFutures`
em `omie/pipeline.js`). A interface deixou de o pedir, o que também tira
uma dependência de rede ao gráfico de 60 dias — passa a depender só de
`/v1/omie/daily` e `/v1/tar`.

Teste de regressão sobre o **fonte** do frontend (não sobre o DOM): o stub de
`getElementById` do smoke test nunca devolve `null`, portanto um
`document.getElementById('cmpFut')` apontando para um contentor removido
passaria despercebido. O teste verifica que não há `cmpFut`, que não há pedido
a `/v1/omie/futures`, que as chaves `futures`/`thContract`/`thProduct` não
sobrevivem em nenhum dos dois dicionários, e que o subtítulo já não promete os
futuros.

### Tabela de quartos — "quem ganha" é diferente de "quem é mais barato"

A tabela quarto-a-hora marca duas coisas distintas:

| marca | significado | quem calculava |
|---|---|---|
| ★ nos 8 mais baratos | os 8 quartos de OMIE mais baixo do dia | servidor (`cheap`) |
| coluna **Fixo €/kWh** + coluna **Melhor** | se o indexado ou o fixo é mais barato **nesse quarto** | servidor (`winner`) |

São coisas diferentes: num domingo de ciclo semanal o indexado ganha em 39 dos
96 quartos e o fixo em 57 — o resumo antigo ("8 quartos mais baratos:
10:30–12:30") não dizia nada sobre isso.

O endpoint `/v1/indexed/quarters` recebe `?fixed=<id>` (o tarifário fixo que o
cliente escolheu no comparador) e devolve, por quarto, `fixed` e `winner`
(`IDX` / `FIX` / `EQ` / `null`). Sem `fixed`, `winner` é `null` e a UI esconde
as duas colunas — **não há um "vencedor" por omissão**, porque um vencedor
calculado contra o tarifário errado é pior do que nenhum.

Regras que a comparação respeita, em `backend/src/engine/compare.js`:

- o fixo é o **do mesmo período** (um bi-horário tem 0,1157 de vazio e 0,1812
  de cheias; comparar os dois com um só número mentiria metade do dia);
- um fixo **simples** só tem `UNICO`, que vale para todos os períodos;
- os dois lados são arredondados a 4 casas **antes** de comparar, senão
  `0.1 + 0.2 > 0.3` daria um falso empate;
- a tarifa de ativação fica de fora: é um valor único e não se repete por
  quarto de hora;
- período sem preço no fixo → `null`, **nunca 0** (0 mostraria o fixo como
  gratuito).

**Notas do tarifário** (`notes`) aparecem em **três sítios** — tooltip no nome,
**badge visível no cartão** (`só em AC` / `AC only`, roxo) e **linha dentro da
composição do preço**. A primeira versão tinha só o tooltip, e isso não
chegava: é uma correcção que ninguém vê. Uma nota tem de ser legível sem
interacção.

O mapeamento código → texto está em `NOTE_KEY`; um código desconhecido mostra-se
tal e qual, para não esconder informação. Só os quatro tarifários
`myAtlante (AC)` / `myAtlante Business (AC)` da Atlante têm nota
(`AC_DC_FLAT`): o nome "(AC)" quer dizer **corrente alternada** — é o preço
da energia nos postos AC. Nos postos **DC** a Atlante pratica um preço
promocional *flat* com o CEME e o OPC já incluídos, que é precisamente o que
este simulador não calcula.

Não reintroduzir texto do servidor na UI.

## Arranque sem bloquear

`init()` pinta primeiro com o OMIE por omissão e só depois busca o OMIE de
referência em segundo plano (`loadOmieRef()`). Com cache frio o primeiro
fetch pode demorar dezenas de segundos (o servidor tem timeout de 25 s × 3
tentativas) — se o OMIE bloqueasse o arranque, a página ficava em branco.

E se o **primeiro** `refresh()` falhar (servidor a acordar, rede caída,
token morto), `init()` mostra cartão de erro com botão de repetição em vez
de `#app` vazio. `api()` vem com retry de 401: limpa o token expirado,
pede sessão nova e repete o pedido uma vez — sem isso a página dizia
"sem resultados" para sempre após 24 h de sessionStorage.

## Favoritos sem login

`localStorage['ceme:favs'] = [tariffId...]`. Sem conta, sem BD.

## PWA

Instalável: `manifest.webmanifest`, `sw.js` e o gatilho de instalação
(`pwa.js`). O service worker é **rede primeiro** para tudo o que muda com um
deploy (`strings.js`, `tz.js`, `pages.css`, manifest) — a cópia em cache só
serve sem rede — e cache primeiro só para os ícones (imutáveis). Não guarda
páginas nem `/v1/*`. Mudar a estratégia ou a lista = subir o nome da cache
(`CACHE` em `sw.js`): o `activate` apaga as caches antigas.

## Evolução planeada

Ver `docs/06-roadmap.md` (é lá que vive a lista — aqui não se repete).
