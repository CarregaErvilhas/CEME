# CEME v2 — simulador moderno de mobilidade eléctrica

Favor à comunidade, sem fins lucrativos. Substitui o Google Sheets
(`1WMaiaShTwp1-QzWXi-SlcB3uTigp5nfYO-v3veCcn84`, 34 tabs) por uma BD
versionada + motor de cálculo testável + API com auth + web mobile-friendly.

## Âmbito (importante)

O simulador calcula **só a parcela de energia** de um carregamento na rede
Mobi.E: tarifário do CEME (com TAR incluída) + IEC + IVA + EGME.

**Não inclui a tarifa de utilização do posto (OPC)** — cada operador define a
sua (€/kWh, €/min ou €/sessão) e publica-a no próprio posto. O valor
mostrado é o mínimo da parcela de energia; a factura final será maior.
Ver [mobie.pt/custo-do-carregamento](https://www.mobie.pt/custo-do-carregamento)
e a [FAQ Mobi.E](https://www.mobie.pt/pt/carregarveiculo/faq).

## Stack (POC, custo zero)

- Backend: Node.js puro (sem deps) — `node:http`, `node:sqlite`, `node:test`.
- Frontend: HTML + CSS + JS vanilla em `frontend/index.html` (sem build),
  bilíngue PT/EN (dicionário no cliente + `Accept-Language` no servidor).
- BD: SQLite (`backend/data/ceme.db`), schema Drizzle-migrável.
- Auth: HS256 JWT de sessão (24h) + API keys (sha256).
- OMIE: dados.tiagofelicia.pt (CC BY 4.0) com cache 6h; produção usa omie.es.

## Correr o POC

```sh
cd ceme-v2/backend
node --test test/*.test.js   # 74 testes
node src/server.js           # http://localhost:3001/
```

Abrir http://localhost:3001/ — ranking ao vivo de **128 tarifários versionados** (55 ofertas distintas em ecrã) / 24 CEME
(seed completo do sheet, incluindo Atlante, EDP, Galp, 6 indexados LuziGas,
MEO Dinâmica, Ynerluz, miio, Via Verde, etc.), com kWh ou bateria %,
região (Portugal Continental / Madeira / Açores), pesquisa, filtros (verde,
sem bundle, favoritos), favoritos em localStorage e detalhe por tarifário.

Página **Indexado vs fixo** (`#/comparar`): valor actual lado a lado, gráfico
SVG de 60 dias, tabela de quartos-horários (os 8 mais baratos destacados) e
futuros OMIP.

## Funcionalidades actuais

- **Bilíngue PT/EN:** detecção pelo cabeçalho `Accept-Language` (servidor), bandeira PT/EN no header, escolha persistida em `localStorage`.
- **Aviso de âmbito** visível no hero + card expansível no topo do ranking, com a tabela das parcelas da Mobi.E e links para a fonte oficial.
- **Regiões:** Portugal Continental (IVA 23%), Madeira (22%), Açores (16%), com timezones, ciclos bi-horários e DST próprios.
- **Tarifários fixos + indexados**, BT/MT, bi-horário (diário/semanal) + simples.
- **Agregação do OMIE por tarifário** (`tariff_version.omie_aggregation`): `SPLIT_VAZIO_FORA` (LuziGas, MEO, Ynerluz) usa médias separadas de vazio e fora-vazio; `SPOT`/`UNICA` usam o OMIE único.
- **OMIE de referência** por omissão = último OMIE real disponível (com médias vazio/fora separadas).
- **Data/hora do carregamento** configurável (formato ISO aaaa/mm/dd hh:mm); default "agora" com base na hora do browser (fallback servidor se desvio >5 min).
- **Bateria %:** capacidade + min/max → kWh calculado.
- **Favoritos** em localStorage, com modal de gestão agrupado por CEME e filtros (pesquisa, popular, bundle, verde).
- **Sessão:** energia/%/bateria/região/favoritos/data-hora persistidos em localStorage (`ceme:S`, `ceme:favs`).
- **Potência do ramal (BT/MT):** selector no cartão de energia — afecta apenas a TAR aplicada, não a lista de tarifários. O dedup por `CEME+nome` (`dedupByRamal()`) é partilhado pelo ranking, pelo modal de favoritos e pelo comparador, por isso cada tarifário aparece uma vez em todo o lado.
- **Pesquisa tolerante:** ignora acentos (`luzigas` → `LUZiGÁS`) e não depende da língua da interface — pesquisa em inglês encontra o tarifário em PT.

## Estrutura

```
ceme-v2/
  README.md
  docs/           # 01-modelo, 02-motor, 03-omie, 04-api-auth, 05-frontend, 06-roadmap, 07-ilhas
  backend/        # server.js, engine/, db/, omie/, test/
  frontend/       # index.html (tudo num ficheiro)
  scripts/
```

## Licença

Mantém CC BY-NC 4.0 do simulador original + atribuição ERSE/Mobi.E/OMIE.
